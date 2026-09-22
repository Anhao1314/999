// v0B4 — Deterministic Workforce Coordination Closure.
// Contract: docs/contracts/work-continuity-v0.md §2–§14, §19.
//
// The Driver is measured the way the contract describes it: as a stateless
// actuator over Runtime truth. Every test here either proves that a
// deterministic continuation happens without the Founder, or proves that the
// Runtime refused to invent one.
import test from "node:test";
import assert from "node:assert/strict";
import {
  BOUNDARIES,
  CONTINUATION_ACTIONS,
  CONTINUATION_DIAGNOSTICS,
  CONTINUATION_POLICY_VERSION,
  MAX_CONTINUATION_STEPS,
  WAKE_CAUSES,
  createContinuationDriver,
  deterministicNextActionProposer,
  newAssignment,
} from "../../packages/runtime/index.mjs";
import {
  openTempKernel,
  reviewArtifact,
  seedCompanyAndWork,
  seedEmployee,
  seedTaskInReview,
} from "../support/kernel.mjs";

const tracesOf = (kernel, workId) => kernel.continuationTraces({ workId, limit: 500 });
const executed = (kernel, workId) =>
  tracesOf(kernel, workId).filter((trace) => trace.actionResult === "EXECUTED");
const activityHead = (kernel, workId) => kernel.workProjection(workId).decisionBasis;

// A company whose one Employee can execute what the deterministic proposer
// proposes, and nobody can review yet.
function seedOperator(kernel, capabilities = ["work.execute"], displayName = "Atlas") {
  const { company, work } = seedCompanyAndWork(kernel);
  const { position, employee } = seedEmployee(kernel, company.id, {
    capabilities,
    displayName,
  });
  return { company, work, position, employee };
}

test("an unactivated Work is materialized, assigned and started without a single manual step", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { work, employee } = seedOperator(kernel);
    const driver = createContinuationDriver({ kernel });

    const summary = driver.driveWork(work.id);

    assert.equal(summary.steps, 3, "one mutation per iteration: materialize, assign, start");
    const tasks = kernel.tasks(work.id);
    assert.equal(tasks.length, 1, "exactly one initial Task");
    assert.equal(tasks[0].state, "RUNNING");
    assert.equal(kernel.assignment(tasks[0].id).employeeId, employee.id);
    assert.equal(kernel.workerRuns({ taskId: tasks[0].id }).length, 1);

    // The trace proves the loop never acted twice against one snapshot: every
    // executed step started from the basis the previous step produced.
    const steps = executed(kernel, work.id);
    assert.deepEqual(
      steps.map((trace) => trace.actionCommand),
      [
        CONTINUATION_ACTIONS.MATERIALIZE,
        CONTINUATION_ACTIONS.ASSIGN,
        CONTINUATION_ACTIONS.START,
      ],
    );
    for (let index = 1; index < steps.length; index += 1)
      assert.equal(
        steps[index].basisBefore,
        steps[index - 1].basisAfter,
        "each iteration re-read truth instead of trusting its own last read",
      );
    assert.equal(summary.stopped, "BOUNDARY");
    assert.equal(summary.boundary, BOUNDARIES.RUNNING);
    assert.equal(kernel.workProjection(work.id).status, "ACTIVE");
  } finally {
    cleanup();
  }
});

test("a Work with no Tasks is never activated twice, however often it is driven", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { work } = seedOperator(kernel);
    const driver = createContinuationDriver({ kernel });
    driver.driveWork(work.id);
    driver.driveWork(work.id);
    driver.driveWork(work.id);
    assert.equal(kernel.tasks(work.id).length, 1);
    assert.equal(
      tracesOf(kernel, work.id).filter(
        (trace) => trace.actionCommand === CONTINUATION_ACTIONS.MATERIALIZE,
      ).length,
      1,
      "REPLAN exists only for initial activation",
    );
  } finally {
    cleanup();
  }
});

test("materialization is atomic, strict, and refuses a second initial Task", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { work } = seedOperator(kernel);
    const basis = activityHead(kernel, work.id);
    const proposal = {
      taskKind: "EXECUTION",
      title: "Produce the readiness read",
      intent: "One output the founder can act on",
      requiredCapabilities: ["work.execute"],
      reviewCapabilities: ["work.review"],
    };

    assert.throws(
      () =>
        kernel.materializeNextAction({
          workId: work.id,
          expectedBasis: basis,
          proposal: { ...proposal, employeeId: "emp_smuggled" },
        }),
      { code: "INVALID_PROPOSAL" },
      "a proposal may describe work; it may not name an Employee",
    );
    assert.throws(
      () =>
        kernel.materializeNextAction({
          workId: work.id,
          expectedBasis: basis,
          proposal: { ...proposal, permission: "grant-everything" },
        }),
      { code: "INVALID_PROPOSAL" },
    );
    assert.throws(
      () =>
        kernel.materializeNextAction({
          workId: work.id,
          expectedBasis: 999,
          proposal,
        }),
      { code: "STALE_CONTINUATION_BASIS" },
      "a proposal is materialized against the reality it named",
    );
    assert.equal(kernel.tasks(work.id).length, 0, "a refused proposal creates nothing");

    const materialized = kernel.materializeNextAction({
      workId: work.id,
      expectedBasis: basis,
      proposal,
    });
    assert.equal(materialized.task.state, "OPEN");
    assert.deepEqual(materialized.requirements.requiredCapabilities, ["work.execute"]);
    assert.deepEqual(materialized.requirements.reviewCapabilities, ["work.review"]);

    // A lost response is retried with the basis that was current when the
    // proposal was made; the retry observes the Task and refuses to duplicate.
    const retry = (() => {
      try {
        kernel.materializeNextAction({ workId: work.id, expectedBasis: basis, proposal });
        return null;
      } catch (error) {
        return error;
      }
    })();
    assert.equal(retry.code, "WORK_ALREADY_ACTIVATED");
    assert.equal(retry.details.taskId, materialized.task.id);
    assert.equal(kernel.tasks(work.id).length, 1);
  } finally {
    cleanup();
  }
});

test("WORK_ALREADY_ACTIVATED is benign convergence: it consumes no attempt and the drive continues", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { work, employee } = seedOperator(kernel);
    // A proposer that is overtaken by another attempt: by the time it answers,
    // the initial Task already exists. The Runtime must converge on it rather
    // than re-plan or fail.
    let raced = false;
    const proposer = {
      name: "racing-proposer",
      version: "test",
      propose({ work: target }) {
        if (!raced) {
          raced = true;
          kernel.materializeNextAction({
            workId: target.id,
            expectedBasis: activityHead(kernel, target.id),
            proposal: {
              taskKind: "EXECUTION",
              title: "Produced by the other attempt",
              intent: "One output the founder can act on",
              requiredCapabilities: ["work.execute"],
              reviewCapabilities: ["work.review"],
            },
          });
        }
        return {
          taskKind: "EXECUTION",
          title: "Produced by this attempt",
          intent: "One output the founder can act on",
          requiredCapabilities: ["work.execute"],
          reviewCapabilities: ["work.review"],
        };
      },
    };
    const driver = createContinuationDriver({ kernel, proposer });
    const summary = driver.driveWork(work.id);

    assert.equal(kernel.tasks(work.id).length, 1, "no duplicate initial Task");
    assert.equal(kernel.tasks(work.id)[0].title, "Produced by the other attempt");
    assert.equal(summary.steps, 2, "the no-op consumed no step: assign and start remain");
    assert.equal(kernel.assignment(kernel.tasks(work.id)[0].id).employeeId, employee.id);
    const noop = tracesOf(kernel, work.id).find(
      (trace) => trace.actionResult === "NO_OP",
    );
    assert.equal(noop.reasonCodes[0], "ALREADY_CONVERGED");
    assert.equal(noop.actionErrorCode, "WORK_ALREADY_ACTIVATED");
  } finally {
    cleanup();
  }
});

test("an Assignment is a preference, not an entitlement to start", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { company, work } = seedCompanyAndWork(kernel);
    const task = kernel.createTask({
      workId: work.id,
      title: "Produce the analysis",
      intent: "One output the founder can act on",
      requiredCapabilities: ["capability.x"],
    });
    const atlas = seedEmployee(kernel, company.id, {
      displayName: "Atlas",
      capabilities: ["capability.x"],
    }).employee;
    const iris = seedEmployee(kernel, company.id, {
      displayName: "Iris",
      capabilities: ["capability.x"],
    }).employee;
    kernel.assignTask({ taskId: task.id, employeeId: atlas.id, reason: "fixture" });
    kernel.setEmployeeEnabled({ employeeId: atlas.id, enabled: false });

    // The Assignment is now unusable, so the Runtime applies its normal
    // dispatch rules instead of starting a disabled Employee.
    const driver = createContinuationDriver({ kernel });
    const summary = driver.driveWork(work.id);

    assert.equal(summary.steps, 2, "reassign, then start");
    assert.equal(kernel.assignment(task.id).employeeId, iris.id);
    assert.equal(kernel.assignment(task.id).reason, "continuation.dispatch");
    assert.equal(kernel.task(task.id).state, "RUNNING");
    assert.equal(kernel.workerRuns({ taskId: task.id }).length, 1);
    assert.equal(kernel.assignments(task.id).length, 2, "the old Assignment stays readable");
  } finally {
    cleanup();
  }
});

test("a busy Employee is contention, never a capability gap, and never a second run", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { company, work } = seedCompanyAndWork(kernel);
    const atlas = seedEmployee(kernel, company.id, {
      displayName: "Atlas",
      capabilities: ["capability.x"],
    }).employee;

    // Atlas is executing something in another Work, so this Work's Task has an
    // eligible Employee and no dispatchable one. That is contention: the
    // capability exists and the Runtime simply cannot use it yet.
    const other = kernel.createWork({
      companyId: company.id,
      title: "Another line of work",
      intent: "One output the founder can act on",
    });
    const busy = kernel.createTask({
      workId: other.id,
      title: "Occupy the analyst",
      intent: "One output the founder can act on",
      requiredCapabilities: ["capability.x"],
    });
    kernel.assignTask({ taskId: busy.id, employeeId: atlas.id, reason: "fixture" });
    kernel.startWorkerRun({ taskId: busy.id });

    const task = kernel.createTask({
      workId: work.id,
      title: "Produce the analysis",
      intent: "One output the founder can act on",
      requiredCapabilities: ["capability.x"],
    });
    const driver = createContinuationDriver({ kernel });
    const summary = driver.driveWork(work.id);

    assert.equal(summary.stopped, "DIAGNOSTIC");
    assert.equal(summary.diagnostic.code, CONTINUATION_DIAGNOSTICS.NO_DISPATCHABLE_EMPLOYEE);
    assert.notEqual(summary.diagnostic.code, CONTINUATION_DIAGNOSTICS.CAPABILITY_GAP);
    assert.equal(kernel.assignment(task.id), null);
    assert.equal(kernel.task(task.id).state, "OPEN");
    assert.equal(
      kernel.workerRuns({ employeeId: atlas.id }).filter((run) => run.state === "RUNNING").length,
      1,
      "the Runtime never opens a second active run for one Employee",
    );
  } finally {
    cleanup();
  }
});

test("reviewer independence is enforced at assignment and again before the run starts", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedTaskInReview(kernel);
    const handoff = kernel.requestReview({
      taskId: flow.task.id,
      generation: flow.generation,
    });

    // 1. The seam every caller has to pass through.
    assert.throws(
      () =>
        kernel.assignTask({
          taskId: handoff.reviewTask.id,
          employeeId: flow.producer.id,
          reason: "self review",
        }),
      { code: "REVIEWER_NOT_INDEPENDENT" },
    );
    assert.equal(kernel.assignment(handoff.reviewTask.id), null, "a refusal writes nothing");

    // 2. A hand-written or migrated self-review Assignment is readable history
    //    and can never become an executable Review run.
    kernel.store.insertAssignment(
      newAssignment({
        companyId: flow.company.id,
        taskId: handoff.reviewTask.id,
        employeeId: flow.producer.id,
        positionId: flow.producerPosition.id,
        reason: "legacy fixture",
        createdAt: "2026-09-20T10:00:00.000Z",
      }),
    );
    assert.equal(kernel.assignment(handoff.reviewTask.id).employeeId, flow.producer.id);
    assert.throws(
      () => kernel.startWorkerRun({ taskId: handoff.reviewTask.id }),
      { code: "REVIEWER_NOT_INDEPENDENT" },
    );
    assert.equal(kernel.task(handoff.reviewTask.id).state, "OPEN");
    assert.equal(kernel.workerRuns({ taskId: handoff.reviewTask.id }).length, 0);

    // 3. The independent reviewer still works, and the review is recorded.
    kernel.assignTask({
      taskId: handoff.reviewTask.id,
      employeeId: flow.reviewer.id,
      reason: "independent review",
    });
    const review = reviewArtifact(kernel, {
      reviewTaskId: handoff.reviewTask.id,
      reviewerId: flow.reviewer.id,
      verdict: "PASS",
      summary: "The output matches what was asked for.",
    });
    assert.equal(review.verdict, "PASS");
  } finally {
    cleanup();
  }
});

test("a committed change wakes the Driver, and a rolled-back one wakes nothing", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { company, work } = seedCompanyAndWork(kernel);
    const task = kernel.createTask({
      workId: work.id,
      title: "Draft the readiness checklist",
      intent: "One checklist the founder can act on",
    });
    const started = kernel.startTask({ taskId: task.id });

    const seen = [];
    kernel.setContinuationObserver((signal) => {
      seen.push({
        ...signal,
        taskState: kernel.task(task.id).state,
        activityHead: kernel.store.workActivityHead(work.id),
      });
    });
    kernel.recordArtifact({
      taskId: task.id,
      generation: started.generation,
      kind: "document",
      title: "Checklist",
      content: "- owner: founder\n",
    });
    kernel.completeTask({ taskId: task.id, generation: started.generation });

    assert.ok(seen.length >= 1);
    const last = seen.at(-1);
    assert.equal(last.taskState, "COMPLETED", "the wake sees committed truth, never RUNNING");
    assert.equal(last.activityHead, kernel.store.workActivityHead(work.id));

    // A transaction that rolls back publishes nothing: the facts it would have
    // reported never became true.
    seen.length = 0;
    assert.throws(
      () =>
        kernel.bootstrapWorkforce({
          companyId: company.id,
          positions: [
            { id: "pos_seed_a", title: "Operator", capabilities: ["capability.x"] },
            { id: "pos_seed_b", title: "Operator", capabilities: ["capability.y"] },
          ],
          employees: [
            { id: "emp_seed_a", positionId: "pos_seed_a", displayName: "Seed A" },
            { id: "emp_seed_b", positionId: "pos_seed_b", displayName: "Seed B", enabled: "yes" },
          ],
        }),
      { code: "INVALID_INPUT" },
    );
    assert.deepEqual(seen, [], "no wake may observe a rolled-back change");
    assert.equal(kernel.status().counts.employees, 0, "and the rollback left no rows behind");
  } finally {
    cleanup();
  }
});

test("disabling an Employee wakes the Work and redistributes it, with no Work fact invented by the wake", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { company, work } = seedCompanyAndWork(kernel);
    const task = kernel.createTask({
      workId: work.id,
      title: "Produce the analysis",
      intent: "One output the founder can act on",
      requiredCapabilities: ["capability.x"],
    });
    const atlas = seedEmployee(kernel, company.id, {
      displayName: "Atlas",
      capabilities: ["capability.x"],
    }).employee;
    const iris = seedEmployee(kernel, company.id, {
      displayName: "Iris",
      capabilities: ["capability.x"],
    }).employee;
    kernel.assignTask({ taskId: task.id, employeeId: atlas.id, reason: "fixture" });
    const driver = createContinuationDriver({ kernel });
    const tracesBefore = tracesOf(kernel, work.id).length;

    // true → false: the Assignment becomes unusable. The committed change is
    // what wakes the Work; the Work itself did not move.
    kernel.setEmployeeEnabled({ employeeId: atlas.id, enabled: false });

    const wakes = tracesOf(kernel, work.id).slice(tracesBefore);
    assert.ok(wakes.length >= 1);
    assert.ok(
      wakes.every((trace) => trace.triggerType === "WAKE"),
      "the redistribution came from the availability wake",
    );
    assert.deepEqual(
      wakes.filter((trace) => trace.actionResult === "EXECUTED").map((trace) => trace.actionCommand),
      [CONTINUATION_ACTIONS.ASSIGN, CONTINUATION_ACTIONS.START],
      "the wake re-read truth and used the ordinary commands; it wrote no Work fact itself",
    );
    assert.equal(kernel.assignment(task.id).employeeId, iris.id);
    assert.equal(kernel.task(task.id).state, "RUNNING");
    assert.equal(kernel.workerRuns({ taskId: task.id })[0].employeeId, iris.id);
    assert.equal(driver.driveWork(work.id).steps, 0, "and it converges: nothing left to do");
  } finally {
    cleanup();
  }
});


test("a disabled-only capability stops the drive, and enabling it lets the Work continue", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { company, work } = seedCompanyAndWork(kernel);
    const task = kernel.createTask({
      workId: work.id,
      title: "Produce the analysis",
      intent: "One output the founder can act on",
      requiredCapabilities: ["capability.x"],
    });
    const atlas = seedEmployee(kernel, company.id, {
      displayName: "Atlas",
      capabilities: ["capability.x"],
      enabled: false,
    }).employee;

    const driver = createContinuationDriver({ kernel });
    const stopped = driver.driveWork(work.id);
    assert.equal(stopped.diagnostic.code, CONTINUATION_DIAGNOSTICS.CAPABILITY_GAP);
    assert.equal(kernel.assignment(task.id), null);

    kernel.setEmployeeEnabled({ employeeId: atlas.id, enabled: true });
    assert.equal(kernel.task(task.id).state, "RUNNING", "the committed enable woke the Work");
    assert.equal(kernel.assignment(task.id).employeeId, atlas.id);
  } finally {
    cleanup();
  }
});

test("creating an Employee re-evaluates Work, and a wake that finds nothing mutates nothing", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { company, work } = seedCompanyAndWork(kernel);
    const position = kernel.createPosition({
      companyId: company.id,
      title: "Operator",
      capabilities: ["capability.x"],
    });
    const task = kernel.createTask({
      workId: work.id,
      title: "Produce the analysis",
      intent: "One output the founder can act on",
      requiredCapabilities: ["capability.y"],
    });
    createContinuationDriver({ kernel });
    const headBefore = activityHead(kernel, work.id);

    // A new Employee who cannot do this Work's Task changes nothing about it,
    // even though the Company-wide wake runs.
    kernel.createEmployee({
      companyId: company.id,
      positionId: position.id,
      displayName: "Atlas",
    });
    assert.equal(activityHead(kernel, work.id), headBefore, "a wake is not a Work mutation");
    assert.equal(kernel.assignment(task.id), null);
    assert.equal(
      tracesOf(kernel, work.id).at(-1).diagnosticCode,
      CONTINUATION_DIAGNOSTICS.CAPABILITY_GAP,
      "the stop is recorded as observability, not as truth",
    );

    // The Employee who can do it unlocks the Work without it being touched.
    const capable = kernel.createPosition({
      companyId: company.id,
      title: "Analyst",
      capabilities: ["capability.y"],
    });
    const analyst = kernel.createEmployee({
      companyId: company.id,
      positionId: capable.id,
      displayName: "Iris",
    });
    assert.equal(kernel.task(task.id).state, "RUNNING");
    assert.equal(kernel.assignment(task.id).employeeId, analyst.id);
  } finally {
    cleanup();
  }
});

test("cross-Work availability wakes a Work whose own facts never changed", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { company, work } = seedCompanyAndWork(kernel);
    const atlas = seedEmployee(kernel, company.id, {
      displayName: "Atlas",
      capabilities: ["capability.x"],
    }).employee;

    const other = kernel.createWork({
      companyId: company.id,
      title: "Another line of work",
      intent: "One output the founder can act on",
    });
    const busyTask = kernel.createTask({
      workId: other.id,
      title: "Occupy the analyst",
      intent: "One output the founder can act on",
      requiredCapabilities: ["capability.x"],
    });
    kernel.assignTask({ taskId: busyTask.id, employeeId: atlas.id, reason: "fixture" });
    const busyRun = kernel.startWorkerRun({ taskId: busyTask.id });

    const task = kernel.createTask({
      workId: work.id,
      title: "Produce the analysis",
      intent: "One output the founder can act on",
      requiredCapabilities: ["capability.x"],
    });
    const driver = createContinuationDriver({ kernel });
    const headBefore = activityHead(kernel, work.id);
    const stopped = driver.driveWork(work.id);
    assert.equal(stopped.diagnostic.code, CONTINUATION_DIAGNOSTICS.NO_DISPATCHABLE_EMPLOYEE);
    assert.equal(activityHead(kernel, work.id), headBefore, "a blocked drive writes no Work fact");

    kernel.recordArtifact({
      taskId: busyTask.id,
      generation: busyRun.generation,
      workerRunId: busyRun.workerRun.id,
      kind: "document",
      title: "Something else",
      content: "done elsewhere\n",
    });
    kernel.completeWorkerRun({ taskId: busyTask.id, generation: busyRun.generation });

    // Work A's own Activity head and business rows did not change until the
    // committed run end made its continuation possible — that is the wake.
    assert.equal(
      kernel.assignment(task.id).employeeId,
      atlas.id,
      "the cross-Work wake re-evaluated and resumed this Work",
    );
    assert.equal(kernel.task(task.id).state, "RUNNING");
  } finally {
    cleanup();
  }
});

test("a Work blocked by contention is re-derived on every drive and parked nowhere", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { company, work } = seedCompanyAndWork(kernel);
    const atlas = seedEmployee(kernel, company.id, {
      displayName: "Atlas",
      capabilities: ["capability.x"],
    }).employee;
    const other = kernel.createWork({
      companyId: company.id,
      title: "Another line of work",
      intent: "One output the founder can act on",
    });
    const busy = kernel.createTask({
      workId: other.id,
      title: "Occupy the analyst",
      intent: "One output the founder can act on",
      requiredCapabilities: ["capability.x"],
    });
    kernel.assignTask({ taskId: busy.id, employeeId: atlas.id, reason: "fixture" });
    kernel.startWorkerRun({ taskId: busy.id });
    const waiting = kernel.createTask({
      workId: work.id,
      title: "Waiting line",
      intent: "One output the founder can act on",
      requiredCapabilities: ["capability.x"],
    });

    const driver = createContinuationDriver({ kernel });
    const headBefore = activityHead(kernel, work.id);
    const first = driver.driveWork(work.id);
    const second = driver.driveWork(work.id);

    assert.equal(first.diagnostic.code, CONTINUATION_DIAGNOSTICS.NO_DISPATCHABLE_EMPLOYEE);
    assert.equal(second.diagnostic.code, CONTINUATION_DIAGNOSTICS.NO_DISPATCHABLE_EMPLOYEE);
    assert.equal(activityHead(kernel, work.id), headBefore, "there is no WAIT object to park");
    assert.equal(kernel.assignment(waiting.id), null);
    assert.equal(
      tracesOf(kernel, work.id).length,
      second.steps + 2,
      "each drive is re-derived and recorded; nothing accumulates in the Runtime",
    );
  } finally {
    cleanup();
  }
});


test("Founder Attention and the Work projection never depend on a trace", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { company, work } = seedOperator(kernel);
    const driver = createContinuationDriver({ kernel });
    driver.driveWork(work.id);
    const before = kernel.workProjection(work.id);
    const attentionBefore = kernel.founderAttention({ companyId: company.id });

    // A deliberately misleading row: it claims a step the Runtime never took.
    kernel.recordContinuationTrace({
      companyId: company.id,
      workId: work.id,
      step: 99,
      triggerType: "WAKE",
      policyVersion: CONTINUATION_POLICY_VERSION,
      reasonCodes: ["FABRICATED"],
      diagnosticCode: null,
      actionCommand: "acceptWork",
      actionResult: "EXECUTED",
    });

    const after = kernel.workProjection(work.id);
    assert.deepEqual(after, before, "a trace explains history; it is never current truth");
    assert.deepEqual(kernel.founderAttention({ companyId: company.id }), attentionBefore);
    assert.equal(
      JSON.stringify(before).includes("continuation_traces"),
      false,
      "no projection field is derived from a trace",
    );
    assert.equal(
      Object.keys(before).some((key) => key.toLowerCase().includes("trace")),
      false,
      "and none is named like one",
    );
  } finally {
    cleanup();
  }
});

test("a trace write failure never invalidates a committed mutation", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { work } = seedOperator(kernel);
    const driver = createContinuationDriver({ kernel });
    const originalWrite = process.stderr.write;
    process.stderr.write = () => true;
    try {
      kernel.recordContinuationTrace = () => {
        throw new Error("trace storage is unavailable");
      };
      const summary = driver.driveWork(work.id);
      assert.equal(summary.steps, 3, "business truth committed anyway");
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.equal(kernel.tasks(work.id).length, 1);
    assert.equal(kernel.task(kernel.tasks(work.id)[0].id).state, "RUNNING");
    assert.deepEqual(tracesOf(kernel, work.id), [], "no trace row exists, and none was invented");
  } finally {
    cleanup();
  }
});

test("the step fuse bounds one drive and the next drive continues from truth", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { work, employee } = seedOperator(kernel);
    // Explicit-only: without the observer, the fuse is observable in isolation.
    const driver = createContinuationDriver({ kernel, observe: false });
    const first = driver.driveWork(work.id, { steps: 1 });
    assert.equal(first.stopped, "LIMIT");
    assert.equal(first.diagnostic.code, CONTINUATION_DIAGNOSTICS.CONTINUATION_LIMIT_REACHED);
    assert.equal(kernel.tasks(work.id).length, 1, "the materialization that fit did happen");
    assert.equal(kernel.assignment(kernel.tasks(work.id)[0].id), null);

    const second = driver.driveWork(work.id);
    assert.equal(second.steps, 2);
    assert.equal(kernel.assignment(kernel.tasks(work.id)[0].id).employeeId, employee.id);
    assert.ok(MAX_CONTINUATION_STEPS >= second.steps);
  } finally {
    cleanup();
  }
});

test("a proposer with nothing to say stops the Work instead of inventing one", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { work } = seedOperator(kernel);
    const driver = createContinuationDriver({
      kernel,
      proposer: { name: "empty", version: "test", propose: () => null },
    });
    const summary = driver.driveWork(work.id);
    assert.equal(summary.stopped, "SKIPPED");
    assert.equal(summary.diagnostic.code, CONTINUATION_DIAGNOSTICS.PLANNING_EXHAUSTED);
    assert.equal(kernel.tasks(work.id).length, 0, "PLANNING_EXHAUSTED is a stop, not a Task");
    assert.equal(
      tracesOf(kernel, work.id).at(-1).actionResult,
      "SKIPPED",
    );
  } finally {
    cleanup();
  }
});

test("the startup seam drives non-terminal Work once and leaves accepted Work alone", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { company, work, employee } = seedOperator(kernel);
    const accepted = kernel.createWork({
      companyId: company.id,
      title: "Already decided",
      intent: "Nothing left to continue",
    });
    const task = kernel.createTask({
      workId: accepted.id,
      title: "Produce the analysis",
      intent: "One output the founder can act on",
    });
    kernel.assignTask({ taskId: task.id, employeeId: employee.id, reason: "fixture" });
    const run = kernel.startWorkerRun({ taskId: task.id });
    kernel.recordArtifact({
      taskId: task.id,
      generation: run.generation,
      workerRunId: run.workerRun.id,
      kind: "document",
      title: "The output",
      content: "accepted text\n",
    });
    kernel.completeWorkerRun({ taskId: task.id, generation: run.generation });
    const projection = kernel.workProjection(accepted.id);
    kernel.acceptWork({
      workId: accepted.id,
      artifactId: projection.outcome.candidateArtifacts[0].id,
      artifactDigest: projection.outcome.candidateArtifacts[0].digest,
      basis: projection.decisionBasis,
    });
    const tracesBefore = tracesOf(kernel, accepted.id).length;
    const headBefore = activityHead(kernel, accepted.id);

    const driver = createContinuationDriver({ kernel });
    driver.driveAll({ triggerType: "STARTUP" });

    assert.equal(kernel.tasks(work.id).length, 1, "the open Work was activated");
    assert.equal(kernel.tasks(work.id)[0].state, "RUNNING");
    assert.equal(activityHead(kernel, accepted.id), headBefore, "an accepted Work is closed");
    assert.equal(
      tracesOf(kernel, accepted.id).length,
      tracesBefore,
      "and a boundary that says nothing to do is not traced",
    );
  } finally {
    cleanup();
  }
});

test("the driver is detachable and holds no truth after detaching", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { work } = seedOperator(kernel);
    const driver = createContinuationDriver({ kernel });
    driver.detach();
    assert.equal(kernel.continuationObserver, null);
    const summary = driver.driveWork(work.id, { triggerType: "EXPLICIT" });
    assert.equal(summary.steps, 3, "an explicit drive still works without the observer");
    assert.equal(
      tracesOf(kernel, work.id)[0].triggerType,
      "EXPLICIT",
      "the trigger seam is recorded, not silently normalised",
    );
    assert.ok(
      tracesOf(kernel, work.id).every((trace) => trace.policyVersion === CONTINUATION_POLICY_VERSION),
    );
  } finally {
    cleanup();
  }
});

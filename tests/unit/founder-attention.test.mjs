// Founder Attention: which Runtime conditions genuinely need the Founder, which
// only look like they do, and which actions may honestly be advertised.
// Contract: docs/contracts/founder-attention-acceptance-v0.md §11–§15.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ATTENTION_ACTIONS,
  ATTENTION_DIAGNOSTICS,
  ATTENTION_KINDS,
  EVENTS,
} from "../../packages/runtime/index.mjs";
import {
  openTempKernel,
  reviewArtifact,
  seedCompanyAndWork,
  seedEmployee,
  seedReviewTeam,
  seedStaffedTask,
  seedTask,
  seedTaskInReview,
  seedWorkReadyForDecision,
} from "../support/kernel.mjs";

const attentionFor = (kernel, companyId, workId) =>
  kernel.founderAttention({ companyId }).find((item) => item.workId === workId) ?? null;

const actionKinds = (item) => item.actions.map((action) => action.kind);

const diagnosticCodes = (projection) =>
  projection.founderAttention.diagnostics.map((entry) => entry.code);

test("reading Founder Attention changes nothing and remembers nothing", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedWorkReadyForDecision(kernel);
    const countsBefore = kernel.status().counts;
    const activityBefore = kernel.activity({ workId: flow.work.id, limit: 500 });

    const first = kernel.founderAttention({ companyId: flow.company.id });
    const repeated = kernel.founderAttention({ companyId: flow.company.id });

    assert.deepEqual(repeated, first, "the same truth yields the same projection");
    assert.deepEqual(kernel.status().counts, countsBefore, "no row is written by a read");
    assert.deepEqual(
      kernel.activity({ workId: flow.work.id, limit: 500 }),
      activityBefore,
      "and no event is appended by a read",
    );
    assert.equal(first.length, 1);
    assert.equal(first[0].id, `att:${ATTENTION_KINDS.DECISION_REQUIRED}:${flow.work.id}`);
    // There is no second lifecycle hiding in the item: nothing to mark, nothing
    // to dismiss, nothing to keep in sync with a stored Inbox row.
    for (const lifecycle of [
      "read",
      "unread",
      "seen",
      "done",
      "dismissed",
      "archived",
      "resolved",
      "status",
    ])
      assert.equal(lifecycle in first[0], false, `an attention item has no ${lifecycle} field`);
  } finally {
    cleanup();
  }
});

test("a ready outcome asks the Founder to decide, and the advertised action is the one that works", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedWorkReadyForDecision(kernel);
    const projection = kernel.workProjection(flow.work.id);
    const item = attentionFor(kernel, flow.company.id, flow.work.id);

    assert.equal(item.kind, ATTENTION_KINDS.DECISION_REQUIRED);
    assert.equal(item.decisionBasis, projection.decisionBasis);
    assert.deepEqual(
      item.evidence.candidateArtifacts.map((entry) => entry.id),
      [flow.artifact.id],
    );
    assert.deepEqual(item.actions, [
      {
        kind: ATTENTION_ACTIONS.ACCEPT,
        effect: "RESOLVES",
        artifactId: flow.artifact.id,
        artifactDigest: flow.artifact.contentDigest,
        basis: projection.decisionBasis,
      },
    ]);

    // Doing exactly what the item suggests is what closes it.
    const [advice] = item.actions;
    const accepted = kernel.acceptWork({
      workId: item.workId,
      artifactId: advice.artifactId,
      artifactDigest: advice.artifactDigest,
      basis: item.decisionBasis,
    });
    assert.equal(accepted.idempotent, false);
    assert.equal(accepted.work.outcome.state, "ACCEPTED");
    assert.equal(attentionFor(kernel, flow.company.id, flow.work.id), null);
    assert.deepEqual(kernel.founderAttention({ companyId: flow.company.id }), []);
  } finally {
    cleanup();
  }
});

test("an interrupted execution needs the Founder, because nothing resumes it", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const staffed = seedStaffedTask(kernel);
    kernel.startWorkerRun({ taskId: staffed.task.id });
    kernel.recover(); // what a restart does to an attempt that was still running
    assert.equal(kernel.task(staffed.task.id).state, "INTERRUPTED");

    const item = attentionFor(kernel, staffed.company.id, staffed.work.id);
    assert.equal(item.kind, ATTENTION_KINDS.EXECUTION_INTERRUPTED);
    // Two exits, both real: run it again, or abandon it. Nothing pretends the
    // Runtime will pick either one by itself.
    assert.deepEqual(actionKinds(item).sort(), [
      ATTENTION_ACTIONS.ABANDON_TASK,
      ATTENTION_ACTIONS.RESUME_EXECUTION,
    ]);
    assert.deepEqual(item.evidence.interruptedTasks, [
      {
        taskId: staffed.task.id,
        title: staffed.task.title,
        role: "execution",
        generation: 2,
        resumable: true,
      },
    ]);

    // The advertised exit genuinely works: a new generation, running again.
    const resumed = kernel.startWorkerRun({ taskId: staffed.task.id });
    assert.equal(resumed.task.state, "RUNNING");
    assert.equal(attentionFor(kernel, staffed.company.id, staffed.work.id), null);
  } finally {
    cleanup();
  }
});

test("an interrupted execution nobody is assigned to advertises an assignment, not autonomy", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { company, work } = seedCompanyAndWork(kernel);
    const task = kernel.createTask({
      workId: work.id,
      title: "Produce the analysis",
      intent: "One output the founder can act on",
      requiredCapabilities: ["capability.x"],
    });
    const { employee } = seedEmployee(kernel, company.id, {
      displayName: "Analyst A",
      capabilities: ["capability.x"],
    });
    kernel.startTask({ taskId: task.id });
    kernel.recover();

    const item = attentionFor(kernel, company.id, work.id);
    assert.equal(item.kind, ATTENTION_KINDS.EXECUTION_INTERRUPTED);
    assert.deepEqual(actionKinds(item).sort(), [
      ATTENTION_ACTIONS.ABANDON_TASK,
      ATTENTION_ACTIONS.ASSIGN_EMPLOYEE,
    ]);
    assert.equal(
      kernel.assignment(task.id),
      null,
      "an eligible Employee is not an assignment, and the Runtime makes none",
    );
    assert.ok(
      item.actions.every((entry) => ["RESOLVES", "ADVANCES"].includes(entry.effect)),
      "only actions with a proven effect are advertised",
    );

    // The advertised exit works, and claiming it clears the item.
    kernel.assignTask({ taskId: task.id, employeeId: employee.id, reason: "the founder decides" });
    kernel.startWorkerRun({ taskId: task.id });
    assert.equal(kernel.task(task.id).state, "RUNNING");
    assert.equal(attentionFor(kernel, company.id, work.id), null);
  } finally {
    cleanup();
  }
});

test("enabling a capable Employee is offered as an advance when it is the only honest action", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { company, work } = seedCompanyAndWork(kernel);
    const task = kernel.createTask({
      workId: work.id,
      title: "Produce the analysis",
      intent: "One output the founder can act on",
      requiredCapabilities: ["capability.x"],
    });
    const { employee } = seedEmployee(kernel, company.id, {
      displayName: "Analyst A",
      capabilities: ["capability.x"],
      enabled: false,
    });
    kernel.startTask({ taskId: task.id });
    kernel.recover();

    const item = attentionFor(kernel, company.id, work.id);
    const enable = item.actions.find(
      (entry) => entry.kind === ATTENTION_ACTIONS.ENABLE_EMPLOYEE,
    );
    assert.equal(enable.effect, "ADVANCES", "enabling alone does not resume anything");
    assert.ok(actionKinds(item).includes(ATTENTION_ACTIONS.ABANDON_TASK));

    kernel.setEmployeeEnabled({ employeeId: employee.id, enabled: true });
    assert.ok(
      !actionKinds(attentionFor(kernel, company.id, work.id)).includes(
        ATTENTION_ACTIONS.ENABLE_EMPLOYEE,
      ),
      "the projection follows the workforce without being stored anywhere",
    );
    assert.ok(
      actionKinds(attentionFor(kernel, company.id, work.id)).includes(
        ATTENTION_ACTIONS.ASSIGN_EMPLOYEE,
      ),
    );
  } finally {
    cleanup();
  }
});

test("a capability gap with no capable Employee leaves abandoning as the only honest exit", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { company, work } = seedCompanyAndWork(kernel);
    kernel.createTask({
      workId: work.id,
      title: "Produce the analysis",
      intent: "One output the founder can act on",
      requiredCapabilities: ["capability.nobody.has"],
    });
    const task = kernel.tasks(work.id).at(-1);
    kernel.startTask({ taskId: task.id });
    kernel.recover();

    const projection = kernel.workProjection(work.id);
    const item = attentionFor(kernel, company.id, work.id);
    assert.equal(item.kind, ATTENTION_KINDS.EXECUTION_INTERRUPTED);
    assert.deepEqual(actionKinds(item), [ATTENTION_ACTIONS.ABANDON_TASK]);
    assert.ok(diagnosticCodes(projection).includes(ATTENTION_DIAGNOSTICS.CAPABILITY_GAP));

    // The one advertised exit really does move the Work on.
    kernel.cancelTask({ taskId: task.id, note: "no one can do this" });
    assert.equal(
      kernel.workProjection(work.id).status,
      "CANCELLED",
      "abandoning the only line of work ends it; it does not finish it",
    );
    assert.equal(kernel.workProjection(work.id).collaboration.outstanding, false);
    assert.equal(attentionFor(kernel, company.id, work.id), null);
  } finally {
    cleanup();
  }
});

test("a Repair nobody can be assigned to needs the Founder", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedTaskInReview(kernel);
    const handoff = kernel.requestReview({ taskId: flow.task.id, generation: flow.generation });
    const requested = reviewArtifact(kernel, {
      reviewTaskId: handoff.reviewTask.id,
      reviewerId: flow.reviewer.id,
      verdict: "REQUEST_REVISION",
      summary: "Not supported by the evidence supplied.",
      findings: ["Add the downside case."],
    });
    // The producer can no longer take the repair back.
    kernel.setEmployeeEnabled({ employeeId: flow.producer.id, enabled: false });
    const backup = kernel.createEmployee({
      companyId: flow.company.id,
      positionId: flow.producerPosition.id,
      displayName: "Producer B",
    });
    const repair = kernel.createRepairTask({ reviewId: requested.id });
    assert.equal(repair.assignment, null, "no second-choice producer is picked silently");

    const item = attentionFor(kernel, flow.company.id, flow.work.id);
    assert.equal(item.kind, ATTENTION_KINDS.REPAIR_UNASSIGNABLE);
    assert.deepEqual(item.actions, [
      {
        kind: ATTENTION_ACTIONS.ASSIGN_EMPLOYEE,
        effect: "RESOLVES",
        taskId: repair.task.id,
      },
    ]);
    assert.deepEqual(item.evidence.unassignableRepairTasks[0].eligibleEmployeeIds, [backup.id]);

    // The advertised exit works, and claiming it clears the item.
    kernel.assignTask({ taskId: repair.task.id, employeeId: backup.id, reason: "founder" });
    assert.equal(attentionFor(kernel, flow.company.id, flow.work.id), null);
  } finally {
    cleanup();
  }
});

test("an unassignable Repair whose only capable Employee is disabled asks for enablement", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedTaskInReview(kernel);
    const handoff = kernel.requestReview({ taskId: flow.task.id, generation: flow.generation });
    const requested = reviewArtifact(kernel, {
      reviewTaskId: handoff.reviewTask.id,
      reviewerId: flow.reviewer.id,
      verdict: "REQUEST_REVISION",
      summary: "Not supported by the evidence supplied.",
      findings: ["Add the downside case."],
    });
    kernel.setEmployeeEnabled({ employeeId: flow.producer.id, enabled: false });
    const repair = kernel.createRepairTask({ reviewId: requested.id });
    assert.equal(repair.assignment, null);

    const item = attentionFor(kernel, flow.company.id, flow.work.id);
    assert.equal(item.kind, ATTENTION_KINDS.REPAIR_UNASSIGNABLE);
    assert.deepEqual(actionKinds(item), [ATTENTION_ACTIONS.ENABLE_EMPLOYEE]);
    assert.equal(
      actionKinds(item).includes(ATTENTION_ACTIONS.ABANDON_TASK),
      false,
      "a repair that is abandoned is a repair that never happens",
    );

    // Enabling brings the repair back to its deterministic owner: the producer
    // who wrote the artifact under review.
    kernel.setEmployeeEnabled({ employeeId: flow.producer.id, enabled: true });
    assert.deepEqual(actionKinds(attentionFor(kernel, flow.company.id, flow.work.id)), [
      ATTENTION_ACTIONS.ASSIGN_EMPLOYEE,
    ]);
    kernel.assignTask({
      taskId: repair.task.id,
      employeeId: flow.producer.id,
      reason: "the founder puts it back",
    });
    assert.equal(attentionFor(kernel, flow.company.id, flow.work.id), null);
  } finally {
    cleanup();
  }
});

test("REQUEST_REVISION with a deterministic Repair available asks the Founder for nothing", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedTaskInReview(kernel);
    const handoff = kernel.requestReview({ taskId: flow.task.id, generation: flow.generation });
    const requested = reviewArtifact(kernel, {
      reviewTaskId: handoff.reviewTask.id,
      reviewerId: flow.reviewer.id,
      verdict: "REQUEST_REVISION",
      summary: "Not supported by the evidence supplied.",
      findings: ["Add the downside case."],
    });

    // The Work is momentarily blocked by an ownership gap the Runtime itself
    // closes: createRepairTask is the deterministic continuation.
    assert.equal(kernel.workProjection(flow.work.id).status, "BLOCKED");
    assert.equal(
      attentionFor(kernel, flow.company.id, flow.work.id),
      null,
      "a Runtime-owned continuation is not Founder attention",
    );

    const repair = kernel.createRepairTask({ reviewId: requested.id });
    assert.equal(repair.assignment.employeeId, flow.producer.id, "the original producer owns it");
    assert.equal(attentionFor(kernel, flow.company.id, flow.work.id), null);
  } finally {
    cleanup();
  }
});

test("an interrupted review asks to be resumed, and never offers to be cancelled away", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedTaskInReview(kernel);
    const handoff = kernel.requestReview({ taskId: flow.task.id, generation: flow.generation });
    kernel.assignTask({
      taskId: handoff.reviewTask.id,
      employeeId: flow.reviewer.id,
      reason: "fixture",
    });
    kernel.startWorkerRun({ taskId: handoff.reviewTask.id });
    kernel.recover();
    assert.equal(kernel.task(handoff.reviewTask.id).state, "INTERRUPTED");

    const item = attentionFor(kernel, flow.company.id, flow.work.id);
    assert.equal(item.kind, ATTENTION_KINDS.EXECUTION_INTERRUPTED);
    assert.equal(item.evidence.interruptedTasks[0].role, "review");
    assert.deepEqual(actionKinds(item), [ATTENTION_ACTIONS.RESUME_EXECUTION]);
    assert.equal(
      actionKinds(item).includes(ATTENTION_ACTIONS.ABANDON_TASK),
      false,
      "cancelling a review leaves an obligation nothing can ever satisfy",
    );
  } finally {
    cleanup();
  }
});

test("cancelling a Repair is legal, but it is not an exit — so it is not offered as one", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedTaskInReview(kernel);
    const handoff = kernel.requestReview({ taskId: flow.task.id, generation: flow.generation });
    const requested = reviewArtifact(kernel, {
      reviewTaskId: handoff.reviewTask.id,
      reviewerId: flow.reviewer.id,
      verdict: "REQUEST_REVISION",
      summary: "Not supported by the evidence supplied.",
      findings: ["Add the downside case."],
    });
    kernel.setEmployeeEnabled({ employeeId: flow.producer.id, enabled: false });
    const backup = kernel.createEmployee({
      companyId: flow.company.id,
      positionId: flow.producerPosition.id,
      displayName: "Producer B",
    });
    const repair = kernel.createRepairTask({ reviewId: requested.id });

    assert.equal(
      actionKinds(attentionFor(kernel, flow.company.id, flow.work.id)).includes(
        ATTENTION_ACTIONS.ABANDON_TASK,
      ),
      false,
      "the Runtime never advertises an action it has not proven resolves anything",
    );

    // A Founder may still cancel it — the command is legal. It just is not a
    // resolution, and the projection does not pretend otherwise.
    kernel.cancelTask({ taskId: repair.task.id, note: "no one can do this" });
    const projection = kernel.workProjection(flow.work.id);
    assert.equal(projection.status, "BLOCKED");
    assert.equal(projection.founderAttention.item, null);
    assert.ok(diagnosticCodes(projection).includes(ATTENTION_DIAGNOSTICS.COLLABORATION_BLOCKED));
    assert.deepEqual(kernel.founderAttention({ companyId: flow.company.id }), []);

    // It does not quietly become assignable again either.
    assert.throws(
      () =>
        kernel.assignTask({ taskId: repair.task.id, employeeId: backup.id, reason: "too late" }),
      { code: "TASK_NOT_ASSIGNABLE" },
    );
  } finally {
    cleanup();
  }
});

test("interruption outranks an unassignable Repair, and each Work appears at most once", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedTaskInReview(kernel);
    const handoff = kernel.requestReview({ taskId: flow.task.id, generation: flow.generation });
    const requested = reviewArtifact(kernel, {
      reviewTaskId: handoff.reviewTask.id,
      reviewerId: flow.reviewer.id,
      verdict: "REQUEST_REVISION",
      summary: "Not supported by the evidence supplied.",
      findings: ["Add the downside case."],
    });
    kernel.setEmployeeEnabled({ employeeId: flow.producer.id, enabled: false });
    kernel.createRepairTask({ reviewId: requested.id });

    const second = kernel.createTask({
      workId: flow.work.id,
      title: "A second line of work",
      intent: "One output the founder can act on",
    });
    kernel.startTask({ taskId: second.id });
    kernel.recover();

    const items = kernel.founderAttention({ companyId: flow.company.id });
    assert.equal(items.length, 1, "one Work, one item");
    assert.equal(items[0].kind, ATTENTION_KINDS.EXECUTION_INTERRUPTED);
    assert.deepEqual(items[0].conditions.sort(), [
      ATTENTION_KINDS.EXECUTION_INTERRUPTED,
      ATTENTION_KINDS.REPAIR_UNASSIGNABLE,
    ]);
  } finally {
    cleanup();
  }
});

test("attention is ordered by what needs a human first", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const ready = seedWorkReadyForDecision(kernel);
    const stuck = kernel.createWork({
      companyId: ready.company.id,
      title: "An interrupted line of work",
      intent: "One output the founder can act on",
    });
    const task = kernel.createTask({
      workId: stuck.id,
      title: "Produce the analysis",
      intent: "One output the founder can act on",
    });
    kernel.startTask({ taskId: task.id });
    kernel.recover();

    const items = kernel.founderAttention({ companyId: ready.company.id });
    assert.deepEqual(
      items.map((item) => item.kind),
      [ATTENTION_KINDS.EXECUTION_INTERRUPTED, ATTENTION_KINDS.DECISION_REQUIRED],
    );
    assert.deepEqual(
      items.map((item) => item.workId),
      [stuck.id, ready.work.id],
    );
  } finally {
    cleanup();
  }
});

test("every mutation of a Work's accepted reality advances its basis, in the same transaction", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const team = seedReviewTeam(kernel);
    const workId = team.work.id;
    const step = (label, mutate) => {
      const before = kernel.store.workActivityHead(workId);
      const result = mutate();
      const after = kernel.store.workActivityHead(workId);
      assert.ok(
        after > before,
        `${label} must append Work-scoped Activity (basis ${before} → ${after})`,
      );
      return result;
    };

    const created = step("createTask", () =>
      seedTask(kernel, workId, { title: "Produce the analysis" }),
    );
    step("setTaskRequirements", () =>
      kernel.setTaskRequirements({
        taskId: created.id,
        requiredCapabilities: ["capability.produce"],
        reviewCapabilities: ["capability.review"],
      }),
    );
    step("assignTask", () =>
      kernel.assignTask({ taskId: created.id, employeeId: team.producer.id, reason: "fixture" }),
    );
    const started = step("startWorkerRun", () =>
      kernel.startWorkerRun({ taskId: created.id }),
    );
    step("checkpointTask", () =>
      kernel.checkpointTask({
        taskId: created.id,
        generation: started.generation,
        label: "half",
        state: { progress: 0.5 },
      }),
    );
    const artifact = step("recordArtifact", () =>
      kernel.recordArtifact({
        taskId: created.id,
        generation: started.generation,
        workerRunId: started.workerRun.id,
        kind: "document",
        title: "Draft analysis",
        content: "draft\n",
      }),
    );
    const handoff = step("requestReview", () =>
      kernel.requestReview({ taskId: created.id, generation: started.generation }),
    );
    step("assignTask (review)", () =>
      kernel.assignTask({
        taskId: handoff.reviewTask.id,
        employeeId: team.reviewer.id,
        reason: "fixture",
      }),
    );
    const reviewRun = step("startWorkerRun (review)", () =>
      kernel.startWorkerRun({ taskId: handoff.reviewTask.id }),
    );
    const review = step("submitReview", () =>
      kernel.submitReview({
        reviewTaskId: handoff.reviewTask.id,
        generation: reviewRun.generation,
        verdict: "REQUEST_REVISION",
        summary: "Not supported by the evidence supplied.",
        findings: ["Add the downside case."],
      }).review,
    );
    const repair = step("createRepairTask", () => kernel.createRepairTask({ reviewId: review.id }));
    const repairRun = step("startWorkerRun (repair)", () =>
      kernel.startWorkerRun({ taskId: repair.task.id }),
    );
    const replacement = step("recordArtifact (superseding)", () =>
      kernel.recordArtifact({
        taskId: repair.task.id,
        generation: repairRun.generation,
        workerRunId: repairRun.workerRun.id,
        supersedesArtifactId: artifact.id,
        kind: "document",
        title: "Draft analysis v2",
        content: "draft v2\n",
      }),
    );
    const secondHandoff = step("requestReview (repair)", () =>
      kernel.requestReview({ taskId: repair.task.id, generation: repairRun.generation }),
    );
    step("assignTask (second review)", () =>
      kernel.assignTask({
        taskId: secondHandoff.reviewTask.id,
        employeeId: team.reviewer.id,
        reason: "fixture",
      }),
    );
    const secondRun = step("startWorkerRun (second review)", () =>
      kernel.startWorkerRun({ taskId: secondHandoff.reviewTask.id }),
    );
    step("submitReview (pass)", () =>
      kernel.submitReview({
        reviewTaskId: secondHandoff.reviewTask.id,
        generation: secondRun.generation,
        verdict: "PASS",
        summary: "The recommendation now matches the evidence supplied.",
      }),
    );

    const basis = kernel.store.workActivityHead(workId);
    assert.equal(kernel.workProjection(workId).decisionBasis, basis);
    const accepted = step("acceptWork", () =>
      kernel.acceptWork({
        workId,
        artifactId: replacement.id,
        artifactDigest: replacement.contentDigest,
        basis,
      }),
    );
    assert.equal(accepted.work.outcome.state, "ACCEPTED");
    assert.equal(
      kernel.activity({ workId, limit: 500 }).at(-1).kind,
      EVENTS.WORK_ACCEPTED,
    );

    // Company-level workforce changes are deliberately outside the Work basis:
    // enabling an Employee changes who could do the work, not what the Work is.
    const headAfterAccept = kernel.store.workActivityHead(workId);
    kernel.setEmployeeEnabled({ employeeId: team.producer.id, enabled: false });
    kernel.setEmployeeEnabled({ employeeId: team.producer.id, enabled: true });
    kernel.createPosition({
      companyId: team.company.id,
      title: "Another Producer",
      capabilities: ["capability.produce"],
    });
    assert.equal(
      kernel.store.workActivityHead(workId),
      headAfterAccept,
      "the workforce is company scope, not Work truth",
    );
    assert.equal(kernel.status().counts.founderDecisions, 1);
  } finally {
    cleanup();
  }
});

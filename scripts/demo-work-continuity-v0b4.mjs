// Demonstration for Work Continuity v0B4 (contract §19).
//
// The last leg of the AI Workforce MVP is the one the Founder used to do by
// hand. Here the Runtime is the coordinator:
//
//   Founder creates the Company, assembles the team, and states one Work.
//   From that point the Runtime plans the initial Task, dispatches it, starts
//   the attempt, turns a REQUEST_REVISION into a Repair, re-dispatches the
//   repair, and hands the re-review to the reviewer.
//   The host plays the two Employees: it produces the artifact and submits the
//   judgment. It never chooses who works on what.
//   The Founder appears exactly once more, at the end, to ACCEPT.
//
// Three sections, all on the real HTTP runtime with the Continuation Driver
// installed (`FLOWCREDIT_COORDINATION=driver`):
//
//   1. Scenario 1 — one Work, produced, reviewed, accepted. 0/0.
//   2. Scenario 2 — a genuine REQUEST_REVISION → Repair → PASS, with a kill -9
//      in the middle. 0/0.
//   3. A cross-Work availability wake: one Work finishing frees the Employee
//      another Work was blocked on.
//
//   node scripts/demo-work-continuity-v0b4.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startRuntime } from "./lib/runtime-process.mjs";

const steps = [];
const report = (step, detail) => {
  steps.push(step);
  console.log(`${String(steps.length).padStart(2, " ")}. ${step} — ${detail}`);
};

// Every command this script issues is booked against exactly one role, so the
// counts at the end are a property of the code, not of a comment.
function makeLedger(getRuntime) {
  const tally = {
    founderTouches: 0,
    manualCoordination: 0,
    workerActions: 0,
  };
  const command = async (role, name, input) => {
    if (role === "founder") tally.founderTouches += 1;
    if (role === "coordinator") tally.manualCoordination += 1;
    if (role === "worker") tally.workerActions += 1;
    return getRuntime().command(name, input);
  };
  return { tally, command };
}

const taskOf = async (runtime, workId) => {
  const { tasks } = await runtime.json(`/works/${workId}/tasks`);
  assert.equal(tasks.length, 1, "this Work carries exactly one Task");
  return tasks[0];
};

const runningRunOf = async (runtime, taskId) => {
  const detail = await runtime.json(`/tasks/${taskId}`);
  assert.equal(detail.task.state, "RUNNING", `task ${taskId} should be running`);
  const run = detail.runs.find((entry) => entry.state === "RUNNING");
  assert.ok(run, `task ${taskId} should have a running attempt`);
  return { detail, run };
};

const attentionOf = async (runtime, companyId) =>
  (await runtime.json(`/companies/${companyId}/attention`)).attention;

let runtime = null;
const dirs = [];

async function openRuntime(dir) {
  const opened = await startRuntime({ dir, coordination: true });
  return opened;
}

try {
  console.log(`\n== Work Continuity v0B4 — the Runtime coordinates, the Founder decides ==\n`);
  assert.ok(process.version.startsWith("v24"), "Node 24 as declared in .nvmrc");

  // ---------------------------------------------------------------- Scenario 1
  {
    console.log(`-- Scenario 1: one Work, produced, reviewed, accepted --`);
    const dir = mkdtempSync(join(tmpdir(), "flowcredit-v0b4-s1-"));
    dirs.push(dir);
    runtime = await openRuntime(dir);
    const { tally, command } = makeLedger(() => runtime);

    const company = await command("founder", "createCompany", { name: "Northwind Studio" });
    const operator = await command("founder", "createPosition", {
      companyId: company.id,
      title: "Operator",
      capabilities: ["work.execute"],
    });
    const reviewer = await command("founder", "createPosition", {
      companyId: company.id,
      title: "Reviewer",
      capabilities: ["work.review"],
    });
    const atlas = await command("founder", "createEmployee", {
      companyId: company.id,
      positionId: operator.id,
      displayName: "Atlas",
    });
    const iris = await command("founder", "createEmployee", {
      companyId: company.id,
      positionId: reviewer.id,
      displayName: "Iris",
    });
    report(
      "Founder assembles the team",
      `Atlas → Operator [work.execute] · Iris → Reviewer [work.review]`,
    );

    // ---- the coordination window opens: the Founder states one Work ----
    const founderTouchesAtWorkCreation = tally.founderTouches;
    const work = await command("founder", "createWork", {
      companyId: company.id,
      title: "Evaluate market option A",
      intent: "The founder needs a defensible read before committing",
    });
    report("Founder states one Work", `"${work.title}" (nothing else is asked of the Founder)`);

    const task = await taskOf(runtime, work.id);
    const { detail, run } = await runningRunOf(runtime, task.id);
    assert.equal(
      detail.assignment.employeeId,
      atlas.id,
      "the Runtime dispatched the Task to the only qualified Employee",
    );
    report(
      "Runtime plans, dispatches and starts",
      `"${task.title}" → Atlas (run ${run.id.slice(0, 12)}… generation ${run.generation})`,
    );

    // The host plays Atlas: produce the output and hand it off.
    await command("worker", "recordArtifact", {
      taskId: task.id,
      generation: run.generation,
      workerRunId: run.id,
      kind: "document",
      title: "Market option A — read v1",
      content: "# Option A\n- upside: reachable in one quarter\n- risk: needs a partner\n",
    });
    await command("worker", "requestReview", { taskId: task.id, generation: run.generation });
    report("Atlas hands the output off", "the Runtime creates the Review Task by itself");

    const afterHandoff = await runtime.json(`/works/${work.id}`);
    const reviewTask = await runtime.json(
      `/tasks/${afterHandoff.collaboration.openReviewTaskId}`,
    );
    assert.equal(reviewTask.task.state, "RUNNING", "the Runtime already started the review");
    assert.equal(reviewTask.assignment.employeeId, iris.id);
    report(
      "Runtime dispatches the review",
      `→ Iris (run ${reviewTask.runs.at(-1).id.slice(0, 12)}…), no Founder involved`,
    );

    // The host plays Iris: judge the artifact.
    await command("worker", "submitReview", {
      reviewTaskId: reviewTask.task.id,
      generation: reviewTask.runs.at(-1).generation,
      verdict: "PASS",
      summary: "The read matches the evidence that was supplied.",
      findings: [],
    });

    const ready = await runtime.json(`/works/${work.id}`);
    assert.equal(ready.status, "READY_FOR_DECISION");
    assert.equal(ready.outcome.state, "READY");
    assert.equal(ready.collaboration.round, 1);
    const inbox = await attentionOf(runtime, company.id);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].kind, "DECISION_REQUIRED");
    report(
      "Work reaches READY_FOR_DECISION",
      `one outcome candidate · Inbox: DECISION_REQUIRED (basis ${ready.decisionBasis})`,
    );

    // ---- the coordination window closes: only now does the Founder return ----
    const window = {
      founder: tally.founderTouches - founderTouchesAtWorkCreation - 1, // minus CREATE_WORK itself
      coordination: tally.manualCoordination,
      worker: tally.workerActions,
    };
    assert.equal(window.founder, 0, "the Founder issued no command between CREATE_WORK and the decision");
    assert.equal(window.coordination, 0, "the host coordinated nothing");
    assert.equal(window.worker, 3, "the host only did the work: produce, hand off, judge");
    report(
      "Founder Extra Touch Count = 0 · Manual Coordination Count = 0",
      `${window.worker} worker actions by the host (produce, hand off, judge)`,
    );

    const candidate = inbox[0].actions[0];
    const accepted = await command("founder", "acceptWork", {
      workId: work.id,
      artifactId: candidate.artifactId,
      artifactDigest: candidate.artifactDigest,
      basis: inbox[0].decisionBasis,
    });
    assert.equal(accepted.decision.disposition, "ACCEPT");
    assert.equal(accepted.work.outcome.state, "ACCEPTED");
    assert.deepEqual(await attentionOf(runtime, company.id), []);
    report(
      "Founder ACCEPTs the outcome",
      `decision ${accepted.decision.id.slice(0, 12)}… · Inbox empty`,
    );
    console.log(
      `   Scenario 1 counters — Founder Extra Touch: 0, Manual Coordination: 0\n`,
    );

    await runtime.stop();
    runtime = null;
  }

  // ---------------------------------------------------------------- Scenario 2
  {
    console.log(`-- Scenario 2: a genuine REQUEST_REVISION → Repair → PASS, with a hard restart --`);
    const dir = mkdtempSync(join(tmpdir(), "flowcredit-v0b4-s2-"));
    dirs.push(dir);
    runtime = await openRuntime(dir);
    const ledger = makeLedger(() => runtime);

    const company = await ledger.command("founder", "createCompany", { name: "Northwind Studio" });
    const operator = await ledger.command("founder", "createPosition", {
      companyId: company.id,
      title: "Operator",
      capabilities: ["work.execute"],
    });
    const reviewer = await ledger.command("founder", "createPosition", {
      companyId: company.id,
      title: "Reviewer",
      capabilities: ["work.review"],
    });
    const atlas = await ledger.command("founder", "createEmployee", {
      companyId: company.id,
      positionId: operator.id,
      displayName: "Atlas",
    });
    await ledger.command("founder", "createEmployee", {
      companyId: company.id,
      positionId: reviewer.id,
      displayName: "Iris",
    });

    const founderTouchesAtWorkCreation = ledger.tally.founderTouches;
    const work = await ledger.command("founder", "createWork", {
      companyId: company.id,
      title: "Evaluate market option B",
      intent: "The founder needs a defensible read before committing",
    });
    report("Founder states one Work", `"${work.title}"`);

    const firstTask = await taskOf(runtime, work.id);
    const first = await runningRunOf(runtime, firstTask.id);
    assert.equal(first.detail.assignment.employeeId, atlas.id);
    const v1 = await ledger.command("worker", "recordArtifact", {
      taskId: firstTask.id,
      generation: first.run.generation,
      workerRunId: first.run.id,
      kind: "document",
      title: "Market option B — read v1",
      content: "# Option B\n- upside: cheap\n",
    });
    await ledger.command("worker", "requestReview", {
      taskId: firstTask.id,
      generation: first.run.generation,
    });
    report("Atlas produces v1", "the Runtime already dispatched the review to Iris");

    const firstHandoff = await runtime.json(`/works/${work.id}`);
    const firstReviewTask = await runtime.json(
      `/tasks/${firstHandoff.collaboration.openReviewTaskId}`,
    );
    await ledger.command("worker", "submitReview", {
      reviewTaskId: firstReviewTask.task.id,
      generation: firstReviewTask.runs.at(-1).generation,
      verdict: "REQUEST_REVISION",
      summary: "The recommendation is not supported by the evidence supplied.",
      findings: ["Add the downside case."],
    });
    report(
      "Iris requests a revision",
      "a genuine REQUEST_REVISION, on the exact artifact she was given",
    );

    // The Runtime turns the revision into a Repair and starts the producer on it.
    const afterRevision = await runtime.json(`/works/${work.id}`);
    assert.equal(afterRevision.collaboration.openRepairTaskId !== null, true);
    const repairTask = await runtime.json(
      `/tasks/${afterRevision.collaboration.openRepairTaskId}`,
    );
    assert.equal(repairTask.task.state, "RUNNING", "the Runtime started the repair by itself");
    assert.equal(
      repairTask.assignment.employeeId,
      atlas.id,
      "the repair went to the original producer, without the Founder",
    );
    assert.equal(repairTask.assignment.reason, "original_producer");
    report(
      "Runtime creates and starts the Repair",
      `"${repairTask.task.title}" → Atlas (reason: original_producer)`,
    );

    // A hard kill in the middle of the repair: the next process recovers the
    // attempt and the Driver continues the same Work.
    const beforeCrash = await runtime.json("/status");
    const { signal } = await runtime.crash();
    assert.equal(signal, "SIGKILL");
    runtime = null;
    report("kill -9 during the Repair", `worker run in flight: ${beforeCrash.tasksByState.RUNNING}`);

    // The host's ledger continues across the restart: a crash does not excuse a
    // coordination command.
    runtime = await openRuntime(dir);
    assert.match(runtime.output(), /recovered 1 interrupted execution/);
    const afterRestart = await runtime.json("/status");
    assert.equal(
      afterRestart.counts.tasks,
      3,
      "the execution Task, its completed Review Task, and the Repair Task",
    );
    assert.equal(afterRestart.counts.assignments, 3, "no duplicate Assignment was invented");
    assert.equal(afterRestart.tasksByState.RUNNING, 1, "the Repair continued in a new attempt");
    const resumedRepair = await runtime.json(`/tasks/${repairTask.task.id}`);
    assert.equal(resumedRepair.task.state, "RUNNING");
    assert.equal(resumedRepair.runs.length, 2, "one interrupted attempt, one continuation");
    report(
      "Runtime converges after the restart",
      `same Task, same Assignment, new attempt (generation ${resumedRepair.task.generation})`,
    );

    const repairRun = resumedRepair.runs.find((entry) => entry.state === "RUNNING");
    await ledger.command("worker", "recordArtifact", {
      taskId: repairTask.task.id,
      generation: repairRun.generation,
      workerRunId: repairRun.id,
      supersedesArtifactId: v1.id,
      kind: "document",
      title: "Market option B — read v2",
      content: "# Option B\n- upside: cheap\n- downside: the partner can walk away\n",
    });
    await ledger.command("worker", "requestReview", {
      taskId: repairTask.task.id,
      generation: repairRun.generation,
    });
    report("Atlas produces v2", "the replacement names the artifact it replaces");

    const secondHandoff = await runtime.json(`/works/${work.id}`);
    const secondReviewTask = await runtime.json(
      `/tasks/${secondHandoff.collaboration.openReviewTaskId}`,
    );
    assert.equal(secondReviewTask.task.state, "RUNNING");
    await ledger.command("worker", "submitReview", {
      reviewTaskId: secondReviewTask.task.id,
      generation: secondReviewTask.runs.at(-1).generation,
      verdict: "PASS",
      summary: "The recommendation now matches the evidence supplied.",
      findings: [],
    });

    const ready = await runtime.json(`/works/${work.id}`);
    assert.equal(ready.status, "READY_FOR_DECISION");
    assert.equal(ready.outcome.candidateArtifacts.length, 1, "v1 is superseded, not a second candidate");
    assert.equal(ready.collaboration.round, 2);
    report(
      "Work reaches READY_FOR_DECISION again",
      `round 2 · one candidate · Inbox: DECISION_REQUIRED`,
    );

    const window = {
      founder: ledger.tally.founderTouches - founderTouchesAtWorkCreation - 1,
      coordination: ledger.tally.manualCoordination,
      worker: ledger.tally.workerActions,
    };
    assert.equal(window.founder, 0);
    assert.equal(window.coordination, 0);
    assert.equal(window.worker, 6, "produce v1, hand off, judge, produce v2, hand off, judge");
    report(
      "Founder Extra Touch Count = 0 · Manual Coordination Count = 0",
      `${window.worker} worker actions, across a crash and a repair cycle`,
    );

    const inbox = await attentionOf(runtime, company.id);
    const candidate = inbox[0].actions[0];
    const accepted = await ledger.command("founder", "acceptWork", {
      workId: work.id,
      artifactId: candidate.artifactId,
      artifactDigest: candidate.artifactDigest,
      basis: inbox[0].decisionBasis,
    });
    assert.equal(accepted.work.outcome.state, "ACCEPTED");
    report("Founder ACCEPTs the repaired outcome", `${accepted.decision.id.slice(0, 12)}…`);
    console.log(
      `   Scenario 2 counters — Founder Extra Touch: 0, Manual Coordination: 0\n`,
    );

    await runtime.stop();
    runtime = null;
  }

  // ------------------------------------------------------- cross-Work wake
  {
    console.log(`-- Cross-Work availability wake --`);
    const dir = mkdtempSync(join(tmpdir(), "flowcredit-v0b4-s3-"));
    dirs.push(dir);
    runtime = await openRuntime(dir);
    const { command } = makeLedger(() => runtime);

    const company = await command("founder", "createCompany", { name: "Northwind Studio" });
    const operator = await command("founder", "createPosition", {
      companyId: company.id,
      title: "Operator",
      capabilities: ["work.execute"],
    });
    const atlas = await command("founder", "createEmployee", {
      companyId: company.id,
      positionId: operator.id,
      displayName: "Atlas",
    });

    const first = await command("founder", "createWork", {
      companyId: company.id,
      title: "The Work that owns the Operator",
      intent: "One output the founder can act on",
    });
    const firstTask = await taskOf(runtime, first.id);
    const firstRun = await runningRunOf(runtime, firstTask.id);

    const second = await command("founder", "createWork", {
      companyId: company.id,
      title: "The Work that has to wait",
      intent: "One output the founder can act on",
    });
    const waitingTask = await taskOf(runtime, second.id);
    assert.equal((await runtime.json(`/tasks/${waitingTask.id}`)).task.state, "OPEN");
    const blockedTraces = (await runtime.json(`/works/${second.id}/traces`)).traces;
    assert.equal(blockedTraces.at(-1).diagnosticCode, "NO_DISPATCHABLE_EMPLOYEE");
    report(
      "Work 2 is blocked on the same Employee",
      `NO_DISPATCHABLE_EMPLOYEE (eligible, busy — not a capability gap)`,
    );

    await command("worker", "recordArtifact", {
      taskId: firstTask.id,
      generation: firstRun.run.generation,
      workerRunId: firstRun.run.id,
      kind: "document",
      title: "The first output",
      content: "finished, freeing the operator\n",
    });
    await command("worker", "requestReview", {
      taskId: firstTask.id,
      generation: firstRun.run.generation,
    });

    const resumed = await runtime.json(`/tasks/${waitingTask.id}`);
    assert.equal(resumed.task.state, "RUNNING");
    assert.equal(resumed.assignment.employeeId, atlas.id);
    report(
      "One Work's run end wakes the other",
      `Work 2 resumed on Atlas without a single coordination command`,
    );

    await runtime.stop();
    runtime = null;
  }

  console.log(`\nAll three sections passed on the real runtime process.`);
  console.log(
    `Deterministic Workforce Coordination Closure = PASS (deterministic proposer, no model calls)`,
  );
} finally {
  if (runtime) await runtime.stop().catch(() => {});
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
}

// Harness Slice 1.1 — bounded autonomous WorkerRun retries.
// Contract: docs/contracts/worker-harness-v0.md §18–§19.
//
// The autonomous attempt budget is derived from durable WorkerRun history:
// three attempts per Task, no stored counter, no Task state, no trace reading.
// When it is spent the Driver stops and the Founder decides.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ATTENTION_ACTIONS,
  ATTENTION_DIAGNOSTICS,
  ATTENTION_KINDS,
  CONTINUATION_DIAGNOSTICS,
  MAX_AUTONOMOUS_ATTEMPTS_PER_TASK,
  TASK_STATES,
  createContinuationDriver,
} from "../../packages/runtime/index.mjs";
import {
  openTempKernel,
  reopenKernel,
  seedReviewTeam,
  seedStaffedTask,
  seedTaskInReview,
  startReviewRun,
} from "../support/kernel.mjs";

function openWorkflow(kernel, { review = false } = {}) {
  if (!review) {
    const staffed = seedStaffedTask(kernel);
    const started = kernel.startWorkerRun({ taskId: staffed.task.id });
    return { work: staffed.work, task: staffed.task, run: started.workerRun, generation: started.generation };
  }
  const flow = seedTaskInReview(kernel);
  const handoff = kernel.requestReview({ taskId: flow.task.id, generation: flow.generation });
  const started = startReviewRun(kernel, { reviewTaskId: handoff.reviewTask.id, reviewerId: flow.reviewer.id });
  return {
    work: flow.work,
    task: handoff.reviewTask,
    run: started.workerRun,
    generation: started.generation,
  };
}

// The one interruption primitive the WorkerHost uses when an attempt dies.
function killLatestAttempt(kernel, taskId, reason = "WORKER_TIMEOUT") {
  const run = kernel.workerRuns({ taskId }).at(-1);
  kernel.interruptWorkerRun({
    workerRunId: run.id,
    generation: run.generation,
    reason,
  });
  return run;
}

test("WORKER_EXECUTION_FAILED uses the same three-attempt continuation and Founder Attention boundary", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = openWorkflow(kernel);
    const driver = createContinuationDriver({ kernel, observe: false });
    for (let attempt = 0; attempt < MAX_AUTONOMOUS_ATTEMPTS_PER_TASK; attempt += 1) {
      killLatestAttempt(kernel, flow.task.id, "WORKER_EXECUTION_FAILED");
      driver.driveWork(flow.work.id, { triggerType: "EXPLICIT" });
    }
    const runs = kernel.workerRuns({ taskId: flow.task.id });
    assert.equal(runs.length, 3);
    assert.ok(runs.every((run) => run.endReason === "WORKER_EXECUTION_FAILED"));
    assert.equal(kernel.task(flow.task.id).state, "INTERRUPTED");
    assert.equal(kernel.workProjection(flow.work.id).founderAttention.item.kind, ATTENTION_KINDS.EXECUTION_INTERRUPTED);
    assert.equal(kernel.workProjection(flow.work.id).founderAttention.item.evidence.interruptedTasks[0].automaticRetryExhausted, true);
    driver.driveWork(flow.work.id, { triggerType: "EXPLICIT" });
    assert.equal(kernel.workerRuns({ taskId: flow.task.id }).length, 3, "no fourth autonomous attempt");
  } finally {
    kernel.close();
    cleanup();
  }
});

test("the frozen budget is one initial attempt plus two automatic retries", () => {
  assert.equal(MAX_AUTONOMOUS_ATTEMPTS_PER_TASK, 3);
});

test("an interrupted Task is retried automatically until the budget is spent, then the Driver stops", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = openWorkflow(kernel);
    const driver = createContinuationDriver({ kernel, observe: false });

    assert.equal(kernel.task(flow.task.id).state, "RUNNING");
    killLatestAttempt(kernel, flow.task.id).id;
    assert.equal(kernel.task(flow.task.id).state, "INTERRUPTED");

    // Attempt 1 INTERRUPTED → attempt 2 starts.
    const second = driver.driveWork(flow.work.id, { triggerType: "EXPLICIT" });
    assert.equal(second.steps, 1, "one deterministic restart, nothing more");
    assert.equal(kernel.workerRuns({ taskId: flow.task.id }).length, 2);

    // Attempt 2 INTERRUPTED → attempt 3 starts.
    killLatestAttempt(kernel, flow.task.id);
    const third = driver.driveWork(flow.work.id, { triggerType: "EXPLICIT" });
    assert.equal(third.steps, 1);
    assert.equal(kernel.workerRuns({ taskId: flow.task.id }).length, 3);

    // Attempt 3 INTERRUPTED → no attempt 4, and the reason is explicit.
    killLatestAttempt(kernel, flow.task.id);
    const stopped = driver.driveWork(flow.work.id, { triggerType: "EXPLICIT" });
    assert.equal(stopped.boundary, "INTERRUPTED");
    assert.equal(stopped.stopped, "DIAGNOSTIC");
    assert.equal(stopped.diagnostic.code, CONTINUATION_DIAGNOSTICS.AUTO_RETRY_EXHAUSTED);
    assert.equal(stopped.diagnostic.evidence.attempts, 3);
    assert.equal(stopped.diagnostic.evidence.maxAutonomousAttempts, 3);
    assert.equal(kernel.workerRuns({ taskId: flow.task.id }).length, 3, "no attempt 4");
    assert.equal(kernel.task(flow.task.id).state, "INTERRUPTED");

    // Driving again changes nothing: stopping is not a one-off.
    const again = driver.driveWork(flow.work.id, { triggerType: "EXPLICIT" });
    assert.equal(again.diagnostic.code, CONTINUATION_DIAGNOSTICS.AUTO_RETRY_EXHAUSTED);
    assert.equal(kernel.workerRuns({ taskId: flow.task.id }).length, 3);
  } finally {
    cleanup();
  }
});

test("exhaustion reaches the Founder as a decision, and the advertised action is the one that works", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = openWorkflow(kernel);
    const driver = createContinuationDriver({ kernel, observe: false });
    for (let attempt = 0; attempt < MAX_AUTONOMOUS_ATTEMPTS_PER_TASK; attempt += 1) {
      killLatestAttempt(kernel, flow.task.id);
      driver.driveWork(flow.work.id, { triggerType: "EXPLICIT" });
    }

    const projection = kernel.workProjection(flow.work.id);
    assert.equal(projection.founderAttention.item.kind, ATTENTION_KINDS.EXECUTION_INTERRUPTED);
    assert.ok(projection.founderAttention.conditions.includes(ATTENTION_DIAGNOSTICS.AUTO_RETRY_EXHAUSTED));
    assert.ok(
      projection.founderAttention.diagnostics.some(
        (entry) => entry.code === ATTENTION_DIAGNOSTICS.AUTO_RETRY_EXHAUSTED,
      ),
    );
    const item = projection.founderAttention.item;
    assert.deepEqual(
      item.actions.map((entry) => entry.kind).sort(),
      [ATTENTION_ACTIONS.ABANDON_TASK, ATTENTION_ACTIONS.RESUME_EXECUTION],
    );
    const [resume] = item.actions.filter((entry) => entry.kind === ATTENTION_ACTIONS.RESUME_EXECUTION);
    assert.equal(resume.effect, "RESOLVES", "an explicit resume really does clear the condition");
    const [interrupted] = item.evidence.interruptedTasks;
    assert.equal(interrupted.attempts, 3);
    assert.equal(interrupted.automaticRetryExhausted, true);
    assert.equal(interrupted.resumeWithoutFounder, false);

    // The advisory surface and the command agree: an explicit resume is legal.
    const resumed = kernel.startWorkerRun({ taskId: flow.task.id });
    assert.equal(resumed.task.state, "RUNNING");
    assert.equal(kernel.workProjection(flow.work.id).founderAttention.item, null);
  } finally {
    cleanup();
  }
});

test("the budget adds no Task state and stores no counter", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = openWorkflow(kernel);
    const driver = createContinuationDriver({ kernel, observe: false });
    for (let attempt = 0; attempt < MAX_AUTONOMOUS_ATTEMPTS_PER_TASK; attempt += 1) {
      killLatestAttempt(kernel, flow.task.id);
      driver.driveWork(flow.work.id, { triggerType: "EXPLICIT" });
    }

    assert.deepEqual(Object.keys(TASK_STATES).sort(), ["CANCELLED", "COMPLETED", "INTERRUPTED", "OPEN", "RUNNING"]);
    const task = kernel.task(flow.task.id);
    for (const invented of ["retryCount", "attempts", "attemptBudget", "exhausted"])
      assert.equal(invented in task, false, `a Task never carries ${invented}`);
    const counts = kernel.status().counts;
    assert.equal(Object.keys(counts).some((key) => /retry|attempt/i.test(key)), false);
    assert.equal(kernel.workerRuns({ taskId: flow.task.id }).length, 3, "the history is the counter");
  } finally {
    cleanup();
  }
});

test("the spent budget survives a restart, because it is derived from durable history", () => {
  const { kernel, cleanup, dir } = openTempKernel();
  try {
    const flow = openWorkflow(kernel);
    const driver = createContinuationDriver({ kernel, observe: false });
    for (let attempt = 0; attempt < MAX_AUTONOMOUS_ATTEMPTS_PER_TASK; attempt += 1) {
      killLatestAttempt(kernel, flow.task.id);
      driver.driveWork(flow.work.id, { triggerType: "EXPLICIT" });
    }
    assert.equal(kernel.workerRuns({ taskId: flow.task.id }).length, 3);
    kernel.close();

    const reopened = reopenKernel(dir);
    const restarted = createContinuationDriver({ kernel: reopened, observe: false });
    const stopped = restarted.driveWork(flow.work.id, { triggerType: "STARTUP" });
    assert.equal(stopped.diagnostic.code, CONTINUATION_DIAGNOSTICS.AUTO_RETRY_EXHAUSTED);
    assert.equal(reopened.workerRuns({ taskId: flow.task.id }).length, 3);
    assert.equal(reopened.workProjection(flow.work.id).founderAttention.item.kind, ATTENTION_KINDS.EXECUTION_INTERRUPTED);
    reopened.close();
  } finally {
    cleanup();
  }
});

test("a manual attempt after exhaustion is legal, and its failure does not reopen automatic retrying", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = openWorkflow(kernel);
    const driver = createContinuationDriver({ kernel, observe: false });
    for (let attempt = 0; attempt < MAX_AUTONOMOUS_ATTEMPTS_PER_TASK; attempt += 1) {
      killLatestAttempt(kernel, flow.task.id);
      driver.driveWork(flow.work.id, { triggerType: "EXPLICIT" });
    }

    // The Founder's explicit attempt goes through the ordinary command, and it
    // does not erase the history that made the Runtime stop.
    kernel.startWorkerRun({ taskId: flow.task.id });
    assert.equal(kernel.workerRuns({ taskId: flow.task.id }).length, 4);
    killLatestAttempt(kernel, flow.task.id);

    const stopped = driver.driveWork(flow.work.id, { triggerType: "EXPLICIT" });
    assert.equal(stopped.diagnostic.code, CONTINUATION_DIAGNOSTICS.AUTO_RETRY_EXHAUSTED);
    assert.equal(kernel.workerRuns({ taskId: flow.task.id }).length, 4, "no attempt 5");
    const projection = kernel.workProjection(flow.work.id);
    assert.equal(projection.founderAttention.item.evidence.interruptedTasks[0].attempts, 4);
  } finally {
    cleanup();
  }
});

test("Review attempts obey the same bounded budget", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = openWorkflow(kernel, { review: true });
    const driver = createContinuationDriver({ kernel, observe: false });
    for (let attempt = 0; attempt < MAX_AUTONOMOUS_ATTEMPTS_PER_TASK; attempt += 1) {
      killLatestAttempt(kernel, flow.task.id);
      driver.driveWork(flow.work.id, { triggerType: "EXPLICIT" });
    }
    assert.equal(kernel.workerRuns({ taskId: flow.task.id }).length, 3);
    const projection = kernel.workProjection(flow.work.id);
    assert.equal(projection.founderAttention.item.kind, ATTENTION_KINDS.EXECUTION_INTERRUPTED);
    const [interrupted] = projection.founderAttention.item.evidence.interruptedTasks;
    assert.equal(interrupted.role, "review");
    assert.equal(interrupted.automaticRetryExhausted, true);
    assert.equal(
      projection.founderAttention.item.actions.some(
        (entry) => entry.kind === ATTENTION_ACTIONS.ABANDON_TASK,
      ),
      false,
      "a Review Task is never advertised as abandonable",
    );
    // Reviewing is the same bounded policy, and the Reviewer is still reachable
    // by an explicit Founder resume.
    const resumed = kernel.startWorkerRun({ taskId: flow.task.id });
    assert.equal(resumed.task.state, "RUNNING");
  } finally {
    cleanup();
  }
});

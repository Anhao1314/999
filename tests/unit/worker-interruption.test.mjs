// H0.1 — external Worker interruption: one Runtime seam, one interruption
// semantics. The Worker host reports that the current attempt can no longer
// continue; the Runtime records it through the same primitive startup recovery
// uses and nothing else.
import test from "node:test";
import assert from "node:assert/strict";
import { createContinuationDriver } from "../../packages/runtime/driver.mjs";
import { openTempKernel, reopenKernel, seedStaffedTask } from "../support/kernel.mjs";

const REASON = "WORKER_TIMEOUT";

function seedRunningAttempt(kernel) {
  const seeded = seedStaffedTask(kernel);
  const started = kernel.startWorkerRun({ taskId: seeded.task.id });
  return { ...seeded, run: started.workerRun, generation: started.generation };
}

const eventsOf = (kernel, taskId, kind) =>
  kernel.activity({ taskId, limit: 200 }).filter((entry) => entry.kind === kind);
const activityCount = (kernel, taskId) => kernel.activity({ taskId, limit: 200 }).length;

test("a RUNNING attempt can be interrupted by its Worker host", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { task, run, generation, employee } = seedRunningAttempt(kernel);
    const result = kernel.interruptWorkerRun({ workerRunId: run.id, generation, reason: REASON });
    assert.equal(result.interrupted, true);
    assert.equal(result.alreadyInterrupted, false);
    assert.equal(result.workerRun.state, "INTERRUPTED");
    assert.equal(result.workerRun.endReason, REASON);
    assert.equal(result.task.state, "INTERRUPTED");
    assert.equal(kernel.workerRun(run.id).state, "INTERRUPTED");
    assert.equal(kernel.task(task.id).state, "INTERRUPTED");
    assert.equal(
      kernel.employee(employee.id).availability,
      "AVAILABLE",
      "an interrupted attempt frees the Employee",
    );
  } finally {
    cleanup();
  }
});

test("Task and WorkerRun transition together, or neither does", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { task, run, generation } = seedRunningAttempt(kernel);
    assert.throws(
      () => kernel.interruptWorkerRun({ workerRunId: run.id, generation: generation + 7, reason: REASON }),
      { code: "STALE_GENERATION" },
    );
    assert.equal(kernel.workerRun(run.id).state, "RUNNING", "a refusal writes nothing");
    assert.equal(kernel.task(task.id).state, "RUNNING", "not even half of the pair");
    assert.equal(eventsOf(kernel, task.id, "task.interrupted").length, 0);

    kernel.interruptWorkerRun({ workerRunId: run.id, generation, reason: REASON });
    assert.equal(kernel.workerRun(run.id).state, "INTERRUPTED");
    assert.equal(kernel.task(task.id).state, "INTERRUPTED");
    assert.equal(eventsOf(kernel, task.id, "task.interrupted").length, 1);
    assert.equal(eventsOf(kernel, task.id, "WORKER_RUN_INTERRUPTED").length, 1);
  } finally {
    cleanup();
  }
});

test("the Task generation is fenced exactly like startup recovery", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { task, run, generation } = seedRunningAttempt(kernel);
    kernel.interruptWorkerRun({ workerRunId: run.id, generation, reason: REASON });
    assert.equal(kernel.task(task.id).generation, generation + 1, "the Task advances one generation");
    assert.equal(kernel.workerRun(run.id).generation, generation, "the attempt keeps its own generation");
  } finally {
    cleanup();
  }
});

test("interruption Activity matches startup recovery semantics", () => {
  const external = openTempKernel();
  const recovery = openTempKernel();
  try {
    const ext = seedRunningAttempt(external.kernel);
    external.kernel.interruptWorkerRun({
      workerRunId: ext.run.id,
      generation: ext.generation,
      reason: REASON,
    });
    const extTaskEvent = eventsOf(external.kernel, ext.task.id, "task.interrupted")[0];
    const extRunEvent = eventsOf(external.kernel, ext.task.id, "WORKER_RUN_INTERRUPTED")[0];

    const rec = seedRunningAttempt(recovery.kernel);
    const recGenerationBefore = rec.generation;
    recovery.kernel.close();
    const reopened = reopenKernel(recovery.dir);
    try {
      const recTaskEvent = eventsOf(reopened, rec.task.id, "task.interrupted")[0];
      const recRunEvent = eventsOf(reopened, rec.task.id, "WORKER_RUN_INTERRUPTED")[0];

      assert.equal(extTaskEvent.kind, recTaskEvent.kind);
      assert.equal(extRunEvent.kind, recRunEvent.kind);
      assert.deepEqual(
        Object.keys(extTaskEvent.detail).sort(),
        Object.keys(recTaskEvent.detail).sort(),
        "the same Activity facts, from either interruption path",
      );
      assert.deepEqual(Object.keys(extRunEvent.detail).sort(), Object.keys(recRunEvent.detail).sort());
      assert.equal(extTaskEvent.detail.interruptedGeneration, recTaskEvent.detail.interruptedGeneration);
      assert.equal(extTaskEvent.detail.interruptedGeneration, recGenerationBefore);
      assert.equal(extTaskEvent.detail.automaticRetry, false);
      assert.equal(recTaskEvent.detail.automaticRetry, false);
      assert.equal(extTaskEvent.detail.reason, REASON);
      assert.equal(recTaskEvent.detail.reason, "PROCESS_INTERRUPTED");
      assert.equal(extRunEvent.detail.workerRunId, ext.run.id);
      assert.equal(recRunEvent.detail.workerRunId, rec.run.id);
      assert.equal(reopened.task(rec.task.id).generation, recGenerationBefore + 1);
    } finally {
      reopened.close();
    }
  } finally {
    external.cleanup();
    recovery.cleanup();
  }
});

test("a wrong generation is refused and changes nothing", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { task, run, generation } = seedRunningAttempt(kernel);
    const before = activityCount(kernel, task.id);
    assert.throws(
      () => kernel.interruptWorkerRun({ workerRunId: run.id, generation: generation + 1, reason: REASON }),
      { code: "STALE_GENERATION" },
    );
    assert.equal(kernel.workerRun(run.id).state, "RUNNING");
    assert.equal(kernel.task(task.id).state, "RUNNING");
    assert.equal(kernel.task(task.id).generation, generation);
    assert.equal(activityCount(kernel, task.id), before);
  } finally {
    cleanup();
  }
});

test("only the frozen interruption reasons are accepted", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { task, run, generation } = seedRunningAttempt(kernel);
    for (const reason of ["FOUNDER_CANCELLED", "TASK_ABANDONED", "WORKER_SUCCEEDED", undefined]) {
      assert.throws(
        () => kernel.interruptWorkerRun({ workerRunId: run.id, generation, reason }),
        { code: "INVALID_INPUT" },
        `reason ${String(reason)} must be refused`,
      );
    }
    assert.equal(kernel.workerRun(run.id).state, "RUNNING");
    assert.equal(kernel.task(task.id).state, "RUNNING");
  } finally {
    cleanup();
  }
});

test("a completed attempt is never overwritten", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { task, run, generation } = seedRunningAttempt(kernel);
    kernel.recordArtifact({
      taskId: task.id,
      generation,
      workerRunId: run.id,
      kind: "document",
      title: "The output",
      content: "done\n",
    });
    kernel.completeWorkerRun({ taskId: task.id, generation });
    const before = activityCount(kernel, task.id);
    assert.throws(
      () => kernel.interruptWorkerRun({ workerRunId: run.id, generation, reason: REASON }),
      { code: "INVALID_TRANSITION" },
    );
    assert.equal(kernel.workerRun(run.id).state, "COMPLETED");
    assert.equal(kernel.workerRun(run.id).endReason, "WORK_COMPLETED");
    assert.equal(kernel.task(task.id).state, "COMPLETED");
    assert.equal(activityCount(kernel, task.id), before, "no interruption facts are written");
  } finally {
    cleanup();
  }
});

test("an identical repeated interruption is benign and writes no duplicate Activity", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { task, run, generation } = seedRunningAttempt(kernel);
    kernel.interruptWorkerRun({ workerRunId: run.id, generation, reason: REASON });
    const before = activityCount(kernel, task.id);
    const second = kernel.interruptWorkerRun({ workerRunId: run.id, generation, reason: REASON });
    assert.equal(second.alreadyInterrupted, true);
    assert.equal(second.interrupted, false);
    assert.equal(second.workerRun.state, "INTERRUPTED");
    assert.equal(activityCount(kernel, task.id), before);
    assert.equal(eventsOf(kernel, task.id, "task.interrupted").length, 1);
    assert.equal(eventsOf(kernel, task.id, "WORKER_RUN_INTERRUPTED").length, 1);
  } finally {
    cleanup();
  }
});

test("an unknown WorkerRun is refused", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    seedRunningAttempt(kernel);
    assert.throws(
      () => kernel.interruptWorkerRun({ workerRunId: "run_missing", generation: 1, reason: REASON }),
      { code: "WORKER_RUN_NOT_FOUND" },
    );
  } finally {
    cleanup();
  }
});

test("an Artifact from the interrupted generation is rejected", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { task, run, generation } = seedRunningAttempt(kernel);
    kernel.interruptWorkerRun({ workerRunId: run.id, generation, reason: REASON });
    assert.throws(
      () =>
        kernel.recordArtifact({
          taskId: task.id,
          generation,
          workerRunId: run.id,
          kind: "document",
          title: "Late output",
          content: "late\n",
        }),
      { code: "STALE_GENERATION" },
    );
    assert.equal(kernel.artifacts(task.id).length, 0);
  } finally {
    cleanup();
  }
});

test("a Checkpoint from the interrupted generation is rejected", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { task, run, generation } = seedRunningAttempt(kernel);
    kernel.interruptWorkerRun({ workerRunId: run.id, generation, reason: REASON });
    assert.throws(
      () => kernel.checkpointTask({ taskId: task.id, generation, label: "late", state: {} }),
      { code: "STALE_GENERATION" },
    );
    assert.equal(kernel.taskDetail(task.id).checkpoints.length, 0);
  } finally {
    cleanup();
  }
});

test("a completion from the interrupted generation is rejected", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { task, run, generation } = seedRunningAttempt(kernel);
    kernel.interruptWorkerRun({ workerRunId: run.id, generation, reason: REASON });
    assert.throws(() => kernel.completeWorkerRun({ taskId: task.id, generation }), {
      code: "STALE_GENERATION",
    });
    assert.equal(kernel.workerRun(run.id).state, "INTERRUPTED");
    assert.equal(kernel.task(task.id).state, "INTERRUPTED");
  } finally {
    cleanup();
  }
});

test("the continuation wake observes committed interruption truth", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { task, run, generation } = seedRunningAttempt(kernel);
    const observed = [];
    kernel.setContinuationObserver((signal) => {
      observed.push({
        cause: signal.cause,
        taskState: kernel.task(task.id).state,
        runState: kernel.workerRun(run.id).state,
      });
    });
    try {
      kernel.interruptWorkerRun({ workerRunId: run.id, generation, reason: REASON });
    } finally {
      kernel.setContinuationObserver(null);
    }
    assert.ok(observed.length >= 1, "the post-commit seam published at least one signal");
    assert.ok(observed.some((entry) => entry.cause === "WORKER_RUN_ENDED"));
    for (const entry of observed) {
      assert.equal(entry.taskState, "INTERRUPTED", "the wake never sees pre-commit state");
      assert.equal(entry.runState, "INTERRUPTED");
    }
  } finally {
    cleanup();
  }
});

test("continuation safely starts a new attempt from the interrupted truth", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const driver = createContinuationDriver({ kernel });
    try {
      const { task, run, generation } = seedRunningAttempt(kernel);
      kernel.interruptWorkerRun({ workerRunId: run.id, generation, reason: REASON });
      const runs = kernel.workerRuns({ taskId: task.id });
      assert.equal(runs.length, 2, "the existing interrupted-execution policy resumed the Task");
      const resumed = runs.find((entry) => entry.id !== run.id);
      assert.equal(resumed.state, "RUNNING");
      assert.ok(resumed.generation > run.generation, "a new attempt gets a new generation");
      assert.equal(kernel.task(task.id).state, "RUNNING");
      assert.equal(kernel.workerRun(run.id).state, "INTERRUPTED", "the old attempt stays interrupted");
    } finally {
      driver.detach();
    }
  } finally {
    cleanup();
  }
});

test("interruption is an execution report, not Founder authority", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { work, task, run, generation } = seedRunningAttempt(kernel);
    const tasksBefore = kernel.tasks(work.id).length;
    kernel.interruptWorkerRun({ workerRunId: run.id, generation, reason: REASON });
    const projection = kernel.workProjection(work.id);
    assert.equal(projection.outcome.accepted, null, "no Founder Decision is created");
    assert.equal(kernel.reviews({ workId: work.id }).length, 0, "no Review is created");
    assert.equal(kernel.repairBindings({ workId: work.id }).length, 0, "no Repair is created");
    assert.equal(kernel.tasks(work.id).length, tasksBefore, "no Task is created");
    assert.equal(kernel.workerRuns({ taskId: task.id }).length, 1, "no second attempt is invented here");
    assert.notEqual(projection.status, "CANCELLED");
    assert.notEqual(projection.status, "ACCEPTED");
  } finally {
    cleanup();
  }
});

test("startup recovery still interrupts orphaned attempts without the command", () => {
  const { dir, kernel, cleanup } = openTempKernel();
  try {
    const { task, run, generation } = seedRunningAttempt(kernel);
    kernel.close();
    const reopened = reopenKernel(dir);
    try {
      assert.equal(reopened.recovery.count, 1);
      assert.equal(reopened.workerRun(run.id).state, "INTERRUPTED");
      assert.equal(reopened.workerRun(run.id).endReason, "PROCESS_INTERRUPTED");
      assert.equal(reopened.task(task.id).state, "INTERRUPTED");
      assert.equal(reopened.task(task.id).generation, generation + 1);
      assert.equal(eventsOf(reopened, task.id, "task.interrupted").length, 1);
    } finally {
      reopened.close();
    }
  } finally {
    cleanup();
  }
});

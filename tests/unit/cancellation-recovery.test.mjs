import test from "node:test";
import assert from "node:assert/strict";
import { openTempKernel, reopenKernel, seedCompanyAndWork, seedTask } from "../support/kernel.mjs";

function openStartedTask(kernel) {
  const { company, work } = seedCompanyAndWork(kernel);
  const task = seedTask(kernel, work.id);
  const { generation } = kernel.startTask({ taskId: task.id });
  return { company, work, task, generation };
}

test("cancelling a running task invalidates the attempt and keeps history", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { task, generation } = openStartedTask(kernel);
    kernel.checkpointTask({ taskId: task.id, generation, label: "before cancel", state: { step: 1 } });
    kernel.recordArtifact({
      taskId: task.id,
      generation,
      kind: "document",
      title: "Partial output",
      content: "kept",
    });

    const cancelled = kernel.cancelTask({ taskId: task.id, note: "no longer needed" });
    assert.equal(cancelled.state, "CANCELLED");
    assert.ok(cancelled.generation > generation, "cancel fences the live attempt");

    for (const late of [
      () => kernel.checkpointTask({ taskId: task.id, generation, label: "late", state: {} }),
      () =>
        kernel.recordArtifact({
          taskId: task.id,
          generation,
          kind: "document",
          title: "late",
          content: "should not land",
        }),
      () => kernel.completeTask({ taskId: task.id, generation }),
    ])
      assert.throws(late, { code: "STALE_GENERATION" });
    assert.throws(
      () =>
        kernel.checkpointTask({
          taskId: task.id,
          generation: cancelled.generation,
          label: "with the current token",
          state: {},
        }),
      { code: "TASK_NOT_RUNNING" },
      "the fence also requires a running task, not just a current token",
    );

    assert.equal(kernel.task(task.id).state, "CANCELLED");
    assert.equal(kernel.checkpoints(task.id).length, 1, "written checkpoints stay readable");
    assert.equal(kernel.artifacts({ taskId: task.id }).length, 1, "written artifacts stay readable");
    const events = kernel.activity({ taskId: task.id });
    assert.equal(events.at(-1).kind, "task.cancelled");
    assert.deepEqual(events.at(-1).detail, { previousState: "RUNNING", note: "no longer needed" });
  } finally {
    cleanup();
  }
});

test("recovery marks an interrupted attempt honestly and never completes it", () => {
  const { dir, kernel, cleanup } = openTempKernel();
  try {
    const { company, work, task, generation } = openStartedTask(kernel);
    kernel.checkpointTask({ taskId: task.id, generation, label: "half", state: { progress: 0.5 } });
    kernel.close();

    const reopened = reopenKernel(dir);
    assert.equal(reopened.recovery.count, 1);
    assert.deepEqual(reopened.recovery.interrupted, [
      {
        taskId: task.id,
        workId: work.id,
        companyId: company.id,
        interruptedGeneration: generation,
      },
    ]);

    const recovered = reopened.task(task.id);
    assert.equal(recovered.state, "INTERRUPTED");
    assert.equal(recovered.generation, generation + 1);
    assert.equal(reopened.checkpoints(task.id).length, 1, "checkpoints survive the restart");
    const events = reopened.activity({ taskId: task.id });
    assert.equal(events.at(-1).kind, "task.interrupted");
    assert.deepEqual(events.at(-1).detail, {
      interruptedGeneration: generation,
      reason: "PROCESS_INTERRUPTED",
      automaticRetry: false,
    });

    assert.equal(reopened.recover().count, 0, "recovery is idempotent");
    assert.equal(reopened.task(task.id).state, "INTERRUPTED", "nothing changed on the second call");
    const status = reopened.status();
    assert.deepEqual(status.needsAttention, [
      { taskId: task.id, workId: work.id, title: task.title },
    ]);
    assert.equal(status.tasksByState.INTERRUPTED, 1);
    assert.equal(status.counts.tasks, 1);
    reopened.close();
  } finally {
    cleanup();
  }
});

test("recovery only touches attempts that were actually running", () => {
  const { dir, kernel, cleanup } = openTempKernel();
  try {
    const { work } = seedCompanyAndWork(kernel);
    const untouched = seedTask(kernel, work.id, { title: "Never started" });
    const finished = seedTask(kernel, work.id, { title: "Already done" });
    const started = kernel.startTask({ taskId: finished.id });
    kernel.recordArtifact({
      taskId: finished.id,
      generation: started.generation,
      kind: "document",
      title: "Output",
      content: "done",
    });
    kernel.completeTask({ taskId: finished.id, generation: started.generation });
    const running = seedTask(kernel, work.id, { title: "Interrupted" });
    kernel.startTask({ taskId: running.id });
    kernel.close();

    const reopened = reopenKernel(dir);
    assert.equal(reopened.recovery.count, 1);
    assert.equal(reopened.task(untouched.id).state, "OPEN");
    assert.equal(reopened.task(untouched.id).generation, 0);
    assert.equal(reopened.task(finished.id).state, "COMPLETED");
    assert.equal(reopened.task(running.id).state, "INTERRUPTED");
    assert.equal(reopened.workProjection(work.id).status, "NEEDS_ATTENTION");
    reopened.close();
  } finally {
    cleanup();
  }
});

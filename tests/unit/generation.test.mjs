import test from "node:test";
import assert from "node:assert/strict";
import { openTempKernel, reopenKernel, seedCompanyAndWork, seedTask } from "../support/kernel.mjs";

function openStartedTask(kernel) {
  const { work } = seedCompanyAndWork(kernel);
  const task = seedTask(kernel, work.id);
  const { generation } = kernel.startTask({ taskId: task.id });
  return { work, task, generation };
}

test("a start binds a new token and only that token may write", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { task, generation } = openStartedTask(kernel);
    assert.equal(generation, 1, "the first attempt is token 1");
    assert.equal(kernel.task(task.id).generation, generation);

    const checkpoint = kernel.checkpointTask({
      taskId: task.id,
      generation,
      label: "outline",
      state: { sections: 3 },
    });
    assert.equal(checkpoint.generation, generation);

    assert.throws(
      () =>
        kernel.checkpointTask({
          taskId: task.id,
          generation: generation + 1,
          label: "from nowhere",
          state: {},
        }),
      { code: "STALE_GENERATION" },
    );
    assert.equal(kernel.checkpoints(task.id).length, 1);
  } finally {
    cleanup();
  }
});

test("a never-started task rejects execution writes even with token 0", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { work } = seedCompanyAndWork(kernel);
    const task = seedTask(kernel, work.id);
    assert.equal(task.generation, 0);
    for (const write of [
      () => kernel.checkpointTask({ taskId: task.id, generation: 0, label: "x", state: {} }),
      () =>
        kernel.recordArtifact({
          taskId: task.id,
          generation: 0,
          kind: "document",
          title: "x",
          content: "y",
        }),
      () => kernel.completeTask({ taskId: task.id, generation: 0 }),
    ])
      assert.throws(write, { code: "TASK_NOT_RUNNING" });
    assert.deepEqual(kernel.checkpoints(task.id), []);
    assert.deepEqual(kernel.artifacts({ taskId: task.id }), []);
  } finally {
    cleanup();
  }
});

test("the milestone scenario: a superseded attempt cannot complete, the new attempt is unaffected", () => {
  const { dir, kernel, cleanup } = openTempKernel();
  try {
    const { task, generation: first } = openStartedTask(kernel);
    kernel.checkpointTask({
      taskId: task.id,
      generation: first,
      label: "half done",
      state: { progress: 0.5 },
    });
    kernel.close();

    const afterRestart = reopenKernel(dir);
    assert.equal(afterRestart.task(task.id).state, "INTERRUPTED");
    const supersededTask = afterRestart.task(task.id);
    const second = afterRestart.startTask({ taskId: task.id });
    assert.ok(second.generation > supersededTask.generation);
    const runningSnapshot = afterRestart.task(task.id);

    assert.throws(
      () =>
        afterRestart.completeTask({
          taskId: task.id,
          generation: first,
        }),
      { code: "STALE_GENERATION" },
      "the dead attempt's completion must be rejected",
    );
    assert.throws(
      () =>
        afterRestart.checkpointTask({
          taskId: task.id,
          generation: first,
          label: "late checkpoint",
          state: {},
        }),
      { code: "STALE_GENERATION" },
    );
    assert.throws(
      () =>
        afterRestart.recordArtifact({
          taskId: task.id,
          generation: first,
          kind: "document",
          title: "late output",
          content: "should not land",
        }),
      { code: "STALE_GENERATION" },
    );

    assert.deepEqual(
      afterRestart.task(task.id),
      runningSnapshot,
      "the running attempt is byte-for-byte unchanged after the late writes",
    );
    assert.deepEqual(afterRestart.artifacts({ taskId: task.id }), []);
    assert.equal(afterRestart.checkpoints(task.id).length, 1);
    afterRestart.close();
  } finally {
    cleanup();
  }
});

test("completion keeps the token of the attempt that completed", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { task, generation } = openStartedTask(kernel);
    kernel.recordArtifact({
      taskId: task.id,
      generation,
      kind: "document",
      title: "Output",
      content: "done",
    });
    const completed = kernel.completeTask({ taskId: task.id, generation });
    assert.equal(completed.generation, generation);
    assert.equal(kernel.artifacts({ taskId: task.id })[0].generation, generation);
  } finally {
    cleanup();
  }
});

test("an artifact from an older attempt does not satisfy completion", () => {
  const { dir, kernel, cleanup } = openTempKernel();
  try {
    const { task, generation: first } = openStartedTask(kernel);
    kernel.recordArtifact({
      taskId: task.id,
      generation: first,
      kind: "document",
      title: "First attempt output",
      content: "candidate from the attempt that died",
    });
    kernel.close();

    const afterRestart = reopenKernel(dir);
    const second = afterRestart.startTask({ taskId: task.id });
    assert.throws(
      () => afterRestart.completeTask({ taskId: task.id, generation: second.generation }),
      { code: "TASK_HAS_NO_ARTIFACT" },
      "history is not an output: the current attempt must record its own",
    );
    afterRestart.recordArtifact({
      taskId: task.id,
      generation: second.generation,
      kind: "document",
      title: "Second attempt output",
      content: "candidate from the attempt that ran",
    });
    assert.equal(
      afterRestart.completeTask({ taskId: task.id, generation: second.generation }).state,
      "COMPLETED",
    );
    assert.equal(afterRestart.artifacts({ taskId: task.id }).length, 2, "history is kept");
    afterRestart.close();
  } finally {
    cleanup();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  openTempKernel,
  reopenKernel,
  seedCompanyAndWork,
  seedTask,
} from "../support/kernel.mjs";
import { TASK_STATES, transitionAllowed } from "../../packages/runtime/index.mjs";

function startTaskInNewWork(kernel) {
  const { work } = seedCompanyAndWork(kernel);
  const task = seedTask(kernel, work.id);
  const { generation } = kernel.startTask({ taskId: task.id });
  return { work, task, generation };
}

test("a task is created OPEN with token 0 and persists", () => {
  const { dir, kernel, cleanup } = openTempKernel();
  try {
    const { work } = seedCompanyAndWork(kernel);
    const task = seedTask(kernel, work.id);
    assert.match(task.id, /^tsk_/);
    assert.equal(task.state, TASK_STATES.OPEN);
    assert.equal(task.generation, 0);
    assert.equal(task.updatedAt, task.createdAt);
    kernel.close();

    const reopened = reopenKernel(dir);
    assert.deepEqual(reopened.task(task.id), task);
    reopened.close();
  } finally {
    cleanup();
  }
});

test("legal transitions are reachable through commands", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { work } = seedCompanyAndWork(kernel);

    const abandoned = seedTask(kernel, work.id, { title: "Abandon before start" });
    assert.equal(kernel.cancelTask({ taskId: abandoned.id }).state, "CANCELLED");

    const { task, generation } = startTaskInNewWork(kernel);
    assert.equal(kernel.task(task.id).state, "RUNNING");
    kernel.recordArtifact({
      taskId: task.id,
      generation,
      kind: "document",
      title: "Output",
      content: "done",
    });
    assert.equal(
      kernel.completeTask({ taskId: task.id, generation }).state,
      "COMPLETED",
    );
  } finally {
    cleanup();
  }
});

test("forbidden transitions are rejected and change nothing", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { work } = seedCompanyAndWork(kernel);
    const { task, generation } = startTaskInNewWork(kernel);

    assert.throws(() => kernel.startTask({ taskId: task.id }), {
      code: "INVALID_TRANSITION",
    });
    assert.equal(kernel.task(task.id).state, "RUNNING");

    kernel.recordArtifact({
      taskId: task.id,
      generation,
      kind: "document",
      title: "Output",
      content: "done",
    });
    kernel.completeTask({ taskId: task.id, generation });

    assert.throws(() => kernel.startTask({ taskId: task.id }), {
      code: "INVALID_TRANSITION",
    });
    assert.throws(() => kernel.cancelTask({ taskId: task.id }), {
      code: "INVALID_TRANSITION",
    });
    assert.throws(
      () =>
        kernel.recordArtifact({
          taskId: task.id,
          generation,
          kind: "document",
          title: "Late output",
          content: "must not land",
        }),
      { code: "TASK_NOT_RUNNING" },
    );
    assert.throws(
      () => kernel.completeTask({ taskId: task.id, generation }),
      { code: "TASK_NOT_RUNNING" },
    );
    assert.equal(kernel.task(task.id).state, "COMPLETED");
    assert.equal(kernel.artifacts({ taskId: task.id }).length, 1);

    const other = seedTask(kernel, work.id, { title: "Already cancelled" });
    kernel.cancelTask({ taskId: other.id });
    assert.throws(() => kernel.cancelTask({ taskId: other.id }), {
      code: "INVALID_TRANSITION",
    });
    assert.throws(() => kernel.startTask({ taskId: other.id }), {
      code: "INVALID_TRANSITION",
    });
    assert.throws(() => kernel.recordArtifact({
      taskId: other.id,
      generation: kernel.task(other.id).generation,
      kind: "document",
      title: "Output",
      content: "must not land",
    }), { code: "TASK_NOT_RUNNING" });
  } finally {
    cleanup();
  }
});

test("an interrupted task can only continue by starting a new attempt", () => {
  const { dir, kernel, cleanup } = openTempKernel();
  try {
    const { task, generation } = startTaskInNewWork(kernel);
    kernel.close();

    const afterRestart = reopenKernel(dir);
    assert.equal(afterRestart.task(task.id).state, "INTERRUPTED");
    assert.throws(
      () => afterRestart.completeTask({ taskId: task.id, generation: generation + 1 }),
      { code: "TASK_NOT_RUNNING" },
    );
    const resumed = afterRestart.startTask({ taskId: task.id });
    assert.equal(resumed.task.state, "RUNNING");
    assert.equal(resumed.generation, generation + 2);
    afterRestart.close();
  } finally {
    cleanup();
  }
});

test("state cannot be changed by mutating a returned object", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { task } = startTaskInNewWork(kernel);
    const copy = kernel.task(task.id);
    copy.state = "COMPLETED";
    copy.generation = 99;
    assert.equal(kernel.task(task.id).state, "RUNNING");
    assert.notEqual(kernel.task(task.id).generation, 99);
  } finally {
    cleanup();
  }
});

test("the transition table is exactly the frozen contract", () => {
  const expected = {
    OPEN: ["RUNNING", "CANCELLED"],
    RUNNING: ["INTERRUPTED", "COMPLETED", "CANCELLED"],
    INTERRUPTED: ["RUNNING", "CANCELLED"],
    COMPLETED: [],
    CANCELLED: [],
  };
  for (const from of Object.keys(expected))
    for (const to of Object.keys(expected))
      assert.equal(
        transitionAllowed(from, to),
        expected[from].includes(to),
        `${from} → ${to}`,
      );
});

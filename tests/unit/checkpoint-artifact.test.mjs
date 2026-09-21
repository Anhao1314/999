import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openTempKernel, reopenKernel, seedCompanyAndWork, seedTask } from "../support/kernel.mjs";

function openStartedTask(kernel, taskOptions) {
  const { company, work } = seedCompanyAndWork(kernel);
  const task = seedTask(kernel, work.id, taskOptions);
  const { generation } = kernel.startTask({ taskId: task.id });
  return { company, work, task, generation };
}

test("a checkpoint persists, reloads and is ordered inside its task", () => {
  const { dir, kernel, cleanup } = openTempKernel();
  try {
    const { task, generation } = openStartedTask(kernel);
    const first = kernel.checkpointTask({
      taskId: task.id,
      generation,
      label: "outline",
      state: { sections: ["intro", "risks"] },
    });
    const second = kernel.checkpointTask({
      taskId: task.id,
      generation,
      label: "draft",
      state: { sections: ["intro", "risks", "plan"] },
    });
    assert.equal(first.sequence, 1);
    assert.equal(second.sequence, 2);
    assert.equal(first.generation, generation);
    kernel.close();

    const reopened = reopenKernel(dir);
    const checkpoints = reopened.checkpoints(task.id);
    assert.equal(checkpoints.length, 2);
    assert.deepEqual(checkpoints[0], first);
    assert.deepEqual(checkpoints[1], second);
    assert.deepEqual(checkpoints[1].state, { sections: ["intro", "risks", "plan"] });
    reopened.close();
  } finally {
    cleanup();
  }
});

test("a checkpoint is neither an artifact nor a completion", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { task, generation } = openStartedTask(kernel);
    kernel.checkpointTask({ taskId: task.id, generation, label: "progress", state: { step: 1 } });
    assert.equal(kernel.task(task.id).state, "RUNNING", "a checkpoint does not finish the task");
    assert.deepEqual(kernel.artifacts({ taskId: task.id }), [], "a checkpoint is not an output");
  } finally {
    cleanup();
  }
});

test("an artifact carries its provenance, digest and size boundary", () => {
  const { dir, kernel, cleanup } = openTempKernel();
  try {
    const { company, work, task, generation } = openStartedTask(kernel);
    const content = "# Readiness checklist\n- owner: founder\n";
    const artifact = kernel.recordArtifact({
      taskId: task.id,
      generation,
      kind: "document",
      title: "Readiness checklist",
      content,
      inputDigest: "sha256:inputs",
    });
    assert.equal(artifact.companyId, company.id);
    assert.equal(artifact.workId, work.id);
    assert.equal(artifact.taskId, task.id);
    assert.equal(artifact.generation, generation);
    assert.equal(artifact.kind, "document");
    assert.equal(
      artifact.contentDigest,
      `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`,
    );
    assert.equal(artifact.inputDigest, "sha256:inputs");
    assert.match(artifact.id, /^art_/);

    assert.throws(
      () =>
        kernel.recordArtifact({
          taskId: task.id,
          generation,
          kind: "document",
          title: "Too large",
          content: "x".repeat(100 * 1024 + 1),
        }),
      { code: "INVALID_INPUT" },
    );
    assert.throws(
      () =>
        kernel.recordArtifact({
          taskId: task.id,
          generation,
          kind: "not a kind!",
          title: "Bad kind",
          content: "x",
        }),
      { code: "INVALID_INPUT" },
    );
    kernel.close();

    const reopened = reopenKernel(dir);
    const reloaded = reopened.artifacts({ taskId: task.id });
    assert.equal(reloaded.length, 1);
    assert.deepEqual(reloaded[0], artifact);
    assert.equal(reloaded[0].content, content, "content is recorded without trimming");
    assert.deepEqual(reopened.artifacts({ workId: work.id }), reloaded);
    reopened.close();
  } finally {
    cleanup();
  }
});

test("artifacts and checkpoints are immutable in the store itself", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { task, generation } = openStartedTask(kernel);
    const checkpoint = kernel.checkpointTask({
      taskId: task.id,
      generation,
      label: "progress",
      state: {},
    });
    const artifact = kernel.recordArtifact({
      taskId: task.id,
      generation,
      kind: "document",
      title: "Output",
      content: "done",
    });
    assert.throws(
      () => kernel.store.db.prepare("UPDATE artifacts SET title=? WHERE id=?").run("rewritten", artifact.id),
      /ARTIFACT_IMMUTABLE/,
    );
    assert.throws(
      () => kernel.store.db.prepare("DELETE FROM artifacts WHERE id=?").run(artifact.id),
      /ARTIFACT_IMMUTABLE/,
    );
    assert.throws(
      () => kernel.store.db.prepare("UPDATE checkpoints SET label=? WHERE id=?").run("rewritten", checkpoint.id),
      /CHECKPOINT_IMMUTABLE/,
    );
    assert.throws(
      () => kernel.store.db.prepare("DELETE FROM checkpoints WHERE id=?").run(checkpoint.id),
      /CHECKPOINT_IMMUTABLE/,
    );
    assert.equal(kernel.artifacts({ taskId: task.id })[0].title, "Output");
    assert.equal(kernel.checkpoints(task.id)[0].label, "progress");
  } finally {
    cleanup();
  }
});

test("credential-shaped content never reaches recorded truth", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { task, generation } = openStartedTask(kernel);
    const fakeKey = ["s", "k", "-", "e".repeat(24)].join("");
    assert.throws(
      () =>
        kernel.recordArtifact({
          taskId: task.id,
          generation,
          kind: "document",
          title: "Provider notes",
          content: `use ${fakeKey} for now`,
        }),
      { code: "SECRET_IN_OUTPUT" },
    );
    assert.throws(
      () =>
        kernel.checkpointTask({
          taskId: task.id,
          generation,
          label: "creds",
          state: { key: fakeKey },
        }),
      { code: "SECRET_IN_OUTPUT" },
    );
    assert.throws(
      () => kernel.cancelTask({ taskId: task.id, note: `blocked on ${fakeKey}` }),
      { code: "SECRET_IN_OUTPUT" },
    );
    assert.deepEqual(kernel.artifacts({ taskId: task.id }), []);
    assert.deepEqual(kernel.checkpoints(task.id), []);
  } finally {
    cleanup();
  }
});

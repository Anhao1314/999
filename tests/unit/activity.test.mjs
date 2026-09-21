import test from "node:test";
import assert from "node:assert/strict";
import { openTempKernel, reopenKernel, seedCompanyAndWork, seedTask } from "../support/kernel.mjs";

test("activity records the whole lifecycle in order", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { company, work } = seedCompanyAndWork(kernel);
    const task = seedTask(kernel, work.id);
    const { generation } = kernel.startTask({ taskId: task.id });
    kernel.checkpointTask({ taskId: task.id, generation, label: "step", state: {} });
    kernel.recordArtifact({
      taskId: task.id,
      generation,
      kind: "document",
      title: "Output",
      content: "done",
    });
    kernel.completeTask({ taskId: task.id, generation });

    const events = kernel.activity({ companyId: company.id });
    assert.deepEqual(
      events.map((event) => event.kind),
      [
        "company.created",
        "work.created",
        "task.created",
        "task.execution_started",
        "checkpoint.written",
        "artifact.recorded",
        "task.completed",
      ],
    );
    const sequences = events.map((event) => event.sequence);
    assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b), "ordered by sequence");
    assert.equal(new Set(sequences).size, sequences.length, "no duplicate sequence");
    for (const event of events) {
      assert.equal(event.companyId, company.id);
      assert.ok(event.createdAt);
      assert.equal(typeof event.detail, "object");
    }
    const completed = events.at(-1);
    assert.equal(completed.workId, work.id);
    assert.equal(completed.taskId, task.id);
    assert.equal(completed.generation, generation);
    assert.equal(completed.detail.artifactCount, 1);
  } finally {
    cleanup();
  }
});

test("activity survives restart and keeps its order", () => {
  const { dir, kernel, cleanup } = openTempKernel();
  try {
    const { company, work } = seedCompanyAndWork(kernel);
    const task = seedTask(kernel, work.id);
    const { generation } = kernel.startTask({ taskId: task.id });
    kernel.checkpointTask({ taskId: task.id, generation, label: "step", state: {} });
    const before = kernel.activity({ companyId: company.id });
    kernel.close();

    const reopened = reopenKernel(dir);
    const after = reopened.activity({ companyId: company.id });
    assert.deepEqual(after.slice(0, before.length), before, "history is unchanged by the restart");
    assert.equal(after.at(-1).kind, "task.interrupted");
    const byWork = reopened.activity({ workId: work.id });
    assert.deepEqual(
      byWork.map((event) => event.kind),
      after.filter((event) => event.workId === work.id).map((event) => event.kind),
    );
    const limited = reopened.activity({ taskId: task.id, limit: 1 });
    assert.equal(limited.length, 1);
    assert.deepEqual(limited[0], reopened.activity({ taskId: task.id })[0]);
    reopened.close();
  } finally {
    cleanup();
  }
});

test("activity is append-only in the store itself", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { company } = seedCompanyAndWork(kernel);
    assert.throws(
      () => kernel.store.db.prepare("UPDATE activity SET kind=? WHERE company_id=?").run("rewritten", company.id),
      /ACTIVITY_APPEND_ONLY/,
    );
    assert.throws(
      () => kernel.store.db.prepare("DELETE FROM activity WHERE company_id=?").run(company.id),
      /ACTIVITY_APPEND_ONLY/,
    );
    assert.equal(kernel.activity({ companyId: company.id }).length, 2);
  } finally {
    cleanup();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  openTempKernel,
  reopenKernel,
  seedCompanyAndWork,
  seedTask,
} from "../support/kernel.mjs";
import { deriveWorkStatus } from "../../packages/runtime/index.mjs";

test("a company is created, persisted and reloaded", () => {
  const { dir, kernel, cleanup } = openTempKernel();
  try {
    const company = kernel.createCompany({ name: "  Ultraviolet Labs  " });
    assert.match(company.id, /^cmp_[0-9a-f-]{36}$/);
    assert.equal(company.name, "Ultraviolet Labs");
    assert.ok(company.createdAt);
    kernel.close();

    const reopened = reopenKernel(dir);
    assert.deepEqual(reopened.company(company.id), company);
    assert.deepEqual(reopened.companies(), [company]);
    reopened.close();
  } finally {
    cleanup();
  }
});

test("a company cannot be created without a real name", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    assert.throws(() => kernel.createCompany({ name: "   " }), {
      code: "INVALID_INPUT",
    });
    assert.throws(() => kernel.createCompany({}), { code: "INVALID_INPUT" });
    assert.throws(() => kernel.createCompany({ name: "x".repeat(121) }), {
      code: "INVALID_INPUT",
    });
    assert.deepEqual(kernel.companies(), []);
  } finally {
    cleanup();
  }
});

test("a work belongs to exactly one company and survives reload", () => {
  const { dir, kernel, cleanup } = openTempKernel();
  try {
    const { company, work } = seedCompanyAndWork(kernel);
    assert.equal(work.companyId, company.id);
    assert.match(work.id, /^wrk_/);
    assert.deepEqual(kernel.works(company.id), [work]);
    kernel.close();

    const reopened = reopenKernel(dir);
    assert.deepEqual(reopened.work(work.id), work);
    assert.deepEqual(reopened.works(company.id), [work]);
    reopened.close();
  } finally {
    cleanup();
  }
});

test("a work cannot reference a missing company", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { company } = seedCompanyAndWork(kernel);
    assert.throws(
      () =>
        kernel.createWork({
          companyId: "cmp_00000000-0000-4000-8000-000000000000",
          title: "Orphan work",
          intent: "Must not exist",
        }),
      { code: "WORK_COMPANY_MISSING" },
    );
    assert.equal(kernel.works(company.id).length, 1, "only the seeded work exists");
  } finally {
    cleanup();
  }
});

test("work status is derived from task truth and never stored", () => {
  const { dir, kernel, cleanup } = openTempKernel();
  try {
    const { company, work } = seedCompanyAndWork(kernel);
    assert.deepEqual(Object.keys(work).sort(), [
      "companyId",
      "createdAt",
      "id",
      "intent",
      "title",
    ]);

    assert.equal(kernel.workProjection(work.id).status, "OPEN");

    const task = seedTask(kernel, work.id);
    assert.equal(kernel.workProjection(work.id).status, "OPEN");

    const started = kernel.startTask({ taskId: task.id });
    assert.equal(kernel.workProjection(work.id).status, "ACTIVE");
    kernel.close();

    const afterRestart = reopenKernel(dir);
    const interrupted = afterRestart.workProjection(work.id);
    assert.equal(interrupted.status, "NEEDS_ATTENTION");
    assert.deepEqual(interrupted.attention, [
      { taskId: task.id, title: task.title, generation: started.generation + 1 },
    ]);

    const resumed = afterRestart.startTask({ taskId: task.id });
    afterRestart.recordArtifact({
      taskId: task.id,
      generation: resumed.generation,
      kind: "document",
      title: "Readiness checklist",
      content: "- owners\n- dates",
    });
    afterRestart.completeTask({ taskId: task.id, generation: resumed.generation });
    const completed = afterRestart.workProjection(work.id);
    // v0B2: a finished task is not a finished Work. With every task done and no
    // review owed, the derived status is READY_FOR_DECISION — the founder has
    // not accepted anything, and nothing claims otherwise.
    assert.equal(completed.status, "READY_FOR_DECISION");
    assert.equal(completed.stage, "READY_FOR_DECISION");
    assert.equal(completed.taskStatus, "COMPLETED", "the task-only reading is kept separately");
    assert.deepEqual(completed.taskCounts, { COMPLETED: 1 });
    assert.deepEqual(completed.attention, []);
    assert.equal(afterRestart.works(company.id).length, 1);
    afterRestart.close();
  } finally {
    cleanup();
  }
});

test("the work status table is total and ordered by precedence", () => {
  const task = (state) => ({ state });
  assert.equal(deriveWorkStatus([]), "OPEN", "a work with no tasks has not started");
  assert.equal(
    deriveWorkStatus([task("INTERRUPTED"), task("RUNNING"), task("COMPLETED")]),
    "NEEDS_ATTENTION",
    "an interruption outranks an active attempt",
  );
  assert.equal(deriveWorkStatus([task("RUNNING"), task("OPEN")]), "ACTIVE");
  assert.equal(deriveWorkStatus([task("COMPLETED"), task("OPEN")]), "OPEN");
  assert.equal(deriveWorkStatus([task("COMPLETED"), task("COMPLETED")]), "COMPLETED");
  assert.equal(deriveWorkStatus([task("CANCELLED"), task("CANCELLED")]), "CANCELLED");
  assert.equal(deriveWorkStatus([task("CANCELLED"), task("COMPLETED")]), "OPEN");
});

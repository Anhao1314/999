import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  openTempKernel,
  reopenKernel,
  seedCompanyAndWork,
  tempStoreDir,
} from "../support/kernel.mjs";
import { SCHEMA_VERSION, STORE_FILE_NAME } from "../../packages/runtime/index.mjs";

test("a fresh store initialises its schema and reports its version", () => {
  const { dir, kernel, cleanup } = openTempKernel();
  try {
    assert.equal(kernel.status().schemaVersion, SCHEMA_VERSION);
    assert.ok(existsSync(join(dir, STORE_FILE_NAME)));
    const tables = kernel.store.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => row.name);
    for (const table of [
      "activity",
      "artifacts",
      "checkpoints",
      "companies",
      "schema_meta",
      "tasks",
      "works",
    ])
      assert.ok(tables.includes(table), `missing table ${table}`);
    assert.deepEqual(kernel.status().counts, {
      companies: 0,
      works: 0,
      tasks: 0,
      checkpoints: 0,
      artifacts: 0,
      positions: 0,
      employees: 0,
      assignments: 0,
      workerRuns: 0,
      activity: 0,
    });
  } finally {
    cleanup();
  }
});

test("reopening the same store keeps the version and the data", () => {
  const { dir, kernel, cleanup } = openTempKernel();
  try {
    const { company, work } = seedCompanyAndWork(kernel);
    kernel.close();

    const reopened = reopenKernel(dir);
    assert.equal(reopened.status().schemaVersion, SCHEMA_VERSION);
    assert.equal(reopened.company(company.id).name, company.name);
    assert.equal(reopened.work(work.id).title, work.title);
    assert.equal(reopened.status().counts.companies, 1);
    reopened.close();

    const third = reopenKernel(dir);
    assert.equal(third.status().counts.works, 1, "reopening does not re-initialise the store");
    third.close();
  } finally {
    cleanup();
  }
});

test("an incompatible schema version fails clearly instead of being read", () => {
  const dir = tempStoreDir();
  try {
    const db = new DatabaseSync(join(dir, STORE_FILE_NAME));
    db.exec("CREATE TABLE schema_meta(version INTEGER NOT NULL)");
    db.prepare("INSERT INTO schema_meta(version) VALUES(?)").run(999);
    db.close();
    assert.throws(() => reopenKernel(dir), {
      code: "INCOMPATIBLE_SCHEMA_VERSION",
    });
    assert.throws(() => reopenKernel(dir), /schema version 999/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a schema_meta table without a version is not silently accepted", () => {
  const dir = tempStoreDir();
  try {
    const db = new DatabaseSync(join(dir, STORE_FILE_NAME));
    db.exec("CREATE TABLE schema_meta(version INTEGER NOT NULL)");
    db.close();
    assert.throws(() => reopenKernel(dir), {
      code: "INCOMPATIBLE_SCHEMA_VERSION",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed transaction leaves no partial write", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    assert.throws(
      () =>
        kernel.store.transaction(() => {
          kernel.store.insertCompany({
            id: "cmp_rollback",
            name: "Rollback Ltd",
            createdAt: new Date().toISOString(),
          });
          throw new Error("boom");
        }),
      /boom/,
    );
    assert.deepEqual(kernel.companies(), []);
    assert.equal(kernel.status().counts.companies, 0);

    const company = kernel.createCompany({ name: "Still works" });
    assert.equal(kernel.company(company.id).name, "Still works", "the store stays usable");
  } finally {
    cleanup();
  }
});

test("foreign keys and the state/generation constraints are enforced by the store", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    assert.throws(
      () =>
        kernel.store.db
          .prepare("INSERT INTO works(id,company_id,title,intent,created_at) VALUES(?,?,?,?,?)")
          .run("wrk_orphan", "cmp_missing", "t", "i", new Date().toISOString()),
      /FOREIGN KEY/,
    );

    const { work } = seedCompanyAndWork(kernel);
    const task = kernel.createTask({ workId: work.id, title: "T", intent: "I" });
    kernel.startTask({ taskId: task.id });
    assert.throws(
      () => kernel.store.db.prepare("UPDATE tasks SET generation=? WHERE id=?").run(0, task.id),
      /GENERATION_REGRESSION/,
    );
    assert.throws(
      () =>
        kernel.store.db
          .prepare("UPDATE tasks SET state=? WHERE id=?")
          .run("NOT_A_STATE", task.id),
      (error) => /CHECK/i.test(error.message),
    );
    assert.equal(kernel.task(task.id).state, "RUNNING");
    assert.equal(kernel.task(task.id).generation, 1);
  } finally {
    cleanup();
  }
});

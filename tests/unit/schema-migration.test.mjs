import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { openKernel } from "../../packages/runtime/index.mjs";
import { STORE_FILE_NAME } from "../../packages/runtime/index.mjs";
import { tempStoreDir } from "../support/kernel.mjs";
import { V1_SCHEMA_DDL } from "../support/schema-v1.mjs";

const CREATED = "2026-09-20T10:00:00.000Z";
const CHECKPOINT_STATE = { sections: ["intro", "risks"], progress: 0.5 };
const ARTIFACT_CONTENT = "# Legacy memo\nrecorded by the v0A runtime\n";

// Builds a real v1 store: the shipped schema, version 1, and rows a v0A runtime
// would have written — including an attempt that was still running.
function createV1Store(dir) {
  const db = new DatabaseSync(join(dir, STORE_FILE_NAME));
  db.exec(V1_SCHEMA_DDL);
  db.prepare("INSERT INTO schema_meta(version) VALUES(?)").run(1);
  db.prepare("INSERT INTO companies(id,name,created_at) VALUES(?,?,?)").run(
    "cmp_legacy",
    "Legacy Ltd",
    CREATED,
  );
  db.prepare("INSERT INTO works(id,company_id,title,intent,created_at) VALUES(?,?,?,?,?)").run(
    "wrk_legacy",
    "cmp_legacy",
    "Legacy work",
    "Why it exists",
    CREATED,
  );
  db.prepare(
    "INSERT INTO tasks(id,work_id,title,intent,state,generation,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run(
    "tsk_legacy",
    "wrk_legacy",
    "Legacy task",
    "One output",
    "RUNNING",
    1,
    CREATED,
    CREATED,
  );
  db.prepare(
    "INSERT INTO checkpoints(id,task_id,generation,sequence,label,state,created_at) VALUES(?,?,?,?,?,?,?)",
  ).run(
    "ckp_legacy",
    "tsk_legacy",
    1,
    1,
    "half",
    JSON.stringify(CHECKPOINT_STATE),
    CREATED,
  );
  db.prepare(
    "INSERT INTO artifacts(id,company_id,work_id,task_id,generation,kind,title,content,content_digest,input_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    "art_legacy",
    "cmp_legacy",
    "wrk_legacy",
    "tsk_legacy",
    1,
    "document",
    "Legacy memo",
    ARTIFACT_CONTENT,
    "sha256:legacy-digest",
    null,
    CREATED,
  );
  db.prepare(
    "INSERT INTO activity(company_id,work_id,task_id,generation,kind,detail,created_at) VALUES(?,?,?,?,?,?,?)",
  ).run("cmp_legacy", null, null, null, "company.created", "{}", CREATED);
  db.prepare(
    "INSERT INTO activity(company_id,work_id,task_id,generation,kind,detail,created_at) VALUES(?,?,?,?,?,?,?)",
  ).run("cmp_legacy", "wrk_legacy", "tsk_legacy", 1, "task.execution_started", "{}", CREATED);
  db.close();
}

test("a real v1 store migrates to v2 and keeps every value", () => {
  const dir = tempStoreDir();
  try {
    createV1Store(dir);
    const kernel = openKernel({ dir });

    assert.equal(kernel.status().schemaVersion, 2);
    assert.deepEqual(kernel.company("cmp_legacy"), {
      id: "cmp_legacy",
      name: "Legacy Ltd",
      createdAt: CREATED,
    });
    assert.deepEqual(kernel.work("wrk_legacy"), {
      id: "wrk_legacy",
      companyId: "cmp_legacy",
      title: "Legacy work",
      intent: "Why it exists",
      createdAt: CREATED,
    });
    assert.deepEqual(kernel.checkpoints("tsk_legacy"), [
      {
        id: "ckp_legacy",
        taskId: "tsk_legacy",
        generation: 1,
        sequence: 1,
        label: "half",
        state: CHECKPOINT_STATE,
        createdAt: CREATED,
      },
    ]);
    const [artifact] = kernel.artifacts({ taskId: "tsk_legacy" });
    assert.equal(artifact.content, ARTIFACT_CONTENT, "content is preserved byte for byte");
    assert.equal(artifact.contentDigest, "sha256:legacy-digest");
    assert.equal(artifact.workerRunId, null, "a v0A artifact has no producer run, not a fake one");
    assert.equal(
      kernel.activity({ companyId: "cmp_legacy" }).map((event) => event.kind).slice(0, 2).join(","),
      "company.created,task.execution_started",
    );

    // The running attempt is still recovered honestly on the first v2 open.
    const recovered = kernel.task("tsk_legacy");
    assert.equal(recovered.state, "INTERRUPTED");
    assert.equal(recovered.generation, 2);

    // The workforce tables are usable in the migrated store, with new runs
    // strictly after the legacy generation.
    const position = kernel.createPosition({
      companyId: "cmp_legacy",
      title: "Analyst",
      capabilities: ["capability.x"],
    });
    const employee = kernel.createEmployee({
      companyId: "cmp_legacy",
      positionId: position.id,
      displayName: "Analyst A",
    });
    kernel.setTaskRequirements({
      taskId: "tsk_legacy",
      requiredCapabilities: ["capability.x"],
    });
    kernel.assignTask({ taskId: "tsk_legacy", employeeId: employee.id, reason: "after migration" });
    const resumed = kernel.startWorkerRun({ taskId: "tsk_legacy" });
    assert.ok(resumed.generation > 2);
    assert.equal(resumed.workerRun.state, "RUNNING");
    assert.equal(resumed.workerRun.companyId, "cmp_legacy");
    assert.equal(resumed.task.state, "RUNNING");
    kernel.close();

    // Reopening a v2 store does not migrate again and loses nothing.
    const again = openKernel({ dir });
    assert.equal(again.status().schemaVersion, 2);
    assert.equal(again.status().counts.companies, 1);
    assert.equal(again.status().counts.artifacts, 1);
    assert.equal(again.workerRuns({ taskId: "tsk_legacy" }).length, 1);
    assert.equal(again.recovery.count, 1, "the second open recovers the run of the first");
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown future schema version still fails clearly after v2 exists", () => {
  const dir = tempStoreDir();
  try {
    const db = new DatabaseSync(join(dir, STORE_FILE_NAME));
    db.exec("CREATE TABLE schema_meta(version INTEGER NOT NULL)");
    db.prepare("INSERT INTO schema_meta(version) VALUES(?)").run(99);
    db.close();
    assert.throws(() => openKernel({ dir }), { code: "INCOMPATIBLE_SCHEMA_VERSION" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

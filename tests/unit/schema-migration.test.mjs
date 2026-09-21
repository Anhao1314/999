import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { openKernel } from "../../packages/runtime/index.mjs";
import { STORE_FILE_NAME } from "../../packages/runtime/index.mjs";
import { tempStoreDir } from "../support/kernel.mjs";
import { V1_SCHEMA_DDL } from "../support/schema-v1.mjs";
import { V2_SCHEMA_DDL } from "../support/schema-v2.mjs";

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

    assert.equal(kernel.status().schemaVersion, 3);
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
    assert.equal(again.status().schemaVersion, 3);
    assert.equal(again.status().counts.companies, 1);
    assert.equal(again.status().counts.artifacts, 1);
    assert.equal(again.workerRuns({ taskId: "tsk_legacy" }).length, 1);
    assert.equal(again.recovery.count, 1, "the second open recovers the run of the first");
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A real v0B1 store: the shipped v2 schema, version 2, and the rows a v0B1
// runtime would have written — a company with a position, an employee, a task
// with requirements, an assignment, a finished run and its artifact.
const V2_PACKET = JSON.stringify({ packetVersion: 1, task: { id: "tsk_v0b1" } });

function createV2Store(dir) {
  const db = new DatabaseSync(join(dir, STORE_FILE_NAME));
  db.exec(V2_SCHEMA_DDL);
  db.prepare("INSERT INTO schema_meta(version) VALUES(?)").run(2);
  db.prepare("INSERT INTO companies(id,name,created_at) VALUES(?,?,?)").run(
    "cmp_v0b1",
    "Workforce Ltd",
    CREATED,
  );
  db.prepare("INSERT INTO positions(id,company_id,title,capabilities,created_at) VALUES(?,?,?,?,?)").run(
    "pos_v0b1",
    "cmp_v0b1",
    "Analyst",
    JSON.stringify(["capability.x"]),
    CREATED,
  );
  db.prepare(
    "INSERT INTO employees(id,company_id,position_id,display_name,enabled,provider_preference,created_at) VALUES(?,?,?,?,?,?,?)",
  ).run("emp_v0b1", "cmp_v0b1", "pos_v0b1", "Analyst A", 1, null, CREATED);
  db.prepare("INSERT INTO works(id,company_id,title,intent,created_at) VALUES(?,?,?,?,?)").run(
    "wrk_v0b1",
    "cmp_v0b1",
    "Shipped work",
    "Why it exists",
    CREATED,
  );
  db.prepare(
    "INSERT INTO tasks(id,work_id,title,intent,state,generation,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run("tsk_v0b1", "wrk_v0b1", "Shipped task", "One output", "COMPLETED", 1, CREATED, CREATED);
  db.prepare(
    "INSERT INTO task_requirements(task_id,required_capabilities,created_at,updated_at) VALUES(?,?,?,?)",
  ).run("tsk_v0b1", JSON.stringify(["capability.x"]), CREATED, CREATED);
  db.prepare(
    "INSERT INTO assignments(id,company_id,task_id,employee_id,position_id,reason,created_at) VALUES(?,?,?,?,?,?,?)",
  ).run("asg_v0b1", "cmp_v0b1", "tsk_v0b1", "emp_v0b1", "pos_v0b1", "seed", CREATED);
  db.prepare(
    "INSERT INTO worker_runs(id,company_id,work_id,task_id,employee_id,position_id,generation,state,work_packet,work_packet_digest,started_at,ended_at,end_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    "run_v0b1",
    "cmp_v0b1",
    "wrk_v0b1",
    "tsk_v0b1",
    "emp_v0b1",
    "pos_v0b1",
    1,
    "COMPLETED",
    V2_PACKET,
    "sha256:packet-digest",
    CREATED,
    CREATED,
    "WORK_COMPLETED",
  );
  db.prepare(
    "INSERT INTO artifacts(id,company_id,work_id,task_id,generation,kind,title,content,content_digest,input_digest,worker_run_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    "art_v0b1",
    "cmp_v0b1",
    "wrk_v0b1",
    "tsk_v0b1",
    1,
    "document",
    "Shipped output",
    "# v0B1 output\n",
    "sha256:v0b1-digest",
    null,
    "run_v0b1",
    CREATED,
  );
  db.close();
}

test("a real v2 store migrates to v3 and keeps every v0B1 fact", () => {
  const dir = tempStoreDir();
  try {
    createV2Store(dir);
    const kernel = openKernel({ dir });

    assert.equal(kernel.status().schemaVersion, 3);
    assert.deepEqual(kernel.position("pos_v0b1"), {
      id: "pos_v0b1",
      companyId: "cmp_v0b1",
      title: "Analyst",
      capabilities: ["capability.x"],
      createdAt: CREATED,
    });
    assert.equal(kernel.employee("emp_v0b1").displayName, "Analyst A");
    assert.equal(kernel.employee("emp_v0b1").enabled, true);
    assert.equal(kernel.assignment("tsk_v0b1").employeeId, "emp_v0b1");
    const [run] = kernel.workerRuns({ taskId: "tsk_v0b1" });
    assert.equal(run.id, "run_v0b1");
    assert.equal(run.state, "COMPLETED");
    assert.equal(run.workPacketDigest, "sha256:packet-digest");
    assert.deepEqual(run.workPacket, JSON.parse(V2_PACKET));
    assert.deepEqual(kernel.taskRequirements("tsk_v0b1").requiredCapabilities, ["capability.x"]);
    assert.deepEqual(
      kernel.taskRequirements("tsk_v0b1").reviewCapabilities,
      [],
      "a v0B1 task owes no review, and the migration says so instead of guessing",
    );

    const [artifact] = kernel.artifacts({ taskId: "tsk_v0b1" });
    assert.equal(artifact.content, "# v0B1 output\n");
    assert.equal(artifact.contentDigest, "sha256:v0b1-digest");
    assert.equal(artifact.workerRunId, "run_v0b1");
    assert.equal(
      artifact.supersedesArtifactId,
      null,
      "nothing in v0B1 was a replacement, so nothing claims to be one",
    );
    assert.equal(kernel.status().counts.positions, 1);
    assert.equal(kernel.status().counts.employees, 1);
    assert.equal(kernel.status().counts.assignments, 1);
    assert.equal(kernel.status().counts.workerRuns, 1);
    assert.equal(kernel.status().counts.reviews, 0);
    assert.equal(kernel.status().counts.reviewRequests, 0);
    assert.equal(kernel.status().counts.repairBindings, 0);
    assert.equal(kernel.recovery.count, 0, "a completed v0B1 task is not an interrupted attempt");
    kernel.close();

    // The migrated store is fully usable: the v0B2 protocol runs on top of it.
    const reopened = openKernel({ dir });
    const reviewer = reopened.createEmployee({
      companyId: "cmp_v0b1",
      positionId: "pos_v0b1",
      displayName: "Reviewer B",
    });
    const task = reopened.createTask({
      workId: "wrk_v0b1",
      title: "New work on the migrated store",
      intent: "One output the founder can act on",
      requiredCapabilities: ["capability.x"],
    });
    reopened.setTaskRequirements({
      taskId: task.id,
      requiredCapabilities: ["capability.x"],
      reviewCapabilities: ["capability.x"],
    });
    reopened.assignTask({ taskId: task.id, employeeId: "emp_v0b1", reason: "fixture" });
    const started = reopened.startWorkerRun({ taskId: task.id });
    const output = reopened.recordArtifact({
      taskId: task.id,
      generation: started.generation,
      workerRunId: started.workerRun.id,
      kind: "document",
      title: "Fresh output",
      content: "fresh\n",
    });
    const handedOff = reopened.requestReview({ taskId: task.id, generation: started.generation });
    reopened.assignTask({ taskId: handedOff.reviewTask.id, employeeId: reviewer.id, reason: "f" });
    const reviewRun = reopened.startWorkerRun({ taskId: handedOff.reviewTask.id });
    const review = reopened.submitReview({
      reviewTaskId: handedOff.reviewTask.id,
      generation: reviewRun.generation,
      verdict: "REQUEST_REVISION",
      summary: "Not acceptable.",
      findings: ["Explain the gap."],
    }).review;
    const repair = reopened.createRepairTask({ reviewId: review.id });
    assert.equal(repair.assignment.employeeId, "emp_v0b1", "the migrated employee is still the producer");
    const repairRun = reopened.startWorkerRun({ taskId: repair.task.id });
    const replacement = reopened.recordArtifact({
      taskId: repair.task.id,
      generation: repairRun.generation,
      workerRunId: repairRun.workerRun.id,
      kind: "document",
      title: "Fixed output",
      content: "fixed\n",
      supersedesArtifactId: output.id,
    });
    assert.equal(replacement.supersedesArtifactId, output.id);
    assert.equal(reopened.artifact(output.id).contentDigest, output.contentDigest);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown future schema version still fails clearly after v3 exists", () => {
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

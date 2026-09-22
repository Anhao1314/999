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
import { V3_SCHEMA_DDL } from "../support/schema-v3.mjs";
import { V4_SCHEMA_DDL } from "../support/schema-v4.mjs";

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

test("a real v1 store migrates through v2, v3 and v4 to v5 and keeps every value", () => {
  const dir = tempStoreDir();
  try {
    createV1Store(dir);
    const kernel = openKernel({ dir });

    assert.equal(kernel.status().schemaVersion, 5);
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
    assert.equal(again.status().schemaVersion, 5);
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

test("a real v2 store migrates through v3 and v4 to v5 and keeps every v0B1 fact", () => {
  const dir = tempStoreDir();
  try {
    createV2Store(dir);
    const kernel = openKernel({ dir });

    assert.equal(kernel.status().schemaVersion, 5);
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

// A real v0B2 store: the shipped v3 schema, version 3, and the rows a v0B2
// runtime would have written for a Work that went through review, a revision
// and a passing second review. It ends at READY_FOR_DECISION with no Founder
// Decision anywhere — which is exactly the state v0B3 must find it in.
function createV3Store(dir) {
  const db = new DatabaseSync(join(dir, STORE_FILE_NAME));
  db.exec(V3_SCHEMA_DDL);
  db.prepare("INSERT INTO schema_meta(version) VALUES(?)").run(3);
  db.prepare("INSERT INTO companies(id,name,created_at) VALUES(?,?,?)").run(
    "cmp_v0b2",
    "Legacy Labs",
    CREATED,
  );
  db.prepare("INSERT INTO positions(id,company_id,title,capabilities,created_at) VALUES(?,?,?,?,?)").run(
    "pos_v0b2",
    "cmp_v0b2",
    "Producer",
    JSON.stringify(["capability.produce"]),
    CREATED,
  );
  db.prepare(
    "INSERT INTO employees(id,company_id,position_id,display_name,enabled,provider_preference,created_at) VALUES(?,?,?,?,?,?,?)",
  ).run("emp_v0b2", "cmp_v0b2", "pos_v0b2", "Legacy Producer", 1, null, CREATED);
  db.prepare("INSERT INTO works(id,company_id,title,intent,created_at) VALUES(?,?,?,?,?)").run(
    "wrk_v0b2",
    "cmp_v0b2",
    "Legacy work",
    "Why it exists",
    CREATED,
  );
  const insertTask = db.prepare(
    "INSERT INTO tasks(id,work_id,title,intent,state,generation,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
  );
  for (const [id, title] of [
    ["tsk_src", "Produce the output"],
    ["tsk_rev1", "Review the output"],
    ["tsk_rep", "Repair the output"],
    ["tsk_rev2", "Review the repair"],
  ])
    insertTask.run(id, "wrk_v0b2", title, "One output", "COMPLETED", 1, CREATED, CREATED);
  const insertRun = db.prepare(
    "INSERT INTO worker_runs(id,company_id,work_id,task_id,employee_id,position_id,generation,state,work_packet,work_packet_digest,started_at,ended_at,end_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  for (const taskId of ["tsk_src", "tsk_rev1", "tsk_rep", "tsk_rev2"])
    insertRun.run(
      `run_${taskId}`,
      "cmp_v0b2",
      "wrk_v0b2",
      taskId,
      "emp_v0b2",
      "pos_v0b2",
      1,
      "COMPLETED",
      JSON.stringify({ packetVersion: 1, task: { id: taskId } }),
      `sha256:packet-${taskId}`,
      CREATED,
      CREATED,
      "WORK_COMPLETED",
    );
  const insertArtifact = db.prepare(
    "INSERT INTO artifacts(id,company_id,work_id,task_id,generation,kind,title,content,content_digest,input_digest,created_at,worker_run_id,supersedes_artifact_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  insertArtifact.run(
    "art_v1",
    "cmp_v0b2",
    "wrk_v0b2",
    "tsk_src",
    1,
    "document",
    "Legacy output v1",
    "v1\n",
    "sha256:v1",
    null,
    CREATED,
    "run_tsk_src",
    null,
  );
  insertArtifact.run(
    "art_v2",
    "cmp_v0b2",
    "wrk_v0b2",
    "tsk_rep",
    1,
    "document",
    "Legacy output v2",
    "v2\n",
    "sha256:v2",
    null,
    CREATED,
    "run_tsk_rep",
    "art_v1",
  );
  const insertRequest = db.prepare(
    "INSERT INTO review_requests(id,company_id,work_id,review_task_id,source_task_id,target_artifact_id,target_artifact_digest,created_at) VALUES(?,?,?,?,?,?,?,?)",
  );
  insertRequest.run("req_v1", "cmp_v0b2", "wrk_v0b2", "tsk_rev1", "tsk_src", "art_v1", "sha256:v1", CREATED);
  insertRequest.run("req_v2", "cmp_v0b2", "wrk_v0b2", "tsk_rev2", "tsk_rep", "art_v2", "sha256:v2", CREATED);
  const insertReview = db.prepare(
    "INSERT INTO reviews(id,company_id,work_id,review_task_id,reviewer_worker_run_id,target_artifact_id,target_artifact_digest,verdict,summary,findings,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  );
  insertReview.run(
    "rev_v1",
    "cmp_v0b2",
    "wrk_v0b2",
    "tsk_rev1",
    "run_tsk_rev1",
    "art_v1",
    "sha256:v1",
    "REQUEST_REVISION",
    "The downside case is missing.",
    JSON.stringify(["Add the downside case."]),
    CREATED,
  );
  insertReview.run(
    "rev_v2",
    "cmp_v0b2",
    "wrk_v0b2",
    "tsk_rev2",
    "run_tsk_rev2",
    "art_v2",
    "sha256:v2",
    "PASS",
    "The recommendation now matches the evidence.",
    JSON.stringify([]),
    CREATED,
  );
  db.prepare(
    "INSERT INTO repair_bindings(id,company_id,work_id,repair_task_id,review_id,source_task_id,target_artifact_id,target_artifact_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run("bnd_v1", "cmp_v0b2", "wrk_v0b2", "tsk_rep", "rev_v1", "tsk_src", "art_v1", "sha256:v1", CREATED);
  const insertActivity = db.prepare(
    "INSERT INTO activity(company_id,work_id,task_id,generation,kind,detail,created_at) VALUES(?,?,?,?,?,?,?)",
  );
  for (const [taskId, kind] of [
    ["tsk_src", "task.created"],
    ["tsk_src", "task.execution_started"],
    ["tsk_src", "artifact.recorded"],
    ["tsk_rev1", "REVIEW_REQUESTED"],
    ["tsk_rev1", "REVIEW_SUBMITTED"],
    ["tsk_rep", "REPAIR_TASK_CREATED"],
    ["tsk_rep", "artifact.recorded"],
    ["tsk_rev2", "REVIEW_REQUESTED"],
    ["tsk_rev2", "REVIEW_SUBMITTED"],
  ])
    insertActivity.run("cmp_v0b2", "wrk_v0b2", taskId, 1, kind, "{}", CREATED);
  db.close();
}

test("a real v3 store migrates through v4 to v5, keeps every v0B2 fact, and still has no decision", () => {
  const dir = tempStoreDir();
  try {
    createV3Store(dir);
    const kernel = openKernel({ dir });

    assert.equal(kernel.status().schemaVersion, 5);
    assert.equal(kernel.recovery.count, 0, "a finished v0B2 work hides no running attempt");

    // Every v0B2 fact survived the migration untouched.
    assert.equal(kernel.status().counts.reviews, 2);
    assert.equal(kernel.status().counts.reviewRequests, 2);
    assert.equal(kernel.status().counts.repairBindings, 1);
    assert.equal(kernel.review("rev_v1").verdict, "REQUEST_REVISION");
    assert.equal(kernel.review("rev_v2").verdict, "PASS");
    assert.equal(kernel.review("rev_v2").targetArtifactId, "art_v2");
    assert.equal(kernel.repairBinding("bnd_v1").targetArtifactId, "art_v1");
    assert.equal(kernel.artifact("art_v1").supersedesArtifactId, null);
    assert.equal(kernel.artifact("art_v2").supersedesArtifactId, "art_v1");

    // Migration is additive: a v0B2 store arrives with no decision, and no
    // backfill invents one. "No decision yet" is an absence, not a row.
    assert.equal(
      kernel.status().counts.founderDecisions,
      0,
      "a store with no history of a decision must not gain one",
    );

    const projection = kernel.workProjection("wrk_v0b2");
    assert.equal(projection.status, "READY_FOR_DECISION");
    assert.equal(projection.outcome.state, "READY");
    assert.equal(projection.outcome.accepted, null);
    assert.deepEqual(
      projection.outcome.candidateArtifacts.map((entry) => entry.id),
      ["art_v2"],
      "the superseded v1 is not a candidate, and the newest is not chosen by recency",
    );
    assert.equal(
      projection.decisionBasis,
      9,
      "the basis is the migrated Work's own activity head",
    );
    assert.equal(projection.founderAttention.item.kind, "DECISION_REQUIRED");

    // The v0B3 decision path works on the migrated store, and the migrated
    // activity history is what the basis was measured against.
    const accepted = kernel.acceptWork({
      workId: "wrk_v0b2",
      artifactId: "art_v2",
      artifactDigest: "sha256:v2",
      basis: projection.decisionBasis,
    });
    assert.equal(accepted.idempotent, false);
    assert.equal(accepted.decision.disposition, "ACCEPT");
    assert.equal(accepted.work.outcome.state, "ACCEPTED");
    assert.equal(accepted.work.outcome.accepted.artifactId, "art_v2");
    kernel.close();

    // Reopening migrates nothing again, and the decision is still there.
    const reopened = openKernel({ dir });
    assert.equal(reopened.status().schemaVersion, 5);
    assert.equal(reopened.status().counts.founderDecisions, 1);
    assert.equal(reopened.workProjection("wrk_v0b2").outcome.state, "ACCEPTED");
    assert.equal(reopened.workProjection("wrk_v0b2").founderAttention.item, null);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// Builds a real v4 store: the shipped v0B3 schema, version 4, and rows a v0B3
// runtime would have written — including the immutable Founder Decision.
function createV4Store(dir) {
  const db = new DatabaseSync(join(dir, STORE_FILE_NAME));
  db.exec(V4_SCHEMA_DDL);
  db.prepare("INSERT INTO schema_meta(version) VALUES(?)").run(4);
  db.prepare("INSERT INTO companies(id,name,created_at) VALUES(?,?,?)").run(
    "cmp_v0b3",
    "Decision Ltd",
    CREATED,
  );
  db.prepare("INSERT INTO works(id,company_id,title,intent,created_at) VALUES(?,?,?,?,?)").run(
    "wrk_v0b3",
    "cmp_v0b3",
    "Decided work",
    "Why it exists",
    CREATED,
  );
  db.prepare(
    "INSERT INTO tasks(id,work_id,title,intent,state,generation,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run("tsk_v0b3", "wrk_v0b3", "Produce the analysis", "One output", "COMPLETED", 1, CREATED, CREATED);
  db.prepare(
    "INSERT INTO artifacts(id,company_id,work_id,task_id,generation,kind,title,content,content_digest,input_digest,created_at,worker_run_id,supersedes_artifact_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    "art_v0b3",
    "cmp_v0b3",
    "wrk_v0b3",
    "tsk_v0b3",
    1,
    "document",
    "Accepted analysis",
    "the accepted text\n",
    "sha256:v0b3",
    null,
    CREATED,
    null,
    null,
  );
  const insertActivity = db.prepare(
    "INSERT INTO activity(company_id,work_id,task_id,generation,kind,detail,created_at) VALUES(?,?,?,?,?,?,?)",
  );
  insertActivity.run("cmp_v0b3", "wrk_v0b3", "tsk_v0b3", null, "task.created", "{}", CREATED);
  insertActivity.run("cmp_v0b3", "wrk_v0b3", "tsk_v0b3", 1, "artifact.recorded", "{}", CREATED);
  insertActivity.run("cmp_v0b3", "wrk_v0b3", "tsk_v0b3", null, "task.completed", "{}", CREATED);
  insertActivity.run("cmp_v0b3", "wrk_v0b3", "tsk_v0b3", null, "WORK_ACCEPTED", "{}", CREATED);
  db.prepare(
    "INSERT INTO founder_decisions(id,company_id,work_id,disposition,artifact_id,artifact_digest,basis_sequence,created_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run("dec_v0b3", "cmp_v0b3", "wrk_v0b3", "ACCEPT", "art_v0b3", "sha256:v0b3", 4, CREATED);
  db.close();
}

test("a real v4 store migrates to v5, keeps every v0B3 fact, and starts with no trace", () => {
  const dir = tempStoreDir();
  try {
    createV4Store(dir);
    const kernel = openKernel({ dir });

    assert.equal(kernel.status().schemaVersion, 5);
    assert.equal(kernel.recovery.count, 0);

    // Every v0B3 fact survived: the decision is still the immutable record it
    // was, and the Work still reads as accepted.
    assert.equal(kernel.status().counts.founderDecisions, 1);
    assert.equal(kernel.status().counts.continuationTraces, 0);
    const decision = kernel.store.founderDecisionForWork("wrk_v0b3");
    assert.equal(decision.artifactId, "art_v0b3");
    assert.equal(decision.disposition, "ACCEPT");
    const projection = kernel.workProjection("wrk_v0b3");
    assert.equal(projection.outcome.state, "ACCEPTED");
    assert.equal(projection.outcome.accepted.decisionId, "dec_v0b3");
    assert.equal(projection.founderAttention.item, null);

    // Migration is additive: absence of traces is the absence of history, not a
    // backfilled guess.
    assert.deepEqual(kernel.continuationTraces({ workId: "wrk_v0b3" }), []);

    // The new table is usable and append-only from the first write.
    const trace = kernel.recordContinuationTrace({
      companyId: "cmp_v0b3",
      workId: "wrk_v0b3",
      step: 1,
      triggerType: "STARTUP",
      basisBefore: 4,
      basisAfter: 4,
      policyVersion: "v0b4.1",
      reasonCodes: ["ACCEPTED"],
      actionResult: "SKIPPED",
    });
    assert.equal(trace.sensorName, null, "v0B4 integrates no sensor and records none");
    assert.equal(kernel.continuationTraces({ workId: "wrk_v0b3" }).length, 1);
    assert.throws(
      () =>
        kernel.store.db
          .prepare("UPDATE continuation_traces SET action_result='EXECUTED' WHERE id=?")
          .run(trace.id),
      /CONTINUATION_TRACE_APPEND_ONLY/,
      "a trace is history, and history is not rewritten",
    );

    kernel.close();
    const reopened = openKernel({ dir });
    assert.equal(reopened.status().schemaVersion, 5);
    assert.equal(reopened.status().counts.continuationTraces, 1);
    assert.equal(reopened.workProjection("wrk_v0b3").outcome.state, "ACCEPTED");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an unknown future schema version still fails clearly after v5 exists", () => {
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

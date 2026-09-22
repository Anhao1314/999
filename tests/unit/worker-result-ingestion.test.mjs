// H0.2 — Atomic Worker result ingestion.
// Contract: docs/contracts/worker-execution-seam-v0.md §4–§6.
//
// The production Worker host delivers a successful result through one Runtime
// command. Artifact recording, the WorkerRun end, the source Task transition and
// the Runtime-derived Review handoff commit together or not at all, and an
// identical replay returns the committed delivery instead of writing a second
// one.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BOUNDS,
  EVENTS,
  STORE_FILE_NAME,
  createContinuationDriver,
} from "../../packages/runtime/index.mjs";
import {
  openTempKernel,
  reopenKernel,
  reviewArtifact,
  seedReviewTeam,
  seedStaffedTask,
  seedWorkReadyForDecision,
} from "../support/kernel.mjs";

const RESULT_DIGEST = "sha256:aaaa000000000000000000000000000000000000000000000000000000000001";
const EVIDENCE_DIGEST = "sha256:bbbb000000000000000000000000000000000000000000000000000000000002";
const REQUEST_KEYS = Object.freeze([
  "workerRunId",
  "generation",
  "artifactId",
  "resultDigest",
  "evidenceDigest",
  "verificationSummary",
  "reviewRequired",
  "reviewRequestId",
]);

// A Task in its first RUNNING attempt, optionally requiring an independent
// review of whatever it delivers.
function seedAttempt(kernel, { reviewCapabilities = [], producerCapabilities = ["capability.x"] } = {}) {
  const seeded = seedStaffedTask(kernel, {
    capabilities: producerCapabilities,
    requiredCapabilities: producerCapabilities,
  });
  if (reviewCapabilities.length > 0)
    kernel.setTaskRequirements({
      taskId: seeded.task.id,
      requiredCapabilities: producerCapabilities,
      reviewCapabilities,
    });
  const started = kernel.startWorkerRun({ taskId: seeded.task.id });
  return { ...seeded, run: started.workerRun, generation: started.generation };
}

const delivery = (flow, over = {}) => ({
  workerRunId: flow.run.id,
  generation: flow.generation,
  resultDigest: RESULT_DIGEST,
  evidenceDigest: EVIDENCE_DIGEST,
  artifact: { kind: "code.patch", title: "the fix", content: "diff --git a/x b/x\n" },
  verificationSummary: "node --test: 12 pass, 0 fail",
  ...over,
});

const eventsOf = (kernel, taskId, kind) =>
  kernel.activity({ taskId, limit: 500 }).filter((entry) => entry.kind === kind);
const receiptOf = (kernel, taskId) => eventsOf(kernel, taskId, EVENTS.WORKER_RESULT_SUBMITTED);

// A producer and a reviewer, with the producing Task already in its first
// attempt and required to hand whatever it delivers to an independent review.
function seedReviewDelivery(kernel) {
  const team = seedReviewTeam(kernel, {
    producerCapabilities: ["capability.produce"],
    reviewerCapabilities: ["capability.review"],
  });
  const task = kernel.createTask({
    workId: team.work.id,
    title: "Deliver the thing",
    intent: "One output the founder can act on",
  });
  kernel.setTaskRequirements({
    taskId: task.id,
    requiredCapabilities: ["capability.produce"],
    reviewCapabilities: ["capability.review"],
  });
  kernel.assignTask({ taskId: task.id, employeeId: team.producer.id, reason: "fixture" });
  const started = kernel.startWorkerRun({ taskId: task.id });
  return { ...team, task, run: started.workerRun, generation: started.generation };
}

test("a successful delivery records the Artifact, the run end and the Task completion together", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedAttempt(kernel);
    const delivered = kernel.submitWorkerResult(delivery(flow));
    assert.equal(delivered.idempotent, false);
    assert.equal(delivered.reviewRequired, false);
    assert.equal(delivered.reviewTask, null);
    assert.equal(delivered.artifact.kind, "code.patch");
    assert.equal(delivered.workerRun.state, "COMPLETED");
    assert.equal(delivered.workerRun.endReason, "WORK_COMPLETED");
    assert.equal(delivered.task.state, "COMPLETED");
    const detail = kernel.taskDetail(flow.task.id);
    assert.equal(detail.artifacts.length, 1, "exactly one Artifact is recorded");
    assert.equal(detail.artifacts[0].workerRunId, flow.run.id, "the Artifact names its producer run");
    const projection = kernel.workProjection(flow.work.id);
    assert.equal(projection.status, "READY_FOR_DECISION");
    assert.equal(projection.outcome.state, "READY");
    assert.equal(projection.outcome.candidateArtifacts.length, 1);
    assert.equal(projection.outcome.candidateArtifacts[0].id, delivered.artifact.id);
  } finally {
    cleanup();
  }
});

test("the Runtime derives the review handoff from the Task's requirements", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedAttempt(kernel, { reviewCapabilities: ["capability.review"] });
    const delivered = kernel.submitWorkerResult(delivery(flow));
    assert.equal(delivered.reviewRequired, true);
    assert.equal(delivered.workerRun.state, "COMPLETED");
    assert.equal(delivered.task.state, "COMPLETED");
    assert.equal(delivered.reviewTask.state, "OPEN");
    assert.equal(kernel.taskDetail(flow.task.id).artifacts.length, 1);
    const projection = kernel.workProjection(flow.work.id);
    assert.notEqual(
      projection.status,
      "READY_FOR_DECISION",
      "the Founder cannot decide before the required Review",
    );
    assert.equal(projection.collaboration.pendingReviewTaskIds.length, 1);
    assert.throws(
      () =>
        kernel.acceptWork({
          workId: flow.work.id,
          artifactId: delivered.artifact.id,
          artifactDigest: delivered.artifact.contentDigest,
          basis: projection.decisionBasis,
        }),
      (error) => error.code === "WORK_NOT_READY_FOR_DECISION",
    );
  } finally {
    cleanup();
  }
});

test("the ReviewRequest binds the exact Artifact and digest", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedAttempt(kernel, { reviewCapabilities: ["capability.review"] });
    const delivered = kernel.submitWorkerResult(delivery(flow));
    assert.equal(delivered.reviewRequest.sourceTaskId, flow.task.id);
    assert.equal(delivered.reviewRequest.targetArtifactId, delivered.artifact.id);
    assert.equal(
      delivered.reviewRequest.targetArtifactDigest,
      delivered.artifact.contentDigest,
      "the review target is the recorded digest, not a re-derived one",
    );
    assert.equal(
      delivered.reviewRequest.reviewTaskId,
      delivered.reviewTask.id,
      "the Review Task and the request point at each other",
    );
  } finally {
    cleanup();
  }
});

test("an identical replay is idempotent and writes nothing", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedAttempt(kernel);
    const first = kernel.submitWorkerResult(delivery(flow));
    const activityBefore = kernel.activity({ taskId: flow.task.id, limit: 500 }).length;
    const replay = kernel.submitWorkerResult(delivery(flow));
    assert.equal(replay.idempotent, true);
    assert.equal(replay.artifact.id, first.artifact.id);
    assert.equal(replay.workerRun.id, first.workerRun.id);
    assert.equal(kernel.taskDetail(flow.task.id).artifacts.length, 1, "no second Artifact");
    assert.equal(
      kernel.activity({ taskId: flow.task.id, limit: 500 }).length,
      activityBefore,
      "no duplicate Activity",
    );
    assert.equal(receiptOf(kernel, flow.task.id).length, 1);
  } finally {
    cleanup();
  }
});

test("a lost response is replayed as the committed delivery", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedAttempt(kernel, { reviewCapabilities: ["capability.review"] });
    const committed = kernel.submitWorkerResult(delivery(flow));
    // The host never saw the response; all it can do is send the same request.
    const replayed = kernel.submitWorkerResult(delivery(flow));
    assert.equal(replayed.idempotent, true);
    assert.equal(replayed.artifact.id, committed.artifact.id);
    assert.equal(replayed.reviewRequest.id, committed.reviewRequest.id);
    assert.equal(replayed.reviewTask.id, committed.reviewTask.id);
    const projection = kernel.workProjection(flow.work.id);
    assert.equal(projection.collaboration.pendingReviewTaskIds.length, 1, "one Review Task, not two");
    assert.equal(projection.collaboration.round, 1, "no second review round");
    assert.equal(receiptOf(kernel, flow.task.id).length, 1);
  } finally {
    cleanup();
  }
});

test("the same attempt cannot deliver a different result", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedAttempt(kernel);
    const first = kernel.submitWorkerResult(delivery(flow));
    assert.throws(
      () => kernel.submitWorkerResult(delivery(flow, { resultDigest: "sha256:cccc000000000000000000000000000000000000000000000000000000000003" })),
      (error) => error.code === "WORKER_RESULT_CONFLICT",
    );
    assert.equal(kernel.taskDetail(flow.task.id).artifacts.length, 1);
    assert.equal(kernel.artifact(first.artifact.id).contentDigest, first.artifact.contentDigest);
  } finally {
    cleanup();
  }
});

test("a failure after the Artifact insert rolls the whole delivery back", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedAttempt(kernel, { reviewCapabilities: ["capability.review"] });
    const original = kernel.store.insertReviewRequest.bind(kernel.store);
    kernel.store.insertReviewRequest = () => {
      throw new Error("injected failure after the Artifact insert");
    };
    try {
      assert.throws(() => kernel.submitWorkerResult(delivery(flow)), /injected failure/);
    } finally {
      kernel.store.insertReviewRequest = original;
    }
    const detail = kernel.taskDetail(flow.task.id);
    assert.equal(detail.artifacts.length, 0, "no Artifact survives the rollback");
    assert.equal(detail.reviewRequest, null);
    assert.equal(detail.task.state, "RUNNING");
    assert.equal(detail.task.generation, flow.generation);
    assert.equal(kernel.workerRun(flow.run.id).state, "RUNNING");
    assert.equal(kernel.employee(flow.employee.id).availability, "BUSY");
    assert.equal(kernel.workProjection(flow.work.id).status, "ACTIVE");
    assert.equal(receiptOf(kernel, flow.task.id).length, 0, "no receipt for a delivery that did not commit");
    // The same attempt can still deliver once the fault is gone.
    const delivered = kernel.submitWorkerResult(delivery(flow));
    assert.equal(delivered.idempotent, false);
    assert.equal(kernel.taskDetail(flow.task.id).artifacts.length, 1);
  } finally {
    cleanup();
  }
});

test("a stale generation is refused and writes nothing", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedAttempt(kernel);
    assert.throws(
      () => kernel.submitWorkerResult(delivery(flow, { generation: flow.generation + 1 })),
      (error) => error.code === "STALE_GENERATION",
    );
    const detail = kernel.taskDetail(flow.task.id);
    assert.equal(detail.artifacts.length, 0);
    assert.equal(detail.task.state, "RUNNING");
    assert.equal(kernel.workerRun(flow.run.id).state, "RUNNING");
  } finally {
    cleanup();
  }
});

test("an interrupted attempt cannot deliver a result", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedAttempt(kernel);
    kernel.interruptWorkerRun({
      workerRunId: flow.run.id,
      generation: flow.generation,
      reason: "WORKER_TIMEOUT",
    });
    assert.throws(
      () => kernel.submitWorkerResult(delivery(flow)),
      (error) => error.code === "INVALID_TRANSITION",
    );
    assert.equal(kernel.taskDetail(flow.task.id).artifacts.length, 0);
    assert.equal(kernel.workProjection(flow.work.id).outcome.candidateArtifacts.length, 0);
  } finally {
    cleanup();
  }
});

test("an orphan attempt cannot deliver after a newer one exists", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedAttempt(kernel);
    kernel.interruptWorkerRun({
      workerRunId: flow.run.id,
      generation: flow.generation,
      reason: "WORKER_PROCESS_EXIT",
    });
    const second = kernel.startWorkerRun({ taskId: flow.task.id });
    assert.notEqual(second.generation, flow.generation, "the retry holds a new generation");
    assert.throws(
      () => kernel.submitWorkerResult(delivery(flow)),
      (error) => error.code === "INVALID_TRANSITION",
      "the abandoned attempt can never deliver",
    );
    const delivered = kernel.submitWorkerResult(delivery({ ...flow, run: second.workerRun, generation: second.generation }));
    assert.equal(delivered.artifact.generation, second.generation);
    assert.equal(kernel.taskDetail(flow.task.id).artifacts.length, 1);
  } finally {
    cleanup();
  }
});

test("an abandoned generation's Artifact never becomes a current candidate", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedAttempt(kernel);
    // The pre-H0.2 path could leave an Artifact behind with the attempt still
    // open; the recovery then interrupts the attempt.
    const orphan = kernel.recordArtifact({
      taskId: flow.task.id,
      generation: flow.generation,
      workerRunId: flow.run.id,
      kind: "code.patch",
      title: "abandoned attempt output",
      content: "orphan bytes\n",
    });
    kernel.interruptWorkerRun({
      workerRunId: flow.run.id,
      generation: flow.generation,
      reason: "WORKER_TIMEOUT",
    });
    const second = kernel.startWorkerRun({ taskId: flow.task.id });
    const delivered = kernel.submitWorkerResult(
      delivery({ ...flow, run: second.workerRun, generation: second.generation }),
    );
    const detail = kernel.taskDetail(flow.task.id);
    assert.equal(detail.artifacts.length, 2, "history stays readable and immutable");
    assert.equal(kernel.artifact(orphan.id).content, "orphan bytes\n");
    const projection = kernel.workProjection(flow.work.id);
    assert.equal(projection.outcome.state, "READY", "one current candidate, never AMBIGUOUS");
    assert.equal(projection.outcome.candidateArtifacts.length, 1);
    assert.equal(projection.outcome.candidateArtifacts[0].id, delivered.artifact.id);
    assert.equal(projection.outcome.candidateArtifacts[0].generation, second.generation);
    assert.equal(projection.status, "READY_FOR_DECISION");
    assert.ok(
      !projection.founderAttention.diagnostics.some((entry) => entry.code === "OUTCOME_AMBIGUOUS"),
      "no false ambiguity is manufactured out of abandoned history",
    );
  } finally {
    cleanup();
  }
});

test("the current generation's Artifact is the candidate and the only one", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedAttempt(kernel);
    const delivered = kernel.submitWorkerResult(delivery(flow));
    const projection = kernel.workProjection(flow.work.id);
    assert.deepEqual(
      projection.outcome.candidateArtifacts.map((entry) => entry.id),
      [delivered.artifact.id],
    );
    assert.equal(projection.founderAttention.item.kind, "DECISION_REQUIRED");
    assert.equal(
      projection.founderAttention.item.actions[0].artifactId,
      delivered.artifact.id,
      "the only exit the Founder is offered names the delivered Artifact",
    );
  } finally {
    cleanup();
  }
});

test("Repair supersession keeps its exact rules through the delivery seam", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedReviewDelivery(kernel);
    const first = kernel.submitWorkerResult(delivery(flow));
    kernel.assignTask({ taskId: first.reviewTask.id, employeeId: flow.reviewer.id, reason: "fixture" });
    const reviewRun = kernel.startWorkerRun({ taskId: first.reviewTask.id });
    const requested = kernel.submitReview({
      reviewTaskId: first.reviewTask.id,
      generation: reviewRun.generation,
      verdict: "REQUEST_REVISION",
      summary: "The evidence does not support the conclusion.",
      findings: ["Add the downside case."],
    });
    const repair = kernel.createRepairTask({ reviewId: requested.review.id });
    const repairRun = kernel.startWorkerRun({ taskId: repair.task.id });
    const repairDelivery = (over = {}) =>
      delivery(
        { run: repairRun.workerRun, generation: repairRun.generation },
        {
          artifact: {
            kind: "code.patch",
            title: "the repaired fix",
            content: "diff --git a/x b/x\nrepaired\n",
            ...(over.artifact ?? {}),
          },
          ...over,
        },
      );
    assert.throws(
      () => kernel.submitWorkerResult(repairDelivery()),
      (error) => error.code === "SUPERSEDES_REQUIRED",
    );
    assert.throws(
      () =>
        kernel.submitWorkerResult(
          repairDelivery({
            artifact: {
              kind: "code.patch",
              title: "the repaired fix",
              content: "diff --git a/x b/x\nrepaired\n",
              supersedesArtifactId: flow.run.id,
            },
          }),
        ),
      (error) => error.code === "SUPERSEDES_NOT_FOUND",
    );
    const repaired = kernel.submitWorkerResult(
      repairDelivery({
        artifact: {
          kind: "code.patch",
          title: "the repaired fix",
          content: "diff --git a/x b/x\nrepaired\n",
          supersedesArtifactId: first.artifact.id,
        },
      }),
    );
    assert.equal(repaired.artifact.supersedesArtifactId, first.artifact.id);
    const projection = kernel.workProjection(flow.work.id);
    assert.equal(projection.outcome.state, "READY");
    assert.equal(projection.outcome.candidateArtifacts.length, 1);
    assert.equal(projection.outcome.candidateArtifacts[0].id, repaired.artifact.id);
    assert.equal(projection.collaboration.round, 2);
  } finally {
    cleanup();
  }
});

test("the delivery seam refuses a caller-chosen handoff", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedAttempt(kernel, { reviewCapabilities: ["capability.review"] });
    for (const override of [
      { handoff: "COMPLETE" },
      { reviewRequired: false },
      { completeTask: true },
      { reviewVerdict: "PASS" },
      { founderDecision: "ACCEPTED" },
      { employeeId: flow.employee.id },
    ]) {
      assert.throws(
        () => kernel.submitWorkerResult(delivery(flow, override)),
        (error) => error.code === "INVALID_INPUT",
        `the caller must not be able to pass ${Object.keys(override)[0]}`,
      );
    }
    const delivered = kernel.submitWorkerResult(delivery(flow));
    assert.equal(delivered.reviewRequired, true, "the Runtime still requires the Review");
    assert.equal(kernel.taskDetail(flow.task.id).artifacts.length, 1);
  } finally {
    cleanup();
  }
});

test("the full Harness evidence never reaches the store", () => {
  const { kernel, dir, cleanup } = openTempKernel();
  try {
    const flow = seedAttempt(kernel);
    const rawEvidence = `RAW_EVIDENCE_MARKER_${flow.task.id}\n${"x".repeat(40_000)}`;
    const delivered = kernel.submitWorkerResult(
      delivery(flow, { verificationSummary: "node --test: 12 pass, 0 fail" }),
    );
    assert.deepEqual(
      Object.keys(receiptOf(kernel, flow.task.id)[0].detail).sort(),
      [...REQUEST_KEYS].sort(),
      "the receipt carries exactly the frozen, bounded facts",
    );
    const storeBytes = readFileSync(join(dir, STORE_FILE_NAME)).toString("utf8");
    assert.ok(
      !storeBytes.includes("RAW_EVIDENCE_MARKER"),
      "only the evidence digest is durable; the evidence itself is not",
    );
    assert.ok(!storeBytes.includes("x".repeat(1000)), "no full logs in the store");
    assert.ok(
      receiptOf(kernel, flow.task.id)[0].detail.verificationSummary.length <=
        BOUNDS.workerVerificationSummaryMax,
    );
    assert.throws(
      () =>
        kernel.submitWorkerResult(
          delivery(flow, { verificationSummary: "y".repeat(BOUNDS.workerVerificationSummaryMax + 1) }),
        ),
      (error) => error.code === "INVALID_INPUT",
      "an oversized summary is refused before it can describe any attempt",
    );
    assert.equal(delivered.evidenceDigest, EVIDENCE_DIGEST);
  } finally {
    cleanup();
  }
});

test("the submission receipt is durable across a restart", () => {
  const { kernel, dir, cleanup } = openTempKernel();
  try {
    const flow = seedAttempt(kernel, { reviewCapabilities: ["capability.review"] });
    const delivered = kernel.submitWorkerResult(delivery(flow));
    kernel.close();
    const reopened = reopenKernel(dir);
    const receipt = reopened.store.resultSubmissionForRun(flow.run.id);
    assert.ok(receipt, "the receipt survives the restart");
    assert.equal(receipt.detail.workerRunId, flow.run.id);
    assert.equal(receipt.detail.generation, flow.generation);
    assert.equal(receipt.detail.artifactId, delivered.artifact.id);
    assert.equal(receipt.detail.resultDigest, RESULT_DIGEST);
    assert.equal(receipt.detail.evidenceDigest, EVIDENCE_DIGEST);
    assert.equal(receipt.detail.reviewRequired, true);
    assert.equal(receipt.detail.reviewRequestId, delivered.reviewRequest.id);
    assert.equal(reopened.recovery.count, 0, "a completed delivery leaves nothing to recover");
    const replay = reopened.submitWorkerResult(delivery(flow));
    assert.equal(replay.idempotent, true, "the replay works across a restart too");
    assert.equal(replay.artifact.id, delivered.artifact.id);
    assert.equal(reopened.taskDetail(flow.task.id).artifacts.length, 1);
  } finally {
    cleanup();
  }
});

test("v0B3 acceptance invariants are unchanged for a delivered Artifact", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const team = seedReviewDelivery(kernel);
    const delivered = kernel.submitWorkerResult(delivery(team));
    assert.throws(
      () =>
        kernel.acceptWork({
          workId: team.work.id,
          artifactId: delivered.artifact.id,
          artifactDigest: delivered.artifact.contentDigest,
          basis: kernel.workProjection(team.work.id).decisionBasis,
        }),
      (error) => error.code === "WORK_NOT_READY_FOR_DECISION",
    );
    const review = reviewArtifact(kernel, {
      reviewTaskId: delivered.reviewTask.id,
      reviewerId: team.reviewer.id,
      verdict: "PASS",
      summary: "The output matches the intent and the tests it names.",
    });
    assert.equal(review.verdict, "PASS");
    const projection = kernel.workProjection(team.work.id);
    assert.equal(projection.status, "READY_FOR_DECISION");
    assert.equal(projection.outcome.candidateArtifacts.length, 1);
    const decided = kernel.acceptWork({
      workId: team.work.id,
      artifactId: delivered.artifact.id,
      artifactDigest: delivered.artifact.contentDigest,
      basis: projection.decisionBasis,
    });
    assert.equal(decided.decision.disposition, "ACCEPT");
    assert.equal(decided.decision.artifactId, delivered.artifact.id);
    const after = kernel.workProjection(team.work.id);
    assert.equal(after.outcome.state, "ACCEPTED");
    assert.equal(after.outcome.accepted.decisionId, decided.decision.id);
  } finally {
    cleanup();
  }
});

test("v0B4 continuation acts on the committed delivery, never inside it", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const team = seedReviewDelivery(kernel);
    const delivered = kernel.submitWorkerResult(delivery(team));
    assert.equal(
      kernel.task(delivered.reviewTask.id).state,
      "OPEN",
      "the delivery commits the handoff and stops there",
    );
    const driver = createContinuationDriver({ kernel });
    driver.driveWork(team.work.id, { triggerType: "EXPLICIT" });
    const reviewTask = kernel.task(delivered.reviewTask.id);
    assert.notEqual(reviewTask.state, "OPEN", "the Driver dispatches the Review Task it was handed");
    assert.equal(
      kernel.taskDetail(delivered.reviewTask.id).assignment.employeeId,
      team.reviewer.id,
      "the reviewer is the employee whose position carries the review capability",
    );
  } finally {
    cleanup();
  }
});

test("a Work at the decision boundary is still never re-driven", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedWorkReadyForDecision(kernel);
    const driver = createContinuationDriver({ kernel });
    const before = kernel.workProjection(flow.work.id);
    assert.equal(before.status, "READY_FOR_DECISION");
    const driven = driver.driveWork(flow.work.id, { triggerType: "EXPLICIT" });
    assert.equal(driven.boundary, "READY_FOR_DECISION");
    assert.equal(driven.steps, 0);
    const after = kernel.workProjection(flow.work.id);
    assert.equal(after.status, "READY_FOR_DECISION");
    assert.equal(after.decisionBasis, before.decisionBasis);
    assert.equal(after.outcome.candidateArtifacts.length, 1);
  } finally {
    cleanup();
  }
});

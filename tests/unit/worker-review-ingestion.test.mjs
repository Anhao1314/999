// Harness Slice 1.1 — atomic Reviewer Worker delivery.
// Contract: docs/contracts/worker-harness-v0.md §15.
//
// A Reviewer Worker reports a judgment; the Runtime derives the whole lineage
// from the WorkerRun, writes the Review through its one Review primitive, and
// records a bounded receipt in the same transaction. Nothing here is Founder
// approval, and nothing here creates a Repair behind the existing protocol.
import test from "node:test";
import assert from "node:assert/strict";
import { EVENTS, createContinuationDriver } from "../../packages/runtime/index.mjs";
import {
  newAssignment,
  newWorkerRun,
} from "../../packages/workforce/index.mjs";
import {
  openTempKernel,
  reopenKernel,
  reviewArtifact,
  seedTaskInReview,
  startReviewRun,
} from "../support/kernel.mjs";

const RESULT_DIGEST = "sha256:cccc000000000000000000000000000000000000000000000000000000000003";
const EVIDENCE_DIGEST = "sha256:dddd000000000000000000000000000000000000000000000000000000000004";

// The producing half of the protocol plus a RUNNING reviewer attempt: the state
// the Runtime leaves behind when it dispatches a Review Task to a Worker.
function seedAttemptInReview(kernel) {
  const flow = seedTaskInReview(kernel);
  const handoff = kernel.requestReview({
    taskId: flow.task.id,
    generation: flow.generation,
  });
  const started = startReviewRun(kernel, {
    reviewTaskId: handoff.reviewTask.id,
    reviewerId: flow.reviewer.id,
  });
  return {
    ...flow,
    sourceRun: flow.workerRun,
    reviewTask: handoff.reviewTask,
    reviewRequest: handoff.reviewRequest,
    run: started.workerRun,
    generation: started.generation,
  };
}

const judgment = (flow, over = {}) => ({
  workerRunId: flow.run.id,
  generation: flow.generation,
  resultDigest: RESULT_DIGEST,
  evidenceDigest: EVIDENCE_DIGEST,
  verdict: "PASS",
  summary: "The output matches the intent and the tests it names.",
  findings: [],
  ...over,
});

const eventsOf = (kernel, taskId, kind) =>
  kernel.activity({ taskId, limit: 500 }).filter((entry) => entry.kind === kind);
const reviewReceipts = (kernel, taskId) =>
  eventsOf(kernel, taskId, EVENTS.WORKER_REVIEW_RESULT_SUBMITTED);

test("a PASS judgment records the Review, ends the attempt and completes the Review Task together", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedAttemptInReview(kernel);
    const delivered = kernel.submitWorkerReviewResult(judgment(flow));

    assert.equal(delivered.idempotent, false);
    assert.equal(delivered.review.verdict, "PASS");
    assert.equal(delivered.review.reviewTaskId, flow.reviewTask.id);
    assert.equal(
      delivered.review.reviewerWorkerRunId,
      flow.run.id,
      "the Review names the attempt that reported it",
    );
    assert.equal(delivered.review.targetArtifactId, flow.artifact.id);
    assert.equal(delivered.review.targetArtifactDigest, flow.artifact.contentDigest);
    assert.equal(delivered.workerRun.state, "COMPLETED");
    assert.equal(delivered.workerRun.endReason, "REVIEW_COMPLETED");
    assert.equal(delivered.task.state, "COMPLETED");

    const kinds = eventsOf(kernel, flow.reviewTask.id, EVENTS.REVIEW_SUBMITTED);
    assert.equal(kinds.length, 1, "exactly one Review was written");
    assert.equal(eventsOf(kernel, flow.reviewTask.id, EVENTS.REVIEW_PASSED).length, 1);
    assert.equal(eventsOf(kernel, flow.reviewTask.id, EVENTS.REVISION_REQUESTED).length, 0);

    const projection = kernel.workProjection(flow.work.id);
    assert.equal(projection.status, "READY_FOR_DECISION");
    assert.equal(projection.outcome.candidateArtifacts[0].id, flow.artifact.id);
    assert.equal(projection.outcome.accepted, null, "a Reviewer PASS is not an acceptance");
    assert.equal(kernel.status().counts.founderDecisions, 0);
  } finally {
    cleanup();
  }
});

test("the receipt is bounded metadata, never evidence, logs or worker output", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedAttemptInReview(kernel);
    kernel.submitWorkerReviewResult(
      judgment(flow, { verificationSummary: "the reviewer read the artifact it was given" }),
    );
    const receipts = reviewReceipts(kernel, flow.reviewTask.id);
    assert.equal(receipts.length, 1);
    assert.deepEqual(Object.keys(receipts[0].detail).sort(), [
      "evidenceDigest",
      "generation",
      "resultDigest",
      "reviewId",
      "verificationSummary",
      "workerRunId",
    ]);
    assert.equal(receipts[0].detail.workerRunId, flow.run.id);
    assert.equal(receipts[0].detail.generation, flow.generation);
    assert.equal(receipts[0].detail.resultDigest, RESULT_DIGEST);
    assert.equal(receipts[0].detail.evidenceDigest, EVIDENCE_DIGEST);
    assert.equal(receipts[0].detail.reviewId, kernel.reviews({ workId: flow.work.id })[0].id);
  } finally {
    cleanup();
  }
});

test("a REQUEST_REVISION judgment records the Review and stops there — the Repair stays Runtime-owned", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedAttemptInReview(kernel);
    const delivered = kernel.submitWorkerReviewResult(
      judgment(flow, {
        verdict: "REQUEST_REVISION",
        summary: "The recommendation is not supported by the evidence supplied.",
        findings: ["Add the downside case."],
      }),
    );
    assert.equal(delivered.review.verdict, "REQUEST_REVISION");
    assert.deepEqual(delivered.review.findings, ["Add the downside case."]);
    assert.equal(
      kernel.repairBindings({ workId: flow.work.id }).length,
      0,
      "no Repair is created inside the delivery transaction",
    );
    assert.equal(
      eventsOf(kernel, flow.reviewTask.id, EVENTS.REVISION_REQUESTED).length,
      1,
      "the existing revision Activity is what the Runtime appends",
    );
    // The work now waits for the continuation policy, which owns Repair
    // creation — the same protocol as any other REQUEST_REVISION review.
    const projection = kernel.workProjection(flow.work.id);
    assert.equal(projection.status, "BLOCKED");
    assert.deepEqual(projection.collaboration.unownedRevisionReviewIds, [
      delivered.review.id,
    ]);
    const driver = createContinuationDriver({ kernel });
    driver.driveWork(flow.work.id, { triggerType: "EXPLICIT" });
    const [repair] = kernel.repairBindings({ workId: flow.work.id });
    assert.equal(repair.reviewId, delivered.review.id);
    assert.equal(repair.targetArtifactId, flow.artifact.id);
    assert.equal(repair.sourceTaskId, flow.task.id);
  } finally {
    cleanup();
  }
});

test("REQUEST_REVISION without findings is refused, and writes nothing", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedAttemptInReview(kernel);
    assert.throws(
      () =>
        kernel.submitWorkerReviewResult(
          judgment(flow, { verdict: "REQUEST_REVISION", findings: [] }),
        ),
      { code: "FINDINGS_REQUIRED" },
    );
    assert.equal(kernel.status().counts.reviews, 0);
    assert.equal(kernel.workerRun(flow.run.id).state, "RUNNING", "the attempt is untouched");
    assert.equal(kernel.task(flow.reviewTask.id).state, "RUNNING");
  } finally {
    cleanup();
  }
});

test("the Review binds to the Artifact the ReviewRequest names, not to the newest one", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedAttemptInReview(kernel);
    // A second artifact exists on the work (a later repair) while this review
    // still judges the artifact its own request named.
    const second = kernel.createTask({
      workId: flow.work.id,
      title: "An unrelated second output",
      intent: "One output the founder can act on",
    });
    kernel.setTaskRequirements({
      taskId: second.id,
      requiredCapabilities: ["capability.produce"],
      reviewCapabilities: [],
    });
    kernel.assignTask({ taskId: second.id, employeeId: flow.producer.id, reason: "fixture" });
    const secondRun = kernel.startWorkerRun({ taskId: second.id });
    const newer = kernel.recordArtifact({
      taskId: second.id,
      generation: secondRun.generation,
      workerRunId: secondRun.workerRun.id,
      kind: "document",
      title: "Newer output",
      content: "newer\n",
    });

    const delivered = kernel.submitWorkerReviewResult(judgment(flow));
    assert.equal(delivered.review.targetArtifactId, flow.artifact.id);
    assert.equal(delivered.review.targetArtifactDigest, flow.artifact.contentDigest);
    assert.notEqual(delivered.review.targetArtifactId, newer.id);
  } finally {
    cleanup();
  }
});

test("the target binding cannot drift: both the Artifact and its ReviewRequest are immutable", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedAttemptInReview(kernel);
    // The delivery validates artifact-vs-request, and storage guarantees the two
    // sides can never disagree: neither row can be rewritten after the fact.
    assert.throws(
      () =>
        kernel.store.db
          .prepare("UPDATE artifacts SET content_digest=? WHERE id=?")
          .run("sha256:tampered", flow.artifact.id),
      /ARTIFACT_IMMUTABLE/,
    );
    assert.throws(
      () =>
        kernel.store.db
          .prepare("UPDATE review_requests SET target_artifact_digest=? WHERE id=?")
          .run("sha256:tampered", flow.reviewRequest.id),
      /REVIEW_REQUEST_IMMUTABLE/,
    );
    assert.equal(kernel.artifact(flow.artifact.id).contentDigest, flow.artifact.contentDigest);
    assert.equal(
      kernel.reviewRequest(flow.reviewRequest.id).targetArtifactDigest,
      flow.artifact.contentDigest,
    );
  } finally {
    cleanup();
  }
});

test("reviewer independence is enforced again at delivery, even for a hand-written run", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedAttemptInReview(kernel);
    // End the independent attempt and hand the Review Task to its own producer,
    // exactly as a migrated or hand-written store could: the delivery seam must
    // still refuse the judgment.
    kernel.store.updateWorkerRun(flow.run.id, {
      state: "CANCELLED",
      endedAt: "2026-09-20T10:00:00.000Z",
      endReason: "FIXTURE",
    });
    kernel.store.insertAssignment(
      newAssignment({
        companyId: flow.company.id,
        taskId: flow.reviewTask.id,
        employeeId: flow.producer.id,
        positionId: flow.producerPosition.id,
        reason: "legacy fixture",
        createdAt: "2026-09-20T10:00:00.001Z",
      }),
    );
    kernel.store.insertWorkerRun(
      newWorkerRun({
        companyId: flow.company.id,
        workId: flow.work.id,
        taskId: flow.reviewTask.id,
        employeeId: flow.producer.id,
        positionId: flow.producerPosition.id,
        generation: kernel.task(flow.reviewTask.id).generation + 7,
        workPacket: {},
        workPacketDigest: "sha256:fixture",
        startedAt: "2026-09-20T10:00:00.002Z",
      }),
    );
    const selfReview = kernel.workerRuns({ taskId: flow.reviewTask.id, state: "RUNNING" })[0];
    assert.throws(
      () =>
        kernel.submitWorkerReviewResult({
          workerRunId: selfReview.id,
          generation: selfReview.generation,
          resultDigest: RESULT_DIGEST,
          evidenceDigest: EVIDENCE_DIGEST,
          verdict: "PASS",
          summary: "I approve my own work.",
        }),
      { code: "REVIEWER_NOT_INDEPENDENT" },
    );
    assert.equal(kernel.status().counts.reviews, 0);
  } finally {
    cleanup();
  }
});

test("an identical replay converges on the committed Review, and writes nothing twice", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedAttemptInReview(kernel);
    const first = kernel.submitWorkerReviewResult(judgment(flow));
    const counts = kernel.status().counts;
    const activity = kernel.activity({ workId: flow.work.id, limit: 500 });

    // The response was lost: the host retries the same submission.
    const replay = kernel.submitWorkerReviewResult(judgment(flow));
    assert.equal(replay.idempotent, true);
    assert.equal(replay.review.id, first.review.id);
    assert.equal(replay.resultDigest, RESULT_DIGEST);
    assert.deepEqual(kernel.status().counts, counts, "no duplicate Review, Task or receipt");
    assert.deepEqual(kernel.activity({ workId: flow.work.id, limit: 500 }), activity);
  } finally {
    cleanup();
  }
});

test("the same attempt cannot rewrite its judgment: a different digest is a 409", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedAttemptInReview(kernel);
    const first = kernel.submitWorkerReviewResult(judgment(flow));
    assert.throws(
      () =>
        kernel.submitWorkerReviewResult(
          judgment(flow, {
            resultDigest: "sha256:eeee000000000000000000000000000000000000000000000000000000000005",
            verdict: "REQUEST_REVISION",
            findings: ["Actually, no."],
          }),
        ),
      { code: "WORKER_REVIEW_RESULT_CONFLICT", status: 409 },
    );
    const [review] = kernel.reviews({ workId: flow.work.id });
    assert.equal(review.id, first.review.id);
    assert.equal(review.verdict, "PASS", "the recorded judgment is immutable");
  } finally {
    cleanup();
  }
});

test("a stale generation is refused, and changes nothing", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedAttemptInReview(kernel);
    assert.throws(
      () => kernel.submitWorkerReviewResult(judgment(flow, { generation: flow.generation - 1 })),
      { code: "STALE_GENERATION" },
    );
    assert.equal(kernel.status().counts.reviews, 0);
    assert.equal(kernel.workerRun(flow.run.id).state, "RUNNING");
  } finally {
    cleanup();
  }
});

test("an interrupted Reviewer attempt cannot deliver a judgment", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedAttemptInReview(kernel);
    kernel.interruptWorkerRun({
      workerRunId: flow.run.id,
      generation: flow.generation,
      reason: "WORKER_TIMEOUT",
    });
    assert.throws(() => kernel.submitWorkerReviewResult(judgment(flow)), {
      code: "INVALID_TRANSITION",
    });
    assert.equal(kernel.status().counts.reviews, 0);
  } finally {
    cleanup();
  }
});

test("an execution attempt cannot deliver a judgment, and a review attempt cannot name its lineage", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedTaskInReview(kernel);
    assert.throws(
      () =>
        kernel.submitWorkerReviewResult({
          workerRunId: flow.workerRun.id,
          generation: flow.generation,
          resultDigest: RESULT_DIGEST,
          evidenceDigest: EVIDENCE_DIGEST,
          verdict: "PASS",
          summary: "Nothing to review here.",
        }),
      { code: "REVIEW_TASK_NOT_REVIEWABLE" },
    );
    // The host cannot choose what is being judged or who judges it.
    assert.throws(
      () =>
        kernel.submitWorkerReviewResult(
          judgment({ ...flow, run: { id: flow.workerRun.id }, generation: flow.generation }, {
            reviewTaskId: "tsk_anything",
            targetArtifactId: flow.artifact.id,
            targetArtifactDigest: flow.artifact.contentDigest,
            reviewerEmployeeId: flow.reviewer.id,
            reviewRequestId: "rr_anything",
          }),
        ),
      { code: "INVALID_INPUT" },
    );
  } finally {
    cleanup();
  }
});

test("a failed receipt write rolls the whole delivery back, and the retry then succeeds", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedAttemptInReview(kernel);
    const realAppend = kernel.store.appendActivity.bind(kernel.store);
    kernel.store.appendActivity = (event) => {
      if (event.kind === EVENTS.WORKER_REVIEW_RESULT_SUBMITTED) throw new Error("storage fell over");
      return realAppend(event);
    };
    assert.throws(() => kernel.submitWorkerReviewResult(judgment(flow)), /storage fell over/);
    kernel.store.appendActivity = realAppend;

    assert.equal(kernel.status().counts.reviews, 0, "no Review survived the rollback");
    assert.equal(kernel.workerRun(flow.run.id).state, "RUNNING", "the attempt is still live");
    assert.equal(kernel.task(flow.reviewTask.id).state, "RUNNING");
    assert.equal(reviewReceipts(kernel, flow.reviewTask.id).length, 0);

    const delivered = kernel.submitWorkerReviewResult(judgment(flow));
    assert.equal(delivered.idempotent, false);
    assert.equal(delivered.review.verdict, "PASS");
  } finally {
    cleanup();
  }
});

test("the delivery and its receipt survive a restart, and the replay still converges", () => {
  const { kernel, cleanup, dir } = openTempKernel();
  try {
    const flow = seedAttemptInReview(kernel);
    const delivered = kernel.submitWorkerReviewResult(judgment(flow));
    kernel.close();

    const reopened = reopenKernel(dir);
    const receipt = reopened.store.reviewResultSubmissionForRun(flow.run.id);
    assert.ok(receipt, "the receipt is durable");
    assert.equal(receipt.detail.reviewId, delivered.review.id);
    assert.equal(receipt.detail.resultDigest, RESULT_DIGEST);
    assert.equal(receipt.detail.evidenceDigest, EVIDENCE_DIGEST);
    assert.equal(reopened.recovery.count, 0, "a delivered review leaves nothing to recover");

    const replay = reopened.submitWorkerReviewResult(judgment(flow));
    assert.equal(replay.idempotent, true);
    assert.equal(replay.review.id, delivered.review.id);
    assert.equal(reopened.activity({ taskId: flow.reviewTask.id, limit: 500 })
      .filter((entry) => entry.kind === EVENTS.WORKER_REVIEW_RESULT_SUBMITTED).length, 1);
    reopened.close();
  } finally {
    cleanup();
  }
});

test("PASS is not acceptance: the Founder still decides, and the Repair protocol still follows", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedAttemptInReview(kernel);
    const delivered = kernel.submitWorkerReviewResult(judgment(flow));
    const ready = kernel.workProjection(flow.work.id);
    assert.equal(ready.status, "READY_FOR_DECISION");
    assert.equal(ready.outcome.accepted, null, "PASS alone accepts nothing");
    assert.equal(kernel.status().counts.founderDecisions, 0);
    const accepted = kernel.acceptWork({
      workId: flow.work.id,
      artifactId: delivered.review.targetArtifactId,
      artifactDigest: delivered.review.targetArtifactDigest,
      basis: ready.decisionBasis,
    });
    assert.equal(accepted.decision.disposition, "ACCEPT");

    // The second cycle: REQUEST_REVISION, then the ordinary Repair path with a
    // verdict delivered through the low-level primitive — the protocol is the
    // same one v0B2 froze.
    const second = seedTaskInReview(kernel, { taskTitle: "Produce the second analysis" });
    const handoff = kernel.requestReview({ taskId: second.task.id, generation: second.generation });
    const run = startReviewRun(kernel, {
      reviewTaskId: handoff.reviewTask.id,
      reviewerId: second.reviewer.id,
    });
    const requested = kernel.submitWorkerReviewResult({
      workerRunId: run.workerRun.id,
      generation: run.generation,
      resultDigest: RESULT_DIGEST,
      evidenceDigest: EVIDENCE_DIGEST,
      verdict: "REQUEST_REVISION",
      summary: "The recommendation is not supported by the evidence supplied.",
      findings: ["Add the downside case."],
    });
    const repair = kernel.createRepairTask({ reviewId: requested.review.id });
    assert.equal(repair.repairBinding.reviewId, requested.review.id);
    assert.equal(repair.repairBinding.targetArtifactId, requested.review.targetArtifactId);
    const repairRun = kernel.startWorkerRun({ taskId: repair.task.id });
    const replacement = kernel.recordArtifact({
      taskId: repair.task.id,
      generation: repairRun.generation,
      workerRunId: repairRun.workerRun.id,
      supersedesArtifactId: requested.review.targetArtifactId,
      kind: "document",
      title: "Draft analysis v2",
      content: "draft v2 with the downside case\n",
    });
    const secondHandoff = kernel.requestReview({
      taskId: repair.task.id,
      generation: repairRun.generation,
    });
    const passed = reviewArtifact(kernel, {
      reviewTaskId: secondHandoff.reviewTask.id,
      reviewerId: second.reviewer.id,
      verdict: "PASS",
      summary: "The replacement answers the findings.",
    });
    assert.equal(passed.verdict, "PASS");
    assert.equal(passed.targetArtifactId, replacement.id);
    const outcome = kernel.workProjection(second.work.id).outcome;
    assert.equal(outcome.accepted, null, "a second PASS is still not an acceptance");
    assert.deepEqual(outcome.candidateArtifacts.map((entry) => entry.id), [replacement.id]);
  } finally {
    cleanup();
  }
});

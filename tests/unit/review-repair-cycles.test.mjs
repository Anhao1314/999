import test from "node:test";
import assert from "node:assert/strict";
import { openTempKernel, reopenKernel, seedTaskInReview } from "../support/kernel.mjs";

// One full collaboration round on an existing Task attempt: hand off → a
// reviewer runs → a judgment is recorded.
function reviewRound(kernel, { taskId, generation, reviewerId, verdict, summary, findings = [] }) {
  const handedOff = kernel.requestReview({ taskId, generation });
  kernel.assignTask({
    taskId: handedOff.reviewTask.id,
    employeeId: reviewerId,
    reason: "fixture",
  });
  const run = kernel.startWorkerRun({ taskId: handedOff.reviewTask.id });
  const review = kernel.submitReview({
    reviewTaskId: handedOff.reviewTask.id,
    generation: run.generation,
    verdict,
    summary,
    findings,
  }).review;
  return { handedOff, run, review };
}

// One repair: a new attempt on the repair task, delivering a replacement.
function repairRound(kernel, { reviewId, content }) {
  const repair = kernel.createRepairTask({ reviewId });
  const run = kernel.startWorkerRun({ taskId: repair.task.id });
  const artifact = kernel.recordArtifact({
    taskId: repair.task.id,
    generation: run.generation,
    workerRunId: run.workerRun.id,
    kind: "document",
    title: "Revised analysis",
    content,
    supersedesArtifactId: repair.repairBinding.targetArtifactId,
  });
  return { repair, run, artifact };
}

test("three cycles: revision, revision, then pass — with no loop limit and no counter", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const fixture = seedTaskInReview(kernel, { artifactContent: "draft v1\n" });

    const first = reviewRound(kernel, {
      taskId: fixture.task.id,
      generation: fixture.generation,
      reviewerId: fixture.reviewer.id,
      verdict: "REQUEST_REVISION",
      summary: "Not supported by the evidence.",
      findings: ["Weakens the comparison."],
    });
    const v2 = repairRound(kernel, { reviewId: first.review.id, content: "draft v2\n" });

    const second = reviewRound(kernel, {
      taskId: v2.repair.task.id,
      generation: v2.run.generation,
      reviewerId: fixture.reviewer.id,
      verdict: "REQUEST_REVISION",
      summary: "Still misses the downside case.",
      findings: ["Add the downside case."],
    });
    const v3 = repairRound(kernel, { reviewId: second.review.id, content: "draft v3\n" });

    const third = reviewRound(kernel, {
      taskId: v3.repair.task.id,
      generation: v3.run.generation,
      reviewerId: fixture.reviewer.id,
      verdict: "PASS",
      summary: "The output now answers the task.",
    });
    assert.equal(third.review.verdict, "PASS");

    // Each review judged the artifact of its own cycle — never a moving pointer.
    assert.equal(first.review.targetArtifactId, fixture.artifact.id);
    assert.equal(second.review.targetArtifactId, v2.artifact.id);
    assert.equal(third.review.targetArtifactId, v3.artifact.id);
    assert.notEqual(v2.artifact.id, fixture.artifact.id);
    assert.notEqual(v3.artifact.id, v2.artifact.id);

    const projection = kernel.workProjection(fixture.work.id);
    assert.equal(projection.status, "READY_FOR_DECISION");
    assert.equal(projection.stage, "READY_FOR_DECISION");
    assert.equal(projection.collaboration.outstanding, false);
    assert.equal(projection.collaboration.round, 3, "the cycle number is derived, not stored");
    assert.equal(projection.artifacts.length, 3);
    assert.equal(projection.reviews.length, 3);
    assert.equal(projection.repairBindings.length, 2);
    assert.equal(projection.latestArtifact.id, v3.artifact.id);
    assert.equal(projection.latestReview.id, third.review.id);
    assert.equal(projection.openReviewTask, null);
    assert.equal(projection.openRepairTask, null);
    assert.deepEqual(
      projection.supersession.map((link) => link.artifactId),
      [v2.artifact.id, v3.artifact.id],
    );
    assert.deepEqual(
      kernel.artifacts({ workId: fixture.work.id }).map((artifact) => artifact.content),
      ["draft v1\n", "draft v2\n", "draft v3\n"],
      "every version survives, in order",
    );
    assert.equal(typeof kernel.accept, "undefined");
  } finally {
    cleanup();
  }
});

test("the projection narrates the collaboration as it moves", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const fixture = seedTaskInReview(kernel);
    assert.equal(
      kernel.workProjection(fixture.work.id).stage,
      "EXECUTING",
      "an employee is producing the first output",
    );

    const handedOff = kernel.requestReview({
      taskId: fixture.task.id,
      generation: fixture.generation,
    });
    const waiting = kernel.workProjection(fixture.work.id);
    assert.equal(waiting.stage, "AWAITING_REVIEW");
    assert.equal(waiting.status, "OPEN", "the review is queued, nothing is running");
    assert.equal(waiting.openReviewTask.id, handedOff.reviewTask.id);

    kernel.assignTask({
      taskId: handedOff.reviewTask.id,
      employeeId: fixture.reviewer.id,
      reason: "fixture",
    });
    const reviewRun = kernel.startWorkerRun({ taskId: handedOff.reviewTask.id });
    const reviewing = kernel.workProjection(fixture.work.id);
    assert.equal(reviewing.stage, "REVIEWING");
    assert.equal(reviewing.status, "ACTIVE");

    const review = kernel.submitReview({
      reviewTaskId: handedOff.reviewTask.id,
      generation: reviewRun.generation,
      verdict: "REQUEST_REVISION",
      summary: "Not acceptable.",
      findings: ["Say what has to change."],
    }).review;
    const requested = kernel.workProjection(fixture.work.id);
    assert.equal(requested.stage, "REVISION_REQUESTED");
    assert.equal(requested.status, "BLOCKED", "a human must decide how to continue");
    assert.deepEqual(requested.collaboration.unownedRevisionReviewIds, [review.id]);

    const repair = kernel.createRepairTask({ reviewId: review.id });
    const repairing = kernel.workProjection(fixture.work.id);
    assert.equal(repairing.stage, "REPAIRING");
    assert.equal(repairing.status, "OPEN");
    assert.equal(repairing.openRepairTask.id, repair.task.id);

    assert.equal(
      kernel.workProjection(fixture.work.id).status === "COMPLETED",
      false,
      "COMPLETED is retired from the Work vocabulary",
    );
  } finally {
    cleanup();
  }
});

test("the lineage survives a store reopened by a different process", () => {
  const { dir, kernel, cleanup } = openTempKernel();
  try {
    const fixture = seedTaskInReview(kernel);
    const first = reviewRound(kernel, {
      taskId: fixture.task.id,
      generation: fixture.generation,
      reviewerId: fixture.reviewer.id,
      verdict: "REQUEST_REVISION",
      summary: "Not acceptable.",
      findings: ["Change it."],
    });
    const repair = kernel.createRepairTask({ reviewId: first.review.id });
    kernel.startWorkerRun({ taskId: repair.task.id });
    kernel.close();

    const reopened = reopenKernel(dir);
    const projection = reopened.workProjection(fixture.work.id);
    assert.equal(projection.reviews.length, 1);
    assert.equal(projection.repairBindings.length, 1);
    assert.equal(projection.latestArtifact.id, fixture.artifact.id);
    assert.equal(reopened.task(repair.task.id).state, "INTERRUPTED");
    assert.equal(projection.status, "NEEDS_ATTENTION");
    assert.equal(projection.stage, "INTERRUPTED");
    assert.deepEqual(
      projection.attention.map((entry) => entry.taskId),
      [repair.task.id],
      "the interrupted repair is named, not silently dropped",
    );
    assert.deepEqual(projection.collaboration.unfinishedRepairTaskIds, [repair.task.id]);
    assert.equal(
      projection.openRepairTask,
      null,
      "an interrupted repair is not open: it needs a human to restart it",
    );
    reopened.close();
  } finally {
    cleanup();
  }
});

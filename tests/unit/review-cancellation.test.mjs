import test from "node:test";
import assert from "node:assert/strict";
import { openTempKernel, seedTaskInReview, startReviewRun } from "../support/kernel.mjs";

const FINDINGS = ["The claim is wider than the evidence supplied."];

function handedOff(kernel, options = {}) {
  const fixture = seedTaskInReview(kernel, options);
  const request = kernel.requestReview({
    taskId: fixture.task.id,
    generation: fixture.generation,
  });
  return { ...fixture, request };
}

test("cancelling a review writes no review, and the work says no pass exists", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = handedOff(kernel);
    const run = startReviewRun(kernel, {
      reviewTaskId: flow.request.reviewTask.id,
      reviewerId: flow.reviewer.id,
    });
    const cancelled = kernel.cancelTask({
      taskId: flow.request.reviewTask.id,
      note: "the reviewer is no longer available",
    });

    assert.equal(cancelled.state, "CANCELLED");
    assert.equal(kernel.workerRun(run.workerRun.id).state, "CANCELLED");
    assert.equal(kernel.workerRun(run.workerRun.id).endReason, "TASK_CANCELLED");
    assert.equal(kernel.reviews({ workId: flow.work.id }).length, 0);
    assert.equal(
      kernel.employee(flow.reviewer.id).availability,
      "AVAILABLE",
      "a cancelled review frees the employee",
    );

    const projection = kernel.workProjection(flow.work.id);
    assert.equal(projection.status, "BLOCKED");
    assert.equal(projection.stage, "AWAITING_REVIEW");
    assert.deepEqual(projection.collaboration.pendingReviewTaskIds, [
      flow.request.reviewTask.id,
    ]);
    assert.equal(
      projection.status === "READY_FOR_DECISION",
      false,
      "an obligation without a review can never read as ready",
    );
  } finally {
    cleanup();
  }
});

test("a cancelled review task cannot submit a judgment afterwards", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = handedOff(kernel);
    const run = startReviewRun(kernel, {
      reviewTaskId: flow.request.reviewTask.id,
      reviewerId: flow.reviewer.id,
    });
    kernel.cancelTask({ taskId: flow.request.reviewTask.id });
    assert.throws(
      () =>
        kernel.submitReview({
          reviewTaskId: flow.request.reviewTask.id,
          generation: kernel.task(flow.request.reviewTask.id).generation,
          verdict: "PASS",
          summary: "Late pass.",
          findings: [],
        }),
      { code: "TASK_NOT_RUNNING" },
      "a cancelled task accepts no judgment",
    );
    assert.throws(
      () =>
        kernel.submitReview({
          reviewTaskId: flow.request.reviewTask.id,
          generation: run.workerRun.generation,
          verdict: "PASS",
          summary: "Late pass.",
          findings: [],
        }),
      { code: "STALE_GENERATION" },
      "cancelling fences the attempt that was running",
    );
    assert.equal(kernel.status().counts.reviews, 0);
  } finally {
    cleanup();
  }
});

test("cancelling a repair keeps the lineage, the findings and the target artifact", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = handedOff(kernel);
    const reviewRun = startReviewRun(kernel, {
      reviewTaskId: flow.request.reviewTask.id,
      reviewerId: flow.reviewer.id,
    });
    const review = kernel.submitReview({
      reviewTaskId: flow.request.reviewTask.id,
      generation: reviewRun.workerRun.generation,
      verdict: "REQUEST_REVISION",
      summary: "Not acceptable as it stands.",
      findings: FINDINGS,
    }).review;
    const repair = kernel.createRepairTask({ reviewId: review.id });
    kernel.startWorkerRun({ taskId: repair.task.id });
    kernel.cancelTask({ taskId: repair.task.id });

    const after = kernel.workProjection(flow.work.id);
    assert.equal(after.repairBindings.length, 1);
    assert.equal(after.repairBindings[0].id, repair.repairBinding.id);
    assert.deepEqual(after.reviews[0].findings, FINDINGS);
    assert.equal(after.latestArtifact.id, flow.artifact.id);
    assert.equal(kernel.artifact(flow.artifact.id).contentDigest, flow.artifact.contentDigest);
    assert.equal(after.status, "BLOCKED");
    assert.equal(after.stage, "BLOCKED");
    assert.deepEqual(after.collaboration.unfinishedRepairTaskIds, [repair.task.id]);
  } finally {
    cleanup();
  }
});

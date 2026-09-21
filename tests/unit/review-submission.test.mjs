import test from "node:test";
import assert from "node:assert/strict";
import {
  openTempKernel,
  seedTaskInReview,
  startReviewRun,
} from "../support/kernel.mjs";

function inReview(kernel, options = {}) {
  const fixture = seedTaskInReview(kernel, options);
  const handedOff = kernel.requestReview({
    taskId: fixture.task.id,
    generation: fixture.generation,
  });
  const started = startReviewRun(kernel, {
    reviewTaskId: handedOff.reviewTask.id,
    reviewerId: fixture.reviewer.id,
  });
  return { ...fixture, handedOff, reviewRun: started.workerRun };
}

test("a PASS writes one immutable review and completes the task and run together", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = inReview(kernel);
    const submitted = kernel.submitReview({
      reviewTaskId: flow.handedOff.reviewTask.id,
      generation: flow.reviewRun.generation,
      verdict: "PASS",
      summary: "The output answers the task it was given.",
      findings: [],
    });

    assert.equal(submitted.review.verdict, "PASS");
    assert.equal(submitted.review.targetArtifactId, flow.artifact.id);
    assert.equal(submitted.review.targetArtifactDigest, flow.artifact.contentDigest);
    assert.equal(submitted.review.reviewerWorkerRunId, flow.reviewRun.id);
    assert.equal(submitted.review.reviewTaskId, flow.handedOff.reviewTask.id);
    assert.deepEqual(submitted.review.findings, []);
    assert.equal(submitted.task.state, "COMPLETED");
    assert.equal(submitted.workerRun.state, "COMPLETED");
    assert.equal(submitted.workerRun.endReason, "REVIEW_COMPLETED");
    assert.equal(kernel.status().counts.reviews, 1);

    const kinds = kernel
      .activity({ taskId: flow.handedOff.reviewTask.id })
      .map((event) => event.kind);
    assert.deepEqual(kinds, [
      "task.created",
      "TASK_REQUIREMENTS_SET",
      "REVIEW_REQUESTED",
      "TASK_ASSIGNED",
      "task.execution_started",
      "WORKER_RUN_STARTED",
      "WORKER_RUN_COMPLETED",
      "REVIEW_SUBMITTED",
      "REVIEW_PASSED",
      "task.completed",
    ]);

    // A review is a judgment, not an output: it writes no Artifact of its own.
    assert.equal(kernel.artifacts({ taskId: flow.handedOff.reviewTask.id }).length, 0);
    const projection = kernel.workProjection(flow.work.id);
    assert.equal(projection.status, "READY_FOR_DECISION");
    assert.equal(projection.stage, "READY_FOR_DECISION");
    assert.equal(projection.latestReview.id, submitted.review.id);
    assert.equal(projection.latestArtifact.id, flow.artifact.id);
  } finally {
    cleanup();
  }
});

test("a recorded review cannot be edited or deleted, even in storage", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = inReview(kernel);
    const submitted = kernel.submitReview({
      reviewTaskId: flow.handedOff.reviewTask.id,
      generation: flow.reviewRun.generation,
      verdict: "PASS",
      summary: "Looks right.",
      findings: [],
    });
    assert.throws(
      () =>
        kernel.store.db
          .prepare("UPDATE reviews SET verdict='REQUEST_REVISION' WHERE id=?")
          .run(submitted.review.id),
      /REVIEW_IMMUTABLE/,
      "a wrong judgment is corrected by a new cycle, never by editing history",
    );
    assert.throws(
      () => kernel.store.db.prepare("DELETE FROM reviews WHERE id=?").run(submitted.review.id),
      /REVIEW_IMMUTABLE/,
    );
    assert.equal(kernel.review(submitted.review.id).verdict, "PASS");
  } finally {
    cleanup();
  }
});

test("a second judgment for the same review task is refused", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = inReview(kernel);
    kernel.submitReview({
      reviewTaskId: flow.handedOff.reviewTask.id,
      generation: flow.reviewRun.generation,
      verdict: "PASS",
      summary: "Looks right.",
      findings: [],
    });
    assert.throws(
      () =>
        kernel.submitReview({
          reviewTaskId: flow.handedOff.reviewTask.id,
          generation: flow.reviewRun.generation,
          verdict: "REQUEST_REVISION",
          summary: "Changed my mind.",
          findings: ["something"],
        }),
      { code: "TASK_NOT_RUNNING" },
      "the task is already complete",
    );
  } finally {
    cleanup();
  }
});

test("a REQUEST_REVISION must say what has to change and leaves the artifact untouched", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = inReview(kernel);
    assert.throws(
      () =>
        kernel.submitReview({
          reviewTaskId: flow.handedOff.reviewTask.id,
          generation: flow.reviewRun.generation,
          verdict: "REQUEST_REVISION",
          summary: "Not acceptable.",
          findings: [],
        }),
      { code: "FINDINGS_REQUIRED" },
      "a revision request without a reason is not a review",
    );
    assert.equal(kernel.task(flow.handedOff.reviewTask.id).state, "RUNNING");

    const submitted = kernel.submitReview({
      reviewTaskId: flow.handedOff.reviewTask.id,
      generation: flow.reviewRun.generation,
      verdict: "REQUEST_REVISION",
      summary: "The recommendation is not supported by the evidence supplied.",
      findings: ["The conclusion claims a comparison the evidence does not make."],
    });
    assert.equal(submitted.review.verdict, "REQUEST_REVISION");
    assert.equal(submitted.review.findings.length, 1);

    const original = kernel.artifacts({ taskId: flow.task.id })[0];
    assert.equal(original.content, flow.artifact.content);
    assert.equal(original.contentDigest, flow.artifact.contentDigest);
    assert.equal(original.workerRunId, flow.artifact.workerRunId);
    assert.equal(original.createdAt, flow.artifact.createdAt);
    assert.equal(original.supersedesArtifactId, null);

    const projection = kernel.workProjection(flow.work.id);
    assert.equal(projection.stage, "REVISION_REQUESTED");
    assert.equal(
      projection.status,
      "BLOCKED",
      "nothing is running and the revision has not been picked up yet",
    );
    assert.equal(projection.collaboration.outstanding, true);

    const sourced = kernel
      .activity({ taskId: flow.handedOff.reviewTask.id })
      .find((event) => event.kind === "REVISION_REQUESTED");
    assert.deepEqual(sourced.detail.findings, submitted.review.findings);
  } finally {
    cleanup();
  }
});

test("a review must come from the assigned reviewer at the current generation", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = inReview(kernel);
    assert.throws(
      () =>
        kernel.submitReview({
          reviewTaskId: flow.handedOff.reviewTask.id,
          generation: flow.reviewRun.generation - 1,
          verdict: "PASS",
          summary: "Looks right.",
          findings: [],
        }),
      { code: "STALE_GENERATION" },
    );
    assert.throws(
      () =>
        kernel.submitReview({
          reviewTaskId: flow.handedOff.reviewTask.id,
          generation: flow.reviewRun.generation,
          verdict: "MAYBE",
          summary: "Unsure.",
          findings: [],
        }),
      { code: "INVALID_VERDICT" },
      "the verdict vocabulary is exactly two words",
    );

    // An ordinary task has no artifact under review to judge.
    const plain = kernel.createTask({
      workId: flow.work.id,
      title: "Ordinary output",
      intent: "One output the founder can act on",
      requiredCapabilities: ["capability.produce"],
    });
    kernel.assignTask({ taskId: plain.id, employeeId: flow.producer.id, reason: "fixture" });
    const plainRun = kernel.startWorkerRun({ taskId: plain.id });
    assert.throws(
      () =>
        kernel.submitReview({
          reviewTaskId: plain.id,
          generation: plainRun.generation,
          verdict: "PASS",
          summary: "Not a review task.",
          findings: [],
        }),
      { code: "REVIEW_TASK_NOT_REVIEWABLE" },
    );

    // An empty summary is not a judgment.
    assert.throws(
      () =>
        kernel.submitReview({
          reviewTaskId: flow.handedOff.reviewTask.id,
          generation: flow.reviewRun.generation,
          verdict: "PASS",
          summary: "",
          findings: [],
        }),
      { code: "INVALID_INPUT" },
    );
  } finally {
    cleanup();
  }
});

test("PASS is not an acceptance: no accepted state exists anywhere", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = inReview(kernel);
    const submitted = kernel.submitReview({
      reviewTaskId: flow.handedOff.reviewTask.id,
      generation: flow.reviewRun.generation,
      verdict: "PASS",
      summary: "The output answers the task it was given.",
      findings: [],
    });
    assert.equal(typeof kernel.accept, "undefined", "there is no accept command");
    assert.equal(typeof kernel.admitKnowledge, "undefined");
    const reviewKeys = Object.keys(submitted.review);
    for (const forbidden of ["accepted", "acceptedAt", "approved", "founderDecision"])
      assert.equal(reviewKeys.includes(forbidden), false);
    const projection = kernel.workProjection(flow.work.id);
    assert.equal(projection.status, "READY_FOR_DECISION");
    assert.equal(
      projection.status === "ACCEPTED",
      false,
      "passing review is not acceptance",
    );
    assert.equal(projection.reviews.length, 1);
  } finally {
    cleanup();
  }
});

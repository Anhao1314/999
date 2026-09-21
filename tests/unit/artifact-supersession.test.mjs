import test from "node:test";
import assert from "node:assert/strict";
import { openTempKernel, seedTaskInReview, startReviewRun } from "../support/kernel.mjs";

const FINDINGS = ["The recommendation is not supported by the supplied evidence."];

function revisionRequested(kernel, options = {}) {
  const fixture = seedTaskInReview(kernel, options);
  const handedOff = kernel.requestReview({
    taskId: fixture.task.id,
    generation: fixture.generation,
  });
  const started = startReviewRun(kernel, {
    reviewTaskId: handedOff.reviewTask.id,
    reviewerId: fixture.reviewer.id,
  });
  const review = kernel.submitReview({
    reviewTaskId: handedOff.reviewTask.id,
    generation: started.workerRun.generation,
    verdict: "REQUEST_REVISION",
    summary: "Not acceptable as it stands.",
    findings: FINDINGS,
  }).review;
  return { ...fixture, handedOff, review, repair: kernel.createRepairTask({ reviewId: review.id }) };
}

// One repair attempt, then as many record attempts as the test needs: a refused
// write must leave the attempt itself intact (the employee may still deliver).
function repairAttempt(kernel, flow) {
  const run = kernel.startWorkerRun({ taskId: flow.repair.task.id });
  return {
    run,
    record({ supersedes, content = "draft v2\n" } = {}) {
      return kernel.recordArtifact({
        taskId: flow.repair.task.id,
        generation: run.generation,
        workerRunId: run.workerRun.id,
        kind: "document",
        title: "Revised analysis",
        content,
        ...(supersedes === undefined ? {} : { supersedesArtifactId: supersedes }),
      });
    },
  };
}

test("a repair output must name exactly the artifact its binding replaces", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = revisionRequested(kernel);
    const attempt = repairAttempt(kernel, flow);
    assert.throws(
      () => attempt.record(),
      { code: "SUPERSEDES_REQUIRED" },
      "a repair that replaces nothing is not a repair",
    );
    assert.throws(() => attempt.record({ supersedes: "art_missing" }), {
      code: "SUPERSEDES_NOT_FOUND",
    });

    const recorded = attempt.record({ supersedes: flow.artifact.id });
    assert.equal(recorded.supersedesArtifactId, flow.artifact.id);
    const event = kernel
      .activity({ taskId: flow.repair.task.id })
      .find((entry) => entry.kind === "ARTIFACT_SUPERSEDED");
    assert.equal(event.detail.supersededArtifactId, flow.artifact.id);
    assert.equal(event.detail.artifactId, recorded.id);
    assert.equal(
      kernel.workerRun(attempt.run.workerRun.id).state,
      "RUNNING",
      "a refused write never kills the attempt",
    );
  } finally {
    cleanup();
  }
});

test("an ordinary task may not replace a recorded artifact", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = revisionRequested(kernel);
    const plain = kernel.createTask({
      workId: flow.work.id,
      title: "Ordinary output",
      intent: "One output the founder can act on",
      requiredCapabilities: ["capability.produce"],
    });
    kernel.assignTask({ taskId: plain.id, employeeId: flow.producer.id, reason: "fixture" });
    const started = kernel.startWorkerRun({ taskId: plain.id });
    assert.throws(
      () =>
        kernel.recordArtifact({
          taskId: plain.id,
          generation: started.generation,
          workerRunId: started.workerRun.id,
          kind: "document",
          title: "Unrequested replacement",
          content: "unbound\n",
          supersedesArtifactId: flow.artifact.id,
        }),
      { code: "SUPERSEDES_NOT_ALLOWED" },
      "only a recorded review can authorise a replacement",
    );
  } finally {
    cleanup();
  }
});

test("supersession never rewrites the artifact it replaces", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = revisionRequested(kernel);
    const before = kernel.artifacts({ taskId: flow.task.id })[0];
    const replacement = repairAttempt(kernel, flow).record({ supersedes: flow.artifact.id });

    const after = kernel.artifacts({ taskId: flow.task.id })[0];
    assert.equal(after.content, before.content, "content is byte-for-byte identical");
    assert.equal(after.contentDigest, before.contentDigest);
    assert.equal(after.workerRunId, before.workerRunId);
    assert.equal(after.createdAt, before.createdAt);
    assert.equal(after.supersedesArtifactId, null, "the old artifact never learns it was replaced");

    const artifacts = kernel.artifacts({ workId: flow.work.id });
    assert.equal(artifacts.length, 2, "both versions exist forever");
    const projection = kernel.workProjection(flow.work.id);
    assert.equal(projection.latestArtifact.id, replacement.id, "latest is derived, not stored");
    assert.equal(replacement.supersedesArtifactId, flow.artifact.id);
    assert.deepEqual(projection.supersession, [
      {
        artifactId: replacement.id,
        supersedesArtifactId: flow.artifact.id,
        supersededExists: true,
      },
    ]);
  } finally {
    cleanup();
  }
});

test("supersession is scoped to one company and one work", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = revisionRequested(kernel);
    const other = revisionRequested(kernel, { taskTitle: "Other work output" });
    const attempt = repairAttempt(kernel, flow);
    assert.throws(
      () => attempt.record({ supersedes: other.artifact.id }),
      { code: "SUPERSEDES_OUT_OF_SCOPE" },
      "a repair replaces one artifact in its own work, nothing else",
    );
  } finally {
    cleanup();
  }
});

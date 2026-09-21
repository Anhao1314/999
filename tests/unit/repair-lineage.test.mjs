import test from "node:test";
import assert from "node:assert/strict";
import { openTempKernel, seedTaskInReview, startReviewRun } from "../support/kernel.mjs";

const FINDINGS = ["The conclusion claims a comparison the evidence does not make."];

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
  const submitted = kernel.submitReview({
    reviewTaskId: handedOff.reviewTask.id,
    generation: started.workerRun.generation,
    verdict: "REQUEST_REVISION",
    summary: "Not acceptable as it stands.",
    findings: FINDINGS,
  });
  return { ...fixture, handedOff, reviewRun: started.workerRun, review: submitted.review };
}

test("a repair is a new task with immutable lineage; the original is never reopened", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = revisionRequested(kernel);
    const created = kernel.createRepairTask({ reviewId: flow.review.id });

    assert.notEqual(created.task.id, flow.task.id, "repair is new work, not a reopened task");
    assert.equal(created.task.state, "OPEN");
    assert.equal(created.task.workId, flow.work.id);
    assert.equal(kernel.task(flow.task.id).state, "COMPLETED", "the source task is untouched");

    const binding = created.repairBinding;
    assert.equal(binding.reviewId, flow.review.id);
    assert.equal(binding.sourceTaskId, flow.task.id);
    assert.equal(binding.targetArtifactId, flow.artifact.id);
    assert.equal(binding.targetArtifactDigest, flow.artifact.contentDigest);
    assert.equal(binding.repairTaskId, created.task.id);

    // The repair must satisfy the same capability requirement and be reviewed again.
    const requirements = kernel.taskRequirements(created.task.id);
    assert.deepEqual(requirements.requiredCapabilities, ["capability.produce"]);
    assert.deepEqual(requirements.reviewCapabilities, ["capability.review"]);

    const event = kernel
      .activity({ taskId: created.task.id })
      .find((entry) => entry.kind === "REPAIR_TASK_CREATED");
    assert.equal(event.detail.reviewId, flow.review.id);
    assert.equal(event.detail.targetArtifactId, flow.artifact.id);
    assert.equal(event.detail.targetArtifactDigest, flow.artifact.contentDigest);
  } finally {
    cleanup();
  }
});

test("the repair goes to the original producer when that employee is still eligible", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = revisionRequested(kernel);
    const created = kernel.createRepairTask({ reviewId: flow.review.id });
    assert.equal(created.assignment.employeeId, flow.producer.id);
    assert.equal(created.assignment.reason, "original_producer");
    assert.equal(kernel.assignment(created.task.id).employeeId, flow.producer.id);
  } finally {
    cleanup();
  }
});

test("a disabled producer leaves the repair unassigned rather than picking someone else", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = revisionRequested(kernel);
    kernel.setEmployeeEnabled({ employeeId: flow.producer.id, enabled: false });
    const created = kernel.createRepairTask({ reviewId: flow.review.id });
    assert.equal(created.assignment, null);
    assert.equal(kernel.assignment(created.task.id), null);
    assert.equal(
      kernel.task(created.task.id).state,
      "OPEN",
      "the repair waits for a human decision, it does not ask the founder by itself",
    );
    const projection = kernel.workProjection(flow.work.id);
    assert.equal(projection.stage, "REPAIRING");
    assert.equal(projection.status, "OPEN");
  } finally {
    cleanup();
  }
});

test("every artifact that enters review has a recorded producer, and the review requires a run", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = revisionRequested(kernel);
    assert.equal(
      flow.artifact.workerRunId,
      flow.workerRun.id,
      "the artifact under review names the run that produced it",
    );

    // The no-run v0A path cannot enter review at all: there is nothing to hand
    // off. That is why the repair's "original producer" policy always has a
    // producer to consider for every review that exists.
    const plain = kernel.createTask({
      workId: flow.work.id,
      title: "No-run output",
      intent: "One output the founder can act on",
      requiredCapabilities: ["capability.produce"],
    });
    kernel.setTaskRequirements({
      taskId: plain.id,
      requiredCapabilities: ["capability.produce"],
      reviewCapabilities: ["capability.review"],
    });
    kernel.startTask({ taskId: plain.id });
    assert.throws(
      () => kernel.requestReview({ taskId: plain.id, generation: 1 }),
      { code: "NO_ACTIVE_RUN" },
      "a task with no employee run has nothing to hand off",
    );
  } finally {
    cleanup();
  }
});

test("the repair packet carries the exact findings and the artifact it must replace", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = revisionRequested(kernel);
    const created = kernel.createRepairTask({ reviewId: flow.review.id });
    const started = kernel.startWorkerRun({ taskId: created.task.id });
    const packet = started.workerRun.workPacket;

    assert.equal(packet.review, null, "a repair run is not a review run");
    assert.equal(packet.repair.repairBindingId, created.repairBinding.id);
    assert.equal(packet.repair.reviewId, flow.review.id);
    assert.equal(packet.repair.reviewVerdict, "REQUEST_REVISION");
    assert.equal(packet.repair.reviewSummary, flow.review.summary);
    assert.deepEqual(packet.repair.reviewFindings, FINDINGS);
    assert.equal(packet.repair.sourceTask.id, flow.task.id);
    assert.equal(packet.repair.targetArtifact.id, flow.artifact.id);
    assert.equal(packet.repair.targetArtifact.contentDigest, flow.artifact.contentDigest);
    assert.equal(packet.repair.supersedesArtifactId, flow.artifact.id);
  } finally {
    cleanup();
  }
});

test("one repair per review, and only a revision request can open one", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = revisionRequested(kernel);
    const first = kernel.createRepairTask({ reviewId: flow.review.id });
    const again = kernel.createRepairTask({ reviewId: flow.review.id });
    assert.equal(again.task.id, first.task.id, "idempotent, not a second repair task");
    assert.equal(kernel.status().counts.repairBindings, 1);

    // A PASS review cannot open a repair.
    const second = seedTaskInReview(kernel, { taskTitle: "Second output" });
    const handedOff = kernel.requestReview({
      taskId: second.task.id,
      generation: second.generation,
    });
    const reviewRun = startReviewRun(kernel, {
      reviewTaskId: handedOff.reviewTask.id,
      reviewerId: second.reviewer.id,
    });
    const pass = kernel.submitReview({
      reviewTaskId: handedOff.reviewTask.id,
      generation: reviewRun.workerRun.generation,
      verdict: "PASS",
      summary: "Fine.",
      findings: [],
    }).review;
    assert.throws(() => kernel.createRepairTask({ reviewId: pass.id }), {
      code: "REVISION_NOT_REQUESTED",
    });
    assert.throws(() => kernel.createRepairTask({ reviewId: "rev_missing" }), {
      code: "REVIEW_NOT_FOUND",
    });
  } finally {
    cleanup();
  }
});

test("the repair binding is immutable in storage", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = revisionRequested(kernel);
    const created = kernel.createRepairTask({ reviewId: flow.review.id });
    assert.throws(
      () =>
        kernel.store.db
          .prepare("UPDATE repair_bindings SET target_artifact_id='art_other' WHERE id=?")
          .run(created.repairBinding.id),
      /REPAIR_BINDING_IMMUTABLE/,
    );
    assert.throws(
      () =>
        kernel.store.db
          .prepare("DELETE FROM repair_bindings WHERE id=?")
          .run(created.repairBinding.id),
      /REPAIR_BINDING_IMMUTABLE/,
    );
  } finally {
    cleanup();
  }
});

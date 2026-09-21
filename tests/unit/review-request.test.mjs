import test from "node:test";
import assert from "node:assert/strict";
import {
  openTempKernel,
  reopenKernel,
  seedReviewTeam,
  seedTaskInReview,
  startReviewRun,
} from "../support/kernel.mjs";

test("an artifact is handed off with an exact binding and a review task is created", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const fixture = seedTaskInReview(kernel);
    const handedOff = kernel.requestReview({
      taskId: fixture.task.id,
      generation: fixture.generation,
    });

    assert.equal(handedOff.task.state, "COMPLETED");
    assert.equal(handedOff.workerRun.state, "COMPLETED");
    assert.equal(handedOff.workerRun.endReason, "WORK_COMPLETED");
    assert.equal(handedOff.targetArtifact.id, fixture.artifact.id);
    assert.equal(handedOff.reviewRequest.targetArtifactId, fixture.artifact.id);
    assert.equal(
      handedOff.reviewRequest.targetArtifactDigest,
      fixture.artifact.contentDigest,
      "the request binds a digest, not a moving latest pointer",
    );
    assert.equal(handedOff.reviewRequest.sourceTaskId, fixture.task.id);
    assert.equal(handedOff.reviewRequest.reviewTaskId, handedOff.reviewTask.id);

    const requirements = kernel.taskRequirements(handedOff.reviewTask.id);
    assert.deepEqual(requirements.requiredCapabilities, ["capability.review"]);
    assert.deepEqual(
      requirements.reviewCapabilities,
      [],
      "a review task is not itself reviewed",
    );

    const kinds = kernel
      .activity({ taskId: fixture.task.id })
      .map((event) => event.kind);
    assert.deepEqual(kinds, [
      "task.created",
      "TASK_REQUIREMENTS_SET",
      "TASK_ASSIGNED",
      "task.execution_started",
      "WORKER_RUN_STARTED",
      "artifact.recorded",
      "ARTIFACT_HANDED_OFF",
      "WORKER_RUN_COMPLETED",
      "task.completed",
    ]);
    const requested = kernel
      .activity({ taskId: handedOff.reviewTask.id })
      .find((event) => event.kind === "REVIEW_REQUESTED");
    assert.equal(requested.detail.targetArtifactId, fixture.artifact.id);
    assert.equal(requested.detail.targetArtifactDigest, fixture.artifact.contentDigest);
  } finally {
    cleanup();
  }
});

test("a task that requires review cannot be completed without one", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const fixture = seedTaskInReview(kernel);
    assert.throws(
      () => kernel.completeWorkerRun({ taskId: fixture.task.id, generation: fixture.generation }),
      { code: "REVIEW_REQUIRED" },
      "the crash window where a task looks done and its review vanished is closed here",
    );
    assert.equal(kernel.task(fixture.task.id).state, "RUNNING", "the refusal changed nothing");
    assert.equal(kernel.artifacts({ taskId: fixture.task.id }).length, 1);

    // The same rule applies to the v0A no-run completion path.
    const plain = kernel.createTask({
      workId: fixture.work.id,
      title: "Second output",
      intent: "One output the founder can act on",
      requiredCapabilities: ["capability.produce"],
    });
    kernel.setTaskRequirements({
      taskId: plain.id,
      requiredCapabilities: ["capability.produce"],
      reviewCapabilities: ["capability.review"],
    });
    kernel.startTask({ taskId: plain.id });
    kernel.recordArtifact({
      taskId: plain.id,
      generation: 1,
      kind: "document",
      title: "Output",
      content: "content\n",
    });
    assert.throws(
      () => kernel.completeTask({ taskId: plain.id, generation: 1 }),
      { code: "REVIEW_REQUIRED" },
    );
  } finally {
    cleanup();
  }
});

test("the obligation is persisted, so a completed task always has a review task", () => {
  const { dir, kernel, cleanup } = openTempKernel();
  try {
    const fixture = seedTaskInReview(kernel);
    const handedOff = kernel.requestReview({
      taskId: fixture.task.id,
      generation: fixture.generation,
    });
    kernel.close();

    const reopened = reopenKernel(dir);
    assert.equal(reopened.task(fixture.task.id).state, "COMPLETED");
    const request = reopened.reviewRequestForTask(handedOff.reviewTask.id);
    assert.equal(request.targetArtifactId, fixture.artifact.id);
    assert.equal(request.targetArtifactDigest, fixture.artifact.contentDigest);
    assert.equal(
      reopened.task(handedOff.reviewTask.id).state,
      "OPEN",
      "the review task exists for exactly as long as the obligation does",
    );
    assert.equal(reopened.status().counts.reviewRequests, 1);
    reopened.close();
  } finally {
    cleanup();
  }
});

test("the reviewer is an ordinary assignment and run, and its packet names the artifact", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const fixture = seedTaskInReview(kernel);
    const handedOff = kernel.requestReview({
      taskId: fixture.task.id,
      generation: fixture.generation,
    });

    // A position that cannot review is refused by the ordinary requirement check.
    assert.throws(
      () =>
        kernel.assignTask({
          taskId: handedOff.reviewTask.id,
          employeeId: fixture.producer.id,
          reason: "wrong employee",
        }),
      { code: "TASK_REQUIREMENTS_UNSATISFIED" },
      "the producer's position does not carry the review capability",
    );

    const started = startReviewRun(kernel, {
      reviewTaskId: handedOff.reviewTask.id,
      reviewerId: fixture.reviewer.id,
    });
    const run = started.workerRun;
    assert.equal(run.employeeId, fixture.reviewer.id);
    assert.equal(run.taskId, handedOff.reviewTask.id);
    assert.equal(
      kernel.employee(fixture.reviewer.id).availability,
      "BUSY",
      "a reviewer is just an employee doing work",
    );

    const packet = run.workPacket;
    assert.equal(packet.packetVersion, 2);
    assert.equal(packet.repair, null, "a review run is not a repair run");
    assert.equal(packet.review.reviewRequestId, handedOff.reviewRequest.id);
    assert.equal(packet.review.reviewTask.id, handedOff.reviewTask.id);
    assert.equal(packet.review.sourceTask.id, fixture.task.id);
    assert.equal(packet.review.targetArtifact.id, fixture.artifact.id);
    assert.equal(
      packet.review.targetArtifact.content,
      fixture.artifact.content,
      "the reviewer can read exactly what it is judging",
    );
    assert.equal(packet.review.reviewedDigest, fixture.artifact.contentDigest);
    assert.deepEqual(packet.review.requiredCapabilities, ["capability.review"]);
    assert.equal(
      Object.keys(packet).includes("eventLog"),
      false,
      "no database dump, no event log, no other work",
    );

    const stored = kernel.workerRun(run.id);
    assert.deepEqual(stored.workPacket, packet, "the granted packet is stored verbatim");
  } finally {
    cleanup();
  }
});

test("a review can only be requested for a running attempt with an output", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const team = seedReviewTeam(kernel);
    const task = kernel.createTask({
      workId: team.work.id,
      title: "Produce the analysis",
      intent: "One output the founder can act on",
    });
    kernel.assignTask({ taskId: task.id, employeeId: team.producer.id, reason: "fixture" });
    const started = kernel.startWorkerRun({ taskId: task.id });
    assert.throws(
      () => kernel.requestReview({ taskId: task.id, generation: started.generation }),
      { code: "REVIEW_NOT_REQUIRED" },
      "a task nobody asked to have reviewed cannot enter review",
    );

    // A second task that does require review, still without an output.
    const second = kernel.createTask({
      workId: team.work.id,
      title: "Second output",
      intent: "One output the founder can act on",
      requiredCapabilities: ["capability.produce"],
    });
    kernel.setTaskRequirements({
      taskId: second.id,
      requiredCapabilities: ["capability.produce"],
      reviewCapabilities: ["capability.review"],
    });
    kernel.assignTask({ taskId: second.id, employeeId: team.producer.id, reason: "fixture" });
    const secondStarted = kernel.startWorkerRun({ taskId: second.id });
    assert.throws(
      () =>
        kernel.requestReview({ taskId: second.id, generation: secondStarted.generation }),
      { code: "TASK_HAS_NO_ARTIFACT" },
      "there is nothing to review yet",
    );

    // A stale generation is refused before anything else happens.
    assert.throws(
      () =>
        kernel.requestReview({ taskId: second.id, generation: secondStarted.generation - 1 }),
      { code: "STALE_GENERATION" },
    );
  } finally {
    cleanup();
  }
});

test("a review task cannot itself be handed off for review", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const fixture = seedTaskInReview(kernel);
    const handedOff = kernel.requestReview({
      taskId: fixture.task.id,
      generation: fixture.generation,
    });
    assert.throws(
      () =>
        kernel.setTaskRequirements({
          taskId: handedOff.reviewTask.id,
          requiredCapabilities: [],
          reviewCapabilities: ["capability.review"],
        }),
      { code: "REVIEW_TASK_NOT_REVIEWABLE" },
    );
    assert.throws(
      () =>
        kernel.requestReview({
          taskId: handedOff.reviewTask.id,
          generation: kernel.task(handedOff.reviewTask.id).generation,
        }),
      { code: "TASK_NOT_RUNNING" },
      "a review task has no running attempt to hand off",
    );
  } finally {
    cleanup();
  }
});

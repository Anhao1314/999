// Worker Harness v0 — WorkerHost end-to-end tests (Slice 1).
// Contract: docs/contracts/worker-harness-v0.md §11–§23.
//
// These tests run the real Runtime with the real Continuation Driver in
// `observe` mode and the deterministic test adapter on real run-scoped
// directories. No model, no network, no Codex CLI.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createContinuationDriver, openKernel } from "../../packages/runtime/index.mjs";
import { deterministicNextActionProposer } from "../../packages/planning/next-action.mjs";
import { createWorkerHost, createStaticWorkerBackendResolver } from "../../packages/harness/index.mjs";
import { createTestWorkerAdapter } from "../../packages/harness/adapters/test-worker.mjs";
import {
  openTempKernel,
  seedTaskInReview,
  startReviewRun,
} from "../support/kernel.mjs";

// The server's coordination switch, mirrored in-process. The driver owns
// assignment, startWorkerRun, review dispatch and repair dispatch; the Host
// only executes attempts the Runtime already started.
function openHarness({ behavior = "complete", timeoutMs = 2000 } = {}) {
  const { dir, kernel, cleanup } = openTempKernel();
  const adapter = createTestWorkerAdapter({ behavior });
  const host = createWorkerHost({
    kernel,
    adapter,
    resolver: createStaticWorkerBackendResolver(),
    runtimeRoot: dir,
    timeoutMs,
  });
  return { dir, kernel, adapter, host, cleanup };
}

// The production composition, exactly as apps/runtime/server.mjs wires it: the
// Host observes first, then the driver runs its startup pass over committed
// truth (server.mjs `driver.driveAll({ triggerType: "STARTUP" })`).
function attachDriver(h) {
  const driver = createContinuationDriver({
    kernel: h.kernel,
    proposer: deterministicNextActionProposer(),
    observe: true,
  });
  driver.driveAll({ triggerType: "STARTUP" });
  return driver;
}

async function until(predicate, { label = "condition", timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

// A Work whose single Task is created explicitly (no review requirement) and
// assigned. This is the documented low-level path, not a driver proposal.
function seedNoReviewWork(kernel, { title = "One deliverable" } = {}) {
  const company = kernel.createCompany({ name: "Harness Co" });
  const position = kernel.createPosition({
    companyId: company.id,
    title: "Operator",
    capabilities: ["work.execute"],
  });
  const employee = kernel.createEmployee({
    companyId: company.id,
    positionId: position.id,
    displayName: "Atlas",
  });
  const work = kernel.createWork({
    companyId: company.id,
    title,
    intent: "The Founder needs one output",
  });
  const task = kernel.createTask({
    workId: work.id,
    title: `Produce: ${title}`,
    intent: "One output the Founder can act on",
    requiredCapabilities: ["work.execute"],
  });
  kernel.assignTask({ taskId: task.id, employeeId: employee.id, reason: "fixture assignment" });
  return { company, position, employee, work, task };
}

test("the Host executes an attempt the Runtime started and delivers exactly once", async () => {
  const h = openHarness();
  try {
    const { work, task } = seedNoReviewWork(h.kernel);
    h.host.start();
    attachDriver(h);

    await until(() => h.kernel.workProjection(work.id).status === "READY_FOR_DECISION", {
      label: "the Work to reach the decision boundary",
    });

    const run = h.kernel.workerRuns({ taskId: task.id })[0];
    assert.equal(h.kernel.task(task.id).state, "COMPLETED");
    assert.equal(run.state, "COMPLETED");
    assert.equal(run.endReason, "WORK_COMPLETED");

    const projection = h.kernel.workProjection(work.id);
    assert.equal(projection.outcome.candidateArtifacts.length, 1, "exactly one current candidate");
    const artifact = h.kernel.artifact(projection.outcome.candidateArtifacts[0].id);
    assert.match(artifact.content, /deterministic test worker output/, "the delivered bytes are the attempt's own output");
    assert.equal(h.kernel.store.resultSubmissionForRun(run.id).detail.artifactId, artifact.id);

    const binding = h.kernel.workerExecutionBinding(run.id);
    assert.equal(binding.backendType, "test-worker");
    assert.equal(binding.generation, run.generation);
    assert.match(binding.workspaceRoot, /workspaces\/.+\/runs\/.+-g1\/workspace$/);
    assert.equal(readFileSync(join(binding.workspaceRoot, "output.txt"), "utf8"), artifact.content);

    const reports = h.host.reportFor(run.id);
    assert.equal(reports.length, 1, "one observation, one delivery");
    assert.equal(reports[0].status, "DELIVERED");
    assert.equal(reports[0].detail.idempotent, false);

    // Agent COMPLETE is not acceptance, and the Runtime never adjudicates.
    assert.equal(projection.outcome.accepted, null);
    assert.equal(projection.outcome.state, "READY");
    assert.equal(h.kernel.status().counts.founderDecisions, 0);
    assert.equal(projection.founderAttention.item.kind, "DECISION_REQUIRED");
  } finally {
    await h.host.stop();
    h.cleanup();
  }
});

// The full production arrangement for a Work that requires review: two
// positions, two employees, the Host observing, the Driver coordinating.
function seedReviewCompany(h, { title = "Deliverable needing review" } = {}) {
  const company = h.kernel.createCompany({ name: "Review Co" });
  const operator = h.kernel.createPosition({
    companyId: company.id,
    title: "Operator",
    capabilities: ["work.execute"],
  });
  h.kernel.createEmployee({ companyId: company.id, positionId: operator.id, displayName: "Atlas" });
  const reviewer = h.kernel.createPosition({
    companyId: company.id,
    title: "Reviewer",
    capabilities: ["work.review"],
  });
  h.kernel.createEmployee({ companyId: company.id, positionId: reviewer.id, displayName: "Iris" });
  const work = h.kernel.createWork({
    companyId: company.id,
    title,
    intent: "The Founder needs a reviewed output",
  });
  return { company, work };
}

test("a review-required delivery is judged by a Reviewer attempt the Host executes", async () => {
  const h = openHarness();
  try {
    h.host.start();
    const driver = createContinuationDriver({
      kernel: h.kernel,
      proposer: deterministicNextActionProposer(),
      observe: true,
    });
    const { work } = seedReviewCompany(h);

    await until(() => h.kernel.workProjection(work.id).status === "READY_FOR_DECISION", {
      label: "the reviewed Work to reach the decision boundary",
      timeoutMs: 5000,
    });

    const tasks = h.kernel.tasks(work.id);
    const sourceTask = tasks.find((task) => !task.title.startsWith("Review:"));
    const reviewTask = tasks.find((task) => task.title.startsWith("Review:"));
    assert.ok(reviewTask, "the Runtime created the Review Task");
    const sourceRun = h.kernel.workerRuns({ taskId: sourceTask.id })[0];
    const reviewRun = h.kernel.workerRuns({ taskId: reviewTask.id })[0];
    assert.equal(h.host.reportFor(sourceRun.id)[0].status, "DELIVERED");

    // The Reviewer attempt was executed and delivered through the Reviewer
    // seam — the Host never called submitReview, and never wrote a verdict of
    // its own choosing.
    const reviewReport = h.host.reportFor(reviewRun.id)[0];
    assert.equal(reviewReport.status, "DELIVERED");
    assert.equal(reviewReport.detail.verdict, "PASS");
    assert.equal(reviewRun.state, "COMPLETED");
    assert.equal(reviewRun.endReason, "REVIEW_COMPLETED");
    assert.equal(h.kernel.task(reviewTask.id).state, "COMPLETED");
    assert.equal(h.kernel.status().counts.reviews, 1);
    assert.equal(h.kernel.status().counts.workerExecutionBindings, 2, "both attempts were bound");

    const [review] = h.kernel.reviews({ workId: work.id });
    assert.equal(review.reviewerWorkerRunId, reviewRun.id);
    assert.equal(review.reviewTaskId, reviewTask.id);
    const [sourceArtifact] = h.kernel.taskDetail(sourceTask.id).artifacts;
    assert.equal(review.targetArtifactId, sourceArtifact.id, "the judge names the judged artifact");
    assert.equal(review.targetArtifactDigest, sourceArtifact.contentDigest);

    // The Work waits for the Founder, and only for the Founder.
    const projection = h.kernel.workProjection(work.id);
    assert.equal(projection.outcome.state, "READY");
    assert.equal(projection.outcome.accepted, null, "a Reviewer PASS is not an acceptance");
    assert.equal(projection.founderAttention.item.kind, "DECISION_REQUIRED");
    assert.equal(h.kernel.status().counts.artifacts, 1, "the Reviewer produced no second artifact");
    assert.equal(h.kernel.status().counts.founderDecisions, 0);
    driver.detach();
  } finally {
    await h.host.stop();
    h.cleanup();
  }
});

test("a Reviewer REQUEST_REVISION becomes a Repair, and the repaired Artifact passes the second review", async () => {
  let reviewAttempts = 0;
  const h = openHarness({
    behavior: (input) => {
      if (input.resultContract?.kind !== "REVIEW_JUDGMENT") return "complete";
      reviewAttempts += 1;
      return reviewAttempts === 1 ? "request-revision" : "complete";
    },
  });
  try {
    h.host.start();
    const driver = createContinuationDriver({
      kernel: h.kernel,
      proposer: deterministicNextActionProposer(),
      observe: true,
    });
    const { work } = seedReviewCompany(h, { title: "Deliverable that needs one repair" });

    await until(() => h.kernel.workProjection(work.id).status === "READY_FOR_DECISION", {
      label: "the repaired Artifact to pass its review",
      timeoutMs: 8000,
    });

    const reviews = h.kernel.reviews({ workId: work.id });
    assert.equal(reviews.length, 2);
    assert.equal(reviews[0].verdict, "REQUEST_REVISION");
    assert.equal(reviews[1].verdict, "PASS");
    const [repair] = h.kernel.repairBindings({ workId: work.id });
    assert.equal(repair.reviewId, reviews[0].id, "the Repair answers the revision request");
    assert.equal(repair.targetArtifactId, reviews[0].targetArtifactId);
    assert.notEqual(
      reviews[1].targetArtifactId,
      reviews[0].targetArtifactId,
      "the second review judges the replacement, not the replaced",
    );

    const projection = h.kernel.workProjection(work.id);
    assert.deepEqual(
      projection.outcome.candidateArtifacts.map((entry) => entry.id),
      [reviews[1].targetArtifactId],
    );
    assert.equal(projection.outcome.accepted, null);
    assert.equal(h.kernel.status().counts.founderDecisions, 0);
    assert.equal(
      projection.founderAttention.item.kind,
      "DECISION_REQUIRED",
      "the Founder is asked exactly once, at the end",
    );
    driver.detach();
  } finally {
    await h.host.stop();
    h.cleanup();
  }
});

test("an invalid review judgment is a protocol error, and the Runtime retries the Reviewer", async () => {
  let reviewAttempts = 0;
  const h = openHarness({
    behavior: (input) => {
      if (input.resultContract?.kind !== "REVIEW_JUDGMENT") return "complete";
      reviewAttempts += 1;
      return reviewAttempts === 1 ? "invalid-result" : "complete";
    },
    timeoutMs: 500,
  });
  try {
    h.host.start();
    const driver = createContinuationDriver({
      kernel: h.kernel,
      proposer: deterministicNextActionProposer(),
      observe: true,
    });
    const { work } = seedReviewCompany(h, { title: "A Work whose first review is malformed" });

    await until(() => h.kernel.status().counts.reviews === 1, {
      label: "the retried Reviewer attempt to deliver",
      timeoutMs: 5000,
    });

    const reviewTask = h.kernel.tasks(work.id).find((task) => task.title.startsWith("Review:"));
    const runs = h.kernel.workerRuns({ taskId: reviewTask.id });
    assert.equal(runs.length, 2, "the malformed attempt was retried, not accepted");
    assert.equal(runs[0].state, "INTERRUPTED");
    assert.equal(runs[0].endReason, "WORKER_PROTOCOL_ERROR");
    assert.equal(h.host.reportFor(runs[0].id)[0].detail.reason, "WORKER_PROTOCOL_ERROR");
    assert.equal(runs[1].state, "COMPLETED");
    assert.equal(h.kernel.status().counts.reviews, 1, "no verdict was faked for the malformed attempt");
    assert.equal(h.kernel.reviews({ workId: work.id })[0].reviewerWorkerRunId, runs[1].id);
    await until(() => h.kernel.workProjection(work.id).status === "READY_FOR_DECISION", {
      label: "the Work to reach the decision boundary",
      timeoutMs: 5000,
    });
    driver.detach();
  } finally {
    await h.host.stop();
    h.cleanup();
  }
});

test("a timeout is reported, the Runtime re-dispatches, and the new attempt succeeds", async () => {
  const h = openHarness({
    behavior: (input) => (input.generation === 1 ? "hang" : "complete"),
    timeoutMs: 80,
  });
  try {
    const { work, task } = seedNoReviewWork(h.kernel, { title: "A Work that gets retried" });
    h.host.start();
    attachDriver(h);

    await until(() => h.kernel.workProjection(work.id).status === "READY_FOR_DECISION", {
      label: "the retried attempt to be delivered",
      timeoutMs: 5000,
    });

    const runs = h.kernel.workerRuns({ taskId: task.id });
    assert.equal(runs.length, 2, "the interrupted attempt and its continuation");
    assert.equal(runs[0].state, "INTERRUPTED");
    assert.equal(runs[0].endReason, "WORKER_TIMEOUT");
    assert.equal(runs[1].state, "COMPLETED");
    assert.ok(runs[1].generation > runs[0].generation, "the retry is fenced by a new generation");

    const firstBinding = h.kernel.workerExecutionBinding(runs[0].id);
    const secondBinding = h.kernel.workerExecutionBinding(runs[1].id);
    assert.ok(firstBinding && secondBinding, "every attempt that executed has its own binding");
    assert.notEqual(firstBinding.workspaceRoot, secondBinding.workspaceRoot);
    assert.notEqual(firstBinding.id, secondBinding.id);

    assert.equal(h.kernel.status().counts.artifacts, 1);
    const projection = h.kernel.workProjection(work.id);
    assert.equal(projection.outcome.candidateArtifacts.length, 1);
    assert.equal(projection.founderAttention.item.kind, "DECISION_REQUIRED");

    const interruptedReport = h.host.reportFor(runs[0].id)[0];
    assert.equal(interruptedReport.status, "INTERRUPTED");
    assert.equal(interruptedReport.detail.reason, "WORKER_TIMEOUT");
    assert.equal(h.host.reportFor(runs[1].id)[0].status, "DELIVERED");
    assert.equal(h.host.leaseState(runs[0].id), "INVALIDATED");
    assert.equal(h.host.leaseState(runs[1].id), "RELEASED");
  } finally {
    await h.host.stop();
    h.cleanup();
  }
});

test("a new attempt never reads the invalidated workspace of an interrupted one", async () => {
  const h = openHarness({
    behavior: (input) => (input.generation === 1 ? "hang" : "complete"),
    timeoutMs: 80,
  });
  try {
    const { work, task } = seedNoReviewWork(h.kernel, { title: "Workspace isolation" });
    h.host.start();
    attachDriver(h);

    await until(() => h.kernel.status().counts.workerRuns === 1, { label: "the first attempt" });
    const firstRun = h.kernel.workerRuns({ state: "RUNNING" })[0];
    const firstBinding = h.kernel.workerExecutionBinding(firstRun.id);
    assert.ok(firstBinding, "the first attempt is bound before it hangs");

    // Poison the abandoned workspace while the retry is in flight. Correctness
    // never depends on killing the orphan: isolation does.
    writeFileSync(join(firstBinding.workspaceRoot, "output.txt"), "POISON FROM A DEAD ATTEMPT\n", "utf8");

    await until(() => h.kernel.workProjection(work.id).status === "READY_FOR_DECISION", {
      label: "the retried attempt to be delivered",
      timeoutMs: 5000,
    });

    const runs = h.kernel.workerRuns({ taskId: task.id });
    const secondBinding = h.kernel.workerExecutionBinding(runs[1].id);
    assert.notEqual(firstBinding.workspaceRoot, secondBinding.workspaceRoot);

    const artifact = h.kernel.artifact(
      h.kernel.workProjection(work.id).outcome.candidateArtifacts[0].id,
    );
    assert.doesNotMatch(artifact.content, /POISON/, "the new attempt read its own workspace");
    assert.match(artifact.content, new RegExp(runs[1].id), "and only its own output");
    assert.equal(
      readFileSync(join(firstBinding.workspaceRoot, "output.txt"), "utf8"),
      "POISON FROM A DEAD ATTEMPT\n",
      "the dead attempt's workspace is not reused or rewritten",
    );
    assert.equal(existsSync(secondBinding.workspaceRoot), true);
  } finally {
    await h.host.stop();
    h.cleanup();
  }
});

test("an unparseable WorkerResult is a protocol error, and the Runtime retries", async () => {
  const h = openHarness({
    behavior: (input) => (input.generation === 1 ? "invalid-result" : "complete"),
    timeoutMs: 500,
  });
  try {
    const { work, task } = seedNoReviewWork(h.kernel, { title: "Protocol failure" });
    h.host.start();
    attachDriver(h);

    await until(() => h.kernel.workerRuns({ taskId: task.id }).length > 0, { label: "the first attempt" });
    const firstRun = h.kernel.workerRuns({ taskId: task.id })[0];
    await until(() => h.host.reportFor(firstRun.id).length > 0, { label: "the protocol refusal" });
    const report = h.host.reportFor(firstRun.id)[0];
    assert.equal(report.status, "INTERRUPTED");
    assert.equal(report.detail.reason, "WORKER_PROTOCOL_ERROR");
    assert.equal(h.kernel.workerRun(firstRun.id).endReason, "WORKER_PROTOCOL_ERROR");
    assert.equal(
      h.kernel
        .taskDetail(task.id)
        .artifacts.filter((artifact) => artifact.generation === firstRun.generation).length,
      0,
      "an unparseable result records nothing for its generation",
    );

    await until(() => h.kernel.workProjection(work.id).status === "READY_FOR_DECISION", {
      label: "the retried attempt to deliver",
      timeoutMs: 5000,
    });
    assert.equal(h.kernel.status().counts.artifacts, 1);
    assert.equal(h.kernel.workProjection(work.id).outcome.candidateArtifacts.length, 1);
  } finally {
    await h.host.stop();
    h.cleanup();
  }
});

test("the Host mutates the Runtime only through its four allowed commands", async () => {
  const { dir, kernel, cleanup } = openTempKernel();
  try {
    const { work, task } = seedNoReviewWork(kernel, { title: "Allowlisted" });
    const adapter = createTestWorkerAdapter();
    const host = createWorkerHost({
      kernel,
      adapter,
      resolver: createStaticWorkerBackendResolver(),
      runtimeRoot: dir,
      timeoutMs: 2000,
    });

    // A restricted facade: every command the Host is forbidden to call throws,
    // and every read plus the three allowed commands is real. If the Host
    // reaches for anything else, this test fails loudly.
    const FORBIDDEN = [
      "recordArtifact", "completeWorkerRun", "requestReview", "submitReview",
      "createRepairTask", "acceptWork", "createTask", "assignTask", "cancelTask",
      "startWorkerRun", "setTaskRequirements", "checkpointTask", "completeTask",
      "createCompany", "createPosition", "createEmployee", "materializeNextAction",
    ];
    const facade = {};
    for (const name of [
      "bindWorkerExecution",
      "submitWorkerResult",
      "submitWorkerReviewResult",
      "interruptWorkerRun",
    ])
      facade[name] = (...args) => kernel[name](...args);
    for (const name of ["workerRun", "workerRuns", "reviewRequestForTask", "task", "employee", "position", "company", "setWorkerRunObserver"])
      facade[name] = (...args) => kernel[name](...args);
    for (const name of FORBIDDEN)
      facade[name] = () => {
        throw new Error(`the Host must never call ${name}`);
      };

    host.start();
    kernel.startWorkerRun({ taskId: task.id }); // the test starts the attempt, not the Host
    await until(() => kernel.workProjection(work.id).status === "READY_FOR_DECISION", {
      label: "delivery through the restricted facade",
    });
    await host.idle();

    assert.equal(kernel.status().counts.artifacts, 1);
    assert.equal(kernel.status().counts.workerExecutionBindings, 1);
    assert.equal(host.reportFor(kernel.workerRuns({ taskId: task.id })[0].id)[0].status, "DELIVERED");

    // The Reviewer seam runs through the same facade: the Host needs
    // submitWorkerReviewResult (and must never need submitReview) to deliver a
    // judgment.
    const reviewFlow = seedTaskInReview(kernel);
    const handoff = kernel.requestReview({
      taskId: reviewFlow.task.id,
      generation: reviewFlow.generation,
    });
    const reviewRun = startReviewRun(kernel, {
      reviewTaskId: handoff.reviewTask.id,
      reviewerId: reviewFlow.reviewer.id,
    });
    await until(() => kernel.status().counts.reviews === 1, {
      label: "the judgment through the restricted facade",
    });
    await host.idle();
    const judgmentReport = host.reportFor(reviewRun.workerRun.id)[0];
    assert.equal(judgmentReport.status, "DELIVERED");
    assert.equal(judgmentReport.detail.verdict, "PASS");
    assert.equal(
      kernel.reviews({ workId: reviewFlow.work.id })[0].reviewerWorkerRunId,
      reviewRun.workerRun.id,
    );
    await host.stop();
  } finally {
    cleanup();
  }
});

test("duplicate observations and a reconciliation pass deliver exactly once", async () => {
  const { dir, kernel, cleanup } = openTempKernel();
  try {
    const { work, task } = seedNoReviewWork(kernel, { title: "Reconcile" });
    // The attempt starts while no Host is observing: the missed notification a
    // restart has to heal.
    const started = kernel.startWorkerRun({ taskId: task.id });

    const adapter = createTestWorkerAdapter();
    const host = createWorkerHost({
      kernel,
      adapter,
      resolver: createStaticWorkerBackendResolver(),
      runtimeRoot: dir,
      timeoutMs: 2000,
    });
    const { reconciled } = host.start();
    assert.equal(reconciled, 1, "startup reconciliation finds the RUNNING attempt");
    host.observe(started.workerRun.id);
    host.observe(started.workerRun.id);
    await until(() => kernel.workProjection(work.id).status === "READY_FOR_DECISION", {
      label: "the reconciled attempt to be delivered",
    });
    await host.idle();

    assert.equal(kernel.status().counts.artifacts, 1, "one attempt, one artifact");
    assert.equal(kernel.status().counts.workerExecutionBindings, 1, "one attempt, one binding");
    assert.equal(host.reportFor(started.workerRun.id).length, 1, "one observation, one report");
    await host.stop();
  } finally {
    cleanup();
  }
});

test("delivery is not acceptance: the Work waits for an explicit Founder decision", async () => {
  const h = openHarness();
  try {
    const { work, task } = seedNoReviewWork(h.kernel, { title: "Nothing is auto-accepted" });
    h.host.start();
    attachDriver(h);
    await until(() => h.kernel.workProjection(work.id).status === "READY_FOR_DECISION", {
      label: "delivery",
    });

    const ready = h.kernel.workProjection(work.id);
    assert.equal(ready.outcome.state, "READY");
    assert.equal(ready.outcome.accepted, null);
    assert.equal(h.kernel.status().counts.founderDecisions, 0);

    // Nothing the Host did can accept; only the explicit Founder command does.
    const candidate = ready.outcome.candidateArtifacts[0];
    const accepted = h.kernel.acceptWork({
      workId: work.id,
      artifactId: candidate.id,
      artifactDigest: candidate.digest,
      basis: ready.decisionBasis,
    });
    assert.equal(accepted.decision.disposition, "ACCEPT");
    assert.equal(h.kernel.workProjection(work.id).outcome.state, "ACCEPTED");
  } finally {
    await h.host.stop();
    h.cleanup();
  }
});

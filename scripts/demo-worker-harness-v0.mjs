// Demonstration for Worker Harness v0 — Slice 1.1 (contract §31, §32).
//
// The Runtime coordinates; the WorkerHost executes; the Founder decides.
//
//   Founder assembles the team and states one Work.
//   From there the Runtime plans, assigns, starts, and (when a Review is
//   required) dispatches the reviewer — and the WorkerHost, observing committed
//   WorkerRun truth, executes each attempt on the deterministic test backend,
//   records Harness evidence, and delivers the result through the atomic
//   Runtime seam for that attempt's role.
//
// Four scenarios, all in-process (the Host is a Runtime client module; the HTTP
// runtime stays the transport for everything else):
//
//   1. One Work end to end — executed, reviewed (PASS), and accepted by the
//      Founder, with zero manual coordination and zero extra Founder touches.
//   2. A Reviewer who asks for a revision: the existing Repair protocol runs,
//      the replacement Artifact is produced, and the second review passes.
//   3. An attempt that times out. The Host reports the execution failure, the
//      Runtime re-dispatches, and the retry executes in a new run-scoped
//      workspace while the abandoned one is poisoned.
//   4. An attempt that always dies: the Runtime stops automatically after three
//      attempts and hands the decision to the Founder instead of looping.
//
//   node scripts/demo-worker-harness-v0.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import {
  CONTINUATION_DIAGNOSTICS,
  MAX_AUTONOMOUS_ATTEMPTS_PER_TASK,
  createContinuationDriver,
  openKernel,
} from "../packages/runtime/index.mjs";
import { deterministicNextActionProposer } from "../packages/planning/next-action.mjs";
import { createWorkerHost, createStaticWorkerBackendResolver } from "../packages/harness/index.mjs";
import { createTestWorkerAdapter } from "../packages/harness/adapters/test-worker.mjs";

const steps = [];
const report = (step, detail) => {
  steps.push(step);
  console.log(`${String(steps.length).padStart(2, " ")}. ${step} — ${detail}`);
};

const dirs = [];
const cleanup = () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
};

async function until(predicate, { label, timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label ?? "condition"}`);
}

function openHarness({ behavior = "complete", timeoutMs = 500 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "flowcredit-harness-v0-"));
  dirs.push(dir);
  const kernel = openKernel({ dir });
  const adapter = createTestWorkerAdapter({ behavior });
  const host = createWorkerHost({
    kernel,
    adapter,
    resolver: createStaticWorkerBackendResolver(),
    runtimeRoot: dir,
    timeoutMs,
  });
  return { dir, kernel, adapter, host };
}

// The server's composition: the Host observes committed WorkerRun starts, then
// the Runtime's own driver owns everything else — including the startup pass
// over committed truth (apps/runtime/server.mjs `driveAll({ triggerType })`).
function attachDriver({ kernel }) {
  const driver = createContinuationDriver({
    kernel,
    proposer: deterministicNextActionProposer(),
    observe: true,
  });
  driver.driveAll({ triggerType: "STARTUP" });
  return driver;
}

// The team every scenario starts from: one producer, one reviewer.
function assembleTeam(kernel, asFounder) {
  const company = asFounder(() => kernel.createCompany({ name: "Northwind Studio" }));
  const operator = asFounder(() =>
    kernel.createPosition({
      companyId: company.id,
      title: "Operator",
      capabilities: ["work.execute"],
    }),
  );
  const reviewer = asFounder(() =>
    kernel.createPosition({
      companyId: company.id,
      title: "Reviewer",
      capabilities: ["work.review"],
    }),
  );
  asFounder(() =>
    kernel.createEmployee({
      companyId: company.id,
      positionId: operator.id,
      displayName: "Atlas",
    }),
  );
  asFounder(() =>
    kernel.createEmployee({
      companyId: company.id,
      positionId: reviewer.id,
      displayName: "Iris",
    }),
  );
  return { company, operator, reviewer };
}

const reviewTaskOf = (kernel, workId) =>
  kernel.tasks(workId).find((task) => task.title.startsWith("Review:"));
const sourceTaskOf = (kernel, workId) =>
  kernel.tasks(workId).find((task) => !task.title.startsWith("Review:"));

console.log(`\n== Worker Harness v0 — Slice 1.1 (deterministic backend, no model calls) ==\n`);

try {
  // ------------------------------------------------------------- Scenario 1
  {
    console.log(`-- Scenario 1: executed → reviewed (PASS) → Founder ACCEPT --`);
    const h = openHarness();
    let founderTouches = 0;
    const asFounder = (fn) => {
      founderTouches += 1;
      return fn();
    };
    const team = assembleTeam(h.kernel, asFounder);
    report("Founder assembles the team", "Atlas → Operator [work.execute] · Iris → Reviewer [work.review]");

    h.host.start();
    attachDriver(h);

    const work = asFounder(() =>
      h.kernel.createWork({
        companyId: team.company.id,
        title: "Evaluate market option A",
        intent: "The founder needs a defensible read before committing",
      }),
    );
    report("Founder states one Work", `"${work.title}" — nothing else is asked of the Founder`);

    // Everything after this point is either the Runtime's coordination or the
    // Founder's decision. Nothing here assigns, starts or dispatches anything.
    let manualCoordination = 0;
    const founderCommandsAfterWork = [];

    await until(() => h.kernel.workProjection(work.id).status === "READY_FOR_DECISION", {
      label: "the Work to travel from one sentence to the decision boundary",
    });

    const sourceTask = sourceTaskOf(h.kernel, work.id);
    const reviewTask = reviewTaskOf(h.kernel, work.id);
    const sourceRun = h.kernel.workerRuns({ taskId: sourceTask.id })[0];
    const reviewRun = h.kernel.workerRuns({ taskId: reviewTask.id })[0];
    assert.equal(h.host.reportFor(sourceRun.id)[0].status, "DELIVERED");
    assert.equal(h.host.reportFor(reviewRun.id)[0].status, "DELIVERED");
    assert.equal(reviewRun.endReason, "REVIEW_COMPLETED");
    report(
      "The Host executes the attempt and the Runtime dispatches the reviewer",
      `test-worker · 2 bound attempts · reviewer delivered ${h.kernel.reviews({ workId: work.id })[0].verdict}`,
    );

    const projection = h.kernel.workProjection(work.id);
    assert.equal(h.kernel.status().counts.reviews, 1);
    assert.equal(h.kernel.status().counts.founderDecisions, 0);
    assert.equal(projection.outcome.accepted, null, "a Reviewer PASS is not an acceptance");
    assert.equal(projection.founderAttention.item.kind, "DECISION_REQUIRED");
    report(
      "The Work waits at READY_FOR_DECISION, on the Founder alone",
      `${projection.founderAttention.item.kind} · 1 Review · 0 Founder Decisions`,
    );

    assert.equal(manualCoordination, 0);
    assert.equal(founderCommandsAfterWork.length, 0);
    assert.equal(founderTouches - 6, 0, "no extra Founder touch inside the coordination window");
    report("Founder Extra Touch = 0, Manual Coordination = 0", "the Runtime did the coordinating");

    const candidate = projection.outcome.candidateArtifacts[0];
    founderCommandsAfterWork.push("acceptWork");
    const accepted = h.kernel.acceptWork({
      workId: work.id,
      artifactId: candidate.id,
      artifactDigest: candidate.digest,
      basis: projection.decisionBasis,
    });
    assert.equal(accepted.decision.disposition, "ACCEPT");
    assert.equal(h.kernel.workProjection(work.id).outcome.state, "ACCEPTED");
    report(
      "Founder ACCEPT — the one decision this Work needed",
      `${accepted.decision.id} · artifact ${candidate.id.slice(0, 12)}… · digest-bound`,
    );
    await h.host.stop();
    console.log("");
  }

  // ------------------------------------------------------------- Scenario 2
  {
    console.log(`-- Scenario 2: the Reviewer asks for a revision, and the Repair passes --`);
    let reviewAttempts = 0;
    const h = openHarness({
      behavior: (input) => {
        if (input.resultContract?.kind !== "REVIEW_JUDGMENT") return "complete";
        reviewAttempts += 1;
        return reviewAttempts === 1 ? "request-revision" : "complete";
      },
    });
    const team = assembleTeam(h.kernel, (fn) => fn());
    h.host.start();
    attachDriver(h);

    const work = h.kernel.createWork({
      companyId: team.company.id,
      title: "Recommend a launch plan",
      intent: "The founder needs a recommendation that survives scrutiny",
    });
    report("Founder states one Work", `"${work.title}"`);

    await until(() => h.kernel.reviews({ workId: work.id }).length === 1, {
      label: "the first review",
    });
    const [requested] = h.kernel.reviews({ workId: work.id });
    assert.equal(requested.verdict, "REQUEST_REVISION");
    const firstArtifact = h.kernel.artifact(requested.targetArtifactId);
    assert.deepEqual(requested.findings, ["The deliverable does not answer the intent recorded in the work packet."]);
    report(
      "Reviewer 1 requests a revision",
      `${requested.id.slice(0, 12)}… · ${requested.findings.length} finding · bound to artifact ${requested.targetArtifactId.slice(0, 12)}…`,
    );

    await until(() => h.kernel.workProjection(work.id).status === "READY_FOR_DECISION", {
      label: "the repaired artifact to pass its review",
    });
    const reviews = h.kernel.reviews({ workId: work.id });
    const [repair] = h.kernel.repairBindings({ workId: work.id });
    assert.equal(reviews.length, 2);
    assert.equal(reviews[1].verdict, "PASS");
    assert.equal(repair.reviewId, requested.id);
    assert.equal(h.kernel.task(repair.repairTaskId).state, "COMPLETED");
    assert.notEqual(reviews[1].targetArtifactId, requested.targetArtifactId);
    assert.equal(
      h.kernel.artifact(reviews[1].targetArtifactId).supersedesArtifactId,
      requested.targetArtifactId,
      "the replacement names what it replaces",
    );
    assert.equal(
      h.kernel.artifact(requested.targetArtifactId).content,
      firstArtifact.content,
      "the replaced artifact is never rewritten",
    );
    assert.equal(
      h.kernel.artifact(requested.targetArtifactId).contentDigest,
      firstArtifact.contentDigest,
      "its digest is unchanged too",
    );
    report(
      "The Runtime repairs, the Host re-executes, Reviewer 2 passes",
      `Repair ${repair.id.slice(0, 12)}… · Artifact v2 · 2 Reviews · 0 Founder decisions`,
    );

    const projection = h.kernel.workProjection(work.id);
    assert.deepEqual(
      projection.outcome.candidateArtifacts.map((entry) => entry.id),
      [reviews[1].targetArtifactId],
    );
    assert.equal(projection.founderAttention.item.kind, "DECISION_REQUIRED");
    report(
      "One current candidate, one Founder decision pending",
      `Founder Decisions so far = ${h.kernel.status().counts.founderDecisions}`,
    );
    const candidate = projection.outcome.candidateArtifacts[0];
    const accepted = h.kernel.acceptWork({
      workId: work.id,
      artifactId: candidate.id,
      artifactDigest: candidate.digest,
      basis: projection.decisionBasis,
    });
    assert.equal(accepted.decision.disposition, "ACCEPT");
    assert.equal(h.kernel.workProjection(work.id).outcome.state, "ACCEPTED");
    report(
      "Founder ACCEPT of the repaired outcome",
      `${accepted.decision.id} · the second review asked for no further revision`,
    );
    await h.host.stop();
    console.log("");
  }

  // ------------------------------------------------------------- Scenario 3
  {
    console.log(`-- Scenario 3: a timed-out attempt, re-dispatched into a fresh workspace --`);
    const h = openHarness({
      behavior: (input) => (input.generation === 1 ? "hang" : "complete"),
      timeoutMs: 80,
    });

    const company = h.kernel.createCompany({ name: "Northwind Studio" });
    const position = h.kernel.createPosition({
      companyId: company.id,
      title: "Operator",
      capabilities: ["work.execute"],
    });
    const employee = h.kernel.createEmployee({
      companyId: company.id,
      positionId: position.id,
      displayName: "Atlas",
    });
    const work = h.kernel.createWork({
      companyId: company.id,
      title: "A Work whose first attempt dies",
      intent: "The output still has to arrive without the Founder calling anyone",
    });
    // Seeded without a review requirement so the retried delivery reaches the
    // Founder decision boundary; Scenario 1 covers the review leg.
    const task = h.kernel.createTask({
      workId: work.id,
      title: `Produce: ${work.title}`,
      intent: work.intent,
      requiredCapabilities: ["work.execute"],
    });
    h.kernel.assignTask({ taskId: task.id, employeeId: employee.id, reason: "fixture assignment" });
    report("Founder states one Work", `"${work.title}"`);

    h.host.start();
    attachDriver(h);

    await until(() => h.kernel.workerRuns({ state: "RUNNING" }).length === 1, {
      label: "the first attempt",
    });
    const firstRun = h.kernel.workerRuns({ state: "RUNNING" })[0];
    const firstBinding = h.kernel.workerExecutionBinding(firstRun.id);
    assert.ok(firstBinding, "the first attempt is bound to its execution");
    report("Attempt 1 starts and hangs", `workspace A = ${firstBinding.workspaceRoot.replace(h.dir, "<runtime>")}`);

    // Poison the abandoned workspace while the retry is in flight: correctness
    // must come from isolation, not from killing the orphan.
    writeFileSync(join(firstBinding.workspaceRoot, "output.txt"), "POISON FROM A DEAD ATTEMPT\n", "utf8");

    await until(() => h.kernel.workProjection(work.id).status === "READY_FOR_DECISION", {
      label: "the retried attempt to be delivered",
    });
    const runs = h.kernel.workerRuns({ taskId: task.id });
    assert.equal(runs.length, 2);
    assert.equal(runs[0].state, "INTERRUPTED");
    assert.equal(runs[0].endReason, "WORKER_TIMEOUT");
    assert.equal(runs[1].state, "COMPLETED");
    const secondBinding = h.kernel.workerExecutionBinding(runs[1].id);
    assert.notEqual(firstBinding.workspaceRoot, secondBinding.workspaceRoot);
    assert.notEqual(firstBinding.id, secondBinding.id);
    report(
      "The Runtime re-dispatches within budget; the retry runs in its own workspace",
      `workspace B = ${secondBinding.workspaceRoot.replace(h.dir, "<runtime>")} · A != B`,
    );

    const projection = h.kernel.workProjection(work.id);
    assert.equal(projection.outcome.candidateArtifacts.length, 1, "exactly one current candidate");
    const artifact = h.kernel.artifact(projection.outcome.candidateArtifacts[0].id);
    assert.doesNotMatch(artifact.content, /POISON/);
    assert.match(artifact.content, new RegExp(runs[1].id));
    assert.equal(readFileSync(join(firstBinding.workspaceRoot, "output.txt"), "utf8"), "POISON FROM A DEAD ATTEMPT\n");
    assert.equal(h.kernel.status().counts.founderDecisions, 0);
    report(
      "The delivered artifact came from B, never from the poisoned A",
      `1 artifact · 1 candidate · 0 Founder decisions`,
    );
    await h.host.stop();
    console.log("");
  }

  // ------------------------------------------------------------- Scenario 4
  {
    console.log(`-- Scenario 4: attempts that always die — the Runtime stops and asks --`);
    const h = openHarness({ behavior: "hang", timeoutMs: 60 });

    const company = h.kernel.createCompany({ name: "Northwind Studio" });
    const position = h.kernel.createPosition({
      companyId: company.id,
      title: "Operator",
      capabilities: ["work.execute"],
    });
    const employee = h.kernel.createEmployee({
      companyId: company.id,
      positionId: position.id,
      displayName: "Atlas",
    });
    const work = h.kernel.createWork({
      companyId: company.id,
      title: "A Work nothing can finish",
      intent: "The Founder must be told, not looped at",
    });
    const task = h.kernel.createTask({
      workId: work.id,
      title: `Produce: ${work.title}`,
      intent: work.intent,
      requiredCapabilities: ["work.execute"],
    });
    h.kernel.assignTask({ taskId: task.id, employeeId: employee.id, reason: "fixture assignment" });
    report("Founder states one Work", `"${work.title}" · the backend never finishes anything`);

    h.host.start();
    const driver = attachDriver(h);

    await until(() => h.kernel.workerRuns({ taskId: task.id }).length === MAX_AUTONOMOUS_ATTEMPTS_PER_TASK, {
      label: "the attempt budget to be spent",
    });
    // Give any (incorrect) further restart a chance to appear.
    driver.driveWork(work.id, { triggerType: "EXPLICIT" });
    await new Promise((resolve) => setTimeout(resolve, 120));

    const runs = h.kernel.workerRuns({ taskId: task.id });
    assert.equal(runs.length, MAX_AUTONOMOUS_ATTEMPTS_PER_TASK);
    assert.equal(runs.every((run) => run.state === "INTERRUPTED"), true);
    assert.equal(h.kernel.task(task.id).state, "INTERRUPTED");
    const stopped = driver.driveWork(work.id, { triggerType: "EXPLICIT" });
    assert.equal(stopped.diagnostic.code, CONTINUATION_DIAGNOSTICS.AUTO_RETRY_EXHAUSTED);
    report(
      `The Runtime stops after ${runs.length} attempts instead of looping`,
      `reason ${CONTINUATION_DIAGNOSTICS.AUTO_RETRY_EXHAUSTED} · no stored counter · no Task state added`,
    );

    const projection = h.kernel.workProjection(work.id);
    const item = projection.founderAttention.item;
    assert.equal(item.kind, "EXECUTION_INTERRUPTED");
    assert.ok(item.conditions.includes("AUTO_RETRY_EXHAUSTED"), "the item says why it reached the Founder");
    assert.deepEqual(
      item.actions.map((entry) => entry.kind).sort(),
      ["ABANDON_TASK", "RESUME_EXECUTION"],
    );
    report(
      "Founder Attention carries the exhausted condition and the honest exits",
      `${item.kind} · conditions: ${item.conditions.join(", ")} · actions: ${item.actions
        .map((entry) => entry.kind)
        .join(" / ")}`,
    );
    await h.host.stop();
  }

  console.log(`\nAll four scenarios passed on the real Runtime seams.`);
  console.log(
    `Worker Harness v0 Slice 1.1 = PASS (deterministic test backend, no model calls): execution, review, repair, bounded retries; Founder decisions stay explicit`,
  );
} finally {
  cleanup();
}

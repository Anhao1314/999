// Demonstration for Review & Repair Collaboration v0B2 (milestone charter §40).
//
// A real company working through the whole protocol:
//
//   Company → Positions → Employees → Work → Execution Task
//   → Atlas produces v1 → HANDOFF FOR REVIEW → Review Task → Iris reviews
//   → REQUEST_REVISION → Repair Task → Atlas repairs → v2 supersedes v1
//   → HANDOFF FOR REVIEW → Iris reviews → PASS → READY_FOR_DECISION
//
// Generic product language only: positions, employees, capability ids. The
// shipped roster lives in fixtures/ and never appears here.
//
//   node scripts/demo-review-repair-v0b2.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startRuntime } from "./lib/runtime-process.mjs";

const dir = mkdtempSync(join(tmpdir(), "flowcredit-review-demo-"));
const steps = [];
const report = (step, detail) => {
  steps.push(step);
  console.log(`${String(steps.length).padStart(2, " ")}. ${step} — ${detail}`);
};

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let runtime = null;
try {
  console.log(`\n== Review & Repair Collaboration v0B2 — company demonstration ==`);
  console.log(`store: ${dir}\n`);

  runtime = await startRuntime({ dir });
  report("runtime started", runtime.base);

  const company = await runtime.command("createCompany", { name: "Acme" });
  report("company created", `${company.id} "${company.name}"`);

  const analystPosition = await runtime.command("createPosition", {
    companyId: company.id,
    title: "Analyst",
    capabilities: ["analysis.execute"],
  });
  const reviewerPosition = await runtime.command("createPosition", {
    companyId: company.id,
    title: "Quality Reviewer",
    capabilities: ["quality.review"],
  });
  report(
    "positions created",
    `[${analystPosition.title} → ${analystPosition.capabilities}] [${reviewerPosition.title} → ${reviewerPosition.capabilities}]`,
  );

  const atlas = await runtime.command("createEmployee", {
    companyId: company.id,
    positionId: analystPosition.id,
    displayName: "Atlas",
  });
  const iris = await runtime.command("createEmployee", {
    companyId: company.id,
    positionId: reviewerPosition.id,
    displayName: "Iris",
  });
  report("employees hired", `Atlas ${atlas.id.slice(0, 12)}… (Analyst) · Iris ${iris.id.slice(0, 12)}… (Quality Reviewer)`);

  const work = await runtime.command("createWork", {
    companyId: company.id,
    title: "Evaluate market option",
    intent: "The founder needs a defensible read before committing",
  });
  const task = await runtime.command("createTask", {
    workId: work.id,
    title: "Analyze evidence",
    intent: "One analysis the founder can act on",
    requiredCapabilities: ["analysis.execute"],
  });
  await runtime.command("setTaskRequirements", {
    taskId: task.id,
    requiredCapabilities: ["analysis.execute"],
    reviewCapabilities: ["quality.review"],
  });
  report("work and execution task created", `"${work.title}" → "${task.title}" (must be reviewed)`);

  await runtime.command("assignTask", {
    taskId: task.id,
    employeeId: atlas.id,
    reason: "the analyst owns this analysis",
  });
  const run = await runtime.command("startWorkerRun", { taskId: task.id });
  report("Atlas is working", `run ${run.workerRun.id.slice(0, 12)}… generation ${run.generation}`);

  const v1 = await runtime.command("recordArtifact", {
    taskId: task.id,
    generation: run.generation,
    workerRunId: run.workerRun.id,
    kind: "document",
    title: "Market option read v1",
    content: "# Option A\n- upside: reachable\n",
  });
  report("artifact v1 produced", `${v1.id.slice(0, 12)}… digest ${v1.contentDigest.slice(0, 20)}…`);

  const closedWithoutReview = await fetch(`${runtime.base}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command: "completeWorkerRun",
      input: { taskId: task.id, generation: run.generation },
    }),
  });
  assert.equal(closedWithoutReview.status, 409);
  report(
    "closing the task without review refused",
    `completeWorkerRun → 409 ${(await closedWithoutReview.json()).error.code}`,
  );

  const handedOff = await runtime.command("requestReview", {
    taskId: task.id,
    generation: run.generation,
  });
  const reviewRequirements = (await runtime.json(`/tasks/${handedOff.reviewTask.id}`))
    .requirements.requiredCapabilities;
  report(
    "handed off, and the review task exists in the same transaction",
    `source=${handedOff.task.state} · review task ${handedOff.reviewTask.id.slice(0, 12)}… needs [${reviewRequirements}]`,
  );
  assert.equal(handedOff.task.state, "COMPLETED");

  await runtime.command("assignTask", {
    taskId: handedOff.reviewTask.id,
    employeeId: iris.id,
    reason: "independent review",
  });
  const reviewRun = await runtime.command("startWorkerRun", { taskId: handedOff.reviewTask.id });
  report(
    "Iris reviews — an ordinary assignment and run",
    `run ${reviewRun.workerRun.id.slice(0, 12)}… packet carries artifact ${v1.id.slice(0, 12)}… at digest ${reviewRun.workerRun.workPacket.review.reviewedDigest.slice(0, 20)}…`,
  );
  assert.equal(reviewRun.workerRun.workPacket.review.targetArtifact.id, v1.id);

  const revision = await runtime.command("submitReview", {
    reviewTaskId: handedOff.reviewTask.id,
    generation: reviewRun.generation,
    verdict: "REQUEST_REVISION",
    summary: "The recommendation is not supported by the evidence supplied.",
    findings: ["The downside case is missing."],
  });
  report(
    "Iris requests a revision",
    `review ${revision.review.id.slice(0, 12)}… → ${revision.review.verdict} (${revision.review.findings.length} finding)`,
  );

  const repair = await runtime.command("createRepairTask", { reviewId: revision.review.id });
  assert.equal(repair.assignment.employeeId, atlas.id);
  report(
    "repair opened and assigned to the original producer",
    `task ${repair.task.id.slice(0, 12)}… → Atlas (reason: ${repair.assignment.reason})`,
  );

  const repairRun = await runtime.command("startWorkerRun", { taskId: repair.task.id });
  report(
    "Atlas repairs with the findings in hand",
    `packet.repair.supersedes=${repairRun.workerRun.workPacket.repair.supersedesArtifactId.slice(0, 12)}… findings=${repairRun.workerRun.workPacket.repair.reviewFindings.length}`,
  );

  const unbound = await fetch(`${runtime.base}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command: "recordArtifact",
      input: {
        taskId: repair.task.id,
        generation: repairRun.generation,
        workerRunId: repairRun.workerRun.id,
        kind: "document",
        title: "Unbound replacement",
        content: "no supersession named\n",
      },
    }),
  });
  assert.equal(unbound.status, 409);
  report(
    "a replacement that names no target is refused",
    `recordArtifact(no supersedes) → 409 ${(await unbound.json()).error.code}`,
  );

  const v2 = await runtime.command("recordArtifact", {
    taskId: repair.task.id,
    generation: repairRun.generation,
    workerRunId: repairRun.workerRun.id,
    supersedesArtifactId: v1.id,
    kind: "document",
    title: "Market option read v2",
    content: "# Option A\n- upside: reachable\n- downside: concentration\n",
  });
  report("artifact v2 supersedes v1", `${v2.id.slice(0, 12)}… supersedes ${v2.supersedesArtifactId.slice(0, 12)}…`);

  const v1After = (await runtime.json(`/artifacts/${v1.id}`)).artifact;
  assert.equal(v1After.content, v1.content);
  assert.equal(v1After.contentDigest, v1.contentDigest);
  assert.equal(v1After.supersedesArtifactId, null);
  report(
    "the replaced artifact is untouched",
    `content and digest identical, supersedes still null`,
  );

  const secondHandoff = await runtime.command("requestReview", {
    taskId: repair.task.id,
    generation: repairRun.generation,
  });
  await runtime.command("assignTask", {
    taskId: secondHandoff.reviewTask.id,
    employeeId: iris.id,
    reason: "independent review",
  });
  const secondReviewRun = await runtime.command("startWorkerRun", {
    taskId: secondHandoff.reviewTask.id,
  });
  const passed = await runtime.command("submitReview", {
    reviewTaskId: secondHandoff.reviewTask.id,
    generation: secondReviewRun.generation,
    verdict: "PASS",
    summary: "The recommendation now matches the evidence supplied.",
    findings: [],
  });
  assert.equal(passed.review.targetArtifactId, v2.id);
  report(
    "Iris reviews cycle 2 and passes",
    `review ${passed.review.id.slice(0, 12)}… → ${passed.review.verdict} on ${passed.review.targetArtifactId.slice(0, 12)}…`,
  );

  const projection = await runtime.json(`/works/${work.id}`);
  assert.equal(projection.status, "READY_FOR_DECISION");
  report(
    "work projection is derived, not stored",
    `status=${projection.status} stage=${projection.stage} round=${projection.collaboration.round} artifacts=${projection.artifacts.length} reviews=${projection.reviews.length} repairs=${projection.repairBindings.length}`,
  );
  assert.equal(projection.latestArtifact.id, v2.id);
  assert.equal(projection.status === "ACCEPTED" || projection.status === "COMPLETED", false);
  assert.ok(deepEqual(projection.supersession.map((link) => link.artifactId), [v2.id]));
  report(
    "history is a chain, not an overwrite",
    projection.artifacts
      .map((artifact) => `${artifact.title}${artifact.supersedesArtifactId ? " (replaces an earlier read)" : ""}`)
      .join(" | "),
  );
  const trails = [task.id, handedOff.reviewTask.id, repair.task.id, secondHandoff.reviewTask.id];
  const activity = (
    await Promise.all(
      trails.map((id) => runtime.json(`/tasks/${id}`).then((detail) => detail.activity)),
    )
  )
    .flat()
    .sort((a, b) => a.sequence - b.sequence);
  report(
    "activity vocabulary across the whole company (chronological)",
    activity.map((event) => event.kind).join(" | "),
  );

  const { code } = await runtime.stop();
  assert.equal(code, 0);
  runtime = null;
  report("runtime stopped", "exit code 0");

  console.log(
    "\nAtlas produced a result. Iris reviewed it independently. Atlas repaired it. Iris reviewed it again and passed it.",
  );
  console.log("Founder has NOT accepted this Work.\n");
} catch (error) {
  console.error(`\ndemonstration failed at step ${steps.length + 1}: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (runtime) await runtime.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}

// Demonstration for Founder Attention & Acceptance v0B3 (milestone charter §20).
//
// The last leg of the AI Workforce loop, on the same company the v0B2 demo
// leaves at READY_FOR_DECISION:
//
//   Work → execution Task → Atlas produces v1 → Iris reviews → REQUEST_REVISION
//   → Repair → Atlas produces v2 superseding v1 → Iris reviews → PASS
//   → exactly one outcome candidate → READY_FOR_DECISION
//   → Founder Attention: DECISION_REQUIRED
//   → Founder reads Artifact v2 + digest + DecisionBasis
//   → Founder ACCEPT → immutable Founder Decision → outcome ACCEPTED
//   → DECISION_REQUIRED disappears → Knowledge unchanged
//
// Generic product language only: positions, employees, capability ids. The
// shipped roster lives in fixtures/ and never appears here.
//
//   node scripts/demo-founder-acceptance-v0b3.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startRuntime } from "./lib/runtime-process.mjs";

const dir = mkdtempSync(join(tmpdir(), "flowcredit-accept-demo-"));
const steps = [];
const report = (step, detail) => {
  steps.push(step);
  console.log(`${String(steps.length).padStart(2, " ")}. ${step} — ${detail}`);
};

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The one way this demo is allowed to fail: a command that must be refused.
async function refusal(runtime, command, input) {
  const response = await fetch(`${runtime.base}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command, input }),
  });
  return { status: response.status, body: await response.json() };
}

let runtime = null;
try {
  console.log(`\n== Founder Attention & Acceptance v0B3 — company demonstration ==`);
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
  report(
    "team assembled",
    `Atlas ${atlas.id.slice(0, 12)}… (Analyst) · Iris ${iris.id.slice(0, 12)}… (Quality Reviewer)`,
  );

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
  const v1 = await runtime.command("recordArtifact", {
    taskId: task.id,
    generation: run.generation,
    workerRunId: run.workerRun.id,
    kind: "document",
    title: "Market option read v1",
    content: "# Option A\n- upside: reachable\n",
  });
  report("artifact v1 produced", `${v1.id.slice(0, 12)}… digest ${v1.contentDigest.slice(0, 20)}…`);

  const handedOff = await runtime.command("requestReview", {
    taskId: task.id,
    generation: run.generation,
  });
  report(
    "handed off for review",
    `source=${handedOff.task.state} · review task ${handedOff.reviewTask.id.slice(0, 12)}… needs ["quality.review"]`,
  );

  await runtime.command("assignTask", {
    taskId: handedOff.reviewTask.id,
    employeeId: iris.id,
    reason: "independent review",
  });
  const reviewRun = await runtime.command("startWorkerRun", { taskId: handedOff.reviewTask.id });
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
    "repair opened and owned by the original producer",
    `task ${repair.task.id.slice(0, 12)}… → Atlas (reason: ${repair.assignment.reason})`,
  );

  const repairRun = await runtime.command("startWorkerRun", { taskId: repair.task.id });
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
  report(
    "Iris reviews cycle 2 and passes",
    `review ${passed.review.id.slice(0, 12)}… → ${passed.review.verdict} on ${passed.review.targetArtifactId.slice(0, 12)}…`,
  );

  const ready = await runtime.json(`/works/${work.id}`);
  assert.equal(ready.status, "READY_FOR_DECISION");
  assert.equal(ready.outcome.state, "READY");
  assert.equal(ready.outcome.accepted, null);
  assert.equal(ready.outcome.candidateArtifacts.length, 1);
  assert.equal(ready.outcome.candidateArtifacts[0].id, v2.id);
  report(
    "exactly one current outcome candidate",
    `status=${ready.status} outcome.state=${ready.outcome.state} candidate=${ready.outcome.candidateArtifacts[0].id.slice(0, 12)}… (the superseded v1 is not one)`,
  );

  const attention = (await runtime.json(`/companies/${company.id}/attention`)).attention;
  assert.equal(attention.length, 1);
  const [item] = attention;
  assert.equal(item.kind, "DECISION_REQUIRED");
  report(
    "Founder Attention is a projection, not an Inbox",
    `${item.id} → action ${item.actions[0].kind} (${item.actions[0].effect})`,
  );

  const countsBefore = (await runtime.json("/status")).counts;
  const reread = (await runtime.json(`/companies/${company.id}/attention`)).attention;
  const countsAfter = (await runtime.json("/status")).counts;
  assert.ok(deepEqual(reread, attention));
  assert.ok(deepEqual(countsAfter, countsBefore));
  report(
    "reading attention twice changes nothing",
    `same item, identical row counts — there is no read/unread/done to store`,
  );

  console.log("\n   Reviewer PASS != Founder ACCEPT\n");
  report(
    "the pass is not an acceptance",
    `outcome.state=${ready.outcome.state} · decisions recorded=${countsBefore.founderDecisions} · the Founder still owes this Work a decision`,
  );

  const decisionInput = {
    workId: item.workId,
    artifactId: item.actions[0].artifactId,
    artifactDigest: item.actions[0].artifactDigest,
    basis: item.decisionBasis,
  };
  report(
    "Founder reads the artifact, its digest and the DecisionBasis",
    `artifact=${decisionInput.artifactId.slice(0, 12)}… digest=${decisionInput.artifactDigest.slice(0, 20)}… basis=${decisionInput.basis}`,
  );

  const refused = await refusal(runtime, "acceptWork", {
    ...decisionInput,
    artifactId: v1.id,
    artifactDigest: v1.contentDigest,
  });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "ARTIFACT_NOT_CURRENT");
  report(
    "the superseded draft cannot be accepted",
    `acceptWork(v1) → 409 ${refused.body.error.code} — the Runtime never falls back to an artifact by recency`,
  );

  const accepted = await runtime.command("acceptWork", decisionInput);
  assert.equal(accepted.idempotent, false);
  assert.equal(accepted.decision.disposition, "ACCEPT");
  report(
    "Founder ACCEPT — one immutable decision",
    `decision ${accepted.decision.id.slice(0, 16)}… disposition=${accepted.decision.disposition} basis=${accepted.decision.basisSequence} at ${accepted.decision.createdAt}`,
  );

  const retried = await runtime.command("acceptWork", decisionInput);
  assert.equal(retried.idempotent, true);
  assert.equal(retried.decision.id, accepted.decision.id);
  assert.ok(deepEqual(retried.work, accepted.work));
  report(
    "the retry is the same decision",
    `idempotent=true · same decision id · the projection is identical`,
  );

  const conflict = await refusal(runtime, "acceptWork", { ...decisionInput, basis: decisionInput.basis - 1 });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, "WORK_ALREADY_DECIDED");
  report(
    "a competing decision is refused before anything else",
    `acceptWork(stale basis) → 409 ${conflict.body.error.code}`,
  );

  assert.equal(accepted.work.outcome.state, "ACCEPTED");
  assert.equal(accepted.work.outcome.accepted.disposition, "ACCEPT");
  assert.equal(accepted.work.status, "READY_FOR_DECISION");
  report(
    "the Work outcome is ACCEPTED",
    `derived outcome.state=${accepted.work.outcome.state} while collaboration status stays ${accepted.work.status} — ACCEPT is the act, ACCEPTED is the state`,
  );

  const clearedAttention = (await runtime.json(`/companies/${company.id}/attention`)).attention;
  assert.deepEqual(clearedAttention, []);
  report("DECISION_REQUIRED is gone", `attention items for this company: ${clearedAttention.length}`);

  const immutable = await fetch(`${runtime.base}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command: "createTask",
      input: { workId: work.id, title: "One more thing", intent: "too late" },
    }),
  });
  assert.equal(immutable.status, 409);
  assert.equal((await immutable.json()).error.code, "WORK_ACCEPTED_LOCKED");
  report(
    "an accepted Work takes no new Tasks",
    `createTask → 409 WORK_ACCEPTED_LOCKED (a Work that is merely READY_FOR_DECISION is not locked)`,
  );

  const countsAccepted = (await runtime.json("/status")).counts;
  const written = Object.keys(countsAccepted).filter(
    (table) => countsAccepted[table] !== countsBefore[table],
  );
  assert.deepEqual(written.sort(), ["activity", "founderDecisions"]);
  console.log("\n   Founder ACCEPT != Knowledge Admission\n");
  report(
    "no Knowledge was written",
    `this Runtime has no knowledge store; the acceptance wrote exactly [${written.join(", ")}]: +${countsAccepted.founderDecisions - countsBefore.founderDecisions} decision, +${countsAccepted.activity - countsBefore.activity} activity event`,
  );

  const { signal } = await runtime.crash();
  assert.equal(signal, "SIGKILL");
  runtime = null;
  report("runtime killed hard", "SIGKILL — no clean shutdown, no final write");

  runtime = await startRuntime({ dir });
  const status = await runtime.json("/status");
  assert.equal(status.counts.founderDecisions, 1);
  assert.equal(status.recovery.count, 0);
  const afterCrash = await runtime.json(`/works/${work.id}`);
  assert.ok(deepEqual(afterCrash, accepted.work));
  report(
    "the decision survived the crash",
    `schemaVersion=${status.schemaVersion} decisions=${status.counts.founderDecisions} outcome=${afterCrash.outcome.state} attention=${(await runtime.json(`/companies/${company.id}/attention`)).attention.length}`,
  );

  const { code } = await runtime.stop();
  assert.equal(code, 0);
  runtime = null;
  report("runtime stopped", "exit code 0");

  console.log(
    "\nAtlas produced, Iris reviewed, Atlas repaired, Iris passed, the Founder accepted.",
  );
  console.log("The decision is durable, the Work is ACCEPTED, and nothing was admitted to Knowledge.\n");
} catch (error) {
  console.error(`\ndemonstration failed at step ${steps.length + 1}: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (runtime) await runtime.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}

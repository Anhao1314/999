// H1.1 — the real Repair loop (CodexExecAdapter closure, contract §8–§20).
//
//   node scripts/h1-1-codex-repair.mjs <scenario>      scenario = 1 | 2 | 3
//   node scripts/h1-1-codex-repair.mjs boundary <scenario...>
//     re-attaches to a finished scenario's store with coordination OFF (no
//     actuation, no model call) and performs the Founder boundary the scenario
//     stopped short of at an honest PASS: READY_FOR_DECISION +
//     DECISION_REQUIRED + 0 Founder Decisions, then an explicit acceptWork.
//
// The goal is one genuine, model-produced evidence chain — no fake verdict, no
// synthetic Review, no manual Repair, no TEST_DRIVER:
//
//   Execution Worker → Artifact v1 → independent real Codex Reviewer
//     → REQUEST_REVISION → Runtime Repair protocol → real Codex Repair Worker
//     → Artifact v2 → independent real Codex Reviewer → PASS
//     → READY_FOR_DECISION → explicit Founder ACCEPT
//
// Runtime owns every handoff: the script only creates the company, the team and
// one Work, then watches. Every real worker process runs inside a run-scoped
// worktree under /tmp/flowcredit-h1-1/...; the canonical FlowCredit checkout is
// fingerprinted before and after and must come out byte-identical.
//
// A scenario may honestly end in PASS on the first attempt: a Reviewer is free
// to judge the artifact acceptable, and that is reported as
// REAL_REPAIR_EVIDENCE_NOT_OBSERVED rather than manufactured.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { CODEX_EXEC_ADAPTER_TYPE } from "../packages/harness/index.mjs";
import { digestOf } from "../packages/work/records.mjs";
import { buildH11Fixture } from "./lib/h1-1-fixture.mjs";
import { repoRoot, startRuntime } from "./lib/runtime-process.mjs";

const H11_ROOT = "/tmp/flowcredit-h1-1";
const ATTEMPT_TIMEOUT_MS = 900_000;

// At most three distinct real task scenarios, each its own plausible product
// change on its own library. The experiment stops at the first genuine
// REQUEST_REVISION.
const SCENARIOS = Object.freeze({
  "1": Object.freeze({
    variant: "normalization",
    title: "Implement request-lab release 2 (input normalization)",
    intent:
      "docs/REQUIREMENTS.md is the authoritative specification for release 2 and is deliberately wider than test/: the shipped tests are a regression suite, not a complete specification. Implement the documented behavior in src/ so that `node --test` passes, and keep test/ untouched.",
  }),
  "2": Object.freeze({
    variant: "duration",
    title: "Implement duration-lab release 2 (ISO-8601 durations and one canonical form)",
    intent:
      "docs/REQUIREMENTS.md is the authoritative specification for release 2 and is deliberately wider than test/: the shipped tests are a regression suite, not a complete specification. Implement the documented behavior in src/ so that `node --test` passes, and keep test/ untouched.",
  }),
  "3": Object.freeze({
    variant: "slots",
    title: "Implement slots-lab release 2 (interval subtraction, intersection and free slots)",
    intent:
      "docs/REQUIREMENTS.md is the authoritative specification for release 2 and is deliberately wider than test/: the shipped tests are a regression suite, not a complete specification. Implement the documented behavior in src/ so that `node --test` passes, and keep test/ untouched.",
  }),
});

let stepNumber = 0;
const step = (title, detail = "") => {
  stepNumber += 1;
  console.log(`${String(stepNumber).padStart(2, " ")}. ${title}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function resetScenarioDir(root) {
  for (const name of ["store", "evidence", "run"]) rmSync(join(root, name), { recursive: true, force: true });
}

async function until(predicate, { label, timeoutMs = 30 * 60_000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label ?? "condition"}${lastError ? ` (last error: ${lastError.message})` : ""}`);
}

// --- FlowCredit integrity (§24) ----------------------------------------------
function fingerprintFlowCredit() {
  const git = (args) => execFileSync("git", [...args], { cwd: repoRoot(), encoding: "utf8" }).trimEnd();
  return Object.freeze({
    branch: git(["branch", "--show-current"]),
    head: git(["rev-parse", "HEAD"]),
    status: git(["status", "--porcelain"]),
    diffDigest: digestOf(git(["diff"])),
  });
}
function assertFlowCreditUnchanged(before, after) {
  assert.equal(after.branch, before.branch, "the canonical checkout's branch changed");
  assert.equal(after.head, before.head, "the canonical checkout's HEAD changed");
  assert.equal(after.status, before.status, "the canonical checkout's working tree changed");
  assert.equal(after.diffDigest, before.diffDigest, "the canonical checkout's diff changed");
}

// --- store readers -----------------------------------------------------------
function readBindings(storeDir) {
  const db = new DatabaseSync(join(storeDir, "kernel.sqlite"), { readOnly: true });
  try {
    return db
      .prepare("SELECT * FROM worker_execution_bindings ORDER BY sequence")
      .all()
      .map((row) => ({
        workerRunId: row.worker_run_id,
        generation: row.generation,
        backendType: row.backend_type,
        backendVersion: row.backend_version,
        baseRevision: row.base_revision,
        workspaceRoot: row.workspace_root,
        externalSessionRef: row.external_session_ref,
      }));
  } finally {
    db.close();
  }
}

function readRunPackets(storeDir) {
  const db = new DatabaseSync(join(storeDir, "kernel.sqlite"), { readOnly: true });
  try {
    return db
      .prepare("SELECT id, task_id, generation, state, end_reason, work_packet FROM worker_runs ORDER BY sequence")
      .all()
      .map((row) => ({
        workerRunId: row.id,
        taskId: row.task_id,
        generation: row.generation,
        state: row.state,
        endReason: row.end_reason,
        packet: JSON.parse(row.work_packet),
      }));
  } finally {
    db.close();
  }
}

function readEvidence(evidenceDir, workerRunId, generation) {
  const path = join(evidenceDir, `${workerRunId}-g${generation}.json`);
  assert.ok(existsSync(path), `expected adapter evidence at ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function report(root, payload) {
  writeFileSync(join(root, "report.json"), JSON.stringify(payload, null, 2), "utf8");
}

function fixtureTestRun(repository) {
  try {
    execFileSync("node", ["--test"], { cwd: repository, stdio: "pipe" });
    return { exitCode: 0 };
  } catch (error) {
    return { exitCode: error.status ?? 1 };
  }
}

// --- the scenario -------------------------------------------------------------
async function main() {
  const scenario = process.argv[2] ?? "1";
  assert.ok(["1", "2", "3"].includes(scenario), "scenario must be 1, 2 or 3 (at most three real attempts)");
  const plan = SCENARIOS[scenario];
  const root = join(H11_ROOT, `scenario-${scenario}`);
  const fixture = buildH11Fixture({ root: join(root, "repo"), variant: plan.variant });
  resetScenarioDir(root);
  const storeDir = join(root, "store");
  const evidenceDir = join(root, "evidence");
  const before = fingerprintFlowCredit();
  step("H1.1 fixture built", `${fixture.repository} @ ${fixture.baseRevision.slice(0, 12)}`);

  const initial = fixtureTestRun(fixture.repository);
  assert.notEqual(initial.exitCode, 0, "the fixture's release-2 tests must start red");
  step("the fixture starts red", `node --test exits ${initial.exitCode} on the unfinished release 2`);

  const runtime = await startRuntime({
    dir: storeDir,
    coordination: true,
    workerBackend: "codex-exec",
    workerTimeoutMs: ATTEMPT_TIMEOUT_MS,
    extraEnv: {
      FLOWCREDIT_CODEX_REPO: fixture.repository,
      FLOWCREDIT_CODEX_BASE_REVISION: fixture.baseRevision,
      FLOWCREDIT_CODEX_VERIFICATION: fixture.verification.join(" "),
      FLOWCREDIT_CODEX_PROTECTED_PATHS: fixture.protectedPaths.join(","),
      FLOWCREDIT_CODEX_EVIDENCE_DIR: evidenceDir,
    },
  });
  // A failed experiment must never leave a runtime child behind: every exit
  // path, including a thrown assertion, reaps the process.
  process.on("exit", () => {
    try {
      if (runtime.child.exitCode === null && runtime.child.signalCode === null) runtime.child.kill("SIGTERM");
    } catch {
      // best effort
    }
  });
  step("runtime started", `coordination=driver · worker=codex-exec · port ${runtime.port}`);

  const founderCommands = [];
  const command = (name, input = {}) => {
    founderCommands.push(name);
    return runtime.command(name, input);
  };

  const company = await command("createCompany", { name: "H1.1 Labs" });
  const engineer = await command("createPosition", {
    companyId: company.id,
    title: "Backend Engineer",
    capabilities: ["work.execute"],
  });
  const alice = await command("createEmployee", { companyId: company.id, positionId: engineer.id, displayName: "Alice" });
  const reviewerPosition = await command("createPosition", {
    companyId: company.id,
    title: "Code Reviewer",
    capabilities: ["work.review"],
  });
  const iris = await command("createEmployee", {
    companyId: company.id,
    positionId: reviewerPosition.id,
    displayName: "Iris",
  });
  step("Founder assembles the team", "Alice → Backend Engineer [work.execute] · Iris → Code Reviewer [work.review]");

  const work = await command("createWork", {
    companyId: company.id,
    title: plan.title,
    intent: plan.intent,
  });
  const commandsAfterWork = founderCommands.length;
  step("Founder states one Work", `"${work.title}" — then the Runtime owns every handoff`);

  // --- the first real review verdict -----------------------------------------
  const firstReview = await until(
    async () => {
      const { tasks } = await runtime.json(`/works/${work.id}/tasks`);
      const reviewTask = tasks.find((task) => task.title.startsWith("Review:"));
      if (!reviewTask) return null;
      const detail = await runtime.json(`/tasks/${reviewTask.id}`);
      return detail.review ? { reviewTask, detail } : null;
    },
    { label: "the first real Codex review verdict" },
  );
  const review1 = firstReview.detail.review;
  step(
    "real Codex Reviewer delivered a verdict",
    `${review1.verdict} · review ${review1.id.slice(0, 12)}… · artifact ${review1.targetArtifactId.slice(0, 12)}…`,
  );
  if (review1.verdict === "PASS") {
    step("an honest PASS — this scenario produced no repair", "a Reviewer is never instructed to ask for a revision");
    await runtime.stop();
    assertFlowCreditUnchanged(before, fingerprintFlowCredit());
    report(root, {
      scenario,
      fixture: fixture.baseRevision,
      workId: work.id,
      result: "REAL_REPAIR_EVIDENCE_NOT_OBSERVED",
      firstReview: {
        reviewId: review1.id,
        verdict: review1.verdict,
        targetArtifactId: review1.targetArtifactId,
        targetArtifactDigest: review1.targetArtifactDigest,
        findings: review1.findings,
      },
    });
    console.log(`\nScenario ${scenario}: REAL_REPAIR_EVIDENCE_NOT_OBSERVED (the Reviewer honestly PASSed).`);
    return;
  }
  assert.equal(review1.verdict, "REQUEST_REVISION", `unexpected verdict ${review1.verdict}`);
  assert.ok(review1.findings.length > 0, "a revision request must say what has to change");
  step("genuine REQUEST_REVISION", review1.findings.map((line) => line.slice(0, 120)).join(" | "));
  assert.equal((await runtime.json("/status")).counts.founderDecisions, 0, "a revision request is not a Founder decision");

  // --- the Runtime's Repair protocol ------------------------------------------
  const repaired = await until(
    async () => {
      const { tasks } = await runtime.json(`/works/${work.id}/tasks`);
      const repairTask = tasks.find((task) => task.title.startsWith("Repair:"));
      if (!repairTask) return null;
      const detail = await runtime.json(`/tasks/${repairTask.id}`);
      const current = await runtime.json(`/works/${work.id}`);
      const successor = (current.outcome.candidateArtifacts ?? []).find(
        (artifact) => artifact.supersedesArtifactId === review1.targetArtifactId,
      );
      if (!successor) return null;
      return { repairTask, detail, successor, current };
    },
    { label: "the Repair Task to deliver Artifact v2" },
  );
  step(
    "the Runtime created the Repair Task and a real Repair Worker delivered v2",
    `task ${repaired.repairTask.id.slice(0, 12)}… · artifact ${repaired.successor.id.slice(0, 12)}… supersedes ${repaired.successor.supersedesArtifactId.slice(0, 12)}…`,
  );
  assert.ok(
    (repaired.detail.runs ?? []).length >= 1,
    "the Repair Task was executed by the WorkerHost like any other Task",
  );
  assert.equal(
    repaired.detail.repairBinding?.targetArtifactId ?? repaired.detail.repairBinding?.targetArtifact?.id,
    review1.targetArtifactId,
    "the RepairBinding targets the reviewed Artifact",
  );

  // --- the re-review and the decision boundary --------------------------------
  const finalProjection = await until(
    async () => {
      const current = await runtime.json(`/works/${work.id}`);
      if (current.status !== "READY_FOR_DECISION") return null;
      const currentCandidate = current.outcome.candidateArtifacts[0];
      // The decision boundary this scenario exists for must be the one the
      // repaired Artifact reached, never an earlier projection.
      return currentCandidate && currentCandidate.id === repaired.successor.id ? current : null;
    },
    { label: "the second review to reach the decision boundary" },
  );
  const reviews = finalProjection.reviews ?? [];
  const verdicts = (reviews ?? []).map((review) => review.verdict);
  assert.ok(verdicts.includes("REQUEST_REVISION"), "the first verdict stays in the record");
  assert.equal(verdicts.at(-1), "PASS", `the latest verdict must be PASS, saw ${verdicts.join(", ")}`);
  const candidate = finalProjection.outcome.candidateArtifacts[0];
  assert.equal(candidate.id, repaired.successor.id, "the current candidate is Artifact v2, not v1");
  assert.equal(finalProjection.outcome.accepted, null, "Reviewer PASS is not Founder ACCEPT");
  assert.equal(finalProjection.founderAttention.item.kind, "DECISION_REQUIRED");
  assert.equal((await runtime.json("/status")).counts.founderDecisions, 0);
  step("Reviewer PASS — the Work waits on the Founder alone", `candidate ${candidate.id.slice(0, 12)}… · v1 is history`);

  assert.equal(founderCommands.length - commandsAfterWork, 0, "no coordination command was issued after createWork");
  step("Founder Extra Touch = 0, Manual Coordination = 0", "the Runtime owned every handoff");

  const accepted = await command("acceptWork", {
    workId: work.id,
    artifactId: candidate.id,
    artifactDigest: candidate.digest ?? candidate.contentDigest,
    basis: finalProjection.decisionBasis,
  });
  assert.equal(accepted.decision.disposition, "ACCEPT");
  const acceptedProjection = await runtime.json(`/works/${work.id}`);
  assert.equal(acceptedProjection.outcome.state, "ACCEPTED");
  step("Founder ACCEPT — the one decision this Work needed", `${accepted.decision.id} · digest-bound`);

  await runtime.stop();

  // --- independent evidence for every attempt ---------------------------------
  const bindings = readBindings(storeDir);
  const packets = readRunPackets(storeDir);
  const evidence = bindings.map((binding) => ({
    binding,
    observation: readEvidence(evidenceDir, binding.workerRunId, binding.generation),
  }));
  assert.ok(evidence.length >= 4, "execution, review, repair and re-review must all have run for real");
  const worlds = new Set(evidence.map((entry) => entry.binding.workspaceRoot));
  assert.equal(worlds.size, evidence.length, "every attempt ran in its own workspace");
  for (const { binding, observation } of evidence) {
    assert.equal(binding.backendType, CODEX_EXEC_ADAPTER_TYPE);
    assert.equal(binding.baseRevision, fixture.baseRevision);
    if (observation.terminal.terminalStatus === "SUCCEEDED" && observation.result.parse !== "NO_CANDIDATE")
      assert.ok(["STRICT_JSON", "EXTRACTED_JSON"].includes(observation.result.parse));
    assert.equal(observation.git.headUnchanged, true, "no attempt may commit");
  }
  const repairRun = packets.find(
    (packet) => packet.taskId === repaired.repairTask.id && packet.state === "COMPLETED",
  );
  assert.ok(repairRun, "the Repair Task has a completed WorkerRun");
  const repairAttempt = evidence.find((entry) => entry.binding.workerRunId === repairRun.workerRunId);
  assert.ok(repairAttempt, "the Repair Worker's attempt has Harness evidence too");
  assert.ok(
    repairAttempt.binding.workspaceRoot.includes(repairRun.workerRunId),
    "the Repair Worker ran in its own run-scoped workspace",
  );
  const firstExecution = evidence.find((entry) => entry.observation.role === "execution");
  assert.notEqual(
    repairAttempt.binding.workspaceRoot,
    firstExecution.binding.workspaceRoot,
    "the Repair Worker never reused the earlier execution workspace",
  );
  assert.equal(repairRun.packet.repair?.targetArtifact?.id, review1.targetArtifactId);
  assert.equal(repairRun.packet.repair?.reviewId, review1.id, "the Repair packet names the review it answers");
  assert.equal(repairRun.packet.repair?.reviewVerdict, "REQUEST_REVISION");
  assert.ok(
    repairRun.packet.repair?.reviewFindings?.length > 0,
    "the Repair packet carries the findings the repair had to address",
  );
  step(
    "independent evidence for every attempt",
    `${evidence.length} attempts · workspaces all distinct · repair packet carries ${repairRun.packet.repair.reviewFindings.length} finding(s)`,
  );

  assertFlowCreditUnchanged(before, fingerprintFlowCredit());
  step("canonical FlowCredit checkout untouched", `${before.head.slice(0, 12)} · clean`);

  report(root, {
    scenario,
    fixture: fixture.baseRevision,
    workId: work.id,
    result: "REAL_REPAIR_EVIDENCE_OBSERVED",
    verdicts,
    review1: {
      reviewId: review1.id,
      reviewerWorkerRunId: review1.reviewerWorkerRunId,
      verdict: review1.verdict,
      targetArtifactId: review1.targetArtifactId,
      targetArtifactDigest: review1.targetArtifactDigest,
      findings: review1.findings,
    },
    repair: {
      taskId: repaired.repairTask.id,
      workerRunId: repairRun.workerRunId,
      artifactId: repaired.successor.id,
      supersedes: repaired.successor.supersedesArtifactId,
    },
    reReview: { reviewId: reviews.at(-1).id, reviewerWorkerRunId: reviews.at(-1).reviewerWorkerRunId, verdict: reviews.at(-1).verdict },
    acceptedDecision: accepted.decision.id,
    evidence: evidence.map(({ binding, observation }) => ({
      workerRunId: binding.workerRunId,
      generation: binding.generation,
      role: observation.role,
      terminal: observation.terminal.terminalStatus,
      workspaceRoot: binding.workspaceRoot,
      session: binding.externalSessionRef,
      parse: observation.result.parse,
      changedFiles: observation.git.changedFiles,
      diffDigest: observation.git.diffDigest,
      verification: observation.verification.summary,
      durationMs: observation.process.durationMs,
    })),
  });
  console.log(
    `\nScenario ${scenario}: REAL_REPAIR_EVIDENCE_OBSERVED — ${evidence.length} real attempts, ${verdicts.join(" → ")}, Founder ACCEPT ${accepted.decision.id}.`,
  );
}

// --- the Founder boundary, replayed on a finished real chain -----------------
// Contract §18: a real Reviewer PASS leaves the Work waiting on the Founder
// alone. The scenario stops there; this re-attaches to the very store that real
// chain wrote and finishes the story with the one command only a Founder may
// issue. coordination=off: nothing is actuated and no model is called.
async function boundary(scenario) {
  const root = join(H11_ROOT, `scenario-${scenario}`);
  const prior = JSON.parse(readFileSync(join(root, "report.json"), "utf8"));
  assert.equal(
    prior.result,
    "REAL_REPAIR_EVIDENCE_NOT_OBSERVED",
    "the boundary replay expects a chain that honestly ended in PASS",
  );
  const evidenceDir = join(root, "evidence");
  const before = fingerprintFlowCredit();
  const runtime = await startRuntime({
    dir: join(root, "store"),
    coordination: false,
    workerBackend: "codex-exec",
    extraEnv: {
      FLOWCREDIT_CODEX_REPO: join(root, "repo"),
      FLOWCREDIT_CODEX_BASE_REVISION: prior.fixture,
      FLOWCREDIT_CODEX_EVIDENCE_DIR: evidenceDir,
    },
  });
  process.on("exit", () => {
    try {
      if (runtime.child.exitCode === null && runtime.child.signalCode === null) runtime.child.kill("SIGTERM");
    } catch {
      // best effort
    }
  });
  step(`scenario ${scenario}: re-attached to the finished store`, "coordination=off — nothing is actuated, no model is called");

  const workId = prior.workId;
  const waiting = await runtime.json(`/works/${workId}`);
  assert.equal(waiting.status, "READY_FOR_DECISION", "Review PASS leaves the Work at the decision boundary");
  assert.equal(waiting.outcome.state, "READY");
  assert.equal(waiting.outcome.accepted, null, "Reviewer PASS is not Founder ACCEPT");
  assert.equal(waiting.founderAttention.item.kind, "DECISION_REQUIRED");
  const candidate = waiting.outcome.candidateArtifacts[0];
  assert.equal(candidate.id, prior.firstReview.targetArtifactId, "the waiting candidate is the reviewed Artifact");
  assert.equal(candidate.digest, prior.firstReview.targetArtifactDigest, "…at the digest the Reviewer judged");
  assert.equal((await runtime.json("/status")).counts.founderDecisions, 0);
  step(
    "the Work waits on the Founder alone",
    `READY_FOR_DECISION · DECISION_REQUIRED · Founder Decisions 0 · candidate ${candidate.id.slice(0, 12)}…`,
  );

  const basis = waiting.decisionBasis;
  const request = { workId, artifactId: candidate.id, artifactDigest: candidate.digest, basis };
  const accepted = await runtime.command("acceptWork", request);
  assert.equal(accepted.decision.disposition, "ACCEPT");
  assert.equal(accepted.idempotent, false, "the first committing call is not a retry");
  const after = await runtime.json(`/works/${workId}`);
  assert.equal(after.outcome.state, "ACCEPTED");
  assert.equal(after.outcome.accepted.decisionId, accepted.decision.id);
  assert.equal(after.outcome.accepted.artifactId, candidate.id);
  assert.equal(after.outcome.accepted.artifactDigest, candidate.digest);
  assert.equal(
    Object.hasOwn(after.outcome.accepted, "idempotent"),
    false,
    "invocation metadata never becomes durable truth",
  );
  step("explicit Founder ACCEPT", `${accepted.decision.id} · digest-bound to ${candidate.id.slice(0, 12)}…`);

  const replay = await runtime.command("acceptWork", request);
  assert.equal(replay.idempotent, true, "an identical repeat is a retry of the committed decision");
  assert.equal(replay.decision.id, accepted.decision.id, "history is never rewritten");
  const decisions = (await runtime.json("/status")).counts.founderDecisions;
  assert.equal(decisions, 1, "one Work, one Founder Decision");
  step("the repeat is a retry, not a second decision", `idempotent=true · same decision · Founder Decisions ${decisions}`);

  await runtime.stop();
  assertFlowCreditUnchanged(before, fingerprintFlowCredit());
  step("canonical FlowCredit checkout untouched", `${before.head.slice(0, 12)} · clean`);
  writeFileSync(
    join(root, "boundary.json"),
    JSON.stringify(
      {
        scenario,
        workId,
        candidate: { id: candidate.id, digest: candidate.digest },
        beforeDecision: {
          status: waiting.status,
          outcomeState: waiting.outcome.state,
          attention: waiting.founderAttention.item.kind,
          accepted: waiting.outcome.accepted,
          founderDecisions: 0,
        },
        accept: { decisionId: accepted.decision.id, disposition: accepted.decision.disposition, idempotent: accepted.idempotent },
        afterDecision: { outcomeState: after.outcome.state, accepted: after.outcome.accepted },
        replay: { decisionId: replay.decision.id, idempotent: replay.idempotent, founderDecisions: decisions },
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(
    `\nScenario ${scenario}: FOUNDER_BOUNDARY_CONFIRMED — Reviewer PASS != Founder ACCEPT; explicit ACCEPT ${accepted.decision.id}.`,
  );
}

const started = Date.now();
if (process.argv[2] === "boundary") {
  const targets = process.argv.slice(3);
  assert.ok(targets.length > 0, "boundary needs at least one scenario (1 | 2 | 3)");
  for (const target of targets) await boundary(target);
} else {
  await main();
}
console.log(`total wall clock: ${((Date.now() - started) / 1000).toFixed(1)}s`);

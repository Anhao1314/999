// H1 — the first real CodexExecAdapter runs (contract §20–§24, §31–§32).
//
//   node scripts/h1-codex-exec.mjs smoke   one real adapter run, no Runtime
//   node scripts/h1-codex-exec.mjs A       execute → review → Founder ACCEPT
//   node scripts/h1-codex-exec.mjs B       timeout → retry in a fresh workspace
//   node scripts/h1-codex-exec.mjs C       protocol failure (controlled double)
//
// Every real worker process runs inside a run-scoped worktree under
// /tmp/flowcredit-h1/...; the canonical FlowCredit checkout is fingerprinted
// before and after each scenario and must come out byte-identical. Scenario C
// swaps only the model behind the CLI for a controlled child process
// (tests/support/stub-codex-cli.mjs) — the Adapter/Host/Runtime path is real.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  MAX_AUTONOMOUS_ATTEMPTS_PER_TASK,
  createContinuationDriver,
  openKernel,
} from "../packages/runtime/index.mjs";
import {
  CODEX_EXEC_ADAPTER_TYPE,
  createCodexExecAdapter,
  createStaticWorkerBackendResolver,
  createWorkerHost,
} from "../packages/harness/index.mjs";
import { digestOf } from "../packages/work/records.mjs";
import { buildH1Fixture } from "./lib/h1-fixture.mjs";
import { repoRoot, startRuntime } from "./lib/runtime-process.mjs";

const H1_ROOT = "/tmp/flowcredit-h1";
const STUB_CLI = fileURLToPath(new URL("../tests/support/stub-codex-cli.mjs", import.meta.url));
const ATTEMPT_TIMEOUT_MS = 900_000;

let stepNumber = 0;
const step = (title, detail = "") => {
  stepNumber += 1;
  console.log(`${String(stepNumber).padStart(2, " ")}. ${title}${detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Every scenario starts from its own empty store and evidence directories: a
// previous run's Runtime truth must never leak into this one's assertions.
function resetScenarioDir(root) {
  for (const name of ["store", "evidence", "run"])
    rmSync(join(root, name), { recursive: true, force: true });
}

async function until(predicate, { label, timeoutMs = 20 * 60_000, intervalMs = 300 } = {}) {
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

// --- FlowCredit integrity (§32) ----------------------------------------------
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

// --- evidence readers --------------------------------------------------------
function readBindingRows(storeDir) {
  const db = new DatabaseSync(join(storeDir, "kernel.sqlite"), { readOnly: true });
  try {
    return db
      .prepare("SELECT * FROM worker_execution_bindings ORDER BY sequence")
      .all()
      .map((row) => ({
        id: row.id,
        workerRunId: row.worker_run_id,
        generation: row.generation,
        backendType: row.backend_type,
        backendVersion: row.backend_version,
        baseRevision: row.base_revision,
        workspaceRoot: row.workspace_root,
        scratchRoot: row.scratch_root,
        externalSessionRef: row.external_session_ref,
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

function assertAdapterEvidence(evidence, { role }) {
  assert.equal(evidence.backend.type, CODEX_EXEC_ADAPTER_TYPE);
  // An attempt that delivered must carry an accepted parse and (for execution)
  // a green independent verification. Attempts that failed for other reasons
  // (protocol, process exit) are legitimate history: they are reported, not
  // hidden, and the bounded retry budget decided what happened next.
  const delivered =
    evidence.terminal.terminalStatus === "SUCCEEDED" && evidence.result.parse !== "NO_CANDIDATE";
  if (delivered) {
    assert.ok(
      ["STRICT_JSON", "EXTRACTED_JSON"].includes(evidence.result.parse),
      `parse method ${evidence.result.parse}`,
    );
  }
  if (role === "execution" && delivered) {
    assert.equal(evidence.verification.status, "OBSERVED");
    assert.equal(evidence.verification.passed, true, "independent verification must pass before a delivery");
    assert.ok(evidence.git.changedFileCount >= 1, "a change must exist");
    assert.ok(evidence.git.diffDigest.startsWith("sha256:"));
  }
  if (role === "review" && delivered) {
    assert.equal(evidence.verification.status, "SKIPPED");
    // The reviewer may legitimately apply the artifact inside its own
    // disposable workspace to test it (the prompt invites that). What matters
    // is that it never commits and that nothing it does becomes a deliverable.
    assert.equal(evidence.git.headUnchanged, true);
  }
  if (evidence.git) assert.equal(evidence.git.headUnchanged, true, "the worker must not commit");
  return evidence;
}

function fixtureTestRun(repository) {
  try {
    execFileSync("node", ["--test"], { cwd: repository, stdio: "pipe" });
    return { exitCode: 0 };
  } catch (error) {
    return { exitCode: error.status ?? 1, output: String(error.stdout ?? "") };
  }
}

function report(root, payload) {
  writeFileSync(join(root, "report.json"), JSON.stringify(payload, null, 2), "utf8");
}

// --- scenario: smoke ---------------------------------------------------------
async function scenarioSmoke() {
  const root = join(H1_ROOT, "smoke");
  const fixture = buildH1Fixture({ root: join(root, "repo") });
  resetScenarioDir(root);
  const evidenceDir = join(root, "evidence");
  const runRoot = join(root, "run");
  const workspaceRoot = join(runRoot, "workspace");
  const scratchRoot = join(runRoot, "scratch");
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(scratchRoot, { recursive: true });
  const before = fingerprintFlowCredit();
  step("H1 fixture built", `${fixture.repository} @ ${fixture.baseRevision.slice(0, 12)}`);

  const initial = fixtureTestRun(fixture.repository);
  assert.notEqual(initial.exitCode, 0, "the fixture's initial tests must fail");
  step("the fixture starts red", `node --test exits ${initial.exitCode} on the unfinished sources`);

  const adapter = createCodexExecAdapter({
    baseRepository: fixture.repository,
    verification: { command: [...fixture.verification] },
    protectedPaths: [...fixture.protectedPaths],
    evidenceDir,
  });
  const input = {
    schemaVersion: 1,
    workerRunId: "run_h1_smoke",
    generation: 1,
    workPacket: {
      work: { intent: "The library must behave as its documented requirements describe" },
      task: {
        id: "task_h1_smoke",
        title: "Implement the request-validation requirements",
        intent:
          "Implement docs/REQUIREMENTS.md in src/ so that `node --test` passes; do not modify test/",
      },
      employee: { displayName: "Alice" },
      position: { title: "Backend Engineer" },
      requirements: { requiredCapabilities: ["work.execute"], reviewCapabilities: ["work.review"] },
    },
    executionBinding: { workspaceRoot, scratchRoot, baseRevision: fixture.baseRevision },
    resultContract: { contractVersion: 1, kind: "ARTIFACT_DELIVERY" },
  };
  const startedAt = Date.now();
  const handle = await adapter.start(input, { workspaceRoot, scratchRoot });
  const terminal = await adapter.wait(handle, { timeoutMs: ATTEMPT_TIMEOUT_MS });
  const durationMs = Date.now() - startedAt;
  step(
    "real codex exec finished",
    `terminal=${terminal.terminalStatus}${terminal.failureReason ? `/${terminal.failureReason}` : ""} in ${(durationMs / 1000).toFixed(1)}s`,
  );
  assert.equal(terminal.terminalStatus, "SUCCEEDED", terminal.reason ?? "");
  assert.equal(terminal.resultCandidate?.outcome, "SUCCEEDED");
  const observation = adapter.observationFor("run_h1_smoke");
  assertAdapterEvidence(observation, { role: "execution" });
  const patch = terminal.resultCandidate.proposedArtifacts[0].content;
  assert.match(patch, /diff --git/);
  step(
    "independent evidence",
    `${observation.git.changedFiles.join(", ")} · diff ${observation.git.diffBytes}B · verification ${observation.verification.summary.slice(0, 90)}`,
  );
  step(
    "result parsing",
    `parse=${observation.result.parse} · source=${observation.result.finalMessageSource} · session=${observation.session.externalSessionRef ?? "none"} (opaque)`,
  );
  step("worker self-report", `"${terminal.resultCandidate.summary}" (never trusted as evidence by itself)`);
  assertFlowCreditUnchanged(before, fingerprintFlowCredit());
  step("canonical FlowCredit checkout untouched", `${before.head.slice(0, 12)} · clean`);
  report(root, {
    scenario: "smoke",
    fixture: fixture.baseRevision,
    terminal: terminal.terminalStatus,
    parse: observation.result.parse,
    changedFiles: observation.git.changedFiles,
    diffDigest: observation.git.diffDigest,
    verification: observation.verification.summary,
    durationMs,
  });
}

// --- scenario A: real execution → real review → Founder ACCEPT ----------------
async function scenarioA() {
  const root = join(H1_ROOT, "scenario-a");
  const fixture = buildH1Fixture({ root: join(root, "repo") });
  resetScenarioDir(root);
  const storeDir = join(root, "store");
  const evidenceDir = join(root, "evidence");
  const before = fingerprintFlowCredit();
  step("H1 fixture built", `${fixture.repository} @ ${fixture.baseRevision.slice(0, 12)}`);

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
  step("runtime started", `coordination=driver · worker=codex-exec · port ${runtime.port}`);

  const founderCommands = [];
  const command = (name, input = {}) => {
    founderCommands.push(name);
    return runtime.command(name, input);
  };

  const company = await command("createCompany", { name: "H1 Labs" });
  const engineer = await command("createPosition", {
    companyId: company.id,
    title: "Backend Engineer",
    capabilities: ["work.execute"],
  });
  const alice = await command("createEmployee", { companyId: company.id, positionId: engineer.id, displayName: "Alice" });
  const reviewer = await command("createPosition", {
    companyId: company.id,
    title: "Code Reviewer",
    capabilities: ["work.review"],
  });
  const iris = await command("createEmployee", { companyId: company.id, positionId: reviewer.id, displayName: "Iris" });
  step("Founder assembles the team", "Alice → Backend Engineer [work.execute] · Iris → Code Reviewer [work.review]");

  const work = await command("createWork", {
    companyId: company.id,
    title: "Make the request-validation library behave as documented",
    intent: "The fixture's red tests must pass without touching test/",
  });
  const commandsAfterWork = founderCommands.length;
  step("Founder states one Work", `"${work.title}" — nothing else is asked of the Founder`);

  const projection = await until(
    async () => {
      const current = await runtime.json(`/works/${work.id}`);
      return current.status === "READY_FOR_DECISION" ? current : null;
    },
    { label: "the Work to reach READY_FOR_DECISION" },
  );
  step(
    "the Runtime coordinated to a decision boundary",
    `${projection.founderAttention.item.kind} · reviews=${(await runtime.json(`/works/${work.id}/tasks`)).tasks.filter((task) => task.title.startsWith("Review:")).length}`,
  );

  let tasks = (await runtime.json(`/works/${work.id}/tasks`)).tasks;
  const reviewTasks = () => tasks.filter((task) => task.title.startsWith("Review:"));
  let cycles = 1;
  let sourceTask = tasks.find((task) => !task.title.startsWith("Review:"));
  let sourceDetail = await runtime.json(`/tasks/${sourceTask.id}`);
  step(
    "execution delivered through the Runtime seam",
    `task ${sourceTask.state} · runs=${sourceDetail.runs.length} · artifacts=${sourceDetail.artifacts.length}`,
  );
  while (reviewTasks().length > 0) {
    const reviewTask = reviewTasks().at(-1);
    const detail = await runtime.json(`/tasks/${reviewTask.id}`);
    const review = detail.review;
    if (review.verdict === "PASS") {
      step("real Codex reviewer PASS", `review ${review.id.slice(0, 12)}… · artifact ${review.targetArtifactId.slice(0, 12)}…`);
      break;
    }
    cycles += 1;
    assert.ok(cycles <= 3, "more than two repair cycles is beyond the H1 budget");
    step("real Codex reviewer requested a revision", `findings: ${review.findings.join(" | ").slice(0, 120)}`);
    await until(
      async () => {
        const currentTask = await runtime.json(`/tasks/${sourceTask.id}`);
        return currentTask.reviews.length >= cycles && reviewTasks().length >= cycles;
      },
      { label: `repair cycle ${cycles} to be re-reviewed` },
    );
    tasks = (await runtime.json(`/works/${work.id}/tasks`)).tasks;
  }
  const finalProjection = await until(
    async () => {
      const current = await runtime.json(`/works/${work.id}`);
      return current.status === "READY_FOR_DECISION" ? current : null;
    },
    { label: "the final decision boundary" },
  );

  assert.equal(finalProjection.founderAttention.item.kind, "DECISION_REQUIRED");
  assert.equal(finalProjection.outcome.accepted, null, "a Reviewer PASS is not an acceptance");
  const candidate = finalProjection.outcome.candidateArtifacts[0];
  step(
    "the Work waits on the Founder alone",
    `candidate ${candidate.id.slice(0, 12)}… · ${(await runtime.json("/status")).counts.founderDecisions} founder decisions so far`,
  );

  assert.equal(founderCommands.length - commandsAfterWork, 0, "no coordination command was issued after createWork");
  step("Founder Extra Touch = 0, Manual Coordination = 0", "the Runtime did the coordinating");

  const accepted = await command("acceptWork", {
    workId: work.id,
    artifactId: candidate.id,
    artifactDigest: candidate.digest,
    basis: finalProjection.decisionBasis,
  });
  assert.equal(accepted.decision.disposition, "ACCEPT");
  const acceptedProjection = await runtime.json(`/works/${work.id}`);
  assert.equal(acceptedProjection.outcome.state, "ACCEPTED");
  step("Founder ACCEPT — the one decision this Work needed", `${accepted.decision.id} · digest-bound`);

  await runtime.stop();
  const bindings = readBindingRows(storeDir);
  step("runtime stopped", `${bindings.length} bound attempts recorded`);

  // Evidence for every bound attempt of this Work.
  const evidenceFiles = [];
  for (const binding of bindings) {
    const evidence = readEvidence(evidenceDir, binding.workerRunId, binding.generation);
    assert.equal(binding.backendType, CODEX_EXEC_ADAPTER_TYPE);
    assert.equal(binding.baseRevision, fixture.baseRevision);
    assert.ok(binding.workspaceRoot.includes(join("workspaces", work.id)));
    assertAdapterEvidence(evidence, {
      role: evidence.role === "review" ? "review" : "execution",
    });
    evidenceFiles.push({
      workerRunId: binding.workerRunId,
      generation: binding.generation,
      role: evidence.role,
      terminal: evidence.terminal.terminalStatus,
      failureReason: evidence.terminal.failureReason ?? null,
      workspaceRoot: binding.workspaceRoot,
      session: binding.externalSessionRef,
      parse: evidence.result.parse,
      changedFiles: evidence.git.changedFiles,
      diffDigest: evidence.git.diffDigest,
      verification: evidence.verification.summary,
      durationMs: evidence.process.durationMs,
    });
  }
  assert.ok(evidenceFiles.length >= 2, "both the execution and the review attempt must have run for real");
  const deliveredAttempts = evidenceFiles.filter((entry) => entry.terminal === "SUCCEEDED" && entry.parse !== "NO_CANDIDATE");
  assert.ok(deliveredAttempts.some((entry) => entry.role === "execution"), "an execution attempt delivered");
  assert.ok(deliveredAttempts.some((entry) => entry.role === "review"), "a review attempt delivered a judgment");
  const worlds = new Set(evidenceFiles.map((entry) => entry.workspaceRoot));
  assert.equal(worlds.size, evidenceFiles.length, "every attempt ran in its own workspace");
  step(
    "independent Harness evidence for every attempt",
    `${evidenceFiles.length} attempts · ${evidenceFiles.map((entry) => `${entry.role}/${entry.parse}`).join(", ")}`,
  );

  assertFlowCreditUnchanged(before, fingerprintFlowCredit());
  step("canonical FlowCredit checkout untouched", `${before.head.slice(0, 12)} · clean`);
  report(root, {
    scenario: "A",
    fixture: fixture.baseRevision,
    workId: work.id,
    cycles,
    acceptedDecision: accepted.decision.id,
    evidence: evidenceFiles,
  });
  console.log(`\nScenario A finished: ${evidenceFiles.length} real attempts · ${cycles} review cycle(s) · Founder ACCEPT recorded.`);
}

// --- scenario B: timeout → retry in a new generation's workspace --------------
async function scenarioB() {
  const root = join(H1_ROOT, "scenario-b");
  const fixture = buildH1Fixture({ root: join(root, "repo") });
  resetScenarioDir(root);
  const storeDir = join(root, "store");
  const evidenceDir = join(root, "evidence");
  const before = fingerprintFlowCredit();
  const codexEnv = {
    FLOWCREDIT_CODEX_REPO: fixture.repository,
    FLOWCREDIT_CODEX_BASE_REVISION: fixture.baseRevision,
    FLOWCREDIT_CODEX_VERIFICATION: fixture.verification.join(" "),
    FLOWCREDIT_CODEX_PROTECTED_PATHS: fixture.protectedPaths.join(","),
    FLOWCREDIT_CODEX_EVIDENCE_DIR: evidenceDir,
  };
  step("H1 fixture built", `${fixture.repository} @ ${fixture.baseRevision.slice(0, 12)}`);

  // Phase 1 — a too-small Host timeout interrupts one explicitly started real
  // attempt. Coordination is OFF here on purpose: no automatic re-dispatch may
  // race the experiment, so the single seeded attempt is the only one that
  // can exist until the restart in phase 2.
  let runtime = await startRuntime({
    dir: storeDir,
    coordination: false,
    workerBackend: "codex-exec",
    workerTimeoutMs: 4000,
    extraEnv: codexEnv,
  });
  const company = await runtime.command("createCompany", { name: "H1 Labs" });
  const engineer = await runtime.command("createPosition", {
    companyId: company.id,
    title: "Backend Engineer",
    capabilities: ["work.execute"],
  });
  const alice = await runtime.command("createEmployee", {
    companyId: company.id,
    positionId: engineer.id,
    displayName: "Alice",
  });
  const work = await runtime.command("createWork", {
    companyId: company.id,
    title: "Make the request-validation library behave as documented",
    intent: "The fixture's red tests must pass without touching test/",
  });
  // Seeded explicitly because coordination is off: one Task, one Assignment,
  // one WorkerRun — the smallest possible attempt to interrupt.
  const task = await runtime.command("createTask", {
    workId: work.id,
    title: `Produce: ${work.title}`,
    intent: work.intent,
    requiredCapabilities: ["work.execute"],
  });
  await runtime.command("assignTask", { taskId: task.id, employeeId: alice.id, reason: "H1 scenario B fixture" });
  const firstStart = await runtime.command("startWorkerRun", { taskId: task.id });
  step(
    "one attempt is started explicitly; it will be interrupted",
    `run ${firstStart.workerRun.id.slice(0, 12)}… · host timeout = 4000ms · coordination off`,
  );

  const interrupted = await until(
    async () => {
      const detail = await runtime.json(`/tasks/${task.id}`);
      const run = detail.runs.at(-1);
      return run && run.state === "INTERRUPTED" ? { run, detail } : null;
    },
    { label: "the first attempt to be interrupted by WORKER_TIMEOUT", timeoutMs: 5 * 60_000 },
  );
  assert.equal(interrupted.run.endReason, "WORKER_TIMEOUT");
  assert.equal(interrupted.run.id, firstStart.workerRun.id);
  assert.equal(interrupted.detail.runs.length, 1, "no automatic retry may exist while coordination is off");
  const bindingRows = readBindingRows(storeDir);
  const bindingA = bindingRows.find((row) => row.workerRunId === interrupted.run.id);
  assert.ok(bindingA, "the interrupted attempt was bound before it ran");
  step("attempt 1 interrupted", `run ${interrupted.run.id.slice(0, 12)}… · workspace A = ${bindingA.workspaceRoot.replace(root, "<scenario-b>")}`);
  await runtime.stop();

  // Poison the abandoned workspace: the retry must never consume it.
  const poison = `POISON FROM ABANDONED ATTEMPT ${interrupted.run.id}\n`;
  writeFileSync(join(bindingA.workspaceRoot, "POISON.txt"), poison, "utf8");
  assert.ok(existsSync(join(bindingA.workspaceRoot, ".git")), "workspace A is a real checkout");
  step("workspace A poisoned", "a marker file the retry must never see");

  // Phase 2 — a restart re-drives the interrupted Task with a normal timeout.
  runtime = await startRuntime({
    dir: storeDir,
    coordination: true,
    workerBackend: "codex-exec",
    workerTimeoutMs: ATTEMPT_TIMEOUT_MS,
    extraEnv: codexEnv,
  });
  step("runtime restarted on the same store", "startup drive resumes the interrupted Task on its own");
  const retried = await until(
    async () => {
      const targets = (await runtime.json(`/works/${work.id}/tasks`)).tasks;
      const sourceTask = targets.find((task) => !task.title.startsWith("Review:"));
      if (!sourceTask) return null;
      const detail = await runtime.json(`/tasks/${sourceTask.id}`);
      return detail.runs.length >= 2 && detail.runs.at(-1).state === "COMPLETED"
        ? { sourceTask, detail, run: detail.runs.at(-1) }
        : null;
    },
    { label: "the retried attempt to be delivered" },
  );
  const retryRows = readBindingRows(storeDir);
  const bindingB = retryRows.find((row) => row.workerRunId === retried.run.id);
  assert.ok(bindingB, "the retried attempt is bound to its own workspace");
  assert.notEqual(bindingB.id, bindingA.id);
  assert.notEqual(bindingB.workspaceRoot, bindingA.workspaceRoot, "workspace A != workspace B");
  assert.equal(existsSync(join(bindingB.workspaceRoot, "POISON.txt")), false, "the retry never saw workspace A");
  assert.equal(readFileSync(join(bindingA.workspaceRoot, "POISON.txt"), "utf8"), poison, "A is untouched by B");
  step(
    "the Runtime re-dispatched and the retry delivered",
    `workspace B = ${bindingB.workspaceRoot.replace(root, "<scenario-b>")} · A != B`,
  );
  const artifact = retried.detail.artifacts.at(-1);
  assert.ok(artifact, "the retry produced an artifact");
  assert.doesNotMatch(artifact.content, /POISON/);
  const evidenceB = assertAdapterEvidence(readEvidence(evidenceDir, retried.run.id, bindingB.generation), {
    role: "execution",
  });
  await runtime.stop();
  assertFlowCreditUnchanged(before, fingerprintFlowCredit());
  step("canonical FlowCredit checkout untouched", `${before.head.slice(0, 12)} · clean`);
  report(root, {
    scenario: "B",
    fixture: fixture.baseRevision,
    workspaceA: bindingA.workspaceRoot,
    workspaceB: bindingB.workspaceRoot,
    runA: interrupted.run.id,
    runB: retried.run.id,
    verification: evidenceB.verification.summary,
  });
  console.log("\nScenario B finished: attempt 1 → WORKER_TIMEOUT; retry → new workspace, real delivery.");
}

// --- scenario C: protocol failure ---------------------------------------------
async function scenarioC() {
  const root = join(H1_ROOT, "scenario-c");
  const fixture = buildH1Fixture({ root: join(root, "repo") });
  resetScenarioDir(root);
  const storeDir = join(root, "store");
  const evidenceDir = join(root, "evidence");
  const before = fingerprintFlowCredit();
  step("H1 fixture built", `${fixture.repository} @ ${fixture.baseRevision.slice(0, 12)}`);

  const kernel = openKernel({ dir: storeDir });
  const adapter = createCodexExecAdapter({
    codexCommand: [process.execPath, STUB_CLI],
    baseRepository: fixture.repository,
    verification: { command: [...fixture.verification] },
    protectedPaths: [...fixture.protectedPaths],
    evidenceDir,
    // The one controlled substitution: a child that changes the workspace and
    // then answers with prose instead of the required JSON object.
    env: { FLOWCREDIT_STUB_MODE: "execution-malformed" },
  });
  const host = createWorkerHost({
    kernel,
    adapter,
    resolver: createStaticWorkerBackendResolver({
      backendType: CODEX_EXEC_ADAPTER_TYPE,
      backendVersion: "0.0.0-stub",
      baseRevision: fixture.baseRevision,
    }),
    runtimeRoot: storeDir,
    timeoutMs: 30_000,
  });
  host.start();
  const driver = createContinuationDriver({ kernel, observe: true });
  driver.driveAll({ triggerType: "STARTUP" });
  step("Runtime + Host + real Adapter assembled", "only the model behind the CLI is a controlled double");

  const company = kernel.createCompany({ name: "H1 Labs" });
  const engineer = kernel.createPosition({
    companyId: company.id,
    title: "Backend Engineer",
    capabilities: ["work.execute"],
  });
  kernel.createEmployee({ companyId: company.id, positionId: engineer.id, displayName: "Alice" });
  const work = kernel.createWork({
    companyId: company.id,
    title: "Make the request-validation library behave as documented",
    intent: "The fixture's red tests must pass without touching test/",
  });
  step("Founder states one Work", `"${work.title}"`);

  const settled = await until(
    () => {
      const tasks = kernel.tasks(work.id);
      const sourceTask = tasks.find((task) => !task.title.startsWith("Review:"));
      if (!sourceTask) return null;
      const runs = kernel.workerRuns({ taskId: sourceTask.id });
      return runs.length >= MAX_AUTONOMOUS_ATTEMPTS_PER_TASK ? { sourceTask, runs } : null;
    },
    { label: "the autonomous attempt budget to be spent", timeoutMs: 5 * 60_000 },
  );
  driver.driveWork(work.id, { triggerType: "EXPLICIT" });
  await sleep(300);
  const runs = kernel.workerRuns({ taskId: settled.sourceTask.id });
  assert.equal(runs.length, MAX_AUTONOMOUS_ATTEMPTS_PER_TASK, "no further attempt is started after exhaustion");
  for (const run of runs) {
    assert.equal(run.state, "INTERRUPTED");
    assert.equal(run.endReason, "WORKER_PROTOCOL_ERROR");
  }
  step(
    "every attempt ended as WORKER_PROTOCOL_ERROR",
    `${runs.length} attempts · no new Runtime state was invented`,
  );

  const projection = kernel.workProjection(work.id);
  assert.equal(projection.outcome.candidateArtifacts.length, 0, "no artifact was recorded");
  assert.equal(kernel.status().counts.artifacts, 0);
  assert.equal(kernel.status().counts.reviews, 0, "no fake review appeared");
  assert.equal(kernel.status().counts.founderDecisions, 0);
  assert.equal(projection.founderAttention.item.kind, "EXECUTION_INTERRUPTED");
  assert.ok(projection.founderAttention.item.conditions.includes("AUTO_RETRY_EXHAUSTED"));
  step("no Artifact, no Review, no decision", `the Founder is asked to intervene instead`);

  const workspaces = new Set();
  for (const run of runs) {
    const binding = readBindingRows(storeDir).find((row) => row.workerRunId === run.id);
    workspaces.add(binding.workspaceRoot);
    const evidence = readEvidence(evidenceDir, run.id, binding.generation);
    assert.equal(evidence.result.parse, "NO_CANDIDATE");
    assert.equal(evidence.verification.passed, true, "the double's work would have passed independent verification");
    assert.ok(evidence.git.changedFileCount >= 1, "the double did change the workspace — and it still delivered nothing");
    assert.equal(evidence.terminal.terminalStatus, "SUCCEEDED", "the process itself succeeded; the protocol did not");
  }
  assert.equal(workspaces.size, runs.length, "every attempt had its own workspace");
  step(
    "a verified-green workspace with an invalid result is still not a delivery",
    `${runs.length} distinct workspaces · verification passed · 0 artifacts`,
  );
  await host.stop();
  kernel.close();
  assertFlowCreditUnchanged(before, fingerprintFlowCredit());
  step("canonical FlowCredit checkout untouched", `${before.head.slice(0, 12)} · clean`);
  report(root, {
    scenario: "C",
    fixture: fixture.baseRevision,
    attempts: runs.map((run) => ({ id: run.id, state: run.state, endReason: run.endReason })),
    attention: projection.founderAttention.item.kind,
    conditions: projection.founderAttention.item.conditions,
  });
  console.log("\nScenario C finished: invalid results stayed invalid; the Runtime asked the Founder.");
}

const scenarios = { smoke: scenarioSmoke, a: scenarioA, b: scenarioB, c: scenarioC };
const requested = (process.argv[2] ?? "A").toLowerCase();
if (!scenarios[requested]) {
  process.stderr.write(`usage: node scripts/h1-codex-exec.mjs <smoke|A|B|C> (got ${process.argv[2] ?? "nothing"})\n`);
  process.exit(2);
}
console.log(`\n== H1 — real CodexExecAdapter (${requested}) ==\n`);
try {
  await scenarios[requested]();
} catch (error) {
  console.error(`\nH1 ${requested} FAILED: ${error?.stack ?? error}`);
  process.exit(1);
}

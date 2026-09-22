// CodexExecAdapter through the real WorkerHost — the failure-reason closure.
// Contract: docs/contracts/codex-exec-adapter-v1.md §9.
//
// The deterministic test worker cannot produce Harness postcondition failures,
// so these end-to-end tests run the production CodexExecAdapter against the
// controlled `codex exec` child (tests/support/stub-codex-cli.mjs): the real
// Runtime, the real WorkerHost, real run-scoped workspaces and a real git
// worktree per attempt. No model, no network, no Codex CLI.
//
// The line under test is exactly one line:
//   malformed / invalid result protocol        → WORKER_PROTOCOL_ERROR
//   protocol-valid candidate, postcondition no → WORKER_OUTPUT_REJECTED
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContinuationDriver, openKernel } from "../../packages/runtime/index.mjs";
import { deterministicNextActionProposer } from "../../packages/planning/next-action.mjs";
import {
  createCodexExecAdapter,
  createStaticWorkerBackendResolver,
  createWorkerHost,
} from "../../packages/harness/index.mjs";
import { openTempKernel, reopenKernel } from "../support/kernel.mjs";

const STUB = fileURLToPath(new URL("../support/stub-codex-cli.mjs", import.meta.url));
const stubCommand = [process.execPath, STUB];
const created = [];

after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

// A throwaway base repository for the real `git worktree` provisioning. Every
// attempt gets its own checkout of this revision; the base itself is never the
// execution directory.
function makeBaseRepo() {
  const dir = mkdtempSync(join(tmpdir(), "fc-codex-host-"));
  created.push(dir);
  const repo = join(dir, "base");
  for (const [path, content] of [
    ["src/app.mjs", "export const x = 1;\n"],
    ["test/placeholder.mjs", "// protected\n"],
  ]) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content, "utf8");
  }
  git(["init", "-q"], repo);
  git(["add", "."], repo);
  git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base"], repo);
  return { dir, repo, sha: git(["rev-parse", "HEAD"], repo).trim() };
}

// The production arrangement with the controlled child: real kernel, real Host,
// real CodexExecAdapter, static resolver — exactly what apps/runtime/server.mjs
// wires for FLOWCREDIT_WORKER_BACKEND=codex-exec.
function openCodexHarness({
  mode,
  verification = [process.execPath, "-e", "process.exit(0)"],
  protectedPaths = [],
  timeoutMs = 5000,
} = {}) {
  const { dir, kernel, cleanup } = openTempKernel();
  const base = makeBaseRepo();
  const adapter = createCodexExecAdapter({
    codexCommand: stubCommand,
    baseRepository: base.repo,
    verification: { command: verification },
    protectedPaths,
    env: { FLOWCREDIT_STUB_MODE: mode },
  });
  const host = createWorkerHost({
    kernel,
    adapter,
    resolver: createStaticWorkerBackendResolver({
      backendType: "codex-exec",
      backendVersion: "0.0.0-stub",
      baseRevision: base.sha,
    }),
    runtimeRoot: dir,
    timeoutMs,
  });
  return {
    dir,
    kernel,
    host,
    adapter,
    async cleanup() {
      await host.stop();
      cleanup();
    },
  };
}

// A Work whose single Task is created and assigned explicitly: the documented
// low-level path, so a test can start one attempt and observe exactly it.
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
  const work = kernel.createWork({ companyId: company.id, title, intent: "The Founder needs one output" });
  const task = kernel.createTask({
    workId: work.id,
    title: `Produce: ${title}`,
    intent: "One output the Founder can act on",
    requiredCapabilities: ["work.execute"],
  });
  kernel.assignTask({ taskId: task.id, employeeId: employee.id, reason: "fixture assignment" });
  return { company, position, employee, work, task };
}

async function until(predicate, { label = "condition", timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Start one attempt, let the real Host execute it, and hand back the facts.
async function runOneAttempt(h, { mode, title }) {
  const { kernel, host } = h;
  const { work, task } = seedNoReviewWork(kernel, { title });
  host.start();
  const started = kernel.startWorkerRun({ taskId: task.id });
  host.observe(started.workerRun.id);
  await until(() => host.reportFor(started.workerRun.id).length > 0, { label: `${mode} to be reported` });
  return { work, task, run: kernel.workerRun(started.workerRun.id), report: host.reportFor(started.workerRun.id)[0] };
}

// ------------------------------------------------- postcondition rejection

test("a protocol-valid delivery whose independent verification fails is WORKER_OUTPUT_REJECTED", async () => {
  const h = openCodexHarness({
    mode: "execution-ok",
    verification: [process.execPath, "-e", "process.exit(3)"],
  });
  try {
    const { work, task, run, report } = await runOneAttempt(h, {
      mode: "execution-ok",
      title: "A delivery that does not verify",
    });

    assert.equal(run.state, "INTERRUPTED");
    assert.equal(run.endReason, "WORKER_OUTPUT_REJECTED");
    assert.equal(report.status, "INTERRUPTED");
    assert.equal(report.detail.reason, "WORKER_OUTPUT_REJECTED");
    assert.equal(report.detail.failureReason, "HARNESS_VERIFICATION_FAILED", "the specific postcondition stays evidence-side");
    assert.match(report.detail.detail, /did not pass/);

    // The Worker's own result was valid — nothing was malformed, and yet nothing
    // was delivered: verification is evidence, not a claim.
    const observation = h.adapter.observationFor(run.id);
    assert.equal(observation.result.parse, "STRICT_JSON", "a protocol-valid candidate existed");
    assert.equal(observation.verification.passed, false);

    assert.equal(h.kernel.taskDetail(task.id).artifacts.length, 0, "a rejected delivery records no Artifact");
    assert.equal(h.kernel.reviews({ workId: work.id }).length, 0, "a rejected delivery records no Review");
    assert.equal(h.kernel.status().counts.founderDecisions, 0);
    assert.equal(h.kernel.task(task.id).state, "INTERRUPTED", "the frozen interrupted-attempt semantics are unchanged");
  } finally {
    await h.cleanup();
  }
});

test("a valid delivery that moves HEAD, changes a protected path or changes nothing is WORKER_OUTPUT_REJECTED", async () => {
  for (const [mode, protectedPaths, expected] of [
    ["execution-protected", ["test/"], "HARNESS_PROTECTED_PATH_MODIFIED"],
    ["execution-commit", [], "HARNESS_GIT_VIOLATION"],
    ["execution-no-change", [], "HARNESS_NO_CHANGE"],
  ]) {
    const h = openCodexHarness({ mode, protectedPaths });
    try {
      const { work, task, run, report } = await runOneAttempt(h, { mode, title: `Rejected: ${mode}` });

      assert.equal(run.endReason, "WORKER_OUTPUT_REJECTED", mode);
      assert.equal(report.detail.reason, "WORKER_OUTPUT_REJECTED", mode);
      assert.equal(report.detail.failureReason, expected, mode);
      const observation = h.adapter.observationFor(run.id);
      assert.equal(observation.result.parse, "STRICT_JSON", `${mode}: the result itself was valid`);
      assert.equal(observation.terminal.failureReason, expected, `${mode}: evidence explains the rejection`);

      assert.equal(h.kernel.taskDetail(task.id).artifacts.length, 0, `${mode}: no Artifact`);
      assert.equal(h.kernel.reviews({ workId: work.id }).length, 0, `${mode}: no Review`);
    } finally {
      await h.cleanup();
    }
  }
});

// ------------------------------------------------------ protocol contrast

test("a malformed result stays WORKER_PROTOCOL_ERROR even when the workspace also fails", async () => {
  const h = openCodexHarness({
    mode: "execution-malformed",
    verification: [process.execPath, "-e", "process.exit(3)"],
  });
  try {
    const { work, task, run, report } = await runOneAttempt(h, {
      mode: "execution-malformed",
      title: "A Worker that cannot say what it did",
    });

    assert.equal(run.endReason, "WORKER_PROTOCOL_ERROR");
    assert.equal(report.detail.reason, "WORKER_PROTOCOL_ERROR");
    assert.equal(h.adapter.observationFor(run.id).result.parse, "NO_CANDIDATE", "no usable candidate existed");
    assert.equal(h.kernel.taskDetail(task.id).artifacts.length, 0);
    assert.equal(h.kernel.reviews({ workId: work.id }).length, 0);
  } finally {
    await h.cleanup();
  }
});

// ------------------------------------------------------- retry semantics

test("rejected deliveries consume the frozen budget and never fabricate work", async () => {
  const h = openCodexHarness({ mode: "execution-no-change" });
  try {
    const { kernel, host } = h;
    const { work, task } = seedNoReviewWork(kernel, { title: "A Work nothing can deliver" });
    host.start();
    const driver = createContinuationDriver({ kernel, proposer: deterministicNextActionProposer(), observe: true });
    driver.driveAll({ triggerType: "STARTUP" });

    await until(
      () => kernel.workProjection(work.id).founderAttention.conditions.includes("AUTO_RETRY_EXHAUSTED"),
      { label: "the bounded retry budget to be spent" },
    );

    const runs = kernel.workerRuns({ taskId: task.id });
    assert.equal(runs.length, 3, "1 initial attempt + 2 automatic retries, unchanged");
    for (const run of runs) {
      assert.equal(run.state, "INTERRUPTED");
      assert.equal(run.endReason, "WORKER_OUTPUT_REJECTED");
      assert.notEqual(run.generation, undefined);
    }
    const generations = runs.map((run) => run.generation);
    assert.equal(new Set(generations).size, 3, "every retry holds its own fenced generation");

    assert.equal(kernel.taskDetail(task.id).artifacts.length, 0, "no rejection ever became an Artifact");
    assert.equal(kernel.reviews({ workId: work.id }).length, 0);
    assert.equal(kernel.status().counts.founderDecisions, 0);

    const projection = kernel.workProjection(work.id);
    assert.equal(projection.founderAttention.item.kind, "EXECUTION_INTERRUPTED");
    assert.ok(projection.founderAttention.conditions.includes("EXECUTION_INTERRUPTED"));
    assert.ok(
      projection.founderAttention.conditions.includes("AUTO_RETRY_EXHAUSTED"),
      "the Runtime stops and asks instead of looping",
    );
  } finally {
    await h.cleanup();
  }
});

// ------------------------------------------------------------ recovery

test("startup recovery keeps its own reason and never rewrites a rejection", async () => {
  const h = openCodexHarness({ mode: "execution-no-change" });
  let reopened = null;
  try {
    const { kernel, host } = h;
    const { task } = seedNoReviewWork(kernel, { title: "A Work interrupted by a restart" });
    host.start();
    const first = kernel.startWorkerRun({ taskId: task.id });
    host.observe(first.workerRun.id);
    await until(() => host.reportFor(first.workerRun.id).length > 0, { label: "the rejected attempt" });
    assert.equal(kernel.workerRun(first.workerRun.id).endReason, "WORKER_OUTPUT_REJECTED");

    // A second attempt starts and is left RUNNING: the Host is stopped, so
    // nothing reports on it — exactly the crash shape recovery owns.
    await host.stop();
    const second = kernel.startWorkerRun({ taskId: task.id });
    assert.equal(kernel.workerRun(second.workerRun.id).state, "RUNNING");

    kernel.close();
    reopened = reopenKernel(h.dir);

    assert.equal(reopened.workerRun(first.workerRun.id).endReason, "WORKER_OUTPUT_REJECTED", "history is not rewritten");
    assert.equal(reopened.workerRun(second.workerRun.id).state, "INTERRUPTED");
    assert.equal(reopened.workerRun(second.workerRun.id).endReason, "PROCESS_INTERRUPTED");
    assert.equal(reopened.task(task.id).state, "INTERRUPTED");
    assert.equal(reopened.recover().count, 0, "recovery is idempotent, exactly as before");
  } finally {
    reopened?.close();
    await h.cleanup();
  }
});

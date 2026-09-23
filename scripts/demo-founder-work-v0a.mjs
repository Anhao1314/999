// Deterministic process proof for the bounded Founder Work product command.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openKernel } from "../packages/runtime/index.mjs";
import { startRuntime } from "./lib/runtime-process.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i = 0; i < 400; i += 1) {
    const result = await fn();
    if (result) return result;
    await pause(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function git(repo, ...args) {
  execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
}

async function post(runtime, command, input, headers = {}) {
  const response = await fetch(`${runtime.base}/product/commands`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ command, input }),
  });
  return { status: response.status, body: await response.json() };
}

export async function runFounderWorkProof() {
  const root = mkdtempSync(join(tmpdir(), "flowcredit-founder-work-"));
  const repo = join(root, "project");
  const dir = join(root, "runtime");
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "proof project\n");
  git(repo, "init", "-q");
  git(repo, "-c", "user.name=Proof", "-c", "user.email=proof@example.invalid", "add", "README.md");
  git(repo, "-c", "user.name=Proof", "-c", "user.email=proof@example.invalid", "commit", "-qm", "initial");
  let runtime;
  try {
    const options = { dir, coordination: true, workerBackend: "test-worker", extraEnv: { FLOWCREDIT_PRODUCT_REPO: repo } };
    runtime = await startRuntime(options);
    const context = await runtime.json("/product/execution-context");
    assert.equal(context.available, true);
    assert.match(context.contextId, /^local-repo:sha256:[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(context).sort(), ["available", "contextId"]);
    assert.equal(JSON.stringify(context).includes(repo), false);
    assert.equal((await fetch(`${runtime.base}/product/execution-context`, {
      headers: { origin: "https://evil.invalid" },
    })).status, 403);

    const company = await runtime.command("createCompany", { name: "Founder Proof Company" });
    const bootstrap = await runtime.command("bootstrapWorkforce", {
      companyId: company.id,
      positions: [
        { id: "proof_operator_position", title: "Operator", capabilities: ["work.execute"] },
        { id: "proof_reviewer_position", title: "Reviewer", capabilities: ["work.review"] },
      ],
      employees: [
        { id: "proof_operator", positionId: "proof_operator_position", displayName: "Operator", enabled: true },
        { id: "proof_reviewer", positionId: "proof_reviewer_position", displayName: "Reviewer", enabled: true },
      ],
    });
    assert.deepEqual([bootstrap.positions, bootstrap.employees], [2, 2]);
    for (const enabled of [false, true]) {
      const lobbyWrite = await fetch(`${runtime.base}/commands`, {
        method: "POST", headers: { "content-type": "application/json", origin: runtime.base },
        body: JSON.stringify({ command: "setEmployeeEnabled", input: { employeeId: "proof_reviewer", enabled } }),
      });
      assert.equal(lobbyWrite.status, 200, "the existing same-origin Lobby command stays usable");
    }

    const input = { requestId: "proof_create_1", companyId: company.id, title: "Prepare project summary", intent: "Create a concise project summary", contextId: context.contextId };
    const missingCompany = await post(runtime, "CreateFounderWork", { ...input, requestId: "unknown_company", companyId: "missing" });
    assert.equal(missingCompany.body.error.code, "WORK_COMPANY_MISSING");
    const malformed = await post(runtime, "CreateFounderWork", { ...input, requestId: "malformed", title: 7 });
    assert.equal(malformed.body.error.code, "INVALID_INPUT");
    const invalidJson = await fetch(`${runtime.base}/product/commands`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    });
    assert.equal((await invalidJson.json()).error.code, "INVALID_REQUEST");
    const wrongMedia = await fetch(`${runtime.base}/product/commands`, {
      method: "POST", headers: { "content-type": "text/plain" }, body: "{}",
    });
    assert.equal(wrongMedia.status, 415);
    const oversized = await fetch(`${runtime.base}/product/commands`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "CreateFounderWork", input: { ...input, intent: "x".repeat(17_000) } }),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).error.code, "INVALID_REQUEST");
    for (const extra of [{ employeeId: "proof_operator" }, { reviewerId: "proof_reviewer" },
      { workerRunId: "forced" }, { generation: 2 }, { backendExecutablePath: "/bin/true" }]) {
      const rejected = await post(runtime, "CreateFounderWork", { ...input, ...extra });
      assert.equal(rejected.body.error.code, "INVALID_INPUT");
    }
    assert.equal((await post(runtime, "CreateFounderWork", { ...input, contextId: "wrong" })).body.error.code, "PRODUCT_CONTEXT_MISMATCH");
    assert.equal((await post(runtime, "assignTask", {})).body.error.code, "PRODUCT_COMMAND_NOT_FOUND");
    const foreign = await post(runtime, "CreateFounderWork", input, { origin: "https://evil.invalid" });
    assert.equal(foreign.status, 403);
    const browserRaw = await fetch(`${runtime.base}/commands`, {
      method: "POST", headers: { "content-type": "application/json", origin: runtime.base },
      body: JSON.stringify({ command: "startWorkerRun", input: {} }),
    });
    assert.equal(browserRaw.status, 403);

    const created = await post(runtime, "CreateFounderWork", input);
    assert.equal(created.status, 200);
    assert.equal(created.body.result.replayed, false);
    const work = created.body.result.work;
    const replay = await post(runtime, "CreateFounderWork", input);
    assert.equal(replay.body.result.replayed, true);
    assert.equal(replay.body.result.work.id, work.id);
    const conflict = await post(runtime, "CreateFounderWork", { ...input, title: "Different intent" });
    assert.equal(conflict.body.error.code, "FOUNDER_WORK_REQUEST_CONFLICT");

    await until(async () => {
      const projection = await runtime.json(`/works/${work.id}`);
      return projection.status === "READY_FOR_DECISION" && projection;
    }, "Runtime coordination and deterministic WorkerHost");
    const tasks = (await runtime.json(`/works/${work.id}/tasks`)).tasks;
    assert.equal(tasks.length, 2);
    const execution = await runtime.json(`/tasks/${tasks.find((task) => !task.title.startsWith("Review:"))?.id}`);
    assert.equal(execution.task.state, "COMPLETED");
    assert.equal(execution.runs[0].state, "COMPLETED");
    assert.equal(execution.runs[0].employeeId, "proof_operator");
    assert.ok(execution.artifacts.some((artifact) => artifact.workerRunId === execution.runs[0].id));
    const before = await runtime.json(`/works/${work.id}`);
    assert.equal(before.outcome.accepted, null);
    writeFileSync(join(repo, "CHANGELOG.md"), "new local head\n");
    git(repo, "-c", "user.name=Proof", "-c", "user.email=proof@example.invalid", "add", "CHANGELOG.md");
    git(repo, "-c", "user.name=Proof", "-c", "user.email=proof@example.invalid", "commit", "-qm", "later");
    const laterHead = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const second = (await post(runtime, "CreateFounderWork", {
      ...input, requestId: "proof_create_2", title: "Prepare second summary",
    })).body.result.work;
    await until(async () => (await runtime.json(`/works/${second.id}`)).status === "READY_FOR_DECISION", "second Work");
    assert.notEqual(second.id, work.id);

    await runtime.stop();
    runtime = null;
    const inspection = openKernel({ dir });
    try {
      const binding = inspection.founderWorkExecutionBinding(work.id);
      assert.equal(binding.contextId, context.contextId);
      assert.match(binding.baseRevision, /^[a-f0-9]{40,64}$/);
      assert.notEqual(binding.baseRevision, laterHead, "a later HEAD does not silently rebind prior Work");
      assert.equal(inspection.founderWorkExecutionBinding(second.id).contextId, context.contextId);
      assert.equal(inspection.founderWorkExecutionBinding(second.id).baseRevision, laterHead,
        "a Work created after HEAD advances pins the commit visible at creation");
      assert.equal(inspection.workerExecutionBinding(execution.runs[0].id).baseRevision,
        binding.baseRevision, "WorkerHost bound the attempt to the Work's pinned revision");
      assert.throws(() => inspection.store.db.prepare(
        "UPDATE founder_work_execution_bindings SET context_id=? WHERE work_id=?",
      ).run("different", work.id), /FOUNDER_WORK_EXECUTION_BINDING_IMMUTABLE/);
      assert.throws(() => inspection.store.db.prepare(
        "DELETE FROM founder_work_execution_bindings WHERE work_id=?",
      ).run(work.id), /FOUNDER_WORK_EXECUTION_BINDING_IMMUTABLE/);
    } finally { inspection.close(); }
    const readOnly = await startRuntime({ dir });
    try {
      assert.equal((await readOnly.json(`/works/${work.id}`)).status, "READY_FOR_DECISION");
    } finally { await readOnly.stop(); }
    await assert.rejects(
      startRuntime({ dir, coordination: true, extraEnv: { FLOWCREDIT_PRODUCT_REPO: repo } }),
      /PRODUCT_BACKEND_UNAVAILABLE/,
    );
    const savedRepo = join(root, "saved-project");
    renameSync(repo, savedRepo);
    try {
      mkdirSync(repo);
      writeFileSync(join(repo, "README.md"), "replacement history\n");
      git(repo, "init", "-q");
      git(repo, "-c", "user.name=Proof", "-c", "user.email=proof@example.invalid", "add", "README.md");
      git(repo, "-c", "user.name=Proof", "-c", "user.email=proof@example.invalid", "commit", "-qm", "replacement");
      await assert.rejects(startRuntime(options), /base commit is unavailable/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      renameSync(savedRepo, repo);
    }
    const otherRepo = join(root, "other-project");
    mkdirSync(otherRepo);
    writeFileSync(join(otherRepo, "README.md"), "different project\n");
    git(otherRepo, "init", "-q");
    git(otherRepo, "-c", "user.name=Proof", "-c", "user.email=proof@example.invalid", "add", "README.md");
    git(otherRepo, "-c", "user.name=Proof", "-c", "user.email=proof@example.invalid", "commit", "-qm", "initial");
    await assert.rejects(
      startRuntime({ ...options, extraEnv: { FLOWCREDIT_PRODUCT_REPO: otherRepo } }),
      /FOUNDER|another local execution context|PRODUCT_CONTEXT_MISMATCH/,
    );
    runtime = await startRuntime(options);
    const after = await runtime.json(`/works/${work.id}`);
    assert.equal(after.status, "READY_FOR_DECISION");
    assert.equal((await post(runtime, "CreateFounderWork", input)).body.result.work.id, work.id);

    const off = await startRuntime({ dir: join(root, "off"), workerBackend: "test-worker", extraEnv: { FLOWCREDIT_PRODUCT_REPO: repo } });
    try {
      assert.equal((await post(off, "CreateFounderWork", input)).body.error.code, "PRODUCT_COORDINATION_UNAVAILABLE");
    } finally { await off.stop(); }
    const noBackend = await startRuntime({ dir: join(root, "no-backend"), coordination: true, extraEnv: { FLOWCREDIT_PRODUCT_REPO: repo } });
    try {
      assert.equal((await post(noBackend, "CreateFounderWork", input)).body.error.code, "PRODUCT_BACKEND_UNAVAILABLE");
    } finally { await noBackend.stop(); }
    const noContext = await startRuntime({ dir: join(root, "no-context"), coordination: true, workerBackend: "test-worker" });
    try {
      assert.equal((await post(noContext, "CreateFounderWork", input)).body.error.code, "PRODUCT_CONTEXT_UNAVAILABLE");
    } finally { await noContext.stop(); }

    return { workId: work.id, taskCount: tasks.length, workerRuns: execution.runs.length, manualCoordinationAfterCreate: 0 };
  } finally {
    if (runtime) await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runFounderWorkProof().then((result) => process.stdout.write(`Founder Work proof PASS ${JSON.stringify(result)}\n`));
}

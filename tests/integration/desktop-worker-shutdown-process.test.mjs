// Desktop quit → Runtime → WorkerHost → Worker child: shutdown ownership.
// Contract: docs/contracts/desktop-worker-backend-discovery-v0.md §12, §15.
//
// The hard requirement under test: when the Runtime is asked to stop while an
// attempt is active, the process it owns is terminated before the Runtime exits
// — no orphan child keeps writing an abandoned workspace — and the durable
// truth afterwards is the ordinary interrupted-attempt recovery, not a new
// reason and not a rewritten history.
//
// No model and no network: the `codex` backend is the deterministic stub behind
// a real executable file, reached through FLOWCREDIT_CODEX_BIN exactly as the
// Desktop hands it over.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createStaticWorkerBackendResolver, createWorkerHost } from "../../packages/harness/index.mjs";
import { startRuntime } from "../../scripts/lib/runtime-process.mjs";
import { openTempKernel, reopenKernel, seedStaffedTask } from "../support/kernel.mjs";

const STUB_URL = pathToFileURL(
  fileURLToPath(new URL("../support/stub-codex-cli.mjs", import.meta.url)),
).href;
const created = [];
after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "relay-code-shutdown-"));
  created.push(dir);
  return dir;
}

async function until(predicate, { label = "condition", timeoutMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const parentOf = (pid) =>
  Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim());

// The stub records its pid only from the attempt's own `exec` process, so a
// live pid in the dump is the run child and never a `--version` probe.
async function waitForLiveChild(pidDump) {
  let pid = null;
  await until(
    () => {
      if (!existsSync(pidDump)) return false;
      const value = Number(readFileSync(pidDump, "utf8").trim());
      if (!Number.isInteger(value) || value <= 0 || !isAlive(value)) return false;
      pid = value;
      return true;
    },
    { label: "the Codex child to start" },
  );
  return pid;
}

// A real executable file that speaks the stub's protocol: the Runtime validates
// it, probes `--version`, and spawns it as the Codex backend. `name` is what the
// PATH lookup finds in the non-Desktop case.
function codexExecutable(dir, { name = "codex-fixture.mjs" } = {}) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!${process.execPath}\nawait import(${JSON.stringify(STUB_URL)});\n`, "utf8");
  chmodSync(path, 0o755);
  return path;
}

function makeBaseRepo() {
  const dir = sandbox();
  const repo = join(dir, "base");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "app.mjs"), "export const x = 1;\n", "utf8");
  const git = (args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q"]);
  git(["add", "."]);
  git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base"]);
  return { repo, sha: git(["rev-parse", "HEAD"]).trim() };
}

// One explicitly started attempt on the production low-level path: create,
// assign, start. Coordination stays off so exactly one attempt can exist.
async function seedRunningAttempt(runtime) {
  const company = await runtime.command("createCompany", { name: "Shutdown Co" });
  const position = await runtime.command("createPosition", {
    companyId: company.id,
    title: "Operator",
    capabilities: ["work.execute"],
  });
  const employee = await runtime.command("createEmployee", {
    companyId: company.id,
    positionId: position.id,
    displayName: "Atlas",
  });
  const work = await runtime.command("createWork", {
    companyId: company.id,
    title: "Long running work",
    intent: "The attempt is interrupted by the application quitting",
  });
  const task = await runtime.command("createTask", {
    workId: work.id,
    title: `Produce: ${work.title}`,
    intent: "One output",
    requiredCapabilities: ["work.execute"],
  });
  await runtime.command("assignTask", {
    taskId: task.id,
    employeeId: employee.id,
    reason: "shutdown fixture",
  });
  const started = await runtime.command("startWorkerRun", { taskId: task.id });
  return { work, task, run: started.workerRun, generation: started.generation };
}

// The shared arrangement: a real executable configured as the Codex backend,
// running the stub in "hang" mode so the attempt is definitely still active.
async function startHangingRuntime() {
  const dir = sandbox();
  const base = makeBaseRepo();
  const executable = codexExecutable(join(dir, "bin"));
  const pidDump = join(dir, "codex-child.pid");
  const runtime = await startRuntime({
    dir: join(dir, "store"),
    coordination: false,
    workerBackend: "codex-exec",
    workerTimeoutMs: 120_000,
    extraEnv: {
      FLOWCREDIT_CODEX_BIN: executable,
      FLOWCREDIT_CODEX_REPO: base.repo,
      FLOWCREDIT_CODEX_BASE_REVISION: base.sha,
      FLOWCREDIT_CODEX_VERIFICATION: `${process.execPath} -e process.exit(0)`,
      FLOWCREDIT_STUB_MODE: "hang",
      FLOWCREDIT_STUB_PID_DUMP: pidDump,
    },
  });
  return { dir, storeDir: join(dir, "store"), runtime, pidDump };
}

test("a Runtime stop during an active attempt terminates its Codex child before exiting", async () => {
  const { runtime, pidDump } = await startHangingRuntime();
  let codexPid = null;
  try {
    // The configured absolute path is what the Runtime validated and probed.
    assert.match(runtime.output(), /codex-exec backend executable=.*codex-fixture\.mjs version=0\.0\.0-stub/);

    const attempt = await seedRunningAttempt(runtime);
    codexPid = await waitForLiveChild(pidDump);

    assert.equal(
      (await runtime.json(`/runs/${attempt.run.id}`)).workerRun.state,
      "RUNNING",
      "the attempt is durable truth while it runs",
    );
    assert.equal(isAlive(codexPid), true, "the child is alive before the quit");
    assert.equal(parentOf(codexPid), runtime.child.pid, "the child's lineage is the Runtime process");

    const startedAt = Date.now();
    const exit = await runtime.stop();
    const elapsedMs = Date.now() - startedAt;

    assert.equal(exit.code, 0, "the Runtime shuts down gracefully");
    assert.equal(exit.signal, null);
    assert.ok(elapsedMs < 8_000, `shutdown stayed inside its bound (${elapsedMs}ms)`);
    await until(() => isAlive(codexPid) === false, {
      label: "the Codex child to be gone",
      timeoutMs: 2_000,
    });
    assert.equal(isAlive(codexPid), false, "no orphan Codex child survives the Runtime");
  } finally {
    if (runtime.child.exitCode === null && runtime.child.signalCode === null)
      await runtime.stop().catch(() => {});
    if (codexPid && isAlive(codexPid)) {
      try {
        process.kill(codexPid, "SIGKILL");
      } catch {
        // best effort
      }
    }
  }
});

test("the interrupted attempt survives the quit as ordinary recovery truth", async () => {
  const { storeDir, runtime, pidDump } = await startHangingRuntime();
  let codexPid = null;
  try {
    const attempt = await seedRunningAttempt(runtime);
    codexPid = await waitForLiveChild(pidDump);
    assert.equal(isAlive(codexPid), true, "the attempt's own child is the one under watch");

    const exit = await runtime.stop();
    assert.equal(exit.code, 0);
    await until(() => isAlive(codexPid) === false, { label: "the Codex child to be gone" });

    // Reopening the same store is the relaunch: recovery resolves the attempt
    // that was cancelled without a report.
    const reopened = reopenKernel(storeDir);
    try {
      assert.equal(reopened.recovery.count, 1);
      const run = reopened.workerRun(attempt.run.id);
      assert.equal(run.state, "INTERRUPTED");
      assert.equal(run.endReason, "PROCESS_INTERRUPTED", "the existing vocabulary, not a new one");
      const task = reopened.task(attempt.task.id);
      assert.equal(task.state, "INTERRUPTED");
      assert.ok(task.generation > attempt.generation, "the attempt's generation is fenced");

      // Work continuity: the Work and its Task are still there, with no manual
      // repair, and nothing from the fenced generation can land.
      const projection = reopened.workProjection(attempt.work.id);
      assert.equal(projection.work.id, attempt.work.id);
      assert.equal(projection.tasks.some((entry) => entry.id === attempt.task.id), true);
      assert.throws(
        () =>
          reopened.submitWorkerResult({
            workerRunId: run.id,
            generation: attempt.generation,
            resultDigest: "sha256:stale",
            evidenceDigest: "sha256:stale",
            artifact: { kind: "patch", title: "stale", content: "stale\n" },
          }),
        (error) => ["STALE_GENERATION", "INVALID_TRANSITION"].includes(error?.code),
        "a result from the interrupted attempt is refused",
      );
      assert.throws(
        () =>
          reopened.submitWorkerResult({
            workerRunId: run.id,
            generation: attempt.generation + 1,
            resultDigest: "sha256:stale",
            evidenceDigest: "sha256:stale",
            artifact: { kind: "patch", title: "stale", content: "stale\n" },
          }),
        { code: "STALE_GENERATION" },
        "the attempt's own generation token is not the accepted one either",
      );
    } finally {
      reopened.close();
    }
  } finally {
    if (runtime.child.exitCode === null && runtime.child.signalCode === null)
      await runtime.stop().catch(() => {});
    if (codexPid && isAlive(codexPid)) {
      try {
        process.kill(codexPid, "SIGKILL");
      } catch {
        // best effort
      }
    }
  }
});

test("an unusable FLOWCREDIT_CODEX_BIN stops the Runtime instead of guessing", async () => {
  const dir = sandbox();
  const base = makeBaseRepo();
  await assert.rejects(
    () =>
      startRuntime({
        dir: join(dir, "store"),
        workerBackend: "codex-exec",
        timeoutMs: 8_000,
        extraEnv: {
          FLOWCREDIT_CODEX_BIN: join(dir, "nowhere", "codex"),
          FLOWCREDIT_CODEX_REPO: base.repo,
        },
      }),
    /FLOWCREDIT_CODEX_BIN is not usable/,
  );

  await assert.rejects(
    () =>
      startRuntime({
        dir: join(dir, "store-relative"),
        workerBackend: "codex-exec",
        timeoutMs: 8_000,
        extraEnv: { FLOWCREDIT_CODEX_BIN: "codex", FLOWCREDIT_CODEX_REPO: base.repo },
      }),
    /must be absolute/,
  );
});

test("without an override the plain codex name still resolves through PATH", async () => {
  const dir = sandbox();
  const base = makeBaseRepo();
  const binDir = join(dir, "bin");
  const named = codexExecutable(binDir, { name: "codex" });
  assert.equal(existsSync(named), true);

  const runtime = await startRuntime({
    dir: join(dir, "store"),
    workerBackend: "codex-exec",
    extraEnv: {
      PATH: `${binDir}:/usr/bin:/bin`,
      FLOWCREDIT_CODEX_REPO: base.repo,
      FLOWCREDIT_CODEX_BASE_REVISION: base.sha,
    },
  });
  try {
    // No override is configured, so the Runtime keeps the plain command name
    // and lets the OS resolve it through PATH. The version the stub answers
    // with proves which binary on that PATH actually ran.
    assert.match(runtime.output(), /codex-exec backend executable=codex version=0\.0\.0-stub/);
    assert.equal(runtime.base.startsWith("http://127.0.0.1:"), true);
  } finally {
    await runtime.stop();
  }
});

// A second stop must be a no-op, not a second cancellation: the Desktop can
// race a signal with its own quit path, and a stopped Host owns nothing left
// to cancel. Stopping a Host that never held an attempt is equally ordinary.
test("WorkerHost.stop is idempotent and safe with nothing to cancel", async () => {
  const { dir, kernel, cleanup } = openTempKernel();
  const cancellations = [];
  const adapter = {
    manifest: () => ({
      adapterType: "test-worker",
      adapterVersion: "0.0.0-fake",
      containment: { sandboxMode: "none", knownLimitations: [] },
    }),
    start: async () => ({ id: "handle" }),
    async *events() {},
    wait: () => new Promise(() => {}),
    cancel: async (_handle, reason) => {
      cancellations.push(reason);
    },
  };
  const host = createWorkerHost({
    kernel,
    adapter,
    resolver: createStaticWorkerBackendResolver({
      backendType: "test-worker",
      backendVersion: "0.0.0-fake",
    }),
    runtimeRoot: dir,
    timeoutMs: 60_000,
  });

  try {
    await host.stop();
    assert.deepEqual(cancellations, [], "a Host that held no attempt cancels nothing");
    await host.stop();
    assert.deepEqual(cancellations, [], "stopping twice still cancels nothing");
    await host.idle();
    assert.equal(host.observe("run_absent"), undefined, "a stopped Host accepts no new observation");
    assert.throws(() => host.start(), /stopped WorkerHost/, "a stopped Host cannot be restarted");
  } finally {
    kernel.close();
    cleanup();
  }
});

test("WorkerHost.stop cancels every active handle it owns, once", async () => {
  const { dir, kernel, cleanup } = openTempKernel();
  const cancellations = [];
  let settleWait = null;
  const adapter = {
    manifest: () => ({
      adapterType: "test-worker",
      adapterVersion: "0.0.0-fake",
      containment: { sandboxMode: "none", knownLimitations: [] },
    }),
    start: async () => ({ id: "handle" }),
    async *events() {},
    wait: () =>
      new Promise((resolve) => {
        settleWait = resolve;
      }),
    cancel: async (_handle, reason) => {
      cancellations.push(reason);
      settleWait?.({ terminalStatus: "CANCELLED", reason });
    },
  };
  const host = createWorkerHost({
    kernel,
    adapter,
    resolver: createStaticWorkerBackendResolver({
      backendType: "test-worker",
      backendVersion: "0.0.0-fake",
    }),
    runtimeRoot: dir,
    timeoutMs: 60_000,
  });

  try {
    const { task } = seedStaffedTask(kernel);
    host.start();
    const started = kernel.startWorkerRun({ taskId: task.id });
    host.observe(started.workerRun.id);
    await new Promise((resolve) => setTimeout(resolve, 100));

    await host.stop();
    assert.deepEqual(cancellations, ["HOST_STOPPING"], "the Host owns cancellation, and it happens once");
    await host.stop();
    assert.deepEqual(
      cancellations,
      ["HOST_STOPPING"],
      "a second stop is a no-op, not a second cancellation",
    );
    assert.equal(
      kernel.workerRun(started.workerRun.id).state,
      "RUNNING",
      "a cancelled attempt writes nothing: the Runtime still holds the truth",
    );
    kernel.close();

    const reopened = reopenKernel(dir);
    try {
      assert.equal(reopened.recovery.count, 1);
      assert.equal(reopened.workerRun(started.workerRun.id).state, "INTERRUPTED");
      assert.equal(reopened.workerRun(started.workerRun.id).endReason, "PROCESS_INTERRUPTED");
    } finally {
      reopened.close();
    }
  } finally {
    cleanup();
  }
});

// The stop sweep can only cancel handles that already exist. An attempt still
// inside adapter.start() when the quit arrives has to be claimed by the
// executor that created it, or its child outlives the Runtime and keeps
// writing to a workspace nobody owns any more.
test("an attempt still starting when the Host stops is cancelled by its own executor", async () => {
  const { dir, kernel, cleanup } = openTempKernel();
  const cancellations = [];
  let lateHandle = null;
  const adapter = {
    manifest: () => ({
      adapterType: "test-worker",
      adapterVersion: "0.0.0-fake",
      containment: { sandboxMode: "none", knownLimitations: [] },
    }),
    // A slow backend: in production this is where a workspace is provisioned
    // and the child is spawned, which is exactly the window under test.
    start: async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      lateHandle = { id: "late-handle" };
      return lateHandle;
    },
    async *events() {},
    // Only reached if the handle were missed by both owners: the attempt then
    // settles as cancelled on its own, which fails the assertions below
    // instead of hanging the test.
    wait: () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ terminalStatus: "CANCELLED", reason: "MISSED_BY_STOP" }), 3_000),
      ),
    cancel: async (handle, reason) => {
      cancellations.push({ handle, reason });
    },
  };
  const host = createWorkerHost({
    kernel,
    adapter,
    resolver: createStaticWorkerBackendResolver({
      backendType: "test-worker",
      backendVersion: "0.0.0-fake",
    }),
    runtimeRoot: dir,
    timeoutMs: 60_000,
  });

  try {
    const { task } = seedStaffedTask(kernel);
    host.start();
    const started = kernel.startWorkerRun({ taskId: task.id });

    await host.stop();

    assert.deepEqual(
      cancellations.map((entry) => entry.reason),
      ["HOST_STOPPING"],
      "the attempt that started during the stop is cancelled exactly once",
    );
    assert.equal(
      cancellations[0].handle,
      lateHandle,
      "the cancelled handle is the one the adapter created during the stop",
    );
    assert.equal(host.reportFor(started.workerRun.id).at(-1).status, "CANCELLED");
    assert.equal(
      kernel.workerRun(started.workerRun.id).state,
      "RUNNING",
      "a cancelled attempt writes nothing to the Runtime",
    );
    kernel.close();

    const reopened = reopenKernel(dir);
    try {
      assert.equal(reopened.recovery.count, 1);
      assert.equal(reopened.workerRun(started.workerRun.id).state, "INTERRUPTED");
      assert.equal(reopened.workerRun(started.workerRun.id).endReason, "PROCESS_INTERRUPTED");
    } finally {
      reopened.close();
    }
  } finally {
    cleanup();
  }
});

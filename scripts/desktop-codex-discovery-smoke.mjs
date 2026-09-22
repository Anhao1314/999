// LOCAL, MANUAL, OPT-IN - real-provider smoke for Desktop Worker Backend
// Discovery (docs/contracts/desktop-worker-backend-discovery-v0.md, sections
// 14-21).
//
// It is never imported by `node --test`, never runs in CI and needs no
// repository credentials: it launches the packaged Relay Code.app through
// LaunchServices, states a fixture Work through the Runtime's HTTP seam, and
// lets the production WorkerHost run the real Codex backend against a
// disposable /tmp Git repository. The FlowCredit checkout is never writable by
// the Worker.
//
// Usage:
//   node scripts/desktop-codex-discovery-smoke.mjs --mode execution
//   node scripts/desktop-codex-discovery-smoke.mjs --mode quit
//
// Options:
//   --app <path>       packaged Relay Code.app (defaults to apps/desktop/dist)
//   --mode <mode>      execution (default) or quit
//   --timeout-ms <n>   how long one real attempt may take (default 600000)
//   --fixture <dir>    reuse a run directory instead of making a new one
//   --quiet-ms <n>      quiet window that counts as "the Runtime settled"
//
// Only processes this script launched, identified by exact PID lineage, are
// ever inspected or stopped.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../", import.meta.url));
const APP_NAME = "Relay Code";
const BUNDLE_ID = "com.flowcredit.relaycode";

// The environment macOS gives a Finder-launched application on this machine:
// no developer PATH, no shell profile, no codex anywhere on PATH. Discovery has
// to find the backend without any of that.
const GUI_ENVIRONMENT = Object.freeze({
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: homedir(),
});

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const log = (line) => process.stdout.write(`${line}\n`);
const isAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function parseArguments(argv) {
  const options = {
    mode: "execution",
    app: null,
    timeoutMs: 600_000,
    fixture: null,
    quietMs: 60_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--mode") {
      if (value !== "execution" && value !== "quit") throw new Error(`unknown --mode ${value}`);
      options.mode = value;
      index += 1;
    } else if (flag === "--app") {
      options.app = resolve(value);
      index += 1;
    } else if (flag === "--timeout-ms") {
      options.timeoutMs = Number(value);
      index += 1;
    } else if (flag === "--fixture") {
      options.fixture = resolve(value);
      index += 1;
    } else if (flag === "--quiet-ms") {
      options.quietMs = Number(value);
      index += 1;
    } else {
      throw new Error(`unknown argument ${flag}`);
    }
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000)
    throw new Error("--timeout-ms must be an integer of at least 1000");
  if (!Number.isInteger(options.quietMs) || options.quietMs < 1_000)
    throw new Error("--quiet-ms must be an integer of at least 1000");
  return options;
}

function defaultAppPath() {
  return join(
    REPOSITORY_ROOT,
    "apps",
    "desktop",
    "dist",
    `${APP_NAME}-darwin-${process.arch}`,
    `${APP_NAME}.app`,
  );
}

async function until(label, predicate, { timeoutMs = 60_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(intervalMs);
  }
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// The bug is small, real and testable: the Worker has to make three failing
// assertions pass inside one module, and the tests are a protected path.
const BUGGY_MODULE = `export function slugify(value) {
  // Deliberately incomplete: no lower-casing, no punctuation handling.
  return value.trim().replace(/\\s+/g, "-");
}
`;

const MODULE_TESTS = `import test from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slug.mjs";

test("lower-cases the words", () => {
  assert.equal(slugify("Hello World"), "hello-world");
});

test("collapses punctuation and repeated separators", () => {
  assert.equal(slugify("  Node.js   Rocks!  "), "node-js-rocks");
});

test("keeps numbers and trims the edges", () => {
  assert.equal(slugify("Release 2 Final"), "release-2-final");
});
`;

function buildFixture(runRoot) {
  const fixture = join(runRoot, "fixture");
  mkdirSync(join(fixture, "src"), { recursive: true });
  mkdirSync(join(fixture, "test"), { recursive: true });
  writeFileSync(join(fixture, "src", "slug.mjs"), BUGGY_MODULE, "utf8");
  writeFileSync(join(fixture, "test", "slug.test.mjs"), MODULE_TESTS, "utf8");
  writeFileSync(
    join(fixture, "README.md"),
    "Disposable fixture for the Relay Code Desktop worker smoke. Not FlowCredit source.\n",
    "utf8",
  );
  git(fixture, ["init", "-q"]);
  git(fixture, ["add", "."]);
  git(fixture, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture: slugify with failing tests",
  ]);
  return { fixture, revision: git(fixture, ["rev-parse", "HEAD"]).trim() };
}

function fixtureVerificationStatus(fixture) {
  const result = spawnSync(process.execPath, ["--test"], { cwd: fixture, encoding: "utf8" });
  return result.status === 0 ? "PASS" : "FAIL";
}

// The Worker may only ever write to a disposable fixture. This guard is
// deliberately independent of the repository layout: it refuses any run
// directory that resolves inside a live FlowCredit checkout, so a mistyped
// `--fixture` can never hand a real Codex process writable access to the
// canonical repository or to the discovery worktree itself.
function assertDisposableFixtureTarget(runRoot) {
  const forbidden = [
    "/Users/yimingyang/Documents/FlowCredit/999",
    "/Users/yimingyang/Documents/FlowCredit/999-desktop-worker-backend-discovery",
  ].map((entry) => resolve(entry));
  const target = resolve(runRoot);
  for (const root of forbidden) {
    if (target === root || target.startsWith(`${root}/`))
      throw new Error(
        `refusing to build a Worker fixture inside a live repository: ${target} (under ${root})`,
      );
  }
  return target;
}

class DesktopApp {
  constructor({ appPath, runRoot, environment, label = "primary" }) {
    this.appPath = appPath;
    this.environment = environment;
    this.logsDir = join(runRoot, "logs");
    // One log per launch: a relaunch must never re-read the previous
    // session's `runtime-ready` line and reconnect to its dead port.
    this.stdoutPath = join(this.logsDir, `${label}.app.log`);
    this.stderrPath = join(this.logsDir, `${label}.app.err`);
    this.userDataDir = join(runRoot, "userdata");
    this.pid = null;
    this.appPid = null;
    this.baseUrl = null;
  }

  // `open` hands the app to LaunchServices: the application is a child of
  // launchd, not of this terminal, and inherits only the GUI environment plus
  // the operator configuration named here.
  launch() {
    mkdirSync(this.logsDir, { recursive: true });
    mkdirSync(this.userDataDir, { recursive: true });
    const args = ["-n", "--stdout", this.stdoutPath, "--stderr", this.stderrPath];
    for (const [name, value] of Object.entries(this.environment))
      args.push("--env", `${name}=${value}`);
    args.push(this.appPath, "--args", `--user-data-dir=${this.userDataDir}`);
    const opened = spawnSync("open", args, { encoding: "utf8", env: { ...GUI_ENVIRONMENT } });
    if (opened.status !== 0) throw new Error(`open failed: ${opened.stderr || opened.stdout}`);
  }

  readStdout() {
    try {
      return readFileSync(this.stdoutPath, "utf8");
    } catch {
      return "";
    }
  }

  // Best effort: a Runtime that has already exited has no parent left to read,
  // and an unreadable parent must never become a reporting failure.
  parentPidOf(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try {
      const raw = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim();
      const value = Number(raw);
      return Number.isInteger(value) && value > 0 ? value : null;
    } catch {
      return null;
    }
  }

  async waitForRuntime(timeoutMs = 60_000) {
    const match = await until(
      "the Runtime ready line",
      () => this.readStdout().match(/runtime-ready base=(http:\/\/127\.0\.0\.1:\d+) pid=(\d+)/),
      { timeoutMs, intervalMs: 250 },
    );
    this.baseUrl = match[1];
    this.pid = Number(match[2]);
    // The Runtime's parent is the Relay Code main process that owns it.
    this.appPid = this.parentPidOf(this.pid);
    return { baseUrl: this.baseUrl, runtimePid: this.pid };
  }

  discoveryLine() {
    const line = this.readStdout()
      .split("\n")
      .find((entry) => entry.includes("worker-backend-discovery "));
    if (!line) return null;
    const fields = {};
    for (const token of line.replace(/^\[relay-code\] worker-backend-discovery /, "").split(" ")) {
      const at = token.indexOf("=");
      if (at > 0) fields[token.slice(0, at)] = token.slice(at + 1);
    }
    return fields;
  }

  async command(name, input = {}) {
    const response = await fetch(`${this.baseUrl}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: name, input }),
    });
    const payload = await response.json();
    if (!response.ok)
      throw new Error(
        `${name} -> ${response.status} ${payload?.error?.code ?? ""} ${payload?.error?.message ?? ""}`,
      );
    return payload.result;
  }

  async get(path) {
    const response = await fetch(`${this.baseUrl}${path}`);
    const payload = await response.json();
    if (!response.ok)
      throw new Error(
        `${path} -> ${response.status} ${payload?.error?.code ?? ""} ${payload?.error?.message ?? ""}`,
      );
    return payload;
  }

  // Exact lineage only: children of the Runtime process this launch started.
  children() {
    if (!this.pid) return [];
    return processTable().filter((entry) => entry.ppid === this.pid);
  }

  // Every process at or below this launch's Runtime, transitively. Once the
  // Runtime exits its children are re-parented, so this is only meaningful
  // while it is alive.
  descendants() {
    if (!this.pid) return [];
    const byParent = new Map();
    for (const entry of processTable()) {
      if (!byParent.has(entry.ppid)) byParent.set(entry.ppid, []);
      byParent.get(entry.ppid).push(entry);
    }
    const collected = [];
    const queue = [...(byParent.get(this.pid) ?? [])];
    while (queue.length > 0) {
      const entry = queue.shift();
      collected.push(entry);
      queue.push(...(byParent.get(entry.pid) ?? []));
    }
    return collected;
  }

  // A Codex child this run started that is somehow still alive. Scoped to this
  // launch's processes and matched by the discovered executable path; it is
  // never a global scan and never a global kill.
  survivingBackendCount(executablePath) {
    if (!executablePath) return 0;
    return this.descendants().filter(
      (entry) => entry.command.includes(executablePath) && isAlive(entry.pid),
    ).length;
  }

  codexChildren(executablePath) {
    if (!executablePath) return [];
    return this.children().filter((entry) => entry.command.includes(executablePath));
  }

  quit() {
    const result = spawnSync("osascript", ["-e", `tell application id "${BUNDLE_ID}" to quit`], {
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(`quit failed: ${result.stderr || result.stdout}`);
  }

  async waitForExit(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // Both have to be gone: the Runtime exiting says nothing about the
      // application shell, and a relaunch needs the shell to be finished.
      const runtimeGone = this.pid === null || !isAlive(this.pid);
      const appGone = this.appPid === null || !isAlive(this.appPid);
      if (runtimeGone && appGone) return true;
      await sleep(250);
    }
    return false;
  }
}

function processTable() {
  return execFileSync("ps", ["-o", "pid=,ppid=,command=", "-ax"], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [pid, ppid, ...rest] = line.trim().split(/\s+/);
      return { pid: Number(pid), ppid: Number(ppid), command: rest.join(" ") };
    });
}

function readEvidence(evidenceDir, workerRunId, generation) {
  const file = join(evidenceDir, `${workerRunId}-g${generation}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function makeLineageWatcher(app, discovery) {
  let pid = null;
  const watch = async () => {
    if (pid !== null) return pid;
    const found = app.codexChildren(discovery.path);
    if (found.length > 0) {
      pid = found[0].pid;
      log(`CODEX_CHILD_PID=${pid}`);
    }
    return pid;
  };
  return { watch, pid: () => pid };
}

// The Continuation Driver owns dispatch and keeps acting until no single legal
// action is deterministically available. "Settled" therefore means: an
// Artifact exists, nothing anywhere in this Work is RUNNING, and the durable
// WorkerRun register has not moved for `quietMs`. It is read from Task truth,
// never inferred from a single Task.
async function waitForWorkSettle(app, workId, { timeoutMs, quietMs }) {
  let signature = null;
  let stableSince = null;
  let artifact = null;
  let lastProjection = null;
  const projection = await until(
    "the real Work to reach a settled Runtime state",
    async () => {
      const current = await app.get(`/works/${workId}`);
      lastProjection = current;
      if (artifact === null && current.artifacts.length > 0)
        artifact = current.latestArtifact ?? current.artifacts.at(-1);
      // The key is the whole Work topology, not just the runs: the Driver also
      // materializes Tasks asynchronously, and a new Task is a new dispatch
      // boundary even though no WorkerRun exists yet.
      const parts = current.tasks
        .map((entry) => `${entry.id}:${entry.generation}:${entry.state}`)
        .sort();
      const runs = [];
      let anyRunning = false;
      for (const task of current.tasks) {
        const detail = await app.get(`/tasks/${task.id}`);
        for (const run of detail.runs ?? []) {
          runs.push(`${run.id}:${run.state}:${run.generation}`);
          if (run.state === "RUNNING") anyRunning = true;
        }
      }
      const nextSignature = [...parts, ...runs.sort(), `artifacts=${current.artifacts.length}`].join("|");
      if (nextSignature !== signature) {
        signature = nextSignature;
        stableSince = Date.now();
      }
      const idle =
        !anyRunning && stableSince !== null && Date.now() - stableSince >= quietMs;
      return artifact !== null && idle ? current : null;
    },
    { timeoutMs, intervalMs: 1_000 },
  );
  return { projection, artifact, signature, lastProjection };
}

async function stateWork(app) {
  const company = await app.command("createCompany", { name: "Fixture Co" });
  const position = await app.command("createPosition", {
    companyId: company.id,
    title: "Engineer",
    capabilities: ["work.execute"],
  });
  const employee = await app.command("createEmployee", {
    companyId: company.id,
    positionId: position.id,
    displayName: "Rio",
  });
  const title = "Make slugify satisfy test/slug.test.mjs";
  const work = await app.command("createWork", {
    companyId: company.id,
    title,
    intent: "The fixture module must satisfy its own tests without editing them.",
  });
  const task = await app.command("createTask", {
    workId: work.id,
    title,
    intent: "Fix src/slug.mjs so the repository's own tests pass. Do not edit test/.",
    requiredCapabilities: ["work.execute"],
  });
  log(`WORK_ID=${work.id}`);
  log(`TASK_ID=${task.id}`);
  log(`EMPLOYEE_ID=${employee.id}`);
  return { work, task };
}

async function runExecutionScenario({ app, appPath, runRoot, environment, discovery, work, task, options }) {
  const evidenceDir = join(runRoot, "evidence");
  const lineage = makeLineageWatcher(app, discovery);

  const quietMs = options.quietMs;
  const settleWatch = setInterval(() => void lineage.watch(), 500);
  const { projection, artifact, signature: lastRunSignature } = await waitForWorkSettle(
    app,
    work.id,
    { timeoutMs: options.timeoutMs, quietMs },
  );
  clearInterval(settleWatch);
  await lineage.watch();
  if (artifact === null) throw new Error("the Work settled before any Artifact existed");
  const runDetail = (await app.get(`/runs/${artifact.workerRunId}`)).workerRun;
  const evidence = readEvidence(evidenceDir, artifact.workerRunId, runDetail.generation);
  log(`WORKER_RUN_ID=${artifact.workerRunId}`);
  log(`WORKER_GENERATION=${runDetail.generation}`);
  log(`CODEX_CHILD_PID=${lineage.pid() ?? "unknown"}`);
  log(`ARTIFACT_ID=${artifact.id}`);
  log(`ARTIFACT_DIGEST=${artifact.contentDigest}`);
  log(`ARTIFACT_KIND=${artifact.kind}`);
  log(`FILES_CHANGED=${(evidence?.git?.changedFiles ?? []).join(",") || "unknown"}`);
  log(
    `VERIFICATION_RESULT=${evidence?.verification?.status ?? "unknown"}:${evidence?.verification?.passed ?? "unknown"}`,
  );
  log(`WORK_STATUS_AFTER_RESULT=${projection.status ?? "unknown"}`);
  log(`WORKER_RUN_STATE_AFTER_RESULT=${runDetail.state}`);
  log(`WORK_OUTCOME_AFTER_SETTLE=${projection.outcome?.state ?? "unknown"}`);
  log(`WORK_TASK_STATE_AFTER_SETTLE=${JSON.stringify(projection.taskCounts ?? {})}`);
  log(
    `FOUNDER_ATTENTION_AFTER_SETTLE=${(projection.founderAttention?.conditions ?? []).join(",") || "none"}`,
  );
  log(`QUIESCENT_MS=${options.quietMs}`);
  log(
    `BACKEND_VERSION_BOUND=${evidence?.backend?.version ?? runDetail.backendVersion ?? "unknown"}`,
  );
  log(`EVIDENCE_DIFF_DIGEST=${evidence?.git?.diffDigest ?? "unknown"}`);
  log(`STORE_DIR=${join(app.userDataDir, "runtime")}`);

  const childPid = lineage.pid();
  app.quit();
  log(`RUNTIME_EXITED=${await app.waitForExit()}`);
  log(`ORPHAN_CODEX_CHILDREN=${isAlive(childPid) ? 1 : 0}`);

  // Relaunch: the same durable store, rediscovered backend, no manual repair.
  const relaunch = new DesktopApp({ appPath, runRoot, environment, label: "relaunch" });
  relaunch.launch();
  await relaunch.waitForRuntime();
  const rediscovery = relaunch.discoveryLine();
  // Recovery must not quietly dispatch another attempt: hold the register
  // still for the same quiet window, over the whole Work, before declaring the
  // relaunch settled.
  const after = await waitForWorkSettle(relaunch, work.id, {
    timeoutMs: options.timeoutMs,
    quietMs,
  });
  const afterRun = (await relaunch.get(`/runs/${artifact.workerRunId}`)).workerRun;
  const afterRunStates = [];
  for (const task0 of after.projection.tasks) {
    const detail = await relaunch.get(`/tasks/${task0.id}`);
    for (const run of detail.runs ?? [])
      afterRunStates.push(`${run.id}:${run.state}:${run.generation}`);
  }
  const afterRuns = afterRunStates.sort().join("|");
  log(`RELAUNCH_CODEX_DISCOVERY_SOURCE=${rediscovery?.source ?? "unknown"}`);
  log(`RELAUNCH_CODEX_VERSION=${rediscovery?.version ?? "unknown"}`);
  log(`RELAUNCH_WORK_STATUS=${after.projection.status ?? "unknown"}`);
  log(`RELAUNCH_ARTIFACT_COUNT=${after.projection.artifacts.length}`);
  log(`RELAUNCH_WORKER_RUN_STATE=${afterRun.state}`);
  log(`RELAUNCH_RUN_REGISTRY=${afterRuns}`);
  log(`RELAUNCH_DISPATCHED_NEW_RUNS=${afterRuns !== lastRunSignature}`);
  log(`RELAUNCH_TASK_COUNT=${after.projection.tasks.length}`);
  log(`RELAUNCH_WORK_OUTCOME=${after.projection.outcome?.state ?? "unknown"}`);
  log(
    `WORK_CONTINUITY_AFTER_RELAUNCH=${after.projection.work?.id === work.id && after.projection.artifacts.length > 0}`,
  );
  relaunch.quit();
  log(`RELAUNCH_EXITED=${await relaunch.waitForExit()}`);
  log(`EVIDENCE_DIR=${evidenceDir}`);
  log(`EVIDENCE_FILES=${readdirSync(evidenceDir).join(",")}`);
}

async function runQuitScenario({ app, appPath, runRoot, environment, discovery, work, task }) {
  const lineage = makeLineageWatcher(app, discovery);
  const activeRun = await until(
    "a running WorkerRun with a live Codex child",
    async () => {
      await lineage.watch();
      const detail = await app.get(`/tasks/${task.id}`);
      const running = detail.runs.find((entry) => entry.state === "RUNNING") ?? null;
      return running && lineage.pid() !== null ? running : null;
    },
    { timeoutMs: 180_000, intervalMs: 500 },
  );
  log(`WORKER_RUN_ID=${activeRun.id}`);
  log(`WORKER_GENERATION=${activeRun.generation}`);
  log(`WORKER_RUN_STATE_BEFORE_QUIT=${activeRun.state}`);
  const codexPid = lineage.pid();
  // Read the surviving-backend count while the Runtime is still alive, so the
  // lineage walk still has a root to walk from.
  const beforeQuitSurvivors = app.survivingBackendCount(discovery.path);
  const evidenceDir = join(runRoot, "evidence");

  log("QUIT_METHOD=osascript-quit-event");
  const quitAt = Date.now();
  app.quit();
  log(`RUNTIME_EXITED=${await app.waitForExit()}`);
  const runtimeExitMs = Date.now() - quitAt;
  await until("the Codex child to be gone", () => !isAlive(codexPid), {
    timeoutMs: 15_000,
    intervalMs: 250,
  });
  const evidence = readEvidence(evidenceDir, activeRun.id, activeRun.generation);
  log(`SHUTDOWN_ELAPSED_MS=${runtimeExitMs}`);
  log(`ADAPTER_CANCEL_CALLED=${evidence?.process?.cancelled === true}`);
  log(`ADAPTER_CANCEL_REASON=${evidence?.process?.cancelReason ?? "unknown"}`);
  log(
    `ADAPTER_TERMINATION_CONFIRMED=${evidence?.process?.terminationConfirmed ?? "unknown"}`,
  );
  log(`ADAPTER_ESCALATED_TO_SIGKILL=${evidence?.process?.escalatedToSigkill ?? "unknown"}`);
  log(`CODEX_CHILD_EXITED=${!isAlive(codexPid)}`);
  log(`ORPHAN_CODEX_CHILDREN=${isAlive(codexPid) ? 1 : 0}`);
  log(`BACKEND_CHILDREN_BEFORE_QUIT=${beforeQuitSurvivors}`);
  log(`STORE_DIR=${join(app.userDataDir, "runtime")}`);

  // Relaunch against the same durable store: recovery owns the interrupted
  // attempt, and the fenced generation must never land afterwards.
  const recoveryApp = new DesktopApp({ appPath, runRoot, environment, label: "recovery" });
  recoveryApp.launch();
  await recoveryApp.waitForRuntime();
  const recoveredRun = await recoveryApp.get(`/runs/${activeRun.id}`);
  const recoveredWork = await recoveryApp.get(`/works/${work.id}`);
  log(`RELAUNCH_CODEX_DISCOVERY_SOURCE=${recoveryApp.discoveryLine()?.source ?? "unknown"}`);
  log(`DURABLE_WORKER_RUN_STATE_AFTER_RELAUNCH=${recoveredRun.workerRun.state}`);
  log(`DURABLE_WORKER_RUN_END_REASON=${recoveredRun.workerRun.endReason ?? ""}`);
  log(`WORK_CONTINUITY_STATUS=${recoveredWork.work?.id === work.id ? "WORK_PRESERVED" : "LOST"}`);
  log(`RELAUNCH_SURVIVING_BACKEND_CHILDREN=${recoveryApp.survivingBackendCount(discovery.path)}`);

  let staleRejected = false;
  try {
    await recoveryApp.command("submitWorkerResult", {
      workerRunId: activeRun.id,
      generation: activeRun.generation,
      resultDigest: "sha256:stale-generation",
      evidenceDigest: "sha256:stale-generation",
      artifact: { kind: "patch", title: "stale", content: "stale\n" },
    });
  } catch {
    staleRejected = true;
  }
  log(`STALE_GENERATION_REJECTED=${staleRejected}`);
  recoveryApp.quit();
  log(`RELAUNCH_EXITED=${await recoveryApp.waitForExit()}`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const appPath = options.app ?? defaultAppPath();
  if (!existsSync(appPath)) throw new Error(`packaged application not found: ${appPath}`);

  const runRoot = options.fixture ?? mkdtempSync(join(tmpdir(), "relay-code-desktop-worker-"));
  assertDisposableFixtureTarget(runRoot);
  mkdirSync(runRoot, { recursive: true });
  mkdirSync(join(runRoot, "evidence"), { recursive: true });
  const { fixture, revision } = buildFixture(runRoot);

  log("APP_LAUNCH_METHOD=open --env (LaunchServices)");
  log(`DESKTOP_GUI_PATH=${appPath}`);
  log(`RUN_ROOT=${runRoot}`);
  log(`FIXTURE_PATH=${fixture}`);
  log(`FIXTURE_BASE_REVISION=${revision}`);
  const before = fixtureVerificationStatus(fixture);
  log(`FIXTURE_TESTS_BEFORE=${before}`);
  if (before !== "FAIL") throw new Error("the fixture is supposed to start with failing tests");

  const environment = {
    FLOWCREDIT_COORDINATION: "driver",
    FLOWCREDIT_WORKER_BACKEND: "codex-exec",
    FLOWCREDIT_CODEX_REPO: fixture,
    FLOWCREDIT_CODEX_BASE_REVISION: revision,
    FLOWCREDIT_CODEX_VERIFICATION: `${process.execPath} --test`,
    FLOWCREDIT_CODEX_PROTECTED_PATHS: "test/",
    FLOWCREDIT_CODEX_EVIDENCE_DIR: join(runRoot, "evidence"),
    FLOWCREDIT_WORKER_TIMEOUT_MS: String(options.timeoutMs),
  };

  const app = new DesktopApp({ appPath, runRoot, environment });
  app.launch();
  const ready = await app.waitForRuntime();
  log(`RUNTIME_BASE=${ready.baseUrl}`);
  log(`RUNTIME_PID=${ready.runtimePid}`);
  log(`APP_PID=${app.appPid}`);
  const discovery = app.discoveryLine();
  if (!discovery) throw new Error("the Desktop never logged a discovery result");
  log(`CODEX_DISCOVERY_SOURCE=${discovery.source}`);
  log(`CODEX_DISCOVERY_AVAILABLE=${discovery.available}`);
  log(`CODEX_VERSION_DISCOVERED=${discovery.version}`);
  log(`CODEX_EXECUTABLE_REPORTED=${discovery.path}`);
  log(`CODEX_EXECUTABLE_REALPATH=${discovery.path}`);

  const { work, task } = await stateWork(app);
  const scenario = { app, appPath, runRoot, environment, discovery, work, task, options };
  if (options.mode === "quit") await runQuitScenario(scenario);
  else await runExecutionScenario(scenario);

  log(`FIXTURE_TESTS_AFTER=${fixtureVerificationStatus(fixture)}`);
  log("REAL_PROVIDER_SMOKE=done");
}

main().catch((error) => {
  log("REAL_PROVIDER_SMOKE=failed");
  log(`ERROR=${error?.message ?? error}`);
  process.exitCode = 1;
});

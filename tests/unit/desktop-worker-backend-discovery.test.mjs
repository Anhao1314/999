// DesktopWorkerBackendDiscovery — deterministic discovery tests.
// Contract: docs/contracts/desktop-worker-backend-discovery-v0.md §9–§12.
//
// No real Codex, no model, no network: every candidate is a fake executable
// materialised in a temp directory, and every assertion is about the policy,
// the validation and the bounded result shape.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISCOVERY_BOUNDS,
  DISCOVERY_SOURCES,
  MAX_DISCOVERY_REJECTIONS,
  OVERRIDE_ENV,
  describeDiscovery,
  discoverCodexBackend,
  probeCodexExecutable,
  validateCodexCandidatePath,
} from "../../apps/desktop/src/worker-backend-discovery.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const created = [];
after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "relay-code-discovery-"));
  created.push(dir);
  return dir;
}

// A fake Codex executable: a real file with a real shebang, so the probe spawns
// the kernel's own binary rather than an interpreted stand-in.
function fakeCodex(dir, { name = "codex", version = "9.9.9-fake", script = null, mode = 0o755 } = {}) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const body = script ?? `process.stdout.write("codex-cli ${version}\\n");`;
  writeFileSync(path, `#!${process.execPath}\n${body}\n`, "utf8");
  chmodSync(path, mode);
  return path;
}

const emptyLists = () => ({ standardLocations: [], appBundleCandidates: [] });

test("an explicit absolute override wins over every other candidate", async () => {
  const dir = sandbox();
  const override = fakeCodex(join(dir, "override"), { version: "1.1.1-fake" });
  const onPath = fakeCodex(join(dir, "path"), { version: "2.2.2-fake" });
  const standard = fakeCodex(join(dir, "standard"), { version: "3.3.3-fake" });

  const discovery = await discoverCodexBackend({
    env: { PATH: join(dir, "path"), [OVERRIDE_ENV]: override },
    standardLocations: [standard],
    appBundleCandidates: [],
  });

  assert.equal(discovery.available, true);
  assert.equal(discovery.discoveredBy, DISCOVERY_SOURCES.EXPLICIT_OVERRIDE);
  assert.equal(discovery.version, "1.1.1-fake");
  assert.equal(discovery.executablePath, override);
  assert.equal(discovery.resolvedPath, realpathSync(override), "the resolved real path is what was probed");
  assert.equal(discovery.rejections.length, 0, "the winner is never probed twice");
  assert.equal(discovery.backendType, "codex-exec");
  // `onPath` was never consulted: the override short-circuits the policy.
  assert.equal(discovery.version === "2.2.2-fake", false);
});

test("an invalid explicit override fails clearly instead of falling back", async () => {
  const dir = sandbox();
  const onPath = fakeCodex(join(dir, "path"), { version: "2.2.2-fake" });
  const pathEnv = { PATH: join(dir, "path") };

  const missing = await discoverCodexBackend({
    env: { ...pathEnv, [OVERRIDE_ENV]: join(dir, "does-not-exist", "codex") },
    ...emptyLists(),
  });
  assert.equal(missing.available, false);
  assert.equal(missing.discoveredBy, DISCOVERY_SOURCES.NONE);
  assert.equal(missing.executablePath, null);
  assert.deepEqual(missing.rejections.map((entry) => entry.code), ["PATH_MISSING"]);

  const relative = await discoverCodexBackend({
    env: { ...pathEnv, [OVERRIDE_ENV]: "codex" },
    ...emptyLists(),
  });
  assert.equal(relative.available, false);
  assert.deepEqual(relative.rejections.map((entry) => entry.code), ["PATH_NOT_ABSOLUTE"]);

  // The PATH candidate that *would* have won is still there and still unused:
  // an operator's explicit instruction is never silently replaced.
  assert.equal(existsSync(onPath), true);
  assert.match(describeDiscovery(missing), /available=false/);
  assert.match(describeDiscovery(missing), /path=none/);
});

test("an inherited PATH candidate is discovered when nothing else exists", async () => {
  const dir = sandbox();
  const candidate = fakeCodex(join(dir, "bin"), { version: "4.4.4-fake" });

  const discovery = await discoverCodexBackend({
    env: { PATH: `/usr/bin:${join(dir, "bin")}` },
    ...emptyLists(),
  });
  assert.equal(discovery.available, true);
  assert.equal(discovery.discoveredBy, DISCOVERY_SOURCES.PATH);
  assert.equal(discovery.resolvedPath, realpathSync(candidate));
  assert.equal(discovery.version, "4.4.4-fake");
});

test("a standard macOS location is discovered when PATH has no candidate", async () => {
  const dir = sandbox();
  const candidate = fakeCodex(join(dir, "usr-local-bin"), { version: "5.5.5-fake" });

  const discovery = await discoverCodexBackend({
    env: { PATH: "/usr/bin:/bin" },
    standardLocations: [join(dir, "missing"), candidate],
    appBundleCandidates: [],
  });
  assert.equal(discovery.available, true);
  assert.equal(discovery.discoveredBy, DISCOVERY_SOURCES.STANDARD_LOCATION);
  assert.equal(discovery.resolvedPath, realpathSync(candidate));
  assert.deepEqual(
    discovery.rejections.map((entry) => entry.code),
    ["PATH_MISSING", "PATH_MISSING", "PATH_MISSING"],
    "the two inherited PATH locations and the declared one are all recorded as missing",
  );
});

test("a bounded known app bundle is discovered when PATH and standard locations miss", async () => {
  const dir = sandbox();
  const candidate = fakeCodex(join(dir, "ChatGPT.app", "Contents", "Resources"), {
    version: "6.6.6-fake",
  });

  const discovery = await discoverCodexBackend({
    env: { PATH: "/usr/bin:/bin" },
    standardLocations: [join(dir, "usr-local-bin")],
    appBundleCandidates: [join(dir, "missing.app"), candidate],
  });
  assert.equal(discovery.available, true, "a bounded known app bundle is a discovery source");
  assert.equal(discovery.discoveredBy, DISCOVERY_SOURCES.KNOWN_APP_BUNDLE);
  assert.equal(discovery.resolvedPath, realpathSync(candidate));
});

test("duplicate real executables are probed once and a winner short-circuits the policy", async () => {
  const dir = sandbox();
  const bin = join(dir, "bin");
  const candidate = fakeCodex(bin, { script: 'process.stdout.write("not codex" + " at all");' });
  const probed = [];
  const probe = async (path, options) => {
    probed.push(path);
    return probeCodexExecutable(path, options);
  };

  // The same real executable is reachable three times and is executed once.
  const exhausted = await discoverCodexBackend({
    env: { PATH: `${bin}:${bin}` },
    standardLocations: [candidate],
    appBundleCandidates: [candidate],
    probe,
  });
  assert.equal(exhausted.available, false);
  assert.deepEqual(probed, [realpathSync(candidate)], "one real executable, one probe");
  assert.deepEqual(
    exhausted.rejections.map((entry) => entry.code),
    ["VERSION_UNRECOGNIZED", "DUPLICATE", "DUPLICATE", "DUPLICATE"],
    "later occurrences are recorded, not re-executed",
  );

  // A valid candidate in the first position ends the search immediately.
  const second = join(dir, "bin-valid");
  const winner = fakeCodex(second, { version: "6.6.6-fake" });
  probed.length = 0;
  const found = await discoverCodexBackend({
    env: { PATH: second },
    standardLocations: [winner],
    appBundleCandidates: [winner],
    probe,
  });
  assert.equal(found.available, true);
  assert.equal(found.discoveredBy, DISCOVERY_SOURCES.PATH, "PATH is consulted first");
  assert.equal(found.version, "6.6.6-fake");
  assert.deepEqual(probed, [realpathSync(winner)]);
  assert.deepEqual(found.rejections, []);
});

test("symlinked candidates are resolved and executed through their real path", async () => {
  const dir = sandbox();
  const real = fakeCodex(join(dir, "real"), { name: "codex-real", version: "7.7.7-fake" });
  const link = join(dir, "bin", "codex");
  mkdirSync(join(dir, "bin"), { recursive: true });
  symlinkSync(real, link);

  const discovery = await discoverCodexBackend({
    env: { PATH: join(dir, "bin") },
    ...emptyLists(),
  });
  assert.equal(discovery.available, true, "a package-manager style symlink stays legal");
  assert.equal(discovery.executablePath, link, "the reported path is what discovery saw");
  assert.equal(discovery.resolvedPath, realpathSync(real), "the real path is what validation resolved");
  assert.equal(discovery.version, "7.7.7-fake");

  const directoryLink = join(dir, "dir-link");
  symlinkSync(dir, directoryLink);
  assert.deepEqual(validateCodexCandidatePath(directoryLink), {
    ok: false,
    code: "PATH_NOT_A_FILE",
  });
});

test("non-executable files, directories and malformed paths are rejected", async () => {
  const dir = sandbox();
  const plain = fakeCodex(join(dir, "standard", "codex"), { mode: 0o644 });
  const asDirectory = join(dir, "codex");
  mkdirSync(asDirectory, { recursive: true });
  const bundledDirectory = join(dir, "bundle", "codex");
  mkdirSync(bundledDirectory, { recursive: true });

  assert.deepEqual(validateCodexCandidatePath(plain), { ok: false, code: "PATH_NOT_EXECUTABLE" });
  assert.deepEqual(validateCodexCandidatePath(asDirectory), { ok: false, code: "PATH_NOT_A_FILE" });
  assert.deepEqual(validateCodexCandidatePath("codex"), { ok: false, code: "PATH_NOT_ABSOLUTE" });
  assert.deepEqual(validateCodexCandidatePath("  /usr/bin/codex"), { ok: false, code: "PATH_MALFORMED" });
  assert.deepEqual(validateCodexCandidatePath(null), { ok: false, code: "PATH_MALFORMED" });

  const discovery = await discoverCodexBackend({
    env: { PATH: dir },
    standardLocations: [plain],
    appBundleCandidates: [bundledDirectory],
  });
  assert.equal(discovery.available, false);
  assert.deepEqual(
    discovery.rejections.map((entry) => entry.code),
    ["PATH_NOT_A_FILE", "PATH_NOT_EXECUTABLE", "PATH_NOT_A_FILE"],
  );
});

test("a probe that never answers is bounded and treated as unavailable", async () => {
  const dir = sandbox();
  const hanging = fakeCodex(join(dir, "bin"), {
    script: 'setInterval(() => {}, 1000);',
  });
  const startedAt = Date.now();
  const discovery = await discoverCodexBackend({
    env: { PATH: join(dir, "bin") },
    ...emptyLists(),
    probeTimeoutMs: 250,
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(discovery.available, false);
  assert.deepEqual(discovery.rejections.map((entry) => entry.code), ["PROBE_TIMEOUT"]);
  assert.ok(elapsed < 5_000, `a hanging candidate must not stall discovery (took ${elapsed}ms)`);
  assert.equal(existsSync(hanging), true);
});

test("a binary that is not Codex, or that does not answer, is rejected", async () => {
  const dir = sandbox();
  const wrongBinary = fakeCodex(join(dir, "wrong"), { script: 'process.stdout.write("hello there\\n");' });
  const failing = fakeCodex(join(dir, "failing"), { script: "process.exit(3);" });
  const bare = fakeCodex(join(dir, "bare"), { script: 'process.stdout.write("0.155.0\\n");' });

  assert.deepEqual(await probeCodexExecutable(wrongBinary), { ok: false, code: "VERSION_UNRECOGNIZED" });
  assert.deepEqual(await probeCodexExecutable(failing), { ok: false, code: "PROBE_FAILED" });
  assert.deepEqual(await probeCodexExecutable(bare), { ok: true, version: "0.155.0" });

  const discovery = await discoverCodexBackend({
    env: { PATH: "" },
    standardLocations: [wrongBinary, failing],
    appBundleCandidates: [],
  });
  assert.equal(discovery.available, false);
  assert.deepEqual(
    discovery.rejections.map((entry) => entry.code),
    ["VERSION_UNRECOGNIZED", "PROBE_FAILED"],
    "candidates are tried in a stable, auditable order",
  );
});

test("candidate paths are executed directly, never through a shell", async () => {
  const dir = sandbox();
  const trickyName = "codex;touch pwned-by-shell-injection && echo";
  const candidate = fakeCodex(join(dir, "bin"), { name: trickyName, version: "8.8.8-fake" });
  const marker = join(process.cwd(), "pwned-by-shell-injection");

  const discovery = await discoverCodexBackend({
    env: { PATH: "" },
    standardLocations: [candidate],
    appBundleCandidates: [],
  });
  assert.equal(discovery.version, "8.8.8-fake", "the file itself is the executable, not a command line");
  assert.equal(discovery.resolvedPath, realpathSync(candidate));
  assert.equal(existsSync(marker), false, "no shell metacharacter in a path is ever interpreted");

  const source = readFileSync(
    join(ROOT, "apps/desktop/src/worker-backend-discovery.mjs"),
    "utf8",
  );
  for (const forbidden of ["shell: true", "/bin/sh", "execSync", "execFileSync", "eval(", "source ~/"])
    assert.equal(source.includes(forbidden), false, `discovery must not use ${forbidden}`);
  assert.match(source, /spawn\(executablePath, \["--version"\]/);
});

test("the discovery result stays bounded and carries no extra fields", async () => {
  const dir = sandbox();
  const missing = Array.from({ length: 40 }, (_, index) => join(dir, `missing-${index}`, "codex"));
  const discovery = await discoverCodexBackend({
    env: { PATH: "relative-nonsense:.:/definitely/missing" },
    standardLocations: missing,
    appBundleCandidates: [],
  });

  assert.equal(discovery.available, false);
  assert.equal(discovery.rejections.length, MAX_DISCOVERY_REJECTIONS, "rejections are capped");
  for (const entry of discovery.rejections) assert.deepEqual(Object.keys(entry), ["candidate", "code"]);
  assert.deepEqual(Object.keys(discovery).sort(), [
    "available",
    "backendType",
    "checkedAt",
    "discoveredBy",
    "executablePath",
    "rejections",
    "resolvedPath",
    "version",
  ]);
  assert.equal(Object.isFrozen(discovery), true);
  assert.ok(DISCOVERY_BOUNDS.pathEntries <= 64);
  assert.ok(DISCOVERY_BOUNDS.reportedPathLength <= 240);
});

test("the discovered path configures the Runtime process and never the renderer", async () => {
  const sources = readdirSync(join(ROOT, "apps/desktop/src"));
  const texts = sources
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => [name, readFileSync(join(ROOT, "apps/desktop/src", name), "utf8")]);

  for (const [, text] of texts)
    for (const forbidden of ["ipcRenderer", "contextBridge", "webContents.send", "executeJavaScript"])
      assert.equal(text.includes(forbidden), false, `desktop main code must not expose ${forbidden}`);

  const settingsMain = texts.find(([name]) => name === "main.mjs")?.[1] ?? "";
  assert.match(settingsMain, /event\.sender === settingsWindow\.webContents/);
  assert.match(settingsMain, /event\.senderFrame\?\.url === new URL\("\.\/settings\.html"/);

  const importers = texts
    .filter(([name]) => name !== "worker-backend-discovery.mjs")
    .filter(([, text]) => text.includes("worker-backend-discovery.mjs"))
    .map(([name]) => name);
  assert.deepEqual(importers, ["main.mjs"], "discovery is main-process infrastructure, not a shared module");

  const main = texts.find(([name]) => name === "main.mjs")[1];
  assert.match(main, /desktopRuntimeEnvironment\(\{ env: process\.env, discovery: backendDiscovery \}\)/);

  // The two product shells the window can reach never learn the executable path.
  for (const file of [
    "apps/workspace/app.mjs",
    "apps/workspace/adapter.mjs",
    "apps/employee/app.mjs",
    "apps/employee/adapter.mjs",
  ]) {
    const text = readFileSync(join(ROOT, file), "utf8");
    assert.equal(text.includes("FLOWCREDIT_CODEX_BIN"), false, `${file} must not read the backend path`);
    assert.equal(text.includes("worker-backend-discovery"), false, `${file} must not import discovery`);
  }
});

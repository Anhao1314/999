// Desktop → Runtime backend configuration tests.
// Contract: docs/contracts/desktop-worker-backend-discovery-v0.md §7, §8, §11.
//
// The line under test: a discovery result may produce exactly one Runtime
// process variable — an absolute Codex path — and only when the operator asked
// for `codex-exec`. Nothing here writes Company truth, and nothing here is a
// renderer surface.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODEX_EXECUTABLE_ENV,
  boundedEnvironmentFacts,
  describeEnvironmentFacts,
  desktopRuntimeEnvironment,
  redactPathValue,
} from "../../apps/desktop/src/runtime-environment.mjs";
import { RuntimeLifecycle } from "../../apps/desktop/src/runtime-lifecycle.mjs";

const FIXTURE = fileURLToPath(new URL("../support/desktop-runtime-fixture.mjs", import.meta.url));
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const created = [];
after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

const discovery = Object.freeze({
  backendType: "codex-exec",
  available: true,
  executablePath: "/opt/example/bin/codex",
  resolvedPath: "/opt/example/real/bin/codex",
  version: "9.9.9-fake",
  discoveredBy: "KNOWN_APP_BUNDLE",
  checkedAt: "2026-01-01T00:00:00.000Z",
  rejections: Object.freeze([]),
});

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "relay-code-env-"));
  created.push(dir);
  return dir;
}

test("a discovered backend becomes one absolute Runtime variable, and only for codex-exec", () => {
  const codexExec = desktopRuntimeEnvironment({
    env: { FLOWCREDIT_WORKER_BACKEND: "codex-exec", FLOWCREDIT_COORDINATION: "driver" },
    discovery,
  });
  assert.deepEqual(codexExec, {
    FLOWCREDIT_COORDINATION: "driver",
    FLOWCREDIT_WORKER_BACKEND: "codex-exec",
    [CODEX_EXECUTABLE_ENV]: "/opt/example/real/bin/codex",
  });
  assert.equal(Object.isFrozen(codexExec), true);

  // The default: no backend selected, so discovery changes nothing at all.
  assert.deepEqual(desktopRuntimeEnvironment({ env: {}, discovery }), {
    FLOWCREDIT_COORDINATION: "off",
    FLOWCREDIT_WORKER_BACKEND: "off",
  });
  assert.deepEqual(desktopRuntimeEnvironment({ env: {}, discovery: null }), {
    FLOWCREDIT_COORDINATION: "off",
    FLOWCREDIT_WORKER_BACKEND: "off",
  });

  // An unavailable backend is never invented, and the operator's switch is
  // never rewritten: the Runtime decides what to do about a missing backend.
  const unavailable = desktopRuntimeEnvironment({
    env: { FLOWCREDIT_WORKER_BACKEND: "codex-exec" },
    discovery: { backendType: "codex-exec", available: false, resolvedPath: null },
  });
  assert.deepEqual(unavailable, {
    FLOWCREDIT_COORDINATION: "off",
    FLOWCREDIT_WORKER_BACKEND: "codex-exec",
  });
  assert.equal(CODEX_EXECUTABLE_ENV in unavailable, false);

  // An operator's rejected override is handed to the Runtime unchanged, so the
  // refusal happens once, in the process that owns execution.
  const rejected = desktopRuntimeEnvironment({
    env: { FLOWCREDIT_WORKER_BACKEND: "codex-exec", [CODEX_EXECUTABLE_ENV]: "relative/codex" },
    discovery: { backendType: "codex-exec", available: false, resolvedPath: null },
  });
  assert.equal(rejected[CODEX_EXECUTABLE_ENV], "relative/codex");

  // Execution configuration passes through by declaration, never as a blob.
  const configured = desktopRuntimeEnvironment({
    env: {
      FLOWCREDIT_WORKER_BACKEND: "codex-exec",
      FLOWCREDIT_CODEX_REPO: "/tmp/repo",
      FLOWCREDIT_WORKER_TIMEOUT_MS: "60000",
      AWS_SECRET_ACCESS_KEY: "never-forwarded",
    },
    discovery,
  });
  assert.equal(configured.FLOWCREDIT_CODEX_REPO, "/tmp/repo");
  assert.equal(configured.FLOWCREDIT_WORKER_TIMEOUT_MS, "60000");
  assert.equal("AWS_SECRET_ACCESS_KEY" in configured, false, "undeclared variables are not forwarded");

  // A discovery result can never select a backend on its own.
  const other = desktopRuntimeEnvironment({
    env: { FLOWCREDIT_WORKER_BACKEND: "test-worker" },
    discovery,
  });
  assert.equal(other.FLOWCREDIT_WORKER_BACKEND, "test-worker");
  assert.equal(CODEX_EXECUTABLE_ENV in other, false);
});

test("environment diagnostics are bounded and redact anything credential-shaped", () => {
  const facts = boundedEnvironmentFacts({
    env: {
      PATH: "/usr/bin:/opt/GITHUB_TOKEN=<value>:/bin:/opt/API_KEY_DIR",
      HOME: "/Users/example",
      USER: "example",
      SHELL: "/bin/zsh",
      TMPDIR: "/tmp/example/",
    },
  });

  assert.equal(facts.pathEntryCount, 4, "the count still describes the real environment");
  assert.equal(facts.path.includes("<value>"), false, "a credential-shaped entry is removed whole");
  assert.equal(facts.path.includes("GITHUB_TOKEN"), false);
  assert.equal(facts.path.includes("API_KEY_DIR"), false);
  assert.match(facts.path, /<redacted>/);
  assert.match(facts.path, /\/usr\/bin/);
  assert.equal(facts.home, "set");
  assert.equal(facts.user, "set");
  assert.equal(facts.shell, "/bin/zsh");
  assert.equal(facts.tmpdir, "set");

  const described = describeEnvironmentFacts(facts);
  assert.equal(described.includes("<value>"), false);
  assert.match(described, /pathEntries=4/);

  assert.equal(redactPathValue(undefined), "");
  assert.equal(redactPathValue("/usr/bin:/bin"), "/usr/bin:/bin");
  assert.equal(redactPathValue("/Users/example/has a space"), "/Users/example/has a space");
  assert.match(redactPathValue(`/usr/bin:${"/x".repeat(400)}`), /…\(truncated\)$/);
});

test("the composed configuration is what the Runtime process actually receives", async () => {
  const dir = sandbox();
  const startFixture = async (name, env) => {
    const dump = join(dir, `${name}.json`);
    const lifecycle = new RuntimeLifecycle({
      entry: FIXTURE,
      cwd: ROOT,
      dataDir: join(dir, `${name}-state`),
      env: { ...env, RELAY_CODE_FIXTURE_ENV_DUMP: dump },
      onStdout: () => {},
      onStderr: () => {},
    });
    const started = await lifecycle.start();
    try {
      return JSON.parse(readFileSync(dump, "utf8"));
    } finally {
      await lifecycle.stop();
      assert.equal(started.health.status, "ok");
    }
  };

  const codexRun = await startFixture(
    "codex",
    desktopRuntimeEnvironment({
      env: {
        FLOWCREDIT_WORKER_BACKEND: "codex-exec",
        FLOWCREDIT_COORDINATION: "driver",
        FLOWCREDIT_CODEX_REPO: "/tmp/fixture-repo",
      },
      discovery,
    }),
  );
  assert.equal(codexRun.FLOWCREDIT_WORKER_BACKEND, "codex-exec");
  assert.equal(codexRun.FLOWCREDIT_COORDINATION, "driver");
  assert.equal(codexRun.FLOWCREDIT_CODEX_BIN, "/opt/example/real/bin/codex");
  assert.equal(codexRun.FLOWCREDIT_CODEX_REPO, "/tmp/fixture-repo");

  const defaultRun = await startFixture("default", desktopRuntimeEnvironment({ env: {}, discovery }));
  assert.equal(defaultRun.FLOWCREDIT_WORKER_BACKEND, "off");
  assert.equal(defaultRun.FLOWCREDIT_CODEX_BIN, null, "an unselected backend is never configured");
});

test("the Runtime consumes the path through the adapter's own command seam", () => {
  const server = readFileSync(join(ROOT, "apps/runtime/server.mjs"), "utf8");
  assert.match(server, /const configured = process\.env\.FLOWCREDIT_CODEX_BIN/);
  assert.match(server, /validateCodexExecutablePath\(configured\)/);
  assert.match(server, /discoverCodexVersion\(\{ codexCommand \}\)/);
  assert.match(server, /createCodexExecAdapter\(\{\s*codexCommand,/);
  assert.match(server, /DEFAULT_CODEX_COMMAND/, "the non-Desktop default stays the plain codex name");

  // The adapter asks the process for its version — never a shell, never a
  // string command — so an absolute path is the whole difference.
  const adapter = readFileSync(join(ROOT, "packages/harness/adapters/codex-exec.mjs"), "utf8");
  assert.match(adapter, /spawn\(codexCommand\[0\], argv/);
  assert.equal(adapter.includes("shell: true"), false);
});

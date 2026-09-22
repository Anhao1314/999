import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { isRuntimeUrl, isSafeExternalUrl } from "../../apps/desktop/src/navigation-policy.mjs";
import {
  desktopRuntimeDataDir,
  runtimeStateDirectoryName,
} from "../../apps/desktop/src/desktop-paths.mjs";
import { RuntimeLifecycle } from "../../apps/desktop/src/runtime-lifecycle.mjs";

const FIXTURE = fileURLToPath(
  new URL("../support/desktop-runtime-fixture.mjs", import.meta.url),
);
const CWD = fileURLToPath(new URL("../../", import.meta.url));

test("desktop package pins the verified Electron toolchain and product identity", async () => {
  const pkg = JSON.parse(
    await readFile(new URL("../../apps/desktop/package.json", import.meta.url), "utf8"),
  );
  assert.equal(pkg.productName, "Relay Code");
  assert.equal(pkg.main, "src/main.mjs");
  assert.equal(pkg.devDependencies.electron, "44.4.3");
  assert.equal(pkg.devDependencies["@electron/packager"], "20.3.0");
});

test("desktop shell keeps secure window and Runtime process ownership boundaries", async () => {
  const main = await readFile(
    new URL("../../apps/desktop/src/main.mjs", import.meta.url),
    "utf8",
  );
  const lifecycle = await readFile(
    new URL("../../apps/desktop/src/runtime-lifecycle.mjs", import.meta.url),
    "utf8",
  );
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /requestSingleInstanceLock/);
  assert.match(main, /app\.getPath\("userData"\)/);
  assert.match(lifecycle, /ELECTRON_RUN_AS_NODE: "1"/);
  assert.match(lifecycle, /FLOWCREDIT_PORT: "0"/);
});

test("desktop Runtime lifecycle uses an ephemeral loopback port and stops cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-code-runtime-lifecycle-"));
  const first = new RuntimeLifecycle({
    entry: FIXTURE,
    cwd: CWD,
    dataDir: join(root, "one"),
    onStdout: () => {},
    onStderr: () => {},
  });
  const second = new RuntimeLifecycle({
    entry: FIXTURE,
    cwd: CWD,
    dataDir: join(root, "two"),
    onStdout: () => {},
    onStderr: () => {},
  });

  try {
    const firstReady = await first.start();
    const secondReady = await second.start();
    assert.ok(firstReady.port > 0);
    assert.ok(secondReady.port > 0);
    assert.notEqual(firstReady.port, secondReady.port);

    const health = await fetch(`${firstReady.baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    assert.deepEqual(firstReady.health, { status: "ok" });
    assert.deepEqual(first.health, { status: "ok" });

    const firstPid = firstReady.pid;
    const firstExit = await first.stop();
    assert.equal(firstExit.code, 0);
    assert.equal(firstExit.signal, null);
    assert.equal(first.running, false);
    assert.throws(() => process.kill(firstPid, 0), { code: "ESRCH" });
  } finally {
    await first.stop();
    await second.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop Runtime lifecycle rejects a bound but unhealthy Runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-code-runtime-unhealthy-"));
  const lifecycle = new RuntimeLifecycle({
    entry: FIXTURE,
    cwd: CWD,
    dataDir: join(root, "state"),
    env: { RELAY_CODE_FIXTURE_HEALTH: "degraded" },
    onStdout: () => {},
    onStderr: () => {},
  });

  try {
    await assert.rejects(() => lifecycle.start(), /health probe returned HTTP 503/);
    assert.equal(lifecycle.running, false);
    assert.equal(lifecycle.health, null);
  } finally {
    await lifecycle.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop Runtime state stays under userData and separates dev from packaged", () => {
  const userDataPath = join(tmpdir(), "relay-code-user-data");
  assert.equal(runtimeStateDirectoryName(true), "runtime");
  assert.equal(runtimeStateDirectoryName(false), "runtime-dev");
  assert.equal(
    desktopRuntimeDataDir({ userDataPath, isPackaged: true }),
    join(userDataPath, "runtime"),
  );
  assert.equal(
    desktopRuntimeDataDir({ userDataPath, isPackaged: false }),
    join(userDataPath, "runtime-dev"),
  );
  assert.notEqual(
    desktopRuntimeDataDir({ userDataPath, isPackaged: true }),
    desktopRuntimeDataDir({ userDataPath, isPackaged: false }),
  );
  assert.throws(() => desktopRuntimeDataDir({}), /userData/);
});

test("desktop navigation accepts only the active Runtime origin", () => {
  const base = "http://127.0.0.1:43210";
  assert.equal(isRuntimeUrl(`${base}/workspace`, base), true);
  assert.equal(isRuntimeUrl(`${base}/employees`, base), true);
  assert.equal(isRuntimeUrl("http://localhost:43210/workspace", base), false);
  assert.equal(isRuntimeUrl("https://127.0.0.1:43210/workspace", base), false);
  assert.equal(isRuntimeUrl("https://example.invalid/workspace", base), false);
  assert.equal(isRuntimeUrl("file:///tmp/workspace.html", base), false);
  assert.equal(isSafeExternalUrl("https://example.com/"), true);
  assert.equal(isSafeExternalUrl("file:///tmp/secret"), false);
  assert.equal(isSafeExternalUrl("javascript:alert(1)"), false);
});

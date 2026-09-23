import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync as readSource } from "node:fs";
import { LocalSecretStore } from "../../apps/desktop/src/local-secret-store.mjs";
import { createJevSettingsController } from "../../apps/desktop/src/jev-settings-controller.mjs";
import { createMemorySecretProvider, createProcessSecretProvider } from "../../packages/runtime/secret-provider.mjs";
import { createJevSenseBackend } from "../../packages/runtime/jev-sense-backend.mjs";
import { RELAY_SENSE_QUESTIONS } from "../../packages/runtime/relay-sense.mjs";

const NAME = "relay-sense.jev";
const KEY_A = "synthetic-secret-alpha";
const KEY_B = "synthetic-secret-bravo";

function fakeSafeStorage() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString(bytes) {
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString();
    },
  };
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "relay-secret-store-"));
  const safeStorage = fakeSafeStorage();
  return {
    dir,
    store: new LocalSecretStore({ userDataPath: dir, safeStorage, platform: "darwin" }),
    reopen: () => new LocalSecretStore({ userDataPath: dir, safeStorage, platform: "darwin" }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("encrypted blob survives a new Desktop store instance, supports replacement and deletion", async () => {
  const f = fixture();
  try {
    assert.equal(await f.store.hasSecret(NAME), false);
    await f.store.setSecret(NAME, KEY_A);
    const blob = readFileSync(f.store.path(NAME));
    assert.equal(blob.includes(Buffer.from(KEY_A)), false);
    assert.equal(statSync(f.store.path(NAME)).mode & 0o777, 0o600);
    const nextLaunch = f.reopen();
    assert.equal(await nextLaunch.hasSecret(NAME), true);
    assert.equal(await nextLaunch.getSecret(NAME), KEY_A);
    await nextLaunch.setSecret(NAME, KEY_B);
    assert.equal(await f.store.getSecret(NAME), KEY_B);
    assert.equal(readFileSync(f.store.path(NAME)).includes(Buffer.from(KEY_B)), false);
    await f.store.deleteSecret(NAME);
    assert.equal(await nextLaunch.hasSecret(NAME), false);
    assert.equal(await nextLaunch.getSecret(NAME), null);
  } finally { f.cleanup(); }
});

test("secure storage unavailable or Linux basic_text fails closed without writing a blob", async () => {
  const f = fixture();
  try {
    for (const store of [
      new LocalSecretStore({ userDataPath: f.dir, platform: "darwin",
        safeStorage: { isEncryptionAvailable: () => false } }),
      new LocalSecretStore({ userDataPath: f.dir, platform: "linux",
        safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "basic_text" } }),
    ]) {
      assert.equal(store.available(), false);
      await assert.rejects(store.setSecret(NAME, KEY_A), /SECURE_STORAGE_UNAVAILABLE/);
      await assert.rejects(store.getSecret(NAME), /SECURE_STORAGE_UNAVAILABLE/);
    }
    assert.equal(await f.store.hasSecret(NAME), false);
  } finally { f.cleanup(); }
});

test("store names are generic and independent from the first Jev consumer", async () => {
  const f = fixture();
  try {
    await f.store.setSecret(NAME, KEY_A);
    await f.store.setSecret("model.provider", "synthetic provider password with spaces");
    assert.notEqual(f.store.path(NAME), f.store.path("model.provider"));
    assert.equal(f.store.path("model.provider").includes("model.provider"), false);
    assert.equal(await f.store.getSecret("model.provider"), "synthetic provider password with spaces");
    await f.store.deleteSecret(NAME);
    assert.equal(await f.store.hasSecret("model.provider"), true);
  } finally { f.cleanup(); }
});

test("settings return status only, restart loads the new key, and removal clears active Runtime", async () => {
  const f = fixture();
  let runtimeProvider = createMemorySecretProvider();
  let restarts = 0;
  const seen = [];
  const controller = createJevSettingsController({ store: f.store,
    restartRuntime: async () => {
      restarts += 1;
      runtimeProvider = createMemorySecretProvider({ [NAME]: await f.store.getSecret(NAME) });
    },
    fetchImpl: async (_url, options) => {
      seen.push(options.headers.authorization);
      return new Response(JSON.stringify({ models: [] }), { status: seen.length === 1 ? 200 : 401 });
    },
  });
  try {
    assert.deepEqual(await controller.status(), { status: "NOT_CONFIGURED", configured: false });
    const saved = await controller.save(KEY_A);
    assert.deepEqual(saved, { status: "CONFIGURED", configured: true });
    assert.equal(JSON.stringify(saved).includes(KEY_A), false);
    assert.equal(runtimeProvider.get(NAME), KEY_A);
    assert.equal((await controller.test()).status, "CONNECTED");
    assert.equal(seen[0], `Bearer ${KEY_A}`);
    assert.equal((await controller.save(KEY_B)).status, "CONFIGURED");
    assert.equal(runtimeProvider.get(NAME), KEY_B);
    assert.equal((await controller.test()).status, "INVALID");
    const removed = await controller.remove();
    assert.deepEqual(removed, { status: "NOT_CONFIGURED", configured: false });
    assert.equal(runtimeProvider.get(NAME), null);
    assert.equal(restarts, 3);
    assert.equal((await controller.test()).status, "NOT_CONFIGURED");
    assert.equal(JSON.stringify({ saved, removed }).includes(KEY_B), false);
  } finally { f.cleanup(); }
});

test("Runtime startup handoff consumes the environment credential into memory only", () => {
  const env = { TYPESAFE_API_KEY: KEY_A };
  const provider = createProcessSecretProvider(env);
  assert.equal(provider.get(NAME), KEY_A);
  assert.equal(Object.hasOwn(env, "TYPESAFE_API_KEY"), false);
  assert.equal(Object.keys(provider).includes(KEY_A), false);
});

test("a second app launch can decrypt and use the same stored key without re-entry", async () => {
  const f = fixture();
  const requests = [];
  try {
    await f.store.setSecret(NAME, KEY_A);
    // New store/controller/backend objects stand in for a fresh Desktop and
    // Runtime process. The only durable input is the encrypted blob.
    const secondLaunch = f.reopen();
    const provider = createMemorySecretProvider({ [NAME]: await secondLaunch.getSecret(NAME) });
    const backend = createJevSenseBackend({ secretProvider: provider,
      fetchImpl: async (_url, options) => {
        requests.push(options.headers.authorization);
        const answers = Object.fromEntries(Object.entries(RELAY_SENSE_QUESTIONS).map(([name, question]) =>
          [name, question.type === "noul" ? { type: "noul", noul: 0.5 } :
            { type: "choice", choice: Object.keys(question.criteria)[0] }]));
        return new Response(JSON.stringify({ model: "jev-test", answers }), { status: 200 });
      },
    });
    assert.equal((await backend.sense({})).model, "jev-test");
    assert.deepEqual(requests, [`Bearer ${KEY_A}`]);
    assert.equal(JSON.stringify(provider).includes(KEY_A), false);
  } finally { f.cleanup(); }
});

test("Jev asks provider on every invocation and never caches a removed key", async () => {
  let key = KEY_A;
  const headers = [];
  const backend = createJevSenseBackend({ secretProvider: { get: () => key },
    fetchImpl: async (_url, options) => {
      headers.push(options.headers.authorization);
      return new Response(JSON.stringify({ model: "jev-test", answers: {} }), { status: 200 });
    },
  });
  await assert.rejects(backend.sense({}), /answer|response|typed/i);
  key = KEY_B;
  await assert.rejects(backend.sense({}), /answer|response|typed/i);
  key = null;
  await assert.rejects(backend.sense({}), /credential unavailable/);
  assert.deepEqual(headers, [`Bearer ${KEY_A}`, `Bearer ${KEY_B}`]);
});

test("renderer bridge exposes fixed operations, no secret read or browser storage", () => {
  const preload = readSource(new URL("../../apps/desktop/src/settings-preload.cjs", import.meta.url), "utf8");
  const ui = readSource(new URL("../../apps/desktop/src/settings-ui.js", import.meta.url), "utf8");
  const main = readSource(new URL("../../apps/desktop/src/main.mjs", import.meta.url), "utf8");
  assert.match(preload, /relay-jev-status/);
  assert.match(preload, /relay-jev-save/);
  assert.match(preload, /relay-jev-remove/);
  assert.match(preload, /relay-jev-test/);
  assert.doesNotMatch(preload, /getSecret|readAllSecrets|getJevApiKey/);
  assert.doesNotMatch(ui, /localStorage|sessionStorage/);
  assert.match(main, /event\.sender === settingsWindow\.webContents/);
  assert.match(main, /event\.senderFrame\?\.url ===/);
});

// Process harness for the Persistent Work Kernel runtime app.
//
// Starts `apps/runtime/server.mjs` as a real child process on an ephemeral
// loopback port and gives tests and the demonstration a way to stop it
// gracefully or kill it hard. Shared by tests/integration/restart.test.mjs and
// scripts/demo-work-kernel.mjs / scripts/demo-workforce-v0b1.mjs.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Milestone-neutral on purpose: the ready line names the product, never a
// milestone, so every later milestone can reuse this harness unchanged.
const READY_PATTERN = /FlowCredit runtime ready on http:\/\/127\.0\.0\.1:(\d+)/;

export function repoRoot() {
  return fileURLToPath(new URL("../../", import.meta.url));
}

export async function startRuntime({ dir, timeoutMs = 15000 } = {}) {
  if (!dir) throw new Error("startRuntime requires a store directory");
  const child = spawn(process.execPath, ["apps/runtime/server.mjs"], {
    cwd: repoRoot(),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      FLOWCREDIT_PORT: "0",
      FLOWCREDIT_RUNTIME_DIR: dir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `runtime did not become ready within ${timeoutMs}ms\nstdout: ${stdout}\nstderr: ${stderr}`,
        ),
      );
    }, timeoutMs);
    const inspect = () => {
      const match = stdout.match(READY_PATTERN);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    };
    child.stdout.on("data", inspect);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(
        new Error(
          `runtime exited before it was ready (code ${code}, signal ${signal})\nstderr: ${stderr}`,
        ),
      );
    });
  });

  const base = `http://127.0.0.1:${port}`;

  const request = async (path, init) => {
    const response = await fetch(base + path, init);
    const payload = await response.json();
    if (!response.ok)
      throw Object.assign(
        new Error(
          `${path} → ${response.status} ${payload?.error?.code ?? ""} ${payload?.error?.message ?? ""}`,
        ),
        { code: payload?.error?.code ?? "HTTP_ERROR", status: response.status },
      );
    return payload;
  };

  const waitForExit = () =>
    new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null)
        return resolve({ code: child.exitCode, signal: child.signalCode });
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

  return {
    base,
    port,
    child,
    output: () => stdout,
    errors: () => stderr,
    json: (path) => request(path),
    command: (command, input = {}) =>
      request("/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command, input }),
      }).then((payload) => payload.result),
    stop: async () => {
      const exit = waitForExit();
      child.kill("SIGTERM");
      return exit;
    },
    crash: async () => {
      const exit = waitForExit();
      child.kill("SIGKILL");
      return exit;
    },
  };
}

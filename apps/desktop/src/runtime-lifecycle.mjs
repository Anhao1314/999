import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";

const READY_PATTERN =
  /FlowCredit runtime ready on (http:\/\/127\.0\.0\.1:(\d+))/;

const DEFAULT_READY_TIMEOUT_MS = 20_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;

async function verifyHealth(baseUrl, timeoutMs) {
  let response;
  try {
    response = await fetch(`${baseUrl}/health`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`FlowCredit Runtime health probe failed: ${error?.message ?? error}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`FlowCredit Runtime health probe returned HTTP ${response.status}`);
  }
  if (!response.ok || payload?.status !== "ok")
    throw new Error(`FlowCredit Runtime health probe returned HTTP ${response.status}`);
  return payload;
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

export class RuntimeLifecycle {
  constructor({
    entry,
    cwd,
    dataDir,
    execPath = process.execPath,
    env = {},
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
    healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
    stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
    onUnexpectedExit = null,
    onStdout = (chunk) => process.stdout.write(chunk),
    onStderr = (chunk) => process.stderr.write(chunk),
  }) {
    if (!entry) throw new Error("RuntimeLifecycle requires a runtime entry");
    if (!cwd) throw new Error("RuntimeLifecycle requires a runtime cwd");
    if (!dataDir) throw new Error("RuntimeLifecycle requires a Runtime data directory");

    this.entry = entry;
    this.cwd = cwd;
    this.dataDir = dataDir;
    this.execPath = execPath;
    this.env = env;
    this.readyTimeoutMs = readyTimeoutMs;
    this.healthTimeoutMs = healthTimeoutMs;
    this.stopTimeoutMs = stopTimeoutMs;
    this.onUnexpectedExit = onUnexpectedExit;
    this.onStdout = onStdout;
    this.onStderr = onStderr;

    this.child = null;
    this.baseUrl = null;
    this.port = null;
    this.health = null;
    this.stopping = false;
  }

  get pid() {
    return this.child?.pid ?? null;
  }

  get running() {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null;
  }

  async start() {
    if (this.child) throw new Error("FlowCredit Runtime lifecycle already started");
    await mkdir(this.dataDir, { recursive: true });

    const child = spawn(this.execPath, [this.entry], {
      cwd: this.cwd,
      env: {
        ...process.env,
        ...this.env,
        ELECTRON_RUN_AS_NODE: "1",
        FLOWCREDIT_PORT: "0",
        FLOWCREDIT_RUNTIME_DIR: this.dataDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;

    let stdout = "";
    let stderr = "";
    let settled = false;

    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(
          new Error(
            `FlowCredit Runtime did not become ready within ${this.readyTimeoutMs}ms\nstdout: ${stdout}\nstderr: ${stderr}`,
          ),
        );
      }, this.readyTimeoutMs);

      const inspect = () => {
        const match = stdout.match(READY_PATTERN);
        if (!match || settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ baseUrl: match[1], port: Number(match[2]) });
      };

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
        this.onStdout(chunk);
        inspect();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        this.onStderr(chunk);
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        this.child = null;
        this.baseUrl = null;
        this.port = null;
        this.health = null;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(
            new Error(
              `FlowCredit Runtime exited before it was ready (code ${code}, signal ${signal})\nstdout: ${stdout}\nstderr: ${stderr}`,
            ),
          );
          return;
        }
        if (!this.stopping) {
          this.onUnexpectedExit?.({ code, signal, stdout, stderr });
        }
      });
    });

    try {
      const result = await ready;
      this.baseUrl = result.baseUrl;
      this.port = result.port;
      const health = await verifyHealth(result.baseUrl, this.healthTimeoutMs);
      this.health = health;
      return { ...result, health, pid: child.pid };
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop() {
    const child = this.child;
    if (!child) return null;

    this.stopping = true;
    const exited = waitForExit(child);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");

    let timer;
    const graceful = await Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), this.stopTimeoutMs);
      }),
    ]);
    clearTimeout(timer);

    let result = graceful;
    if (result === null && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      result = await exited;
    }

    this.stopping = false;
    this.child = null;
    this.baseUrl = null;
    this.port = null;
    this.health = null;
    return result;
  }
}

// codex-exec — the first real production Worker backend.
// Contract: docs/contracts/codex-exec-adapter-v1.md.
//
// It implements the frozen WorkerAdapter v0 contract (manifest/start/events/
// wait/cancel) around one local `codex exec` child process, exactly one fresh
// process per WorkerRun. It has zero Runtime authority: it cannot assign,
// start, complete, review, repair or accept anything; it reports what happened
// and the WorkerHost decides what that means.
//
// Two backend concerns live here because the frozen Harness leaves them to the
// real adapter (worker-harness-v0 §20):
//
//   Git workspace provisioning — a detached `git worktree` of the base
//   repository at the exact base revision. The base checkout is never touched,
//   no commit is created and no push is possible.
//
//   Independent verification — after the child exits, the adapter observes the
//   workspace itself (git evidence, protected paths, a configured verification
//   command) before anything is reported as a delivery. A failure maps through
//   the existing interruption vocabulary; the frozen Host has no verification
//   seam of its own (recorded as a limitation, not redesigned).
import { spawn } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { BOUNDS, digestOf } from "../../work/records.mjs";
import { newWorkerEvent } from "../events.mjs";
import { HARNESS_BOUNDS } from "../result.mjs";
import { RESULT_CONTRACT_KINDS } from "../worker-run-input.mjs";
import { createCodexStreamMapper, parseCodexFinalMessage } from "./codex-exec-events.mjs";
import { codexReportSchemaFor, compileCodexPrompt } from "./codex-exec-prompt.mjs";

export const CODEX_EXEC_ADAPTER_TYPE = "codex-exec";
export const DEFAULT_CODEX_COMMAND = Object.freeze(["codex"]);
export const DEFAULT_VERIFICATION_TIMEOUT_MS = 120_000;
export const CODEX_SANDBOX_MODE = "workspace-write";

const MAX_STDERR_BYTES = 8192;
const MAX_GIT_OUTPUT_BYTES = 512 * 1024;
const MAX_CHANGED_FILES_RECORDED = 50;
const MAX_STDOUT_REMAINDER_BYTES = 1024 * 1024;

// Bounded wait for a SIGKILLed child to be reported gone by the kernel, on top
// of the configured SIGTERM grace. Cancellation never returns before this
// bound, so a WorkerHost stop cannot leave an unreaped orphan behind.
const CANCEL_SIGKILL_WAIT_MS = 2000;

// The adapter's honest self-description: what the backend actually enforces,
// never what someone wished it enforced.
const KNOWN_LIMITATIONS = Object.freeze([
  "the Codex CLI sandbox (workspace-write) is not proven OS-level containment; H0 observed writes outside the assigned workspace",
  "no network policy is enforced by this adapter; the child inherits the host environment",
  "TMPDIR, TMP and TEMP point at the run scratch directory by intent, not by proof",
]);

const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const bound = (text, max) => (typeof text === "string" ? text.slice(0, max) : null);

function runCommand(command, args, { cwd = undefined, env = undefined, timeoutMs = 60_000, maxOutputBytes = 256 * 1024, stdin = null } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // best effort
      }
    }, timeoutMs);
    timer.unref?.();
    const finish = (exitCode, signal, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command,
        args,
        exitCode,
        signal: signal ?? null,
        error,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
      });
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length >= maxOutputBytes) {
        stdoutTruncated = true;
        return;
      }
      stdout += chunk.length > maxOutputBytes ? chunk.slice(0, maxOutputBytes) : chunk;
      if (stdout.length > maxOutputBytes) {
        stdout = stdout.slice(0, maxOutputBytes);
        stdoutTruncated = true;
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length >= maxOutputBytes) {
        stderrTruncated = true;
        return;
      }
      stderr += chunk.length > maxOutputBytes ? chunk.slice(0, maxOutputBytes) : chunk;
      if (stderr.length > maxOutputBytes) {
        stderr = stderr.slice(0, maxOutputBytes);
        stderrTruncated = true;
      }
    });
    child.once("error", (error) => finish(null, null, error?.message ?? String(error)));
    child.once("close", (code, signal) => finish(code, signal));
    if (child.stdin) {
      child.stdin.on("error", () => {});
      if (stdin !== null) child.stdin.end(stdin, "utf8");
      else child.stdin.end();
    }
  });
}

async function git(cwd, args, { timeoutMs = 60_000 } = {}) {
  return runCommand("git", args, { cwd, timeoutMs, maxOutputBytes: MAX_GIT_OUTPUT_BYTES });
}

async function gitOrFail(cwd, args, what) {
  const result = await git(cwd, args);
  if (result.exitCode !== 0)
    throw new Error(
      `codex-exec could not ${what}: git ${args.join(" ")} exited ${result.exitCode ?? "null"} ${bound(
        result.stderr.trim(),
        300,
      )}`,
    );
  return result;
}

// The narrow, provider-specific executable seam this backend accepts. An
// absolute path is the only shape allowed: no PATH search, no shell parsing,
// no argv embedded in a string, no profile sourcing. The resolved real path
// is what callers spawn, so a package-manager or app-bundle symlink stays
// legal while a regular non-executable file or a directory never is.
export function validateCodexExecutablePath(value) {
  const label = typeof value === "string" ? value.slice(0, 200) : String(value).slice(0, 200);
  if (typeof value !== "string" || value.length === 0)
    throw new Error("a Codex executable path must be a non-empty absolute path");
  if (value.includes("\0") || /[\r\n]/.test(value))
    throw new Error("a Codex executable path must not contain control characters");
  if (!isAbsolute(value))
    throw new Error(`the Codex executable path must be absolute: ${label}`);
  let stats = null;
  try {
    stats = statSync(value);
  } catch {
    throw new Error(`the Codex executable does not exist: ${label}`);
  }
  if (!stats.isFile())
    throw new Error(`the Codex executable is not a regular file: ${label}`);
  try {
    accessSync(value, fsConstants.X_OK);
  } catch {
    throw new Error(`the Codex executable is not executable: ${label}`);
  }
  let resolvedPath = null;
  try {
    resolvedPath = realpathSync(value);
  } catch {
    throw new Error(`the Codex executable path cannot be resolved: ${label}`);
  }
  return Object.freeze({ executablePath: value, resolvedPath });
}

export async function discoverCodexVersion({ codexCommand = DEFAULT_CODEX_COMMAND } = {}) {
  if (!Array.isArray(codexCommand) || codexCommand.length === 0 || codexCommand.some((part) => typeof part !== "string" || part.length === 0))
    throw new Error("codexCommand must be a non-empty argv prefix");
  const result = await runCommand(codexCommand[0], [...codexCommand.slice(1), "--version"], {
    timeoutMs: 15_000,
    maxOutputBytes: 64 * 1024,
  });
  if (result.exitCode !== 0 || result.timedOut) return null;
  const line = result.stdout.split("\n").map((entry) => entry.trim()).find((entry) => entry.length > 0) ?? "";
  const match = line.match(/codex-cli\s+(\S+)/);
  const version = (match ? match[1] : line).trim();
  if (version.length === 0 || version.length > BOUNDS.backendVersionMax) return null;
  return version;
}

// The exact argv shape this backend runs, for documentation and tests:
//   codex exec --json --ephemeral --color never --cd <workspace>
//     --sandbox workspace-write --output-schema <scratch>/result-schema.json
//     --output-last-message <scratch>/last-message.txt -
// The prompt goes over stdin, so no shell interpolation and no argv size
// limits; the child runs with cwd = workspaceRoot.
function buildCodexArgv({ codexCommand, workspaceRoot, schemaPath, lastMessagePath }) {
  return [
    ...codexCommand.slice(1),
    "exec",
    "--json",
    "--ephemeral",
    "--color",
    "never",
    "--cd",
    workspaceRoot,
    "--sandbox",
    CODEX_SANDBOX_MODE,
    "--output-schema",
    schemaPath,
    "--output-last-message",
    lastMessagePath,
    "-",
  ];
}

function createSignal() {
  let fire;
  let promise = new Promise((resolve) => {
    fire = resolve;
  });
  return {
    wait: () => promise,
    fire: () => {
      const resolve = fire;
      promise = new Promise((next) => {
        fire = next;
      });
      resolve();
    },
  };
}

function parseStatusPaths(statusText) {
  const files = [];
  for (const line of statusText.split("\n")) {
    if (line.trim().length === 0) continue;
    let path = line.slice(3).trim();
    if (path.includes(" -> ")) path = path.split(" -> ").at(-1).trim();
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    if (path.length > 0) files.push(bound(path, 400));
  }
  return files;
}

export function createCodexExecAdapter(options = {}) {
  const {
    codexCommand = DEFAULT_CODEX_COMMAND,
    baseRepository = null,
    baseRevision = null,
    verification = null,
    protectedPaths = [],
    evidenceDir = null,
    env = null,
    now = () => Date.now(),
    cancellationGraceMs = 3000,
  } = options;

  if (!Array.isArray(codexCommand) || codexCommand.length === 0 || codexCommand.some((part) => typeof part !== "string" || part.length === 0))
    throw new Error("codexCommand must be a non-empty argv prefix");
  if (verification !== null) {
    if (!isPlainObject(verification) || !Array.isArray(verification.command) || verification.command.length === 0)
      throw new Error("verification must be { command: [argv...] } when configured");
    if (verification.command.some((part) => typeof part !== "string" || part.length === 0))
      throw new Error("every verification command part must be a non-empty string");
  }
  if (!Array.isArray(protectedPaths) || protectedPaths.some((entry) => typeof entry !== "string" || entry.length === 0))
    throw new Error("protectedPaths must be a list of repository-relative paths");

  const handles = new Map();
  const observations = new Map();
  let cachedVersion = null;

  const verificationCommand = verification ? Object.freeze([...verification.command]) : null;
  const verificationTimeoutMs = verification?.timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;
  const protectedList = Object.freeze([...protectedPaths]);

  function childEnvironment(scratchRoot) {
    return {
      ...process.env,
      ...(env ?? {}),
      TMPDIR: scratchRoot,
      TMP: scratchRoot,
      TEMP: scratchRoot,
    };
  }

  async function provisionWorkspace({ workspaceRoot, revision }) {
    if (!baseRepository) throw new Error("codex-exec is not configured with a baseRepository");
    if (!existsSync(baseRepository)) throw new Error(`the configured baseRepository does not exist: ${baseRepository}`);
    if (existsSync(workspaceRoot)) {
      if (readdirSync(workspaceRoot).length > 0)
        throw new Error(`the run workspace is not empty and will not be reused: ${workspaceRoot}`);
    } else {
      mkdirSync(workspaceRoot, { recursive: true });
    }
    const resolved = await gitOrFail(baseRepository, ["rev-parse", "--verify", `${revision}^{commit}`], "resolve the base revision");
    const baseSha = resolved.stdout.trim();
    await gitOrFail(baseRepository, ["worktree", "add", "--detach", workspaceRoot, baseSha], "create the run worktree");
    const head = await gitOrFail(workspaceRoot, ["rev-parse", "HEAD"], "verify the run worktree");
    if (head.stdout.trim() !== baseSha)
      throw new Error(`the run workspace is at ${head.stdout.trim()}, not the requested base revision ${baseSha}`);
    return baseSha;
  }

  async function collectGitEvidence(handle) {
    const workspace = handle.workspaceRoot;
    const headResult = await git(workspace, ["rev-parse", "HEAD"]);
    const head = headResult.stdout.trim();
    const status = await git(workspace, ["status", "--porcelain"]);
    const changedFilesAll = parseStatusPaths(status.stdout);
    // Intent-to-add makes new files visible in the diff. The workspace is
    // disposable and run-scoped; this never runs against the base checkout.
    await git(workspace, ["add", "-N", "."]);
    const diff = await git(workspace, ["diff", handle.baseSha, "--"]);
    return Object.freeze({
      baseRevision: handle.baseSha,
      head,
      headUnchanged: head === handle.baseSha,
      statusTruncated: status.stdoutTruncated === true,
      changedFileCount: changedFilesAll.length,
      changedFiles: Object.freeze(changedFilesAll.slice(0, MAX_CHANGED_FILES_RECORDED)),
      diffText: diff.stdout,
      diffDigest: digestOf(diff.stdout),
      diffBytes: Buffer.byteLength(diff.stdout, "utf8"),
    });
  }

  async function checkProtectedPaths(handle) {
    const violated = [];
    for (const path of protectedList) {
      const status = await git(handle.workspaceRoot, ["status", "--porcelain", "--", path]);
      if (status.stdout.trim().length > 0) violated.push(path);
    }
    return Object.freeze({ checked: protectedList, violated: Object.freeze(violated) });
  }

  async function runVerification(handle) {
    if (!verificationCommand)
      return Object.freeze({
        status: "SKIPPED",
        command: Object.freeze([]),
        exitCode: null,
        signal: null,
        passed: null,
        timedOut: false,
        durationMs: 0,
        summary: "no verification command is configured for this backend",
      });
    const [command, ...args] = verificationCommand;
    const result = await runCommand(command, args, {
      cwd: handle.workspaceRoot,
      env: childEnvironment(handle.scratchRoot),
      timeoutMs: verificationTimeoutMs,
      maxOutputBytes: 64 * 1024,
    });
    const passed = result.exitCode === 0 && !result.timedOut;
    const tail = (result.stdout.trim() || result.stderr.trim() || "(no output)").slice(-400);
    return Object.freeze({
      status: "OBSERVED",
      command: verificationCommand,
      exitCode: result.exitCode,
      signal: result.signal,
      passed,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      summary: bound(
        `${verificationCommand.join(" ")} → exit ${result.exitCode ?? "killed"}${result.timedOut ? " (timeout)" : ""}: ${tail}`,
        HARNESS_BOUNDS.summaryMax,
      ),
    });
  }

  function readFinalMessage(handle) {
    let fromFile = null;
    try {
      if (existsSync(handle.lastMessagePath)) fromFile = readFileSync(handle.lastMessagePath, "utf8");
    } catch {
      fromFile = null;
    }
    if (typeof fromFile === "string" && fromFile.trim().length > 0)
      return { text: fromFile, source: "LAST_MESSAGE_FILE" };
    const fallback = handle.mapper.state.lastAgentMessage;
    if (typeof fallback === "string" && fallback.trim().length > 0)
      return { text: fallback, source: "AGENT_MESSAGE_FALLBACK" };
    return { text: "", source: "NONE" };
  }

  function composeCandidate(handle, parsed, gitEvidence) {
    if (handle.role === "review") {
      for (const key of Object.keys(parsed))
        if (!["verdict", "findings", "summary"].includes(key))
          return { kind: "REFUSED", reason: `the final message carried fields outside the review schema: ${key}` };
      return {
        kind: "CANDIDATE",
        candidate: {
          schemaVersion: 1,
          workerRunId: handle.workerRunId,
          generation: handle.generation,
          verdict: parsed.verdict,
          findings: parsed.findings ?? [],
          summary: parsed.summary,
        },
      };
    }
    for (const key of Object.keys(parsed))
      if (!["outcome", "summary", "completionClaim", "reportedVerification", "blockers"].includes(key))
        return { kind: "REFUSED", reason: `the final message carried fields outside the result schema: ${key}` };
    let proposedArtifacts = [];
    if (parsed.outcome === "SUCCEEDED") {
      if (Buffer.byteLength(gitEvidence.diffText, "utf8") > HARNESS_BOUNDS.artifactContentMax)
        return {
          kind: "FAILURE",
          failureReason: "HARNESS_ARTIFACT_TOO_LARGE",
          reason: `the workspace diff exceeds the harness artifact bound (${gitEvidence.diffBytes} bytes)`,
        };
      const title = `Patch: ${handle.input.workPacket?.task?.title ?? "execution"}`;
      proposedArtifacts = [
        {
          kind: "patch",
          title: title.slice(0, BOUNDS.artifactTitleMax),
          content: gitEvidence.diffText,
        },
      ];
    }
    return {
      kind: "CANDIDATE",
      candidate: {
        resultVersion: 1,
        outcome: parsed.outcome,
        summary: parsed.summary,
        completionClaim: parsed.completionClaim ?? null,
        reportedVerification: parsed.reportedVerification ?? null,
        blockers: parsed.blockers ?? [],
        proposedArtifacts,
        suggestedNextActions: [],
      },
    };
  }

  function buildObservation(handle, { processEvidence, gitEvidence, protectedResult, verificationResult, result, terminal }) {
    const state = handle.mapper.state;
    const eventKinds = [...new Set(handle.events.map((event) => event.kind))];
    return Object.freeze({
      observationVersion: 1,
      workerRunId: handle.workerRunId,
      generation: handle.generation,
      taskId: handle.taskId,
      role: handle.role,
      backend: Object.freeze({ type: CODEX_EXEC_ADAPTER_TYPE, version: handle.adapterVersion }),
      process: Object.freeze({ ...processEvidence }),
      session: Object.freeze({ externalSessionRef: state.externalSessionRef }),
      events: Object.freeze({
        count: handle.events.length,
        kinds: Object.freeze(eventKinds),
        toolExecutions: state.toolExecutions,
        agentMessages: state.agentMessages,
        reasoningItems: state.reasoningItems,
        errorItems: state.errorItems,
        unknownItems: state.unknownItems,
        unknownEventTypes: state.unknownEventTypes,
        malformedLines: state.malformedLines,
        firstError: state.firstError,
        usage: state.usage,
        sawTurnCompleted: state.sawTurnCompleted,
        stderrTail: bound(handle.stderr.trim(), 2000),
        stdoutBytes: handle.stdoutBytes,
        stderrBytes: handle.stderrBytes,
      }),
      git: gitEvidence,
      protectedPaths: protectedResult,
      verification: verificationResult,
      result: Object.freeze({
        parse: result.method,
        rawDigest: result.rawDigest,
        finalMessageSource: handle.finalMessageSource,
        candidateReason: result.candidateReason ?? null,
      }),
      containment: Object.freeze({
        sandboxMode: CODEX_SANDBOX_MODE,
        workspaceRoot: handle.workspaceRoot,
        scratchRoot: handle.scratchRoot,
        knownLimitations: KNOWN_LIMITATIONS,
      }),
      terminal: Object.freeze({ ...terminal }),
      observedAt: new Date(now()).toISOString(),
    });
  }

  function adapterMetaFor(handle, observation) {
    const meta = {
      adapter: CODEX_EXEC_ADAPTER_TYPE,
      backendVersion: handle.adapterVersion,
      parse: observation.result.parse,
      rawDigest: observation.result.rawDigest,
      externalSessionRef: observation.session.externalSessionRef,
      durationMs: observation.process.durationMs,
      changedFileCount: observation.git?.changedFileCount ?? 0,
      diffDigest: observation.git?.diffDigest ?? null,
      verification: {
        status: observation.verification.status,
        passed: observation.verification.passed,
        exitCode: observation.verification.exitCode,
      },
    };
    if (observation.terminal.failureReason) meta.failureReason = observation.terminal.failureReason;
    if (observation.result.candidateReason) meta.candidateReason = bound(observation.result.candidateReason, 300);
    return meta;
  }

  function persistEvidence(handle, observation) {
    if (!evidenceDir) return;
    try {
      mkdirSync(evidenceDir, { recursive: true });
      const payload = {
        ...observation,
        argv: handle.argv,
        prompt: Object.freeze({ path: handle.promptPath, digest: handle.promptDigest, bytes: handle.promptBytes }),
      };
      writeFileSync(
        join(evidenceDir, `${handle.workerRunId}-g${handle.generation}.json`),
        JSON.stringify(payload, null, 2),
        "utf8",
      );
    } catch (error) {
      process.stderr.write(`codex-exec evidence write failed: ${error?.message ?? error}\n`);
    }
  }

  function settle(handle, terminal) {
    if (handle.finished) return;
    handle.finished = true;
    handle.terminal = Object.freeze(terminal);
    for (const resolve of handle.waiters.splice(0)) resolve(handle.terminal);
    handle.signal.fire();
  }

  function childGone(child) {
    return !child || child.exitCode !== null || child.signalCode !== null;
  }

  // Resolves true only when the child is known to be gone: either it already
  // was, or the kernel reported its exit inside the bound. A timeout is not
  // proof of termination, so the caller escalates instead of assuming.
  function waitForChildExit(child, timeoutMs) {
    if (childGone(child)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const settle = (exited) => {
        clearTimeout(timer);
        child.removeListener("exit", onExit);
        resolve(exited);
      };
      const onExit = () => settle(true);
      const timer = setTimeout(() => settle(false), timeoutMs);
      timer.unref?.();
      child.once("exit", onExit);
      if (childGone(child)) onExit();
    });
  }

  // Ownership of termination sits here and nowhere else: this adapter kills
  // exactly the one child it spawned (SIGTERM, then SIGKILL after the grace)
  // and reports whether the child is confirmed gone. No caller — Desktop
  // included — ever scans the OS for processes to kill.
  async function terminateChild(child, graceMs) {
    if (childGone(child)) return Object.freeze({ terminated: true, escalated: false });
    try {
      child.kill("SIGTERM");
    } catch {
      // best effort
    }
    if (await waitForChildExit(child, graceMs))
      return Object.freeze({ terminated: true, escalated: false });
    try {
      if (!childGone(child)) child.kill("SIGKILL");
    } catch {
      // best effort
    }
    return Object.freeze({
      terminated: await waitForChildExit(child, CANCEL_SIGKILL_WAIT_MS),
      escalated: true,
    });
  }

  async function finalize(handle, code, signal) {
    if (handle.finished) return;
    handle.durationMs = now() - handle.startedAt;
    if (handle.stdoutRemainder.length > 0) {
      handle.mapper.consumeLine(handle.stdoutRemainder);
      handle.stdoutRemainder = "";
    }
    const processEvidence = {
      pid: handle.pid,
      exitCode: code,
      signal: signal ?? null,
      durationMs: handle.durationMs,
      cancelled: false,
    };

    if (handle.cancelled) {
      settle(handle, { terminalStatus: "CANCELLED", reason: handle.cancelReason });
      return;
    }

    if (code !== 0) {
      const terminal = {
        terminalStatus: "FAILED",
        failureReason: "PROCESS_EXIT",
        reason: bound(
          handle.spawnError
            ? `the codex process could not start: ${handle.spawnError}`
            : signal
              ? `codex exec was stopped by ${signal}`
              : `codex exec exited with code ${code}`,
          200,
        ),
      };
      const observation = buildObservation(handle, {
        processEvidence,
        gitEvidence: null,
        protectedResult: Object.freeze({ checked: protectedList, violated: Object.freeze([]) }),
        verificationResult: Object.freeze({ status: "SKIPPED", command: Object.freeze([]), exitCode: null, signal: null, passed: null, timedOut: false, durationMs: 0, summary: "the child did not reach independent verification" }),
        result: { method: "NO_CANDIDATE", rawDigest: null, candidateReason: "the child process did not exit successfully" },
        terminal,
      });
      handle.emit("RUN_FAILED", { reason: "PROCESS_EXIT" });
      observations.set(handle.workerRunId, observation);
      persistEvidence(handle, observation);
      settle(handle, { ...terminal, adapterMeta: adapterMetaFor(handle, observation) });
      return;
    }

    const finalMessage = readFinalMessage(handle);
    handle.finalMessageSource = finalMessage.source;
    const parsed = parseCodexFinalMessage(finalMessage.text);
    const rawDigest = finalMessage.text.length > 0 ? digestOf(finalMessage.text) : null;
    const gitEvidence = await collectGitEvidence(handle);
    const protectedResult = await checkProtectedPaths(handle);
    const verificationResult =
      handle.role === "review"
        ? Object.freeze({ status: "SKIPPED", command: Object.freeze([]), exitCode: null, signal: null, passed: null, timedOut: false, durationMs: 0, summary: "a review attempt delivers a judgment, not a workspace change" })
        : await runVerification(handle);

    // Protocol stage first: a Harness postcondition only ever explains why a
    // protocol-valid delivery was rejected. An attempt whose final message is
    // missing, unparseable, ambiguous or outside the schema never reached a
    // candidate, so its failure is the protocol's — the postcondition checks
    // below are gated on a candidate having been composed.
    let candidate = null;
    let candidateReason = parsed.reason;
    let composedFailure = null;
    let usableCandidate = false;
    if (parsed.method !== "NO_CANDIDATE") {
      const composed = composeCandidate(handle, parsed.candidate, gitEvidence);
      if (composed.kind === "CANDIDATE") {
        candidate = composed.candidate;
        usableCandidate = true;
      } else if (composed.kind === "REFUSED") {
        candidateReason = composed.reason;
      } else {
        composedFailure = { failureReason: composed.failureReason, reason: composed.reason };
      }
    }

    let failure = null;
    if (usableCandidate) {
      if (!gitEvidence.headUnchanged)
        failure = { failureReason: "HARNESS_GIT_VIOLATION", reason: bound(`the worker moved HEAD from ${handle.baseSha} to ${gitEvidence.head}`, 200) };
      else if (protectedResult.violated.length > 0)
        failure = { failureReason: "HARNESS_PROTECTED_PATH_MODIFIED", reason: bound(`protected paths changed: ${protectedResult.violated.join(", ")}`, 200) };
      else if (handle.role === "execution" && verificationResult.status === "OBSERVED" && !verificationResult.passed)
        failure = {
          failureReason: "HARNESS_VERIFICATION_FAILED",
          reason: bound(`verification \`${verificationResult.command.join(" ")}\` did not pass (exit ${verificationResult.exitCode ?? "killed"})`, 200),
        };
      else if (handle.role === "execution" && gitEvidence.diffText.trim().length === 0)
        failure = { failureReason: "HARNESS_NO_CHANGE", reason: "the attempt produced no workspace change; the workspace diff is this backend's deliverable" };
    }
    if (!failure && composedFailure) failure = composedFailure;
    if (failure) candidate = null;

    const terminal = failure
      ? { terminalStatus: "FAILED", failureReason: failure.failureReason, reason: failure.reason }
      : { terminalStatus: "SUCCEEDED" };
    const observation = buildObservation(handle, {
      processEvidence,
      gitEvidence,
      protectedResult,
      verificationResult,
      // The parse method records what the parser actually found; candidateReason
      // says why nothing crossed the seam. A rejected delivery therefore keeps
      // `STRICT_JSON`/`EXTRACTED_JSON` here and explains itself through
      // `terminal.failureReason` — the operator can tell «the Worker spoke
      // nonsense» from «the Worker spoke clearly and the delivery was refused».
      result: { method: parsed.method, rawDigest, candidateReason: candidate ? null : candidateReason },
      terminal,
    });
    observations.set(handle.workerRunId, observation);
    persistEvidence(handle, observation);

    if (failure) {
      handle.emit("RUN_FAILED", { reason: failure.failureReason });
      settle(handle, { ...terminal, adapterMeta: adapterMetaFor(handle, observation) });
      return;
    }
    handle.emit("RESULT_READY", { candidate: candidate !== null });
    settle(handle, {
      terminalStatus: "SUCCEEDED",
      reason: candidate ? null : bound(candidateReason, 200),
      rawResultDigest: rawDigest,
      resultCandidate: candidate,
      adapterMeta: adapterMetaFor(handle, observation),
    });
  }

  return Object.freeze({
    async manifest() {
      if (cachedVersion === null) cachedVersion = await discoverCodexVersion({ codexCommand });
      return {
        adapterType: CODEX_EXEC_ADAPTER_TYPE,
        adapterVersion: cachedVersion ?? "unknown",
        containment: { sandboxMode: "sandbox", knownLimitations: [...KNOWN_LIMITATIONS] },
      };
    },

    async start(input, context) {
      if (!isPlainObject(input)) throw new Error("codex-exec requires a WorkerRunInput");
      const kind = input.resultContract?.kind;
      if (kind !== RESULT_CONTRACT_KINDS.ARTIFACT_DELIVERY && kind !== RESULT_CONTRACT_KINDS.REVIEW_JUDGMENT)
        throw new Error(`codex-exec received an unknown ResultContract: ${kind}`);
      const workspaceRoot = context?.workspaceRoot ?? input.executionBinding?.workspaceRoot;
      const scratchRoot = context?.scratchRoot ?? input.executionBinding?.scratchRoot;
      if (!workspaceRoot || !scratchRoot) throw new Error("codex-exec requires workspaceRoot and scratchRoot");
      const revision = input.executionBinding?.baseRevision ?? baseRevision;
      if (!revision)
        throw new Error("codex-exec requires a baseRevision on the execution binding (or adapter configuration)");

      const baseSha = await provisionWorkspace({ workspaceRoot, revision });
      mkdirSync(scratchRoot, { recursive: true });
      const schemaPath = join(scratchRoot, "result-schema.json");
      const lastMessagePath = join(scratchRoot, "last-message.txt");
      const promptPath = join(scratchRoot, "prompt.txt");
      const prompt = compileCodexPrompt({ input, verification: verificationCommand ? { command: verificationCommand } : null, protectedPaths: protectedList, baseSha });
      writeFileSync(schemaPath, JSON.stringify(codexReportSchemaFor(kind), null, 2), "utf8");
      writeFileSync(promptPath, prompt, "utf8");
      if (kind === RESULT_CONTRACT_KINDS.REVIEW_JUDGMENT)
        writeFileSync(
          join(scratchRoot, "artifact.patch"),
          String(input.workPacket?.review?.targetArtifact?.content ?? ""),
          "utf8",
        );

      if (cachedVersion === null) cachedVersion = await discoverCodexVersion({ codexCommand });
      const argv = buildCodexArgv({ codexCommand, workspaceRoot, schemaPath, lastMessagePath });
      const child = spawn(codexCommand[0], argv, {
        cwd: workspaceRoot,
        env: childEnvironment(scratchRoot),
        stdio: ["pipe", "pipe", "pipe"],
      });

      const handle = {
        id: `cxe_${randomUUID()}`,
        workerRunId: input.workerRunId,
        generation: input.generation,
        taskId: input.workPacket?.task?.id ?? null,
        role: kind === RESULT_CONTRACT_KINDS.REVIEW_JUDGMENT ? "review" : "execution",
        input,
        baseSha,
        workspaceRoot,
        scratchRoot,
        lastMessagePath,
        promptPath,
        promptDigest: digestOf(prompt),
        promptBytes: Buffer.byteLength(prompt, "utf8"),
        argv,
        adapterVersion: cachedVersion ?? "unknown",
        child,
        pid: child.pid ?? null,
        startedAt: now(),
        cancelled: false,
        cancelReason: null,
        finished: false,
        terminal: null,
        waiters: [],
        events: [],
        eventSeq: 0,
        signal: createSignal(),
        stdoutRemainder: "",
        stdoutBytes: 0,
        stderr: "",
        stderrBytes: 0,
        finalMessageSource: null,
        mapper: null,
      };
      const emit = (eventKind, detail = null) => {
        handle.events.push(
          newWorkerEvent({ kind: eventKind, sequence: handle.eventSeq + 1, detail, at: new Date(now()).toISOString() }),
        );
        handle.eventSeq += 1;
        handle.signal.fire();
      };
      // The mapper owns the provider-side events; the terminal event is
      // emitted here once the attempt's outcome is known, so the frozen
      // vocabulary always ends an attempt with RESULT_READY or RUN_FAILED.
      handle.emit = emit;
      handle.mapper = createCodexStreamMapper(emit);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        handle.stdoutBytes += Buffer.byteLength(chunk, "utf8");
        handle.stdoutRemainder += chunk;
        let index;
        while ((index = handle.stdoutRemainder.indexOf("\n")) >= 0) {
          const line = handle.stdoutRemainder.slice(0, index);
          handle.stdoutRemainder = handle.stdoutRemainder.slice(index + 1);
          handle.mapper.consumeLine(line);
        }
        if (handle.stdoutRemainder.length > MAX_STDOUT_REMAINDER_BYTES) {
          handle.mapper.state.malformedLines += 1;
          handle.stdoutRemainder = "";
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        handle.stderrBytes += Buffer.byteLength(chunk, "utf8");
        handle.stderr = (handle.stderr + chunk).slice(-MAX_STDERR_BYTES);
      });
      child.once("error", (error) => {
        handle.spawnError = error?.message ?? String(error);
        void finalize(handle, null, null);
      });
      child.once("close", (code, signal) => {
        void finalize(handle, code, signal);
      });
      if (child.stdin) {
        child.stdin.on("error", () => {});
        child.stdin.end(prompt, "utf8");
      }

      handles.set(input.workerRunId, handle);
      return handle;
    },

    async *events(handle) {
      let index = 0;
      while (true) {
        while (index < handle.events.length) yield handle.events[index++];
        if (handle.finished) return;
        await handle.signal.wait();
      }
    },

    wait(handle) {
      if (handle.terminal) return Promise.resolve(handle.terminal);
      return new Promise((resolve) => handle.waiters.push(resolve));
    },

    cancel(handle, reason) {
      // Idempotent by contract: a second cancel is a no-op that resolves with
      // the first one, and cancelling an already-finished execution is legal.
      // The returned promise is the termination receipt: it resolves only
      // after this attempt's child is confirmed gone, so a WorkerHost stop
      // cannot leave an unreported orphan behind (contract §12, §15).
      if (!handle) return undefined;
      if (handle.cancelled) return handle.cancellation;
      handle.cancelled = true;
      handle.cancelReason = bound(reason ?? null, 200);
      handle.cancellation = (async () => {
        if (handle.finished) return;
        const termination = await terminateChild(handle.child, cancellationGraceMs);
        const terminal = { terminalStatus: "CANCELLED", reason: handle.cancelReason };
        const observation = buildObservation(handle, {
          processEvidence: {
            pid: handle.pid,
            exitCode: handle.child?.exitCode ?? null,
            signal: handle.child?.signalCode ?? null,
            durationMs: now() - handle.startedAt,
            cancelled: true,
            cancelReason: handle.cancelReason,
            terminationConfirmed: termination.terminated,
            escalatedToSigkill: termination.escalated,
          },
          gitEvidence: Object.freeze({
            baseRevision: handle.baseSha,
            head: null,
            headUnchanged: null,
            statusTruncated: false,
            changedFileCount: null,
            changedFiles: Object.freeze([]),
            diffText: null,
            diffDigest: null,
            diffBytes: null,
            notCollected: "the attempt was cancelled before independent evidence collection",
          }),
          protectedResult: Object.freeze({ checked: protectedList, violated: Object.freeze([]) }),
          verificationResult: Object.freeze({ status: "SKIPPED", command: Object.freeze([]), exitCode: null, signal: null, passed: null, timedOut: false, durationMs: 0, summary: "the attempt was cancelled" }),
          result: { method: "NO_CANDIDATE", rawDigest: null, candidateReason: "the attempt was cancelled" },
          terminal,
        });
        observations.set(handle.workerRunId, observation);
        persistEvidence(handle, observation);
        settle(handle, terminal);
      })();
      return handle.cancellation;
    },

    observationFor(workerRunId) {
      return observations.get(workerRunId) ?? null;
    },

    handleFor(workerRunId) {
      return handles.get(workerRunId) ?? null;
    },
  });
}

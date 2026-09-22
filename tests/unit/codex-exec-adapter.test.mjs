// CodexExecAdapter — the first real production Worker backend.
// Contract: docs/contracts/codex-exec-adapter-v1.md
//
// Provider-specific behavior is tested here with a controlled child process
// (tests/support/stub-codex-cli.mjs): argv and environment construction, JSONL
// normalization, result parsing, ResultContract-specific candidates, the
// independent-evidence checks and cancellation. The real `codex exec` CLI is
// exercised only by the opt-in H1 scenarios (scripts/h1-codex-exec.mjs).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODEX_EXEC_ADAPTER_TYPE,
  artifactReportSchema,
  assertAdapterManifest,
  buildWorkerRunInput,
  createCodexExecAdapter,
  createCodexStreamMapper,
  discoverCodexVersion,
  normalizeAdapterResult,
  parseCodexFinalMessage,
  parseWorkerResult,
  parseWorkerReviewResult,
  resultContractForWorkPacket,
  reviewReportSchema,
} from "../../packages/harness/index.mjs";
import { compileCodexPrompt } from "../../packages/harness/adapters/codex-exec-prompt.mjs";
import {
  openTempKernel,
  seedStaffedTask,
  seedTaskInReview,
  startReviewRun,
} from "../support/kernel.mjs";

const STUB = fileURLToPath(new URL("../support/stub-codex-cli.mjs", import.meta.url));
const stubCommand = [process.execPath, STUB];
const created = [];

after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const commit = (repo) =>
  git(["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture base"], repo);

function makeRepo({ files = { "src/app.mjs": "export const x = 1;\n", "test/app.test.mjs": "// protected\n" } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fc-codex-adapter-"));
  created.push(dir);
  const repo = join(dir, "base");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content, "utf8");
  }
  git(["init", "-q"], repo);
  git(["add", "."], repo);
  commit(repo);
  return { dir, repo, sha: git(["rev-parse", "HEAD"], repo).trim() };
}

function makeRunRoot(dir) {
  const runRoot = join(dir, "run");
  const workspaceRoot = join(runRoot, "workspace");
  const scratchRoot = join(runRoot, "scratch");
  mkdirSync(workspaceRoot, { recursive: true });
  mkdirSync(scratchRoot, { recursive: true });
  return { workspaceRoot, scratchRoot };
}

// A real WorkerRunInput produced by the real kernel, then re-bound to the test
// workspace so the adapter provisions its worktree exactly where the Host
// would have placed it.
function executionInputFixture() {
  const { kernel, cleanup } = openTempKernel();
  const flow = seedStaffedTask(kernel);
  const started = kernel.startWorkerRun({ taskId: flow.task.id });
  const bound = kernel.bindWorkerExecution({
    workerRunId: started.workerRun.id,
    generation: started.generation,
    backendType: CODEX_EXEC_ADAPTER_TYPE,
    backendVersion: "0.0.0-stub",
    executionProfileDigest: "sha256:unit-profile",
    workspaceRoot: "/unit/workspace",
    scratchRoot: "/unit/scratch",
  });
  const input = buildWorkerRunInput({
    run: started.workerRun,
    binding: bound.binding,
    effectivePolicy: {
      sandboxMode: "sandbox",
      workspaceRoot: "/unit/workspace",
      scratchRoot: "/unit/scratch",
      knownLimitations: [],
    },
  });
  return { input, cleanup, task: flow.task };
}

function reviewInputFixture() {
  const { kernel, cleanup } = openTempKernel();
  const flow = seedTaskInReview(kernel);
  const handoff = kernel.requestReview({ taskId: flow.task.id, generation: flow.generation });
  const started = startReviewRun(kernel, { reviewTaskId: handoff.reviewTask.id, reviewerId: flow.reviewer.id });
  const bound = kernel.bindWorkerExecution({
    workerRunId: started.workerRun.id,
    generation: started.generation,
    backendType: CODEX_EXEC_ADAPTER_TYPE,
    backendVersion: "0.0.0-stub",
    executionProfileDigest: "sha256:unit-profile",
    workspaceRoot: "/unit/workspace",
    scratchRoot: "/unit/scratch",
  });
  const input = buildWorkerRunInput({
    run: started.workerRun,
    binding: bound.binding,
    effectivePolicy: {
      sandboxMode: "sandbox",
      workspaceRoot: "/unit/workspace",
      scratchRoot: "/unit/scratch",
      knownLimitations: [],
    },
    resultContract: resultContractForWorkPacket(started.workerRun.workPacket),
  });
  return { input, cleanup, artifact: flow.artifact };
}

function rebind(input, { workspaceRoot, scratchRoot, baseRevision }) {
  return {
    ...input,
    executionBinding: { ...input.executionBinding, workspaceRoot, scratchRoot, baseRevision },
  };
}

function adapterFor(repo, { mode = "execution-ok", ...overrides } = {}) {
  return createCodexExecAdapter({
    codexCommand: stubCommand,
    baseRepository: repo,
    verification: { command: [process.execPath, "-e", "process.exit(0)"] },
    env: { FLOWCREDIT_STUB_MODE: mode },
    ...overrides,
  });
}

async function drainEvents(adapter, handle) {
  const events = [];
  for await (const event of adapter.events(handle)) events.push(event);
  return events;
}

async function until(predicate, { label, timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label ?? "condition"}`);
}

// ---------------------------------------------------------------- manifest

test("the codex-exec manifest is bounded, honest backend metadata", async () => {
  const adapter = createCodexExecAdapter({ codexCommand: stubCommand });
  const manifest = assertAdapterManifest(await adapter.manifest());
  assert.equal(manifest.adapterType, "codex-exec");
  assert.equal(manifest.adapterVersion, "0.0.0-stub");
  assert.equal(manifest.containment.sandboxMode, "sandbox");
  assert.ok(
    manifest.containment.knownLimitations.some((entry) => /not proven OS-level containment/.test(entry)),
    "the manifest must not overclaim containment",
  );
  assert.equal(await discoverCodexVersion({ codexCommand: stubCommand }), "0.0.0-stub");
  assert.equal(
    await discoverCodexVersion({ codexCommand: [join(tmpdir(), "no-such-codex-binary")] }),
    null,
    "a missing CLI is reported as unknown, not invented",
  );
});

// ------------------------------------------------- argv / env / provisioning

test("argv and environment are constructed without shell interpolation", async () => {
  const { dir, repo, sha } = makeRepo();
  const { workspaceRoot, scratchRoot } = makeRunRoot(dir);
  const argvDump = join(dir, "argv.json");
  const envDump = join(dir, "env.json");
  const promptDump = join(dir, "prompt.txt");
  const adapter = adapterFor(repo, {
    env: {
      FLOWCREDIT_STUB_MODE: "execution-ok",
      FLOWCREDIT_STUB_ARGV_DUMP: argvDump,
      FLOWCREDIT_STUB_ENV_DUMP: envDump,
      FLOWCREDIT_STUB_PROMPT_DUMP: promptDump,
    },
  });
  const fixture = executionInputFixture();
  try {
    const input = rebind(fixture.input, { workspaceRoot, scratchRoot, baseRevision: sha });
    const handle = await adapter.start(input, { workspaceRoot, scratchRoot });
    const terminal = normalizeAdapterResult(await adapter.wait(handle));
    assert.equal(terminal.terminalStatus, "SUCCEEDED");
    const argv = JSON.parse(readFileSync(argvDump, "utf8"));
    assert.deepEqual(argv, [
      "exec",
      "--json",
      "--ephemeral",
      "--color",
      "never",
      "--cd",
      workspaceRoot,
      "--sandbox",
      "workspace-write",
      "--output-schema",
      join(scratchRoot, "result-schema.json"),
      "--output-last-message",
      join(scratchRoot, "last-message.txt"),
      "-",
    ]);
    const env = JSON.parse(readFileSync(envDump, "utf8"));
    assert.equal(realpathSync(env.cwd), realpathSync(workspaceRoot), "the child runs in the run workspace");
    assert.equal(env.TMPDIR, scratchRoot);
    assert.equal(env.TMP, scratchRoot);
    assert.equal(env.TEMP, scratchRoot);
    assert.equal(env.schemaPresent, true);
    // The workspace is a real detached worktree of the base repository.
    assert.equal(git(["rev-parse", "HEAD"], workspaceRoot).trim(), sha);
    assert.equal(git(["status", "--porcelain"], repo).trim(), "", "the base checkout stays clean");
    const prompt = readFileSync(promptDump, "utf8");
    assert.match(prompt, /PROHIBITED EFFECTS/);
    assert.match(prompt, /No git commit, no git push/);
    assert.match(prompt, new RegExp(fixture.input.workPacket.employee.displayName));
  } finally {
    fixture.cleanup();
  }
});

test("a non-empty run workspace is never reused", async () => {
  const { dir, repo, sha } = makeRepo();
  const { workspaceRoot, scratchRoot } = makeRunRoot(dir);
  writeFileSync(join(workspaceRoot, "leftover.txt"), "from an old attempt\n", "utf8");
  const adapter = adapterFor(repo);
  const fixture = executionInputFixture();
  try {
    await assert.rejects(
      () =>
        adapter.start(rebind(fixture.input, { workspaceRoot, scratchRoot, baseRevision: sha }), {
          workspaceRoot,
          scratchRoot,
        }),
      /not empty/,
    );
  } finally {
    fixture.cleanup();
  }
});

// ------------------------------------------------------- JSONL normalization

test("JSONL mapping keeps the frozen vocabulary and drops reasoning payloads", () => {
  const emitted = [];
  const mapper = createCodexStreamMapper((kind, detail) => emitted.push({ kind, detail }));
  mapper.consumeLine(JSON.stringify({ type: "thread.started", thread_id: "th-1" }));
  mapper.consumeLine(JSON.stringify({ type: "turn.started" }));
  mapper.consumeLine(
    JSON.stringify({
      type: "item.completed",
      item: { id: "i0", type: "command_execution", command: "ls", exit_code: 0 },
    }),
  );
  mapper.consumeLine(
    JSON.stringify({ type: "item.completed", item: { id: "i1", type: "reasoning", text: "CHAIN OF THOUGHT" } }),
  );
  mapper.consumeLine(
    JSON.stringify({ type: "item.completed", item: { id: "i2", type: "agent_message", text: "done" } }),
  );
  mapper.consumeLine(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 7, output_tokens: 3 } }));
  mapper.consumeLine(JSON.stringify({ type: "turn.diff.updated", patch: "provider-specific" }));
  mapper.consumeLine("not json at all");
  mapper.consumeLine("");

  assert.deepEqual(
    emitted.map((event) => event.kind),
    ["RUN_STARTED", "TOOL_FINISHED"],
    "only frozen event kinds cross the seam",
  );
  assert.equal(mapper.state.externalSessionRef, "th-1");
  assert.equal(mapper.state.toolExecutions, 1);
  assert.equal(mapper.state.reasoningItems, 1);
  assert.equal(mapper.state.agentMessages, 1);
  assert.equal(mapper.state.lastAgentMessage, "done");
  assert.equal(mapper.state.unknownEventTypes, 1);
  assert.equal(mapper.state.malformedLines, 1);
  assert.deepEqual(mapper.state.usage, { inputTokens: 7, outputTokens: 3, reasoningOutputTokens: null });
  assert.equal(
    JSON.stringify(emitted).includes("CHAIN OF THOUGHT"),
    false,
    "reasoning payloads must never leave the adapter",
  );
});

// ------------------------------------------------------------- result parsing

test("final-message parsing is strict JSON first, one unambiguous object second", () => {
  assert.deepEqual(parseCodexFinalMessage('{"outcome":"SUCCEEDED"}'), {
    method: "STRICT_JSON",
    candidate: { outcome: "SUCCEEDED" },
    reason: null,
  });
  const fenced = parseCodexFinalMessage('Done.\n```json\n{"outcome":"SUCCEEDED"}\n```\n');
  assert.equal(fenced.method, "EXTRACTED_JSON");
  assert.deepEqual(fenced.candidate, { outcome: "SUCCEEDED" });
  // The real CLI was observed emitting bare objects after prose too.
  const bare = parseCodexFinalMessage('All checks passed.\n{"verdict":"PASS","findings":[],"summary":"ok"}');
  assert.equal(bare.method, "EXTRACTED_JSON");
  assert.equal(bare.candidate.verdict, "PASS");
  assert.equal(parseCodexFinalMessage("no structure here").method, "NO_CANDIDATE");
  assert.equal(parseCodexFinalMessage("[1,2]").method, "NO_CANDIDATE");
  assert.equal(parseCodexFinalMessage('wrapped [{"a":1}] in an array').method, "NO_CANDIDATE");
  assert.match(
    parseCodexFinalMessage('```json\n{"a":1}\n```\nand\n```json\n{"b":2}\n```').reason,
    /more than one structured JSON candidate/,
  );
  assert.match(
    parseCodexFinalMessage('first {"a":1} then {"b":2}').reason,
    /more than one structured JSON candidate/,
  );
  assert.match(
    parseCodexFinalMessage("x".repeat(300 * 1024)).reason,
    /bounded payload/,
  );
  assert.equal(
    parseCodexFinalMessage('note: {not json at all} but then {"verdict":"PASS"}').candidate.verdict,
    "PASS",
    "an unparseable brace span is not a competing candidate",
  );
  assert.equal(parseCodexFinalMessage("").method, "NO_CANDIDATE");
});

// ------------------------------------------------------ execution delivery

test("a successful execution produces one bounded patch candidate plus evidence", async () => {
  const { dir, repo, sha } = makeRepo();
  const { workspaceRoot, scratchRoot } = makeRunRoot(dir);
  const adapter = adapterFor(repo, { protectedPaths: ["test/"] });
  const fixture = executionInputFixture();
  try {
    const input = rebind(fixture.input, { workspaceRoot, scratchRoot, baseRevision: sha });
    const handle = await adapter.start(input, { workspaceRoot, scratchRoot });
    const terminal = normalizeAdapterResult(await adapter.wait(handle, { timeoutMs: 10_000 }));
    assert.equal(terminal.terminalStatus, "SUCCEEDED");
    assert.equal(terminal.failureReason, null);
    assert.ok(terminal.rawResultDigest.startsWith("sha256:"));
    const parsed = parseWorkerResult(terminal.resultCandidate);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.result.outcome, "SUCCEEDED");
    assert.equal(parsed.result.proposedArtifacts.length, 1);
    assert.equal(parsed.result.proposedArtifacts[0].kind, "patch");
    assert.match(parsed.result.proposedArtifacts[0].content, /diff --git/);
    assert.match(parsed.result.proposedArtifacts[0].content, /stub change/);
    assert.ok(JSON.stringify(terminal.adapterMeta).length <= 4096, "adapterMeta stays bounded");
    assert.equal(terminal.adapterMeta.parse, "STRICT_JSON");
    assert.equal(terminal.adapterMeta.externalSessionRef, "stub-thread-0001");

    const events = await drainEvents(adapter, handle);
    assert.deepEqual(
      events.map((event) => event.kind),
      ["RUN_STARTED", "TOOL_FINISHED", "RESULT_READY"],
      "an attempt ends with the frozen terminal event",
    );
    const observation = adapter.observationFor(input.workerRunId);
    assert.equal(observation.git.headUnchanged, true);
    assert.deepEqual(observation.git.changedFiles, ["src/change.txt"]);
    assert.ok(observation.git.diffDigest.startsWith("sha256:"));
    assert.deepEqual(observation.protectedPaths.violated, []);
    assert.equal(observation.verification.status, "OBSERVED");
    assert.equal(observation.verification.passed, true);
    assert.equal(observation.events.reasoningItems, 1);
    assert.equal(observation.result.finalMessageSource, "LAST_MESSAGE_FILE");
    assert.equal(observation.session.externalSessionRef, "stub-thread-0001");
  } finally {
    fixture.cleanup();
  }
});

test("the fallback to an agent message keeps working when no last-message file exists", async () => {
  const { dir, repo, sha } = makeRepo();
  const { workspaceRoot, scratchRoot } = makeRunRoot(dir);
  const adapter = adapterFor(repo, { mode: "execution-agent-message-only" });
  const fixture = executionInputFixture();
  try {
    const input = rebind(fixture.input, { workspaceRoot, scratchRoot, baseRevision: sha });
    const handle = await adapter.start(input, { workspaceRoot, scratchRoot });
    const terminal = normalizeAdapterResult(await adapter.wait(handle));
    assert.equal(terminal.terminalStatus, "SUCCEEDED");
    assert.equal(parseWorkerResult(terminal.resultCandidate).ok, true);
    const observation = adapter.observationFor(input.workerRunId);
    assert.equal(observation.result.parse, "STRICT_JSON");
    assert.equal(observation.result.finalMessageSource, "AGENT_MESSAGE_FALLBACK");
  } finally {
    fixture.cleanup();
  }
});

test("a prose answer with exactly one JSON fence is accepted, and the digest is preserved", async () => {
  const { dir, repo, sha } = makeRepo();
  const { workspaceRoot, scratchRoot } = makeRunRoot(dir);
  const adapter = adapterFor(repo, { mode: "execution-fenced" });
  const fixture = executionInputFixture();
  try {
    const input = rebind(fixture.input, { workspaceRoot, scratchRoot, baseRevision: sha });
    const handle = await adapter.start(input, { workspaceRoot, scratchRoot });
    const terminal = normalizeAdapterResult(await adapter.wait(handle));
    assert.equal(terminal.terminalStatus, "SUCCEEDED");
    assert.equal(parseWorkerResult(terminal.resultCandidate).ok, true);
    const observation = adapter.observationFor(input.workerRunId);
    assert.equal(observation.result.parse, "EXTRACTED_JSON");
    assert.equal(observation.result.finalMessageSource, "LAST_MESSAGE_FILE");
  } finally {
    fixture.cleanup();
  }
});

test("an invalid or competing result candidate is never turned into an artifact", async () => {
  for (const [mode, expected] of [
    ["execution-two-fences", /more than one structured JSON candidate/],
    ["execution-malformed", /no structured JSON candidate|strict JSON parsing failed/],
  ]) {
    const { dir, repo, sha } = makeRepo();
    const { workspaceRoot, scratchRoot } = makeRunRoot(dir);
    const adapter = adapterFor(repo, { mode });
    const fixture = executionInputFixture();
    try {
      const input = rebind(fixture.input, { workspaceRoot, scratchRoot, baseRevision: sha });
      const handle = await adapter.start(input, { workspaceRoot, scratchRoot });
      const terminal = normalizeAdapterResult(await adapter.wait(handle));
      assert.equal(terminal.terminalStatus, "SUCCEEDED", `${mode}: the process succeeded`);
      assert.equal(terminal.resultCandidate, null, `${mode}: no candidate crosses the seam`);
      assert.match(terminal.reason, expected);
      assert.equal(parseWorkerResult(terminal.resultCandidate).ok, false);
      const observation = adapter.observationFor(input.workerRunId);
      assert.equal(observation.result.parse, "NO_CANDIDATE");
    } finally {
      fixture.cleanup();
    }
  }
});

test("a result that names Runtime facts is refused before it can be delivered", async () => {
  const { dir, repo, sha } = makeRepo();
  const { workspaceRoot, scratchRoot } = makeRunRoot(dir);
  const adapter = adapterFor(repo, { mode: "execution-extra-field" });
  const fixture = executionInputFixture();
  try {
    const input = rebind(fixture.input, { workspaceRoot, scratchRoot, baseRevision: sha });
    const handle = await adapter.start(input, { workspaceRoot, scratchRoot });
    const terminal = normalizeAdapterResult(await adapter.wait(handle));
    assert.equal(terminal.resultCandidate, null);
    assert.match(terminal.reason, /outside the result schema: workerRunId/);
  } finally {
    fixture.cleanup();
  }
});

// -------------------------------------------------------------- review path

test("a review attempt delivers a judgment about this exact attempt", async () => {
  const { dir, repo, sha } = makeRepo();
  const { workspaceRoot, scratchRoot } = makeRunRoot(dir);
  const adapter = adapterFor(repo, { mode: "review-ok" });
  const fixture = reviewInputFixture();
  try {
    const input = rebind(fixture.input, { workspaceRoot, scratchRoot, baseRevision: sha });
    const handle = await adapter.start(input, { workspaceRoot, scratchRoot });
    const terminal = normalizeAdapterResult(await adapter.wait(handle));
    assert.equal(terminal.terminalStatus, "SUCCEEDED");
    const parsed = parseWorkerReviewResult(terminal.resultCandidate);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.result.verdict, "PASS");
    assert.equal(parsed.result.workerRunId, input.workerRunId);
    assert.equal(parsed.result.generation, input.generation);
    const observation = adapter.observationFor(input.workerRunId);
    assert.equal(observation.role, "review");
    assert.equal(observation.verification.status, "SKIPPED", "a judgment delivers no workspace change to verify");
    assert.equal(observation.git.diffText, "", "a review attempt does not touch the workspace");
  } finally {
    fixture.cleanup();
  }
});

test("a review judgment that names lineage is refused", async () => {
  const { dir, repo, sha } = makeRepo();
  const { workspaceRoot, scratchRoot } = makeRunRoot(dir);
  const adapter = adapterFor(repo, { mode: "review-extra-field" });
  const fixture = reviewInputFixture();
  try {
    const input = rebind(fixture.input, { workspaceRoot, scratchRoot, baseRevision: sha });
    const handle = await adapter.start(input, { workspaceRoot, scratchRoot });
    const terminal = normalizeAdapterResult(await adapter.wait(handle));
    assert.equal(terminal.resultCandidate, null);
    assert.match(terminal.reason, /outside the review schema: targetArtifactId/);
    assert.equal(parseWorkerReviewResult(terminal.resultCandidate).ok, false);
  } finally {
    fixture.cleanup();
  }
});

// --------------------------------------------------- independent evidence

test("independent verification failing maps to a bounded harness failure", async () => {
  const { dir, repo, sha } = makeRepo();
  const { workspaceRoot, scratchRoot } = makeRunRoot(dir);
  const adapter = adapterFor(repo, { verification: { command: [process.execPath, "-e", "process.exit(3)"] } });
  const fixture = executionInputFixture();
  try {
    const input = rebind(fixture.input, { workspaceRoot, scratchRoot, baseRevision: sha });
    const handle = await adapter.start(input, { workspaceRoot, scratchRoot });
    const terminal = normalizeAdapterResult(await adapter.wait(handle));
    assert.equal(terminal.terminalStatus, "FAILED");
    assert.equal(terminal.failureReason, "HARNESS_VERIFICATION_FAILED");
    const observation = adapter.observationFor(input.workerRunId);
    assert.equal(observation.verification.passed, false);
    assert.equal(observation.verification.exitCode, 3);
    const events = await drainEvents(adapter, handle);
    assert.equal(events.at(-1).kind, "RUN_FAILED");
    assert.equal(events.at(-1).detail.reason, "HARNESS_VERIFICATION_FAILED");
  } finally {
    fixture.cleanup();
  }
});

test("a modified protected path and a committed workspace are both caught", async () => {
  for (const [mode, protectedPaths, failureReason] of [
    ["execution-protected", ["test/"], "HARNESS_PROTECTED_PATH_MODIFIED"],
    ["execution-commit", [], "HARNESS_GIT_VIOLATION"],
  ]) {
    const { dir, repo, sha } = makeRepo();
    const { workspaceRoot, scratchRoot } = makeRunRoot(dir);
    const adapter = adapterFor(repo, { mode, protectedPaths });
    const fixture = executionInputFixture();
    try {
      const input = rebind(fixture.input, { workspaceRoot, scratchRoot, baseRevision: sha });
      const handle = await adapter.start(input, { workspaceRoot, scratchRoot });
      const terminal = normalizeAdapterResult(await adapter.wait(handle));
      assert.equal(terminal.terminalStatus, "FAILED", mode);
      assert.equal(terminal.failureReason, failureReason);
      assert.ok(terminal.reason.length > 0 && terminal.reason.length <= 200);
      const observation = adapter.observationFor(input.workerRunId);
      if (failureReason === "HARNESS_PROTECTED_PATH_MODIFIED")
        assert.deepEqual(observation.protectedPaths.violated, ["test/"]);
      else assert.equal(observation.git.headUnchanged, false);
    } finally {
      fixture.cleanup();
    }
  }
});

test("an attempt that changes nothing is not a delivery", async () => {
  const { dir, repo, sha } = makeRepo();
  const { workspaceRoot, scratchRoot } = makeRunRoot(dir);
  const adapter = adapterFor(repo, { mode: "execution-no-change" });
  const fixture = executionInputFixture();
  try {
    const input = rebind(fixture.input, { workspaceRoot, scratchRoot, baseRevision: sha });
    const handle = await adapter.start(input, { workspaceRoot, scratchRoot });
    const terminal = normalizeAdapterResult(await adapter.wait(handle));
    assert.equal(terminal.terminalStatus, "FAILED");
    assert.equal(terminal.failureReason, "HARNESS_NO_CHANGE");
  } finally {
    fixture.cleanup();
  }
});

// ------------------------------------------------------------- lifecycle

test("a non-zero child exit is PROCESS_EXIT, the one adapter-certified failure", async () => {
  const { dir, repo, sha } = makeRepo();
  const { workspaceRoot, scratchRoot } = makeRunRoot(dir);
  const adapter = adapterFor(repo, { mode: "exit-1" });
  const fixture = executionInputFixture();
  try {
    const input = rebind(fixture.input, { workspaceRoot, scratchRoot, baseRevision: sha });
    const handle = await adapter.start(input, { workspaceRoot, scratchRoot });
    const terminal = normalizeAdapterResult(await adapter.wait(handle));
    assert.equal(terminal.terminalStatus, "FAILED");
    assert.equal(terminal.failureReason, "PROCESS_EXIT");
    const observation = adapter.observationFor(input.workerRunId);
    assert.match(observation.events.stderrTail, /stub failed on purpose/);
    assert.ok(observation.events.malformedLines >= 1, "partial stdout is counted, not parsed");
  } finally {
    fixture.cleanup();
  }
});

test("a missing CLI binary is a process failure, never a silent success", async () => {
  const { dir, repo, sha } = makeRepo();
  const { workspaceRoot, scratchRoot } = makeRunRoot(dir);
  const adapter = createCodexExecAdapter({
    codexCommand: [join(dir, "definitely-not-a-binary")],
    baseRepository: repo,
    verification: { command: [process.execPath, "-e", "process.exit(0)"] },
  });
  const fixture = executionInputFixture();
  try {
    const input = rebind(fixture.input, { workspaceRoot, scratchRoot, baseRevision: sha });
    const handle = await adapter.start(input, { workspaceRoot, scratchRoot });
    const terminal = normalizeAdapterResult(await adapter.wait(handle));
    assert.equal(terminal.terminalStatus, "FAILED");
    assert.equal(terminal.failureReason, "PROCESS_EXIT");
    assert.match(terminal.reason, /could not start/);
  } finally {
    fixture.cleanup();
  }
});

test("cancel is idempotent, ends the stream and invents no result", async () => {
  const { dir, repo, sha } = makeRepo();
  const { workspaceRoot, scratchRoot } = makeRunRoot(dir);
  const adapter = adapterFor(repo, { mode: "hang" });
  const fixture = executionInputFixture();
  try {
    const input = rebind(fixture.input, { workspaceRoot, scratchRoot, baseRevision: sha });
    const handle = await adapter.start(input, { workspaceRoot, scratchRoot });
    await until(() => handle.events.length >= 1, { label: "the child's first event" });
    adapter.cancel(handle, "WORKER_TIMEOUT");
    adapter.cancel(handle, "WORKER_TIMEOUT");
    adapter.cancel(handle, "a third cancel with a different reason");
    const terminal = normalizeAdapterResult(await adapter.wait(handle, { timeoutMs: 10 }));
    assert.equal(terminal.terminalStatus, "CANCELLED");
    assert.equal(terminal.resultCandidate, null);
    assert.equal(terminal.reason, "WORKER_TIMEOUT", "the first cancel reason sticks");
    const events = await drainEvents(adapter, handle);
    assert.equal(events.filter((event) => event.kind === "RUN_STARTED").length, 1);
    assert.equal(
      events.some((event) => ["RESULT_READY", "RUN_FAILED"].includes(event.kind)),
      false,
      "a cancelled attempt invents no terminal result event",
    );
    const observation = adapter.observationFor(input.workerRunId);
    assert.equal(observation.terminal.terminalStatus, "CANCELLED");
    assert.equal(observation.process.cancelled, true);
    // Cancelling an already-terminal attempt is legal and changes nothing.
    adapter.cancel(handle, "too late");
    assert.equal(normalizeAdapterResult(await adapter.wait(handle)).terminalStatus, "CANCELLED");
  } finally {
    fixture.cleanup();
  }
});

test("start() refuses an unknown ResultContract before spawning anything", async () => {
  const { dir, repo, sha } = makeRepo();
  const { workspaceRoot, scratchRoot } = makeRunRoot(dir);
  const adapter = adapterFor(repo);
  const fixture = executionInputFixture();
  try {
    const input = rebind(fixture.input, { workspaceRoot, scratchRoot, baseRevision: sha });
    await assert.rejects(
      () =>
        adapter.start({ ...input, resultContract: { kind: "SOMETHING_ELSE" } }, { workspaceRoot, scratchRoot }),
      /unknown ResultContract/,
    );
  } finally {
    fixture.cleanup();
  }
});

// ---------------------------------------------------------------- prompts

test("prompt compilation is ResultContract-aware and requests no chain of thought", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedStaffedTask(kernel);
    const started = kernel.startWorkerRun({ taskId: flow.task.id });
    const bound = kernel.bindWorkerExecution({
      workerRunId: started.workerRun.id,
      generation: started.generation,
      backendType: CODEX_EXEC_ADAPTER_TYPE,
      backendVersion: "0.0.0-stub",
      executionProfileDigest: "sha256:unit-profile",
      workspaceRoot: "/unit/workspace",
      scratchRoot: "/unit/scratch",
    });
    const input = buildWorkerRunInput({
      run: started.workerRun,
      binding: bound.binding,
      effectivePolicy: {
        sandboxMode: "sandbox",
        workspaceRoot: "/unit/workspace",
        scratchRoot: "/unit/scratch",
        knownLimitations: [],
      },
    });
    const prompt = compileCodexPrompt({
      input,
      verification: { command: ["node", "--test"] },
      protectedPaths: ["test/"],
      baseSha: "0123456789abcdef0123456789abcdef01234567",
    });
    assert.match(prompt, /- Employee: Analyst A/);
    assert.match(prompt, /The repository's verification command will be run independently/);
    assert.match(prompt, /node --test/);
    assert.match(prompt, /test\//);
    assert.match(prompt, /No git commit, no git push, no remote change, no publishing and no deployment/);
    assert.equal(/chain of thought/i.test(prompt), false, "the prompt never asks for reasoning traces");
    assert.match(prompt, /"outcome"/);
    assert.deepEqual(Object.keys(artifactReportSchema().properties), [
      "outcome",
      "summary",
      "completionClaim",
      "reportedVerification",
      "blockers",
    ]);
    assert.deepEqual(Object.keys(reviewReportSchema().properties), ["verdict", "findings", "summary"]);
  } finally {
    cleanup();
  }
});

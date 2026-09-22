// Worker Harness v0 — contract-level tests (Slice 1.1).
// Contract: docs/contracts/worker-harness-v0.md
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOST_STATUS,
  RESULT_CONTRACT_KINDS,
  WORKER_ADAPTER_METHODS,
  WORKER_ADAPTER_TERMINAL_STATUSES,
  WORKER_EVENT_KINDS,
  WORKER_REVIEW_VERDICTS,
  WORKSPACE_LEASE_STATES,
  assertAdapterManifest,
  assertWorkerAdapter,
  buildHarnessEvidence,
  buildWorkerRunInput,
  createStaticWorkerBackendResolver,
  defaultRequestedPolicy,
  defaultResultContract,
  ensureRunWorkspace,
  executionProfileDigest,
  harnessEvidenceDigest,
  leaseStateForRun,
  normalizeAdapterResult,
  normalizeWorkerEvent,
  parseWorkerResult,
  parseWorkerReviewResult,
  resultContractForWorkPacket,
  reviewResultContract,
  runWorkspaceLayout,
  workerResultDigest,
  workerReviewResultDigest,
  newWorkerEvent,
} from "../../packages/harness/index.mjs";
import { createTestWorkerAdapter } from "../../packages/harness/adapters/test-worker.mjs";
import { openTempKernel, reopenKernel, seedStaffedTask } from "../support/kernel.mjs";

const validResult = (overrides = {}) => ({
  resultVersion: 1,
  outcome: "SUCCEEDED",
  summary: "the deterministic run finished",
  reportedVerification: "wrote and read back its own file",
  blockers: [],
  proposedArtifacts: [{ kind: "document", title: "Output", content: "bytes\n" }],
  suggestedNextActions: [],
  ...overrides,
});

test("the adapter contract is exactly the five frozen methods", () => {
  assert.deepEqual(WORKER_ADAPTER_METHODS, ["manifest", "start", "events", "wait", "cancel"]);
  const adapter = createTestWorkerAdapter();
  assert.equal(assertWorkerAdapter(adapter), adapter);
  for (const method of WORKER_ADAPTER_METHODS) {
    const broken = { ...adapter };
    delete broken[method];
    assert.throws(() => assertWorkerAdapter(broken), new RegExp(`${method}\\(\\)`));
  }
});

test("the deterministic adapter exists and is honest about containment", () => {
  const manifest = assertAdapterManifest(createTestWorkerAdapter().manifest());
  assert.equal(manifest.adapterType, "test-worker");
  assert.equal(manifest.containment.sandboxMode, "none");
  assert.ok(
    manifest.containment.knownLimitations.length > 0,
    "a backend that contains nothing must say so",
  );
  assert.throws(
    () => assertAdapterManifest({ adapterType: "x", adapterVersion: "1", containment: { sandboxMode: "vibes" } }),
    /sandboxMode/,
  );
});

test("the adapter cancel is idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fc-harness-unit-"));
  try {
    const adapter = createTestWorkerAdapter({ behavior: "hang" });
    const workspaceRoot = join(dir, "workspace");
    const scratchRoot = join(dir, "scratch");
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(scratchRoot, { recursive: true });
    const handle = adapter.start(
      { workerRunId: "run_x", generation: 1, workPacket: {}, workPacketDigest: "sha256:x" },
      { workspaceRoot, scratchRoot },
    );
    adapter.cancel(handle, "WORKER_TIMEOUT");
    adapter.cancel(handle, "WORKER_TIMEOUT");
    adapter.cancel(handle, "anything at all");
    const terminal = await adapter.wait(handle, { timeoutMs: 10 });
    assert.equal(terminal.terminalStatus, "CANCELLED");
    assert.equal(
      normalizeAdapterResult(terminal).resultCandidate,
      null,
      "a cancel never invents a result",
    );
    const events = [];
    for await (const event of adapter.events(handle)) events.push(event);
    assert.deepEqual(
      events.map((event) => event.kind),
      ["RUN_STARTED", "TOOL_FINISHED"],
      "cancelling ends the stream without inventing a result",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the event vocabulary is frozen and normalized at the Host boundary", () => {
  assert.deepEqual(WORKER_EVENT_KINDS, ["RUN_STARTED", "TOOL_FINISHED", "RESULT_READY", "RUN_FAILED", "PROGRESS"]);
  const event = newWorkerEvent({ kind: "PROGRESS", sequence: 1, detail: { percent: 10 }, at: "t" });
  assert.deepEqual(normalizeWorkerEvent(event), event);
  assert.throws(() => normalizeWorkerEvent({ kind: "codex.message.delta", sequence: 1 }), /unknown worker event/);
  assert.throws(() => normalizeWorkerEvent({ kind: "PROGRESS", sequence: 0 }), /sequence/);
  assert.throws(
    () => normalizeWorkerEvent({ kind: "PROGRESS", sequence: 1, detail: { text: "x".repeat(5000) } }),
    /detail/,
  );
});

test("WorkerRunInput is the durable packet plus an execution envelope, nothing duplicated", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedStaffedTask(kernel);
    const started = kernel.startWorkerRun({ taskId: flow.task.id });
    const bound = kernel.bindWorkerExecution({
      workerRunId: started.workerRun.id,
      generation: started.generation,
      backendType: "test-worker",
      backendVersion: "0.1.0",
      executionProfileDigest: "sha256:profile",
      workspaceRoot: "/tmp/run/workspace",
      scratchRoot: "/tmp/run/scratch",
    });
    const input = buildWorkerRunInput({
      run: started.workerRun,
      binding: bound.binding,
      effectivePolicy: {
        sandboxMode: "none",
        workspaceRoot: "/tmp/run/workspace",
        scratchRoot: "/tmp/run/scratch",
        knownLimitations: ["nothing is contained"],
      },
    });
    assert.equal(input.workerRunId, started.workerRun.id);
    assert.equal(input.workPacketDigest, started.workerRun.workPacketDigest);
    assert.deepEqual(input.workPacket, started.workerRun.workPacket);
    assert.equal(input.executionBinding.id, bound.binding.id);
    assert.equal(input.executionPolicy.requested.network, false);
    assert.equal(input.executionPolicy.effective.sandboxMode, "none");
    assert.deepEqual(input.executionPolicy.effective.knownLimitations, ["nothing is contained"]);
    assert.deepEqual(input.resultContract, defaultResultContract());
    // The envelope never restates WorkPacket facts.
    for (const duplicated of ["task", "work", "requirements", "assignment", "employee", "position"])
      assert.equal(duplicated in input, false, `${duplicated} belongs to the WorkPacket`);
  } finally {
    cleanup();
  }
});

test("requested restriction is never presented as proven containment", () => {
  const requested = defaultRequestedPolicy();
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedStaffedTask(kernel);
    const started = kernel.startWorkerRun({ taskId: flow.task.id });
    const bound = kernel.bindWorkerExecution({
      workerRunId: started.workerRun.id,
      generation: started.generation,
      backendType: "test-worker",
      backendVersion: "0.1.0",
      executionProfileDigest: "sha256:profile",
      workspaceRoot: "/tmp/run/workspace",
      scratchRoot: "/tmp/run/scratch",
    });
    const input = buildWorkerRunInput({
      run: started.workerRun,
      binding: bound.binding,
      requestedPolicy: requested,
      effectivePolicy: {
        sandboxMode: "none",
        workspaceRoot: "/tmp/run/workspace",
        scratchRoot: "/tmp/run/scratch",
        knownLimitations: ["no OS-level isolation"],
      },
    });
    assert.equal(input.executionPolicy.requested.network, false);
    assert.notEqual(
      input.executionPolicy.effective.sandboxMode,
      input.executionPolicy.requested.sandboxMode,
      "requested facts and effective facts live in separate places",
    );
    assert.equal("sandboxMode" in input.executionPolicy.requested, false);
    assert.deepEqual(input.executionPolicy.effective.knownLimitations, ["no OS-level isolation"]);
  } finally {
    cleanup();
  }
});

test("the Host parses a WorkerResult strictly and refuses everything else", () => {
  const parsed = parseWorkerResult(validResult());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result.outcome, "SUCCEEDED");
  assert.equal(Object.isFrozen(parsed.result), true);
  for (const [label, raw] of [
    ["not an object", "text"],
    ["unknown outcome", validResult({ outcome: "MAYBE" })],
    ["missing summary", validResult({ summary: null })],
    ["unknown field", validResult({ confidence: 1 })],
    ["unsupported version", validResult({ resultVersion: 99 })],
    ["unbounded blocker", validResult({ blockers: ["x".repeat(600)] })],
    ["bad artifact", validResult({ proposedArtifacts: [{ kind: "k", title: "t" }] })],
  ])
    assert.equal(parseWorkerResult(raw).ok, false, `${label} must not parse`);
});

test("the result digest is stable and content-bound", () => {
  const first = parseWorkerResult(validResult()).result;
  const same = parseWorkerResult(validResult()).result;
  const other = parseWorkerResult(
    validResult({ proposedArtifacts: [{ kind: "document", title: "Output", content: "different\n" }] }),
  ).result;
  assert.equal(workerResultDigest(first), workerResultDigest(same));
  assert.notEqual(workerResultDigest(first), workerResultDigest(other));
});

test("HarnessEvidence is the Host's observation, never the Worker's report", () => {
  const run = { id: "run_1", generation: 1, taskId: "tsk_1" };
  const evidence = buildHarnessEvidence({
    run,
    processOutcome: "SUCCEEDED",
    events: [newWorkerEvent({ kind: "RUN_STARTED", sequence: 1, at: "t" })],
    resultParse: "PARSED",
    reportedVerification: "the Worker said its tests passed",
    containment: {
      sandboxMode: "none",
      workspaceRoot: "/tmp/w",
      scratchRoot: "/tmp/s",
      knownLimitations: ["none"],
    },
    observedAt: "t1",
  });
  assert.equal(evidence.resultParse, "PARSED");
  assert.equal(evidence.verification.status, "REPORTED");
  assert.equal(evidence.containment.sandboxMode, "none");
  assert.deepEqual(evidence.eventKinds, ["RUN_STARTED"]);
  assert.equal("proposedArtifacts" in evidence, false, "evidence is not the result");
  assert.equal(evidence.evidenceDigest, harnessEvidenceDigest(evidence));
  const other = buildHarnessEvidence({
    run,
    processOutcome: "TIMEOUT",
    events: [],
    resultParse: "NOT_ATTEMPTED",
    containment: evidence.containment,
    observedAt: "t2",
  });
  assert.notEqual(other.evidenceDigest, evidence.evidenceDigest);
});

test("workspaces are run-scoped, generation-scoped and never the scratch directory", () => {
  const base = { runtimeRoot: "/runtime", workId: "wrk_1", workerRunId: "run_1" };
  const first = runWorkspaceLayout({ ...base, generation: 1 });
  const firstAgain = runWorkspaceLayout({ ...base, generation: 1 });
  const second = runWorkspaceLayout({ ...base, generation: 2 });
  const otherRun = runWorkspaceLayout({ ...base, workerRunId: "run_2", generation: 1 });
  assert.deepEqual(first, firstAgain, "the layout is deterministic");
  assert.notEqual(first.runRoot, second.runRoot, "a new generation gets a new tree");
  assert.notEqual(first.runRoot, otherRun.runRoot, "a new attempt gets a new tree");
  assert.notEqual(first.workspaceRoot, first.scratchRoot);
  assert.match(first.workspaceRoot, /run_1-g1\/workspace$/);
  assert.match(first.scratchRoot, /run_1-g1\/scratch$/);
});

test("the workspace lease is derived from WorkerRun state, never stored", () => {
  assert.equal(leaseStateForRun("RUNNING"), WORKSPACE_LEASE_STATES.ACTIVE);
  assert.equal(leaseStateForRun("COMPLETED"), WORKSPACE_LEASE_STATES.RELEASED);
  assert.equal(leaseStateForRun("CANCELLED"), WORKSPACE_LEASE_STATES.RELEASED);
  assert.equal(leaseStateForRun("INTERRUPTED"), WORKSPACE_LEASE_STATES.INVALIDATED);
  assert.throws(() => leaseStateForRun("PARKED"), /unknown WorkerRun state/);
});

test("the static resolver is deterministic, replaceable and ranks nothing", () => {
  const resolver = createStaticWorkerBackendResolver();
  const run = { id: "run_1" };
  const first = resolver.resolve({ workerRun: run, employee: { id: "emp_1" }, position: { id: "pos_1" } });
  const second = resolver.resolve({ workerRun: run, employee: { id: "emp_1" }, position: { id: "pos_1" } });
  assert.deepEqual(first, second);
  assert.equal(first.backendType, "test-worker");
  assert.equal(Array.isArray(first.candidates), false, "a resolver is not a ranking");
  assert.equal(resolver.resolve({}), null, "no attempt, no backend");
});

test("a WorkerExecutionBinding is immutable, idempotent on retry, and never rebound", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedStaffedTask(kernel);
    const started = kernel.startWorkerRun({ taskId: flow.task.id });
    const facts = {
      workerRunId: started.workerRun.id,
      generation: started.generation,
      backendType: "test-worker",
      backendVersion: "0.1.0",
      executionProfileDigest: "sha256:profile",
      workspaceRoot: "/tmp/runs/run_1-g1/workspace",
      scratchRoot: "/tmp/runs/run_1-g1/scratch",
    };
    const bound = kernel.bindWorkerExecution(facts);
    assert.equal(bound.idempotent, false);
    assert.equal(bound.binding.companyId, flow.company.id);
    assert.equal(bound.binding.workId, flow.work.id);
    assert.equal(bound.binding.taskId, flow.task.id);
    assert.equal(bound.binding.workerRunId, started.workerRun.id);
    assert.equal(bound.binding.generation, started.generation);

    const retry = kernel.bindWorkerExecution(facts);
    assert.equal(retry.idempotent, true);
    assert.equal(retry.binding.id, bound.binding.id, "an exact retry returns the committed binding");

    assert.throws(
      () => kernel.bindWorkerExecution({ ...facts, workspaceRoot: "/tmp/elsewhere/workspace" }),
      { code: "EXECUTION_BINDING_CONFLICT" },
    );
    assert.throws(
      () => kernel.bindWorkerExecution({ ...facts, backendType: "codex-exec" }),
      { code: "EXECUTION_BINDING_CONFLICT" },
    );
    assert.throws(
      () => kernel.store.db.prepare("UPDATE worker_execution_bindings SET branch='x' WHERE id=?").run(bound.binding.id),
      /WORKER_EXECUTION_BINDING_IMMUTABLE/,
    );
    assert.equal(kernel.workerExecutionBinding(started.workerRun.id).id, bound.binding.id);
    assert.equal(kernel.workerExecutionBindings({ workId: flow.work.id }).length, 1);
  } finally {
    cleanup();
  }
});

test("a binding requires a live attempt at the exact generation", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedStaffedTask(kernel);
    const started = kernel.startWorkerRun({ taskId: flow.task.id });
    const facts = {
      workerRunId: started.workerRun.id,
      generation: started.generation,
      backendType: "test-worker",
      backendVersion: "0.1.0",
      executionProfileDigest: "sha256:profile",
      workspaceRoot: "/tmp/runs/run_1-g1/workspace",
      scratchRoot: "/tmp/runs/run_1-g1/scratch",
    };
    assert.throws(() => kernel.bindWorkerExecution({ ...facts, generation: 99 }), { code: "STALE_GENERATION" });
    assert.throws(() => kernel.bindWorkerExecution({ ...facts, workerRunId: "run_missing" }), {
      code: "WORKER_RUN_NOT_FOUND",
    });
    assert.throws(
      () => kernel.bindWorkerExecution({ ...facts, scratchRoot: facts.workspaceRoot }),
      { code: "INVALID_INPUT" },
      "scratch is never the deliverable workspace",
    );
  } finally {
    cleanup();
  }
});

test("an interrupted attempt is not bound to a new execution", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedStaffedTask(kernel);
    const started = kernel.startWorkerRun({ taskId: flow.task.id });
    kernel.interruptWorkerRun({
      workerRunId: started.workerRun.id,
      generation: started.generation,
      reason: "WORKER_PROCESS_EXIT",
    });
    assert.throws(
      () =>
        kernel.bindWorkerExecution({
          workerRunId: started.workerRun.id,
          generation: started.generation,
          backendType: "test-worker",
          backendVersion: "0.1.0",
          executionProfileDigest: "sha256:profile",
          workspaceRoot: "/tmp/x/workspace",
          scratchRoot: "/tmp/x/scratch",
        }),
      { code: "INVALID_TRANSITION" },
    );
  } finally {
    cleanup();
  }
});

test("the observation seam fires after commit, and a failed command publishes nothing", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedStaffedTask(kernel);
    const observed = [];
    kernel.setWorkerRunObserver((notice) => observed.push(notice.workerRunId));

    const started = kernel.startWorkerRun({ taskId: flow.task.id });
    assert.deepEqual(observed, [started.workerRun.id]);

    // A rolled-back command publishes nothing: the insert fails, the
    // transaction rolls back, and no WorkerRun exists to observe.
    const second = kernel.createTask({ workId: flow.work.id, title: "Second", intent: "x" });
    kernel.assignTask({ taskId: second.id, employeeId: flow.employee.id, reason: "fixture" });
    const insert = kernel.store.insertWorkerRun.bind(kernel.store);
    kernel.store.insertWorkerRun = () => {
      throw new Error("injected failure inside the transaction");
    };
    assert.throws(() => kernel.startWorkerRun({ taskId: second.id }), /injected failure/);
    kernel.store.insertWorkerRun = insert;
    assert.equal(observed.length, 1, "a rolled-back attempt was never observed");
    assert.equal(kernel.workerRuns({ taskId: second.id }).length, 0);
    assert.equal(kernel.task(second.id).state, "OPEN", "the Task rolled back with the attempt");
  } finally {
    cleanup();
  }
});

test("a throwing observer never fails a committed command", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedStaffedTask(kernel);
    kernel.setWorkerRunObserver(() => {
      throw new Error("observer is broken");
    });
    const started = kernel.startWorkerRun({ taskId: flow.task.id });
    assert.equal(started.workerRun.state, "RUNNING");
    assert.equal(kernel.workerRuns({ taskId: flow.task.id }).length, 1);
  } finally {
    cleanup();
  }
});

test("the reconciliation read returns only RUNNING attempts", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedStaffedTask(kernel);
    const first = kernel.startWorkerRun({ taskId: flow.task.id });
    kernel.interruptWorkerRun({
      workerRunId: first.workerRun.id,
      generation: first.generation,
      reason: "WORKER_TIMEOUT",
    });
    const second = kernel.startWorkerRun({ taskId: flow.task.id });
    const running = kernel.workerRuns({ state: "RUNNING" });
    assert.deepEqual(running.map((run) => run.id), [second.workerRun.id]);
    assert.throws(() => kernel.workerRuns({ state: "PARKED" }), { code: "INVALID_INPUT" });
  } finally {
    cleanup();
  }
});

test("execution profile digests bind backend, containment and requested intent", () => {
  const effective = {
    sandboxMode: "none",
    workspaceRoot: "/tmp/w",
    scratchRoot: "/tmp/s",
    knownLimitations: ["nope"],
  };
  const digest = executionProfileDigest({
    backendType: "test-worker",
    backendVersion: "0.1.0",
    effectivePolicy: effective,
  });
  assert.match(digest, /^sha256:/);
  assert.notEqual(
    digest,
    executionProfileDigest({
      backendType: "test-worker",
      backendVersion: "0.2.0",
      effectivePolicy: effective,
    }),
  );
  assert.notEqual(
    digest,
    executionProfileDigest({
      backendType: "test-worker",
      backendVersion: "0.1.0",
      effectivePolicy: { ...effective, workspaceRoot: "/tmp/other" },
    }),
  );
});

test("workspace directories are real and created on demand", () => {
  const dir = mkdtempSync(join(tmpdir(), "fc-harness-dirs-"));
  try {
    const layout = runWorkspaceLayout({
      runtimeRoot: dir,
      workId: "wrk_1",
      workerRunId: "run_1",
      generation: 1,
    });
    assert.equal(existsSync(layout.workspaceRoot), false);
    ensureRunWorkspace(layout);
    assert.equal(existsSync(layout.workspaceRoot), true);
    assert.equal(existsSync(layout.scratchRoot), true);
    writeFileSync(join(layout.workspaceRoot, "probe.txt"), "hello", "utf8");
    assert.equal(existsSync(join(layout.workspaceRoot, "probe.txt")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the host status vocabulary is exported and frozen", () => {
  assert.equal(Object.isFrozen(HOST_STATUS), true);
  assert.ok(HOST_STATUS.DELIVERED);
  assert.equal(
    "DEFERRED_REVIEW_SEAM" in HOST_STATUS,
    false,
    "the review seam is delivered, not deferred",
  );
  for (const status of ["INTERRUPTED", "CANCELLED", "REFUSED", "SKIPPED_NOT_RUNNING"])
    assert.ok(HOST_STATUS[status]);
});

// --- Slice 1.1: role-specific contracts and the adapter parse boundary ------

test("the result contract is role-specific and derived from Runtime truth, never chosen", () => {
  assert.equal(defaultResultContract().kind, RESULT_CONTRACT_KINDS.ARTIFACT_DELIVERY);
  assert.equal(reviewResultContract().kind, RESULT_CONTRACT_KINDS.REVIEW_JUDGMENT);
  assert.deepEqual(reviewResultContract().verdicts, [...WORKER_REVIEW_VERDICTS]);
  // The packet's review section is the Runtime's decision, carried durably.
  const production = { task: { id: "tsk_1" }, review: null };
  const review = { task: { id: "tsk_2" }, review: { reviewRequestId: "rrq_1" } };
  assert.equal(resultContractForWorkPacket(production).kind, "ARTIFACT_DELIVERY");
  assert.equal(resultContractForWorkPacket(review).kind, "REVIEW_JUDGMENT");
  assert.equal(resultContractForWorkPacket(null).kind, "ARTIFACT_DELIVERY");
  for (const contract of [defaultResultContract(), reviewResultContract()])
    assert.equal(Object.isFrozen(contract), true, "a contract is never mutated in flight");
});

test("the adapter result boundary is exactly the declared shape", () => {
  assert.deepEqual(WORKER_ADAPTER_TERMINAL_STATUSES, ["SUCCEEDED", "FAILED", "CANCELLED"]);
  const normalized = normalizeAdapterResult({
    terminalStatus: "SUCCEEDED",
    resultCandidate: { anything: true },
    adapterMeta: { backend: "x" },
  });
  assert.equal(normalized.resultCandidate.anything, true);
  assert.equal(normalized.failureReason, null);
  assert.equal(Object.isFrozen(normalized), true);
  for (const [label, raw] of [
    ["the Slice 1 shape", { outcome: "SUCCEEDED", rawResult: {} }],
    ["nothing at all", null],
    ["an unknown terminal status", { terminalStatus: "MAYBE" }],
    ["a FAILED without a reason", { terminalStatus: "FAILED" }],
    ["a SUCCEEDED with a failure reason", { terminalStatus: "SUCCEEDED", failureReason: "PROCESS_EXIT" }],
    ["an unknown field", { terminalStatus: "SUCCEEDED", verdict: "PASS" }],
    ["an oversized meta", { terminalStatus: "SUCCEEDED", adapterMeta: { blob: "x".repeat(5000) } }],
  ])
    assert.throws(() => normalizeAdapterResult(raw), Error, `${label} must not normalize`);
});

const validReviewResult = (overrides = {}) => ({
  schemaVersion: 1,
  workerRunId: "run_1",
  generation: 1,
  verdict: "PASS",
  findings: [],
  summary: "the artifact matches the intent it was given",
  ...overrides,
});

test("the Host parses a WorkerReviewResult strictly and refuses everything else", () => {
  const parsed = parseWorkerReviewResult(validReviewResult());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.result.verdict, "PASS");
  assert.equal(Object.isFrozen(parsed.result), true);
  assert.equal(Object.isFrozen(parsed.result.findings), true);
  for (const [label, raw] of [
    ["not an object", "text"],
    ["an unknown verdict", validReviewResult({ verdict: "MAYBE" })],
    ["a score nobody consumes", validReviewResult({ score: 0.9 })],
    ["an unsupported version", validReviewResult({ schemaVersion: 99 })],
    ["no worker run", validReviewResult({ workerRunId: "" })],
    ["no generation", validReviewResult({ generation: "1" })],
    ["a revision with no findings", validReviewResult({ verdict: "REQUEST_REVISION" })],
    ["an unbounded finding", validReviewResult({ findings: ["x".repeat(1001)] })],
    ["an unbounded summary", validReviewResult({ summary: "x".repeat(2001) })],
  ])
    assert.equal(parseWorkerReviewResult(raw).ok, false, `${label} must not parse`);
  // `summary` is optional on the wire; whether it is deliverable is the Host's
  // delivery check, because the frozen Review primitive requires one.
  assert.equal(parseWorkerReviewResult(validReviewResult({ summary: undefined })).ok, true);
});

test("the two contracts never parse each other's candidate", () => {
  // An attempt that returns the wrong role's result is a protocol problem, not
  // a delivery: the Host validates against the contract the packet granted.
  assert.equal(parseWorkerResult(validReviewResult()).ok, false);
  assert.equal(parseWorkerReviewResult(validResult()).ok, false);
  assert.equal(parseWorkerReviewResult(validResult({ verdict: "PASS" })).ok, false);
});

test("the review digest is stable and content-bound", () => {
  const first = parseWorkerReviewResult(validReviewResult()).result;
  const same = parseWorkerReviewResult(validReviewResult()).result;
  const other = parseWorkerReviewResult(validReviewResult({ verdict: "REQUEST_REVISION", findings: ["change it"] })).result;
  assert.equal(workerReviewResultDigest(first), workerReviewResultDigest(same));
  assert.notEqual(workerReviewResultDigest(first), workerReviewResultDigest(other));
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildHarnessEvidence,
  createAuthorizedToolSession,
  createFakeActuator,
  createGenericModelWorkerAdapter,
  createTestModelBackend,
  createToolBudget,
  createToolGrant,
  harnessEvidenceDigest,
} from "../../packages/harness/index.mjs";
import { openTempKernel, seedStaffedTask } from "../support/kernel.mjs";

const SEARCH = "research.web.search";
const READ = "research.web.read";
const skill = {
  skillId: "BoundedMethod",
  version: "1",
  requiredCapabilities: ["capability.x"],
  allowedToolCapabilities: [SEARCH, READ],
};

async function withRun(callback) {
  const fixture = openTempKernel();
  try {
    const { task } = seedStaffedTask(fixture.kernel);
    const run = fixture.kernel.startWorkerRun({ taskId: task.id }).workerRun;
    return await callback(run);
  } finally {
    fixture.kernel.close();
    fixture.cleanup();
  }
}

test("ToolSession closes after a denied request; repeated probing adds no receipts or Actuator calls", async () => {
  await withRun(async (run) => {
    const actuator = createFakeActuator({ responses: { [SEARCH]: { hits: [] } } });
    const grant = createToolGrant({ run, skill, approvedCapabilities: [], actuators: [actuator] });
    const session = createAuthorizedToolSession({ run, grant, budget: createToolBudget({ maxToolCalls: 2 }), actuators: [actuator] });
    await assert.rejects(session.invoke({ callId: "denied", capability: SEARCH, input: {} }), { code: "TOOL_DENIED" });
    for (let i = 0; i < 100; i += 1)
      await assert.rejects(session.invoke({ callId: `probe-${i}`, capability: SEARCH, input: {} }), { code: "TOOL_DENIED" });
    assert.equal(session.snapshot().receipts.length, 1);
    assert.equal(actuator.calls.length, 0);
  });
});

test("only a valid authorized dispatch spends execution budget; exhaustion never invokes Actuator", async () => {
  await withRun(async (run) => {
    const actuator = createFakeActuator({ responses: { [SEARCH]: { hits: ["fixture"] } } });
    const grant = createToolGrant({ run, skill, approvedCapabilities: [SEARCH], actuators: [actuator] });
    const budget = createToolBudget({ maxToolCalls: 1 });
    const session = createAuthorizedToolSession({ run, grant, budget, actuators: [actuator] });
    const first = await session.invoke({ callId: "one", capability: SEARCH, input: { query: "fixture" } });
    assert.equal(first.type, "TOOL_RESULT");
    await assert.rejects(session.invoke({ callId: "two", capability: SEARCH, input: {} }), { code: "TOOL_BUDGET_EXHAUSTED" });
    await assert.rejects(session.invoke({ callId: "three", capability: SEARCH, input: {} }), { code: "TOOL_BUDGET_EXHAUSTED" });
    assert.deepEqual(session.snapshot().receipts.map((receipt) => receipt.status), ["SUCCEEDED", "TOOL_BUDGET_EXHAUSTED"]);
    assert.equal(actuator.calls.length, 1);
    assert.throws(() => createAuthorizedToolSession({ run: { ...run, generation: run.generation + 1 }, grant, budget, actuators: [actuator] }), /generation/);
  });
});

test("Host receipt callback identifies the Actuator that actually ran", async () => {
  await withRun(async (run) => {
    const selected = createFakeActuator({ responses: { [SEARCH]: { hits: ["selected"] } } });
    const unused = createFakeActuator({ responses: { [SEARCH]: { hits: ["unused"] } } });
    const grant = createToolGrant({ run, skill, approvedCapabilities: [SEARCH], actuators: [selected, unused] });
    const observed = [];
    const session = createAuthorizedToolSession({ run, grant, budget: createToolBudget({ maxToolCalls: 1 }),
      actuators: [selected, unused], onReceipt: ({ receipt, actuator }) => observed.push({ receipt, actuator }) });
    await session.invoke({ callId: "selected", capability: SEARCH, input: { query: "fixture" } });
    assert.equal(observed[0].receipt.status, "SUCCEEDED");
    assert.equal(observed[0].actuator, selected);
    assert.equal(unused.calls.length, 0);
  });
});

test("elapsed, input and output limits fail closed with bounded receipts", async () => {
  await withRun(async (run) => {
    const actuator = createFakeActuator({ responses: { [SEARCH]: { text: "x".repeat(70 * 1024) } } });
    const grant = createToolGrant({ run, skill, approvedCapabilities: [SEARCH], actuators: [actuator] });
    const budget = createToolBudget({ maxToolCalls: 1, maxElapsedMs: 100, toolTimeoutMs: 50 });
    const oversizedInput = createAuthorizedToolSession({ run, grant, budget, actuators: [actuator] });
    await assert.rejects(oversizedInput.invoke({ callId: "input", capability: SEARCH, input: { text: "x".repeat(9 * 1024) } }), { code: "TOOL_PROTOCOL_ERROR" });
    assert.equal(oversizedInput.snapshot().receipts.length, 1);
    const oversizedOutput = createAuthorizedToolSession({ run, grant, budget, actuators: [actuator] });
    await assert.rejects(oversizedOutput.invoke({ callId: "output", capability: SEARCH, input: {} }), { code: "TOOL_OUTPUT_INVALID" });
    assert.equal(oversizedOutput.snapshot().receipts.length, 1);
    assert.doesNotMatch(JSON.stringify(oversizedOutput.snapshot()), /x{100}/);
    let clock = 0;
    const elapsed = createAuthorizedToolSession({ run, grant, budget, actuators: [actuator], now: () => clock });
    clock = 101;
    await assert.rejects(elapsed.invoke({ callId: "late", capability: SEARCH, input: {} }), { code: "TOOL_BUDGET_EXHAUSTED" });
    assert.equal(actuator.calls.length, 1, "only the oversized-output call reached the Actuator");
  });
});

test("v1 evidence digest stays byte-identical; v2 digest covers result and bounded tool receipts", () => {
  const legacy = {
    evidenceVersion: 1,
    workerRunId: "run_v1",
    generation: 1,
    taskId: "task_v1",
    processOutcome: "SUCCEEDED",
    eventCount: 1,
    eventKinds: ["RUN_STARTED"],
    resultParse: "PARSED",
    verification: { status: "NOT_PERFORMED", summary: null },
    containment: { sandboxMode: "none", workspaceRoot: "workspace", scratchRoot: "scratch", knownLimitations: [] },
    observedAt: "2026-01-01T00:00:00.000Z",
  };
  assert.equal(harnessEvidenceDigest(legacy), "sha256:9c5f9e694ee0e68312cb32604e24f1f632695d62c687da2c3bc33ad84358781c");

  const budget = createToolBudget({ maxToolCalls: 2, maxCallsByCapability: { [SEARCH]: 1, [READ]: 1 } });
  const reverse = createToolBudget({ maxToolCalls: 2, maxCallsByCapability: { [READ]: 1, [SEARCH]: 1 } });
  assert.deepEqual(budget, reverse, "equivalent per-capability policy has canonical ordering");
  const args = {
    run: { id: "run_v2", generation: 1, taskId: "task_v2" },
    processOutcome: "SUCCEEDED", events: [], resultParse: "PARSED",
    containment: legacy.containment, observedAt: legacy.observedAt,
    resultDigest: "sha256:result-a",
    toolSessionEvidence: {
      grantDigest: "sha256:grant", skillId: "BoundedMethod", skillVersion: "1", budget,
      receipts: [{ callId: "one", capability: SEARCH, status: "SUCCEEDED", inputDigest: "sha256:input", outputDigest: "sha256:output", durationMs: 1 }],
    },
  };
  const first = buildHarnessEvidence(args);
  assert.equal(first.evidenceVersion, 2);
  assert.equal(first.toolSession.sources, undefined, "existing non-Web v2 evidence has no source extension");
  assert.equal(first.evidenceDigest, harnessEvidenceDigest(first));
  assert.notEqual(buildHarnessEvidence({ ...args, resultDigest: "sha256:result-b" }).evidenceDigest, first.evidenceDigest);
  assert.notEqual(buildHarnessEvidence({ ...args, failureCode: "PROVIDER_ERROR" }).evidenceDigest, first.evidenceDigest);
  assert.notEqual(buildHarnessEvidence({ ...args, toolSessionEvidence: { ...args.toolSessionEvidence, receipts: [] } }).evidenceDigest, first.evidenceDigest);
  assert.throws(() => buildHarnessEvidence({ ...args, toolSessionEvidence: { ...args.toolSessionEvidence, receipts: Array(34).fill(args.toolSessionEvidence.receipts[0]) } }), /bounded/);
});

test("GenericModelWorkerAdapter.cancel is idempotent during ModelBackend invocation", async () => {
  let started;
  const invoked = new Promise((resolve) => { started = resolve; });
  let aborted = false;
  const backend = createTestModelBackend({ steps: [({ abortSignal }) => {
    started();
    return new Promise((_, reject) => abortSignal.addEventListener("abort", () => {
      aborted = true;
      reject(new Error("aborted"));
    }, { once: true }));
  }] });
  const adapter = createGenericModelWorkerAdapter({ modelBackend: backend, skill: { ...skill, rules: [] } });
  const handle = adapter.start({ workerRunId: "run_test", generation: 1, workPacket: {}, resultContract: { kind: "ARTIFACT_DELIVERY" } });
  await invoked;
  await adapter.cancel(handle, "FIRST");
  await adapter.cancel(handle, "SECOND");
  assert.equal(aborted, true);
  assert.equal(backend.calls.length, 1);
  assert.deepEqual(await adapter.wait(handle), { terminalStatus: "CANCELLED", reason: "FIRST" });
});

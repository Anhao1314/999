import test from "node:test";
import assert from "node:assert/strict";
import {
  createFakeActuator,
  createGenericModelWorkerAdapter,
  createStaticWorkerBackendResolver,
  createTestModelBackend,
  createToolGrant,
  createWorkerHost,
  GENERIC_MODEL_WORKER_ADAPTER_TYPE,
  HARNESS_EVIDENCE_VERSION,
} from "../../packages/harness/index.mjs";
import { createContinuationDriver } from "../../packages/runtime/index.mjs";
import { openTempKernel, reopenKernel, seedStaffedTask, seedTaskInReview, startReviewRun } from "../support/kernel.mjs";

const SEARCH = "research.web.search";
const READ = "research.web.read";
const SKILL = Object.freeze({
  skillId: "DeterministicResearch",
  version: "0.1.0",
  requiredCapabilities: ["capability.x"],
  allowedToolCapabilities: [SEARCH, READ],
  rules: ["Return the Runtime-selected result contract."],
});

const artifact = {
  resultVersion: 1,
  outcome: "SUCCEEDED",
  summary: "The search and read results were incorporated.",
  blockers: [],
  proposedArtifacts: [{ kind: "document", title: "Research note", content: "Evidence from the fake search and read.\n" }],
  suggestedNextActions: [],
};

function openFlow({ steps, responses = { [SEARCH]: { hits: ["fake://item"] }, [READ]: { text: "fixture content" } }, approvedCapabilities = [SEARCH, READ], budget = {}, timeoutMs = 1_000, onInvoke = null, onEvent = null } = {}) {
  const fixture = openTempKernel();
  const modelBackend = createTestModelBackend({ steps });
  const actuator = createFakeActuator({ responses, onInvoke });
  const genericAdapter = createGenericModelWorkerAdapter({ modelBackend, skill: SKILL });
  const adapter = onEvent
    ? Object.freeze({
        ...genericAdapter,
        async *events(handle) {
          for await (const event of genericAdapter.events(handle)) {
            onEvent(event);
            yield event;
          }
        },
      })
    : genericAdapter;
  const host = createWorkerHost({
    kernel: fixture.kernel,
    adapter,
    resolver: createStaticWorkerBackendResolver({ backendType: GENERIC_MODEL_WORKER_ADAPTER_TYPE, backendVersion: "0.1.0-test-model" }),
    runtimeRoot: fixture.dir,
    timeoutMs,
    toolPolicy: { skill: SKILL, approvedCapabilities, actuators: [actuator], budget },
  });
  return { ...fixture, modelBackend, actuator, adapter, host };
}

async function finish(flow, taskId) {
  flow.host.start();
  const started = flow.kernel.startWorkerRun({ taskId });
  await flow.host.idle();
  return flow.kernel.workerRun(started.workerRun.id);
}

test("search → read → FINAL_RESULT uses Host authorization and creates a real Artifact", async () => {
  const flow = openFlow({
    steps: [
      { type: "TOOL_REQUEST", callId: "search-1", capability: SEARCH, input: { query: "fixture" } },
      ({ messages, tools }) => {
        assert.deepEqual(tools, [READ, SEARCH]);
        assert.equal(JSON.parse(messages.at(-1).content).output.hits[0], "fake://item");
        return { type: "TOOL_REQUEST", callId: "read-1", capability: READ, input: { url: "fake://item" } };
      },
      ({ messages }) => {
        assert.equal(JSON.parse(messages.at(-1).content).output.text, "fixture content");
        return { type: "FINAL_RESULT", candidate: artifact };
      },
    ],
  });
  try {
    const { work, task } = seedStaffedTask(flow.kernel);
    const run = await finish(flow, task.id);
    assert.equal(run.state, "COMPLETED");
    assert.equal(flow.kernel.task(task.id).state, "COMPLETED");
    assert.deepEqual(flow.actuator.calls.map((call) => call.capability), [SEARCH, READ]);
    assert.equal(flow.modelBackend.calls.length, 3);
    const candidate = flow.kernel.workProjection(work.id).outcome.candidateArtifacts[0];
    assert.equal(flow.kernel.artifact(candidate.id).content, artifact.proposedArtifacts[0].content);
    const report = flow.host.reportFor(run.id)[0];
    assert.equal(report.status, "DELIVERED");
    assert.equal(report.detail.evidence.evidenceVersion, HARNESS_EVIDENCE_VERSION);
    assert.deepEqual(report.detail.evidence.toolSession.receipts.map((receipt) => receipt.status), ["SUCCEEDED", "SUCCEEDED"]);
    assert.equal(report.detail.evidence.modelExecution.modelSteps, 3);
    assert.ok(report.detail.evidence.modelExecution.outputDigest);
    assert.doesNotMatch(JSON.stringify(report.detail.evidence), /fake:\/\/item|fixture content|"query":"fixture"/);
    assert.equal(flow.kernel.store.resultSubmissionForRun(run.id).detail.evidenceDigest, report.detail.evidenceDigest);
    assert.equal(flow.kernel.store.resultSubmissionForRun(run.id).detail.resultDigest, report.detail.evidence.resultDigest);
    assert.equal(flow.kernel.workProjection(work.id).outcome.accepted, null);
  } finally {
    await flow.host.stop();
    flow.kernel.close();
    flow.cleanup();
  }
});

test("the same GenericModelWorkerAdapter delivers REVIEW_JUDGMENT through WorkerHost", async () => {
  const flow = openFlow({ steps: [({ resultContract, messages }) => {
    assert.equal(resultContract.kind, "REVIEW_JUDGMENT");
    const compiled = JSON.parse(messages[1].content);
    const packet = compiled.workPacket;
    assert.ok(packet.review?.targetArtifact);
    return { type: "FINAL_RESULT", candidate: {
      schemaVersion: 1,
      workerRunId: compiled.workerRunId,
      generation: compiled.generation,
      verdict: "PASS",
      findings: [],
      summary: "The supplied artifact answers the assigned review.",
    } };
  }] });
  try {
    const source = seedTaskInReview(flow.kernel);
    const handoff = flow.kernel.requestReview({ taskId: source.task.id, generation: source.generation });
    flow.host.start();
    const started = startReviewRun(flow.kernel, { reviewTaskId: handoff.reviewTask.id, reviewerId: source.reviewer.id });
    await flow.host.idle();
    const run = flow.kernel.workerRun(started.workerRun.id);
    assert.equal(run.state, "COMPLETED");
    assert.equal(flow.host.reportFor(run.id)[0].status, "DELIVERED");
    assert.equal(flow.kernel.reviews({ workId: source.work.id })[0].reviewerWorkerRunId, run.id);
    assert.equal(flow.actuator.calls.length, 0);
  } finally {
    await flow.host.stop();
    flow.kernel.close();
    flow.cleanup();
  }
});

test("REQUEST_REVISION from GenericModelWorkerAdapter enters the existing Repair continuation", async () => {
  const flow = openFlow({ steps: [({ messages }) => {
    const compiled = JSON.parse(messages[1].content);
    return { type: "FINAL_RESULT", candidate: {
      schemaVersion: 1,
      workerRunId: compiled.workerRunId,
      generation: compiled.generation,
      verdict: "REQUEST_REVISION",
      findings: ["Add the missing downside case."],
      summary: "The artifact needs a revision before the Founder decides.",
    } };
  }] });
  try {
    const source = seedTaskInReview(flow.kernel);
    const handoff = flow.kernel.requestReview({ taskId: source.task.id, generation: source.generation });
    flow.host.start();
    const started = startReviewRun(flow.kernel, { reviewTaskId: handoff.reviewTask.id, reviewerId: source.reviewer.id });
    await flow.host.idle();
    const review = flow.kernel.reviews({ workId: source.work.id })[0];
    assert.equal(review.verdict, "REQUEST_REVISION");
    assert.equal(review.reviewerWorkerRunId, started.workerRun.id);
    assert.equal(flow.kernel.tasks(source.work.id).filter((task) => task.title.startsWith("Repair:")).length, 0,
      "the Adapter did not create Repair work");
    const driver = createContinuationDriver({ kernel: flow.kernel, observe: false });
    driver.driveWork(source.work.id, { triggerType: "EXPLICIT" });
    assert.equal(flow.kernel.tasks(source.work.id).filter((task) => task.title.startsWith("Repair:")).length, 1,
      "ordinary Runtime continuation created the Repair Task");
  } finally {
    await flow.host.stop();
    flow.kernel.close();
    flow.cleanup();
  }
});

test("ToolGrant requires explicit approval even when Task and Skill capabilities match", async () => {
  const flow = openFlow({
    approvedCapabilities: [],
    steps: [{ type: "TOOL_REQUEST", callId: "denied", capability: SEARCH, input: { query: "fixture" } }],
  });
  try {
    const { task } = seedStaffedTask(flow.kernel);
    const started = flow.kernel.startWorkerRun({ taskId: task.id });
    const grant = createToolGrant({ run: started.workerRun, skill: SKILL, approvedCapabilities: [], actuators: [flow.actuator] });
    assert.deepEqual(grant.capabilities, []);
    const ineligible = createToolGrant({
      run: started.workerRun,
      skill: { ...SKILL, requiredCapabilities: ["capability.other"] },
      approvedCapabilities: [SEARCH],
      actuators: [flow.actuator],
    });
    assert.deepEqual(ineligible.capabilities, []);
    flow.host.start();
    await flow.host.idle();
    const run = flow.kernel.workerRun(started.workerRun.id);
    assert.equal(run.state, "INTERRUPTED");
    assert.equal(run.endReason, "WORKER_EXECUTION_FAILED");
    assert.equal(flow.host.reportFor(run.id)[0].detail.failureCode, "TOOL_DENIED");
    assert.equal(flow.host.reportFor(run.id)[0].detail.evidence.failureCode, "TOOL_DENIED");
    assert.equal(flow.actuator.calls.length, 0);
  } finally {
    await flow.host.stop();
    flow.kernel.close();
    flow.cleanup();
  }
});

test("ToolBudget blocks a second call before Actuator invocation", async () => {
  const flow = openFlow({
    budget: { maxToolCalls: 1 },
    steps: [
      { type: "TOOL_REQUEST", callId: "first", capability: SEARCH, input: { query: "fixture" } },
      { type: "TOOL_REQUEST", callId: "second", capability: READ, input: { url: "fake://item" } },
    ],
  });
  try {
    const { task } = seedStaffedTask(flow.kernel);
    const run = await finish(flow, task.id);
    assert.equal(run.endReason, "WORKER_EXECUTION_FAILED");
    assert.equal(flow.host.reportFor(run.id)[0].detail.failureCode, "TOOL_BUDGET_EXHAUSTED");
    assert.deepEqual(flow.actuator.calls.map((call) => call.capability), [SEARCH]);
  } finally {
    await flow.host.stop();
    flow.kernel.close();
    flow.cleanup();
  }
});

test("per-capability budget blocks repeated search without blocking another capability", async () => {
  const flow = openFlow({
    budget: { maxToolCalls: 3, maxCallsByCapability: { [SEARCH]: 1 } },
    steps: [
      { type: "TOOL_REQUEST", callId: "search-1", capability: SEARCH, input: { query: "first" } },
      { type: "TOOL_REQUEST", callId: "search-2", capability: SEARCH, input: { query: "second" } },
    ],
  });
  try {
    const { task } = seedStaffedTask(flow.kernel);
    const run = await finish(flow, task.id);
    assert.equal(run.endReason, "WORKER_EXECUTION_FAILED");
    assert.deepEqual(flow.actuator.calls.map((call) => call.input.query), ["first"]);
  } finally {
    await flow.host.stop();
    flow.kernel.close();
    flow.cleanup();
  }
});

test("malformed and repeated tool requests interrupt as protocol errors", async (t) => {
  for (const steps of [
    [{ type: "TOOL_REQUEST", callId: "missing-input", capability: SEARCH }],
    [
      { type: "TOOL_REQUEST", callId: "same", capability: SEARCH, input: { query: "first" } },
      { type: "TOOL_REQUEST", callId: "same", capability: READ, input: { url: "fake://item" } },
    ],
  ]) {
    await t.test(steps.length === 1 ? "malformed" : "duplicate callId", async () => {
      const flow = openFlow({ steps });
      try {
        const { task } = seedStaffedTask(flow.kernel);
        const run = await finish(flow, task.id);
        assert.equal(run.endReason, "WORKER_PROTOCOL_ERROR");
        assert.equal(flow.actuator.calls.length, steps.length - 1);
      } finally {
        await flow.host.stop();
        flow.kernel.close();
        flow.cleanup();
      }
    });
  }
});

test("unknown capability and hidden tool request in FINAL_RESULT are rejected", async (t) => {
  for (const { name, step, reason } of [
    { name: "unknown capability", step: { type: "TOOL_REQUEST", callId: "unknown", capability: "research.web.unknown", input: {} }, reason: "WORKER_EXECUTION_FAILED" },
    { name: "hidden final tool", step: { type: "FINAL_RESULT", candidate: { ...artifact, toolRequest: { capability: SEARCH } } }, reason: "WORKER_PROTOCOL_ERROR" },
    { name: "multiple final objects", step: { type: "FINAL_RESULT", candidate: artifact, anotherFinal: artifact }, reason: "WORKER_PROTOCOL_ERROR" },
  ]) {
    await t.test(name, async () => {
      const flow = openFlow({ steps: [step] });
      try {
        const { task } = seedStaffedTask(flow.kernel);
        const run = await finish(flow, task.id);
        assert.equal(run.endReason, reason);
        assert.equal(flow.actuator.calls.length, 0);
        assert.equal(flow.kernel.status().counts.artifacts, 0);
      } finally {
        await flow.host.stop();
        flow.kernel.close();
        flow.cleanup();
      }
    });
  }
});

test("provider error is an execution failure, not a process exit", async () => {
  const flow = openFlow({ steps: [{ type: "PROVIDER_ERROR", code: "UNAVAILABLE" }] });
  try {
    const { task } = seedStaffedTask(flow.kernel);
    const run = await finish(flow, task.id);
    assert.equal(run.endReason, "WORKER_EXECUTION_FAILED");
    assert.equal(flow.host.reportFor(run.id)[0].detail.failureCode, "PROVIDER_ERROR");
    assert.equal(flow.host.reportFor(run.id)[0].detail.evidence.failureCode, "PROVIDER_ERROR");
  } finally {
    await flow.host.stop();
    flow.kernel.close();
    flow.cleanup();
  }
});

test("invalid FINAL_RESULT is rejected by existing WorkerHost validation", async () => {
  const flow = openFlow({ steps: [{ type: "FINAL_RESULT", candidate: { ...artifact, proposedArtifacts: [] } }] });
  try {
    const { task } = seedStaffedTask(flow.kernel);
    const run = await finish(flow, task.id);
    assert.equal(run.endReason, "WORKER_PROTOCOL_ERROR");
    assert.equal(flow.kernel.status().counts.artifacts, 0);
    assert.equal(flow.host.reportFor(run.id)[0].detail.reason, "WORKER_PROTOCOL_ERROR");
  } finally {
    await flow.host.stop();
    flow.kernel.close();
    flow.cleanup();
  }
});

function untilAborted(signal) {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

test("Host timeout aborts a pending model invocation", async () => {
  let aborted = false;
  const flow = openFlow({
    timeoutMs: 30,
    steps: [async ({ abortSignal }) => {
      try { await untilAborted(abortSignal); } catch (error) { aborted = true; throw error; }
    }],
  });
  try {
    const { task } = seedStaffedTask(flow.kernel);
    const run = await finish(flow, task.id);
    assert.equal(aborted, true);
    assert.equal(run.endReason, "WORKER_TIMEOUT");
  } finally {
    await flow.host.stop();
    flow.kernel.close();
    flow.cleanup();
  }
});

test("tool timeout aborts FakeActuator and reports WORKER_TIMEOUT", async () => {
  let aborted = false;
  const flow = openFlow({
    budget: { maxElapsedMs: 200, toolTimeoutMs: 20 },
    steps: [{ type: "TOOL_REQUEST", callId: "slow", capability: SEARCH, input: { query: "fixture" } }],
    onInvoke: async ({ signal }) => {
      try { await untilAborted(signal); } catch (error) { aborted = true; throw error; }
    },
  });
  try {
    const { task } = seedStaffedTask(flow.kernel);
    const run = await finish(flow, task.id);
    assert.equal(aborted, true);
    assert.equal(run.endReason, "WORKER_TIMEOUT");
  } finally {
    await flow.host.stop();
    flow.kernel.close();
    flow.cleanup();
  }
});

test("Host.stop aborts an in-flight Actuator and recovery interrupts the WorkerRun", async () => {
  let startedTool;
  const toolStarted = new Promise((resolve) => { startedTool = resolve; });
  let aborted = false;
  const flow = openFlow({
    steps: [{ type: "TOOL_REQUEST", callId: "in-flight", capability: SEARCH, input: { query: "fixture" } }],
    onInvoke: async ({ signal }) => {
      startedTool();
      try { await untilAborted(signal); } catch (error) { aborted = true; throw error; }
    },
  });
  try {
    const { task } = seedStaffedTask(flow.kernel);
    flow.host.start();
    const started = flow.kernel.startWorkerRun({ taskId: task.id });
    await toolStarted;
    await flow.host.stop();
    await flow.host.stop();
    assert.equal(aborted, true);
    assert.equal(flow.modelBackend.calls.length, 1);
    assert.equal(flow.kernel.status().counts.artifacts, 0);
    assert.equal(flow.kernel.status().counts.reviews, 0);
    assert.equal(flow.kernel.workerRun(started.workerRun.id).state, "RUNNING");
    flow.kernel.close();
    const reopened = reopenKernel(flow.dir);
    try {
      assert.equal(reopened.workerRun(started.workerRun.id).state, "INTERRUPTED");
      assert.equal(reopened.workerRun(started.workerRun.id).endReason, "PROCESS_INTERRUPTED");
    } finally { reopened.close(); }
  } finally {
    flow.cleanup();
  }
});

test("Host.stop aborts an in-flight ModelBackend invocation without delivery", async () => {
  let startedModel;
  const modelStarted = new Promise((resolve) => { startedModel = resolve; });
  let aborted = false;
  const flow = openFlow({ steps: [async ({ abortSignal }) => {
    startedModel();
    try { await untilAborted(abortSignal); } catch (error) { aborted = true; throw error; }
  }] });
  try {
    const { task } = seedStaffedTask(flow.kernel);
    flow.host.start();
    const started = flow.kernel.startWorkerRun({ taskId: task.id });
    await modelStarted;
    await flow.host.stop();
    await flow.host.stop();
    assert.equal(aborted, true);
    assert.equal(flow.modelBackend.calls.length, 1);
    assert.equal(flow.actuator.calls.length, 0);
    assert.equal(flow.kernel.status().counts.artifacts, 0);
    assert.equal(flow.kernel.status().counts.reviews, 0);
    assert.equal(flow.kernel.workerRun(started.workerRun.id).state, "RUNNING");
    flow.kernel.close();
    const reopened = reopenKernel(flow.dir);
    try { assert.equal(reopened.workerRun(started.workerRun.id).endReason, "PROCESS_INTERRUPTED"); }
    finally { reopened.close(); }
  } finally {
    flow.cleanup();
  }
});

test("Host.stop after TOOL_RESULT prevents the next model step and any delivery", async () => {
  let flow;
  let stopped = null;
  flow = openFlow({
    steps: [
      { type: "TOOL_REQUEST", callId: "first", capability: SEARCH, input: { query: "fixture" } },
      { type: "FINAL_RESULT", candidate: artifact },
    ],
    onEvent: (event) => {
      if (event.kind === "TOOL_FINISHED" && !stopped) stopped = flow.host.stop();
    },
  });
  try {
    const { task } = seedStaffedTask(flow.kernel);
    flow.host.start();
    const started = flow.kernel.startWorkerRun({ taskId: task.id });
    await flow.host.idle();
    assert.ok(stopped);
    await stopped;
    assert.equal(flow.modelBackend.calls.length, 1);
    assert.equal(flow.actuator.calls.length, 1);
    assert.equal(flow.kernel.status().counts.artifacts, 0);
    assert.equal(flow.kernel.status().counts.reviews, 0);
    assert.equal(flow.host.reportFor(started.workerRun.id).at(-1).status, "CANCELLED");
  } finally {
    await flow.host.stop();
    flow.kernel.close();
    flow.cleanup();
  }
});

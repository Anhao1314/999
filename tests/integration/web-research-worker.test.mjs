import test from "node:test";
import assert from "node:assert/strict";
import {
  createGenericModelWorkerAdapter, createStaticWorkerBackendResolver, createTestModelBackend,
  createWebReader, createWebResearchActuator, createWorkerHost,
  GENERIC_MODEL_WORKER_ADAPTER_TYPE, WEB_READ, WEB_SEARCH,
} from "../../packages/harness/index.mjs";
import { openTempKernel, seedStaffedTask } from "../support/kernel.mjs";

const URL_TO_READ = "https://public.example/article?campaign=private";
const SKILL = Object.freeze({
  skillId: "WebObservationMethod", version: "0.1.0",
  requiredCapabilities: ["capability.x"], allowedToolCapabilities: [WEB_SEARCH, WEB_READ],
  rules: ["Use authorized tools and return the selected result contract."],
});
const result = (content = "Observed source was read.") => ({
  resultVersion: 1, outcome: "SUCCEEDED", summary: "Public source observed.",
  blockers: [], proposedArtifacts: [{ kind: "document", title: "Web note", content }], suggestedNextActions: [],
});
const publicDns = async () => [{ address: "93.184.215.14", family: 4 }];
const okPage = () => ({ statusCode: 200, headers: { "content-type": "text/html" }, body: Buffer.from("<html><head><title>Source title</title></head><body>Observed public page.</body></html>") });

function flow({ steps, searchProvider = { async search() { return [{ url: URL_TO_READ, title: "Candidate" }]; } },
  transport = async () => okPage(), timeoutMs = 1_000, toolTimeoutMs = timeoutMs,
  readerTimeoutMs = 800, approved = [WEB_SEARCH, WEB_READ] } = {}) {
  const fixture = openTempKernel();
  const calls = [];
  const reader = createWebReader({ resolveHost: publicDns, transport: async (request) => { calls.push({ capability: WEB_READ, request }); return transport(request); },
    now: () => "2026-09-23T00:00:00.000Z", timeoutMs: readerTimeoutMs });
  const provider = searchProvider && { async search(request) { calls.push({ capability: WEB_SEARCH, request }); return searchProvider.search(request); } };
  const actuator = createWebResearchActuator({ searchProvider: provider, reader });
  const backend = createTestModelBackend({ steps });
  const adapter = createGenericModelWorkerAdapter({ modelBackend: backend, skill: SKILL });
  const host = createWorkerHost({
    kernel: fixture.kernel, adapter,
    resolver: createStaticWorkerBackendResolver({ backendType: GENERIC_MODEL_WORKER_ADAPTER_TYPE, backendVersion: "0.1.0-web-test" }),
    runtimeRoot: fixture.dir, timeoutMs,
    toolPolicy: { skill: SKILL, approvedCapabilities: approved, actuators: [actuator], budget: { maxToolCalls: 3, maxElapsedMs: timeoutMs, toolTimeoutMs } },
  });
  return { ...fixture, calls, backend, host };
}

async function finish(fixture) {
  const { work, task } = seedStaffedTask(fixture.kernel);
  fixture.host.start();
  const { workerRun } = fixture.kernel.startWorkerRun({ taskId: task.id });
  await fixture.host.idle();
  return { work, task, run: fixture.kernel.workerRun(workerRun.id) };
}

async function close(fixture) {
  await fixture.host.stop();
  fixture.kernel.close();
  fixture.cleanup();
}

test("Generic Worker search → read → final delivers an Artifact in one WorkerRun with Host-minted source evidence", async () => {
  let observedId;
  const fixture = flow({ steps: [
    { type: "TOOL_REQUEST", callId: "search", capability: WEB_SEARCH, input: { query: "public source", limit: 1 } },
    ({ messages, tools }) => {
      assert.deepEqual(tools, [WEB_READ, WEB_SEARCH]);
      const search = JSON.parse(messages.at(-1).content);
      assert.equal(search.output.results[0].url, URL_TO_READ);
      assert.equal(Object.hasOwn(search.output, "sourceObservation"), false);
      return { type: "TOOL_REQUEST", callId: "read", capability: WEB_READ, input: { url: search.output.results[0].url } };
    },
    ({ messages }) => {
      const read = JSON.parse(messages.at(-1).content);
      observedId = read.output.sourceObservation.sourceId;
      assert.match(observedId, /^src_[0-9a-f-]{36}$/);
      assert.equal(read.output.sourceObservation.content, "Observed public page.");
      return { type: "FINAL_RESULT", candidate: result(`Observation ${observedId} supports this note.`) };
    },
  ] });
  try {
    const tablesBefore = fixture.kernel.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const { work, run } = await finish(fixture);
    assert.equal(run.state, "COMPLETED", JSON.stringify(fixture.host.reportFor(run.id)));
    assert.deepEqual(fixture.calls.map((call) => call.capability), [WEB_SEARCH, WEB_READ]);
    assert.equal(fixture.backend.calls.length, 3);
    const candidate = fixture.kernel.workProjection(work.id).outcome.candidateArtifacts[0];
    assert.match(fixture.kernel.artifact(candidate.id).content, new RegExp(observedId));
    const evidence = fixture.host.reportFor(run.id)[0].detail.evidence;
    assert.equal(evidence.toolSession.receipts.length, 2);
    assert.equal(evidence.toolSession.receipts[0].sourceId, undefined);
    assert.equal(evidence.toolSession.receipts[1].sourceId, observedId);
    assert.equal(evidence.toolSession.sources.length, 1);
    assert.equal(evidence.toolSession.sources[0].receiptCallId, "read");
    assert.equal(evidence.toolSession.sources[0].safeUrl, "https://public.example");
    assert.doesNotMatch(JSON.stringify(evidence), /campaign=private|Observed public page/);
    assert.deepEqual(fixture.kernel.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(), tablesBefore);
    assert.equal(fixture.kernel.store.resultSubmissionForRun(run.id).detail.evidenceDigest, evidence.evidenceDigest);
  } finally { await close(fixture); }
});

test("search candidates alone produce no SourceObservation", async () => {
  const fixture = flow({ steps: [
    { type: "TOOL_REQUEST", callId: "search", capability: WEB_SEARCH, input: { query: "q" } },
    { type: "FINAL_RESULT", candidate: result("Search candidate only; no source was read.") },
  ] });
  try {
    const { run } = await finish(fixture);
    assert.equal(run.state, "COMPLETED");
    assert.deepEqual(fixture.host.reportFor(run.id)[0].detail.evidence.toolSession.sources, []);
    assert.deepEqual(fixture.calls.map((call) => call.capability), [WEB_SEARCH]);
  } finally { await close(fixture); }
});

test("denied and failed reads mint no source; model-supplied sourceId is a protocol error", async (t) => {
  for (const [name, input, transport, expectedReason, expectedCode] of [
    ["localhost", { url: "http://localhost/" }, async () => okPage(), "WORKER_EXECUTION_FAILED", "WEB_URL_DENIED"],
    ["failed GET", { url: URL_TO_READ }, async () => ({ statusCode: 503, headers: {}, body: Buffer.alloc(0) }), "WORKER_EXECUTION_FAILED", "WEB_HTTP_STATUS"],
    ["invented sourceId", { url: URL_TO_READ, sourceId: "src_fake" }, async () => okPage(), "WORKER_PROTOCOL_ERROR", "TOOL_PROTOCOL_ERROR"],
  ]) await t.test(name, async () => {
    const fixture = flow({ steps: [{ type: "TOOL_REQUEST", callId: "read", capability: WEB_READ, input }], transport });
    try {
      const { work, run } = await finish(fixture);
      assert.equal(run.endReason, expectedReason);
      const report = fixture.host.reportFor(run.id)[0];
      assert.equal(report.detail.failureCode, expectedCode);
      assert.deepEqual(report.detail.evidence.toolSession.sources, []);
      assert.equal(fixture.kernel.workProjection(work.id).outcome.candidateArtifacts.length, 0);
    } finally { await close(fixture); }
  });
});

test("redirect-to-private and unavailable SearchProvider create no source", async () => {
  const redirect = flow({
    steps: [{ type: "TOOL_REQUEST", callId: "read", capability: WEB_READ, input: { url: URL_TO_READ } }],
    transport: async () => ({ statusCode: 302, headers: { location: "http://169.254.169.254/" }, body: Buffer.alloc(0) }),
  });
  try {
    const { run } = await finish(redirect);
    assert.equal(run.endReason, "WORKER_EXECUTION_FAILED");
    assert.equal(redirect.host.reportFor(run.id)[0].detail.failureCode, "WEB_URL_DENIED");
    assert.deepEqual(redirect.host.reportFor(run.id)[0].detail.evidence.toolSession.sources, []);
    assert.equal(redirect.calls.length, 1);
  } finally { await close(redirect); }
  const unavailable = flow({ searchProvider: null, steps: [{ type: "TOOL_REQUEST", callId: "search", capability: WEB_SEARCH, input: { query: "q" } }] });
  try {
    const { run } = await finish(unavailable);
    assert.equal(run.endReason, "WORKER_EXECUTION_FAILED");
    assert.equal(unavailable.host.reportFor(run.id)[0].detail.failureCode, "TOOL_DENIED");
    assert.deepEqual(unavailable.host.reportFor(run.id)[0].detail.evidence.toolSession.sources, []);
  } finally { await close(unavailable); }
});

test("Host.stop aborts active HTTP read, with no next model step, tool result or Artifact", async () => {
  let invoked;
  const active = new Promise((resolve) => { invoked = resolve; });
  let aborted = false;
  const fixture = flow({
    steps: [{ type: "TOOL_REQUEST", callId: "read", capability: WEB_READ, input: { url: URL_TO_READ } },
      { type: "FINAL_RESULT", candidate: result("must not deliver") }],
    transport: ({ signal }) => {
      invoked();
      return new Promise((_, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true }));
    },
  });
  try {
    const { work, task } = seedStaffedTask(fixture.kernel);
    fixture.host.start();
    const { workerRun } = fixture.kernel.startWorkerRun({ taskId: task.id });
    await active;
    await fixture.host.stop();
    assert.equal(aborted, true);
    assert.equal(fixture.backend.calls.length, 1);
    assert.equal(fixture.kernel.workProjection(work.id).outcome.candidateArtifacts.length, 0);
    assert.equal(fixture.host.reportFor(workerRun.id)[0].status, "CANCELLED");
  } finally { await close(fixture); }
});

test("WebReader timeout maps to WORKER_TIMEOUT and creates no source or Artifact", async () => {
  let aborted = false;
  const fixture = flow({
    steps: [{ type: "TOOL_REQUEST", callId: "read", capability: WEB_READ, input: { url: URL_TO_READ } }],
    timeoutMs: 200, readerTimeoutMs: 20,
    transport: ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true })),
  });
  try {
    const { work, run } = await finish(fixture);
    assert.equal(aborted, true);
    assert.equal(run.endReason, "WORKER_TIMEOUT");
    assert.equal(fixture.host.reportFor(run.id)[0].detail.failureCode, "TOOL_TIMEOUT");
    assert.deepEqual(fixture.host.reportFor(run.id)[0].detail.evidence.toolSession.sources, []);
    assert.equal(fixture.kernel.workProjection(work.id).outcome.candidateArtifacts.length, 0);
  } finally { await close(fixture); }
});

test("tool timeout aborts active SearchProvider and never yields a tool result", async () => {
  let aborted = false;
  const fixture = flow({
    steps: [{ type: "TOOL_REQUEST", callId: "search", capability: WEB_SEARCH, input: { query: "q" } },
      { type: "FINAL_RESULT", candidate: result("must not deliver") }],
    timeoutMs: 200, toolTimeoutMs: 20,
    searchProvider: { search({ signal }) {
      return new Promise((_, reject) => signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true }));
    } },
  });
  try {
    const { work, run } = await finish(fixture);
    assert.equal(aborted, true);
    assert.equal(run.endReason, "WORKER_TIMEOUT");
    assert.equal(fixture.backend.calls.length, 1);
    assert.deepEqual(fixture.host.reportFor(run.id)[0].detail.evidence.toolSession.sources, []);
    assert.equal(fixture.kernel.workProjection(work.id).outcome.candidateArtifacts.length, 0);
  } finally { await close(fixture); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { digestOf } from "../../packages/work/records.mjs";
import {
  buildHarnessEvidence, createAuthorizedToolSession, createToolBudget, createToolGrant,
  createWebReader, createWebResearchActuator, isPublicIp, parsePublicWebUrl,
  WEB_LIMITS, WEB_READ, WEB_SEARCH,
} from "../../packages/harness/index.mjs";
import { openTempKernel, seedStaffedTask } from "../support/kernel.mjs";

const publicDns = async () => [{ address: "93.184.215.14", family: 4 }];
const html = (body = "<html><head><title>Observed &amp; Read</title></head><body><script>secret()</script><main>Public text</main></body></html>") =>
  ({ statusCode: 200, headers: { "content-type": "text/html" }, body: Buffer.from(body) });
const text = (body = "Public text") => ({ statusCode: 200, headers: { "content-type": "text/plain" }, body: Buffer.from(body) });

test("public-network policy denies local, private, metadata and unsupported targets", () => {
  for (const address of ["127.0.0.1", "10.2.3.4", "172.16.0.1", "192.168.1.1", "168.63.129.16", "169.254.169.254", "100.100.100.200", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "2001:db8::1", "2002:c0a8:101::1"])
    assert.equal(isPublicIp(address), false, address);
  for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])
    assert.equal(isPublicIp(address), true, address);
  for (const url of [
    "http://localhost/", "http://127.1/", "http://10.1.2.3/", "http://192.168.0.1/",
    "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://[fc00::1]/",
    "http://metadata.google.internal/", "http://metadata.google.internal./", "http://metadata/", "file:///etc/passwd",
    "data:text/plain,hello", "ftp://public.example/file", "https://user:pass@public.example/",
    "https://public.example:8080/",
  ]) assert.throws(() => parsePublicWebUrl(url), { code: "WEB_URL_DENIED" }, url);
});

test("WebReader resolves every DNS answer, pins one public address, and extracts bounded text", async () => {
  const calls = [];
  const reader = createWebReader({
    resolveHost: async () => [{ address: "93.184.215.14", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }],
    transport: async (request) => { calls.push(request); return html(); },
    now: () => "2026-09-23T00:00:00.000Z",
  });
  const observation = await reader.read({ url: "https://public.example/article?ref=one#fragment" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].address, "93.184.215.14");
  assert.equal(calls[0].url.hostname, "public.example");
  assert.equal(observation.canonicalUrl, "https://public.example/article?ref=one");
  assert.equal(observation.title, "Observed & Read");
  assert.equal(observation.content, "Public text");
  assert.equal(observation.contentDigest, digestOf(html().body));
  assert.equal(observation.observedAt, "2026-09-23T00:00:00.000Z");
});

test("mixed public/private DNS is denied before any connection", async () => {
  let connections = 0;
  const reader = createWebReader({
    resolveHost: async () => [{ address: "1.1.1.1", family: 4 }, { address: "10.0.0.1", family: 4 }],
    transport: async () => { connections += 1; return text(); },
  });
  await assert.rejects(reader.read({ url: "https://public.example/" }), { code: "WEB_URL_DENIED" });
  assert.equal(connections, 0);
});

test("every redirect is revalidated, and a private target is never fetched", async () => {
  let calls = 0;
  const reader = createWebReader({
    resolveHost: publicDns,
    transport: async () => {
      calls += 1;
      return { statusCode: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" }, body: Buffer.alloc(0) };
    },
  });
  await assert.rejects(reader.read({ url: "https://public.example/start" }), { code: "WEB_URL_DENIED" });
  assert.equal(calls, 1);
  const dnsRedirect = createWebReader({
    resolveHost: async (host) => host === "other.example" ? [{ address: "127.0.0.1", family: 4 }] : publicDns(),
    transport: async () => ({ statusCode: 302, headers: { location: "https://other.example/" }, body: Buffer.alloc(0) }),
  });
  await assert.rejects(dnsRedirect.read({ url: "https://public.example/" }), { code: "WEB_URL_DENIED" });
});

test("a Founder-scoped reader never follows a redirect to another public host", async () => {
  let connections = 0;
  const reader = createWebReader({ resolveHost: publicDns, sameHostRedirectsOnly: true,
    transport: async () => { connections += 1; return {
      statusCode: 302, headers: { location: "https://unapproved.example/product" }, body: Buffer.alloc(0),
    }; } });
  await assert.rejects(reader.read({ url: "https://public.example/start" }), { code: "WEB_URL_DENIED" });
  assert.equal(connections, 1);
});

test("redirect count, response, extracted text, headers, encoding and content type remain bounded", async (t) => {
  const cases = [
    ["redirect", async () => ({ statusCode: 302, headers: { location: "/again" }, body: Buffer.alloc(0) }), "WEB_REDIRECT_LIMIT"],
    ["response", async () => text("x".repeat(WEB_LIMITS.responseBytes + 1)), "WEB_RESPONSE_TOO_LARGE"],
    ["headers", async () => ({ ...text(), headers: { "content-type": "text/plain", padding: "x".repeat(WEB_LIMITS.headerBytes) } }), "WEB_RESPONSE_TOO_LARGE"],
    ["encoding", async () => ({ ...text(), headers: { "content-type": "text/plain", "content-encoding": "gzip" } }), "WEB_ENCODING_UNSUPPORTED"],
    ["content-type", async () => ({ ...text(), headers: { "content-type": "application/pdf" } }), "WEB_CONTENT_TYPE_UNSUPPORTED"],
  ];
  for (const [name, transport, code] of cases) await t.test(name, async () => {
    const reader = createWebReader({ resolveHost: publicDns, transport });
    await assert.rejects(reader.read({ url: "https://public.example/" }), { code });
  });
  const clipped = createWebReader({ resolveHost: publicDns,
    transport: async () => text("x".repeat(WEB_LIMITS.extractedTextBytes + 1)) });
  const observation = await clipped.read({ url: "https://public.example/" });
  assert.ok(Buffer.byteLength(observation.content) <= WEB_LIMITS.extractedTextBytes);
  assert.match(observation.content, /Excerpt truncated/);
});

test("WebReader timeout and cancellation abort the active request and prevent redirects", async () => {
  const waitForAbort = ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new Error("transport aborted")), { once: true });
  });
  const timed = createWebReader({ resolveHost: publicDns, transport: waitForAbort, timeoutMs: 20 });
  await assert.rejects(timed.read({ url: "https://public.example/" }), { code: "TOOL_TIMEOUT" });
  const controller = new AbortController();
  let started;
  const invoked = new Promise((resolve) => { started = resolve; });
  const reader = createWebReader({ resolveHost: publicDns, transport: async (request) => { started(); return waitForAbort(request); } });
  const pending = reader.read({ url: "https://public.example/", signal: controller.signal });
  await invoked;
  controller.abort();
  await assert.rejects(pending, { code: "ABORTED" });
});

test("cancellation during redirect DNS resolution stops the chain before a second request", async () => {
  const controller = new AbortController();
  let resolving;
  const resolvingSecond = new Promise((resolve) => { resolving = resolve; });
  let connections = 0;
  const reader = createWebReader({
    resolveHost: (host, { signal }) => host === "second.example"
      ? new Promise((_, reject) => { resolving(); signal.addEventListener("abort", () => reject(new Error("DNS cancelled")), { once: true }); })
      : publicDns(),
    transport: async () => { connections += 1; return { statusCode: 302, headers: { location: "https://second.example/" }, body: Buffer.alloc(0) }; },
  });
  const pending = reader.read({ url: "https://public.example/", signal: controller.signal });
  await resolvingSecond;
  controller.abort();
  await assert.rejects(pending, { code: "ABORTED" });
  assert.equal(connections, 1);
});

test("SearchProvider discovers bounded candidates, cannot claim source evidence, and honors cancellation", async () => {
  const calls = [];
  const actuator = createWebResearchActuator({
    searchProvider: { async search(request) { calls.push(request); return [{ url: "https://public.example/article", title: "Candidate", snippet: "May be useful" }]; } },
    reader: { async read() { throw new Error("not called"); } },
  });
  const output = await actuator.invoke({ capability: WEB_SEARCH, input: { query: "public research", limit: 1 } });
  assert.deepEqual(output.results, [{ url: "https://public.example/article", title: "Candidate", snippet: "May be useful" }]);
  assert.equal(Object.hasOwn(output, "sourceObservation"), false);
  assert.equal(calls[0].limit, 1);
  assert.equal(createWebResearchActuator({ reader: { read() {} } }).supports(WEB_SEARCH), false);
  await assert.rejects(actuator.invoke({ capability: WEB_READ, input: { url: "https://public.example/", sourceId: "src_fake" } }), { code: "TOOL_PROTOCOL_ERROR" });
  const failed = createWebResearchActuator({ searchProvider: { async search() { throw new Error("provider offline"); } } });
  await assert.rejects(failed.invoke({ capability: WEB_SEARCH, input: { query: "q" } }), { code: "WEB_SEARCH_FAILED" });
  const tooMany = createWebResearchActuator({ searchProvider: { async search() { return Array(6).fill({ url: "https://public.example/" }); } } });
  await assert.rejects(tooMany.invoke({ capability: WEB_SEARCH, input: { query: "q" } }), { code: "WEB_SEARCH_INVALID" });
  await assert.rejects(actuator.invoke({ capability: WEB_SEARCH, input: { query: "x".repeat(301) } }), { code: "TOOL_PROTOCOL_ERROR" });
  const controller = new AbortController();
  let started;
  const invoked = new Promise((resolve) => { started = resolve; });
  const cancellable = createWebResearchActuator({ searchProvider: { search({ signal }) {
    started();
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  } } });
  const pending = cancellable.invoke({ capability: WEB_SEARCH, input: { query: "q" }, signal: controller.signal });
  await invoked;
  controller.abort();
  await assert.rejects(pending, { code: "ABORTED" });
});

test("Host-owned session mints unique sourceIds only for successful reads and binds bounded evidence", async () => {
  const fixture = openTempKernel();
  try {
    const { task } = seedStaffedTask(fixture.kernel);
    const run = fixture.kernel.startWorkerRun({ taskId: task.id }).workerRun;
    const actuator = createWebResearchActuator({
      searchProvider: { async search() { return [{ url: "https://public.example/article" }]; } },
      reader: createWebReader({ resolveHost: publicDns, transport: async () => text("Observed body"), now: () => "2026-09-23T00:00:00.000Z" }),
    });
    const skill = { skillId: "WebMethod", version: "1", requiredCapabilities: ["capability.x"], allowedToolCapabilities: [WEB_SEARCH, WEB_READ] };
    const grant = createToolGrant({ run, skill, approvedCapabilities: [WEB_SEARCH, WEB_READ], actuators: [actuator] });
    const session = createAuthorizedToolSession({ run, grant, budget: createToolBudget({ maxToolCalls: 3 }), actuators: [actuator] });
    const search = await session.invoke({ callId: "search", capability: WEB_SEARCH, input: { query: "q" } });
    assert.equal(search.output.results[0].url, "https://public.example/article");
    assert.deepEqual(session.snapshot().sources, []);
    const first = await session.invoke({ callId: "read-1", capability: WEB_READ, input: { url: "https://public.example/article?secret=one" } });
    const second = await session.invoke({ callId: "read-2", capability: WEB_READ, input: { url: "https://public.example/article?secret=two" } });
    const firstId = first.output.sourceObservation.sourceId;
    const secondId = second.output.sourceObservation.sourceId;
    assert.match(firstId, /^src_[0-9a-f-]{36}$/);
    assert.notEqual(firstId, secondId);
    const evidence = session.snapshot();
    assert.deepEqual(evidence.sources.map((source) => source.sourceId), [firstId, secondId]);
    assert.deepEqual(evidence.receipts.map((receipt) => receipt.sourceId ?? null), [null, firstId, secondId]);
    assert.equal(evidence.sources[0].safeUrl, "https://public.example");
    assert.doesNotMatch(JSON.stringify(evidence), /secret=|Observed body/);
  } finally {
    fixture.kernel.close();
    fixture.cleanup();
  }
});

test("a cancelled read leaves no source in the Host registry", async () => {
  const fixture = openTempKernel();
  try {
    const { task } = seedStaffedTask(fixture.kernel);
    const run = fixture.kernel.startWorkerRun({ taskId: task.id }).workerRun;
    let started;
    const invoked = new Promise((resolve) => { started = resolve; });
    const actuator = createWebResearchActuator({ reader: { read({ signal }) {
      started();
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("read aborted")), { once: true }));
    } } });
    const skill = { skillId: "WebMethod", version: "1", requiredCapabilities: ["capability.x"], allowedToolCapabilities: [WEB_READ] };
    const grant = createToolGrant({ run, skill, approvedCapabilities: [WEB_READ], actuators: [actuator] });
    const session = createAuthorizedToolSession({ run, grant, budget: createToolBudget({ maxToolCalls: 1 }), actuators: [actuator] });
    const controller = new AbortController();
    const pending = session.invoke({ callId: "cancelled-read", capability: WEB_READ, input: { url: "https://public.example/" }, signal: controller.signal });
    await invoked;
    controller.abort();
    await assert.rejects(pending, { code: "ABORTED" });
    assert.deepEqual(session.snapshot().sources, []);
    assert.deepEqual(session.snapshot().receipts.map((receipt) => receipt.status), ["ABORTED"]);
  } finally {
    fixture.kernel.close();
    fixture.cleanup();
  }
});

test("32 successful observations fit bounded evidence and source metadata changes its digest", async () => {
  const fixture = openTempKernel();
  try {
    const { task } = seedStaffedTask(fixture.kernel);
    const run = fixture.kernel.startWorkerRun({ taskId: task.id }).workerRun;
    const actuator = createWebResearchActuator({ reader: createWebReader({ resolveHost: publicDns, transport: async () => text("Observed body") }) });
    const skill = { skillId: "WebMethod", version: "1", requiredCapabilities: ["capability.x"], allowedToolCapabilities: [WEB_READ] };
    const grant = createToolGrant({ run, skill, approvedCapabilities: [WEB_READ], actuators: [actuator] });
    const session = createAuthorizedToolSession({ run, grant, budget: createToolBudget({ maxToolCalls: 32 }), actuators: [actuator] });
    for (let index = 0; index < 32; index += 1)
      await session.invoke({ callId: `read-${index}`, capability: WEB_READ, input: { url: `https://public.example/${index}` } });
    const snapshot = session.snapshot();
    assert.equal(snapshot.sources.length, 32);
    const args = {
      run, processOutcome: "SUCCEEDED", events: [], resultParse: "PARSED", observedAt: "2026-09-23T00:00:00.000Z",
      containment: { sandboxMode: "none", workspaceRoot: "workspace", scratchRoot: "scratch", knownLimitations: [] },
      toolSessionEvidence: snapshot,
    };
    const evidence = buildHarnessEvidence(args);
    assert.equal(evidence.toolSession.sources.length, 32);
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 32 * 1024);
    const changed = { ...snapshot, sources: snapshot.sources.map((source, index) => index === 0 ? { ...source, contentDigest: digestOf("different") } : source) };
    assert.notEqual(buildHarnessEvidence({ ...args, toolSessionEvidence: changed }).evidenceDigest, evidence.evidenceDigest);
    assert.throws(() => buildHarnessEvidence({ ...args, toolSessionEvidence: { ...snapshot, sources: [...snapshot.sources, snapshot.sources[0]] } }), /bounded/);
  } finally {
    fixture.kernel.close();
    fixture.cleanup();
  }
});

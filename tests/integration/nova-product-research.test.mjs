import test from "node:test";
import assert from "node:assert/strict";
import {
  createGenericModelWorkerAdapter, createStaticWorkerBackendResolver, createTestModelBackend,
  createWebReader, createWebResearchActuator, createWorkerHost,
  GENERIC_MODEL_WORKER_ADAPTER_TYPE, WEB_READ, WEB_SEARCH,
} from "../../packages/harness/index.mjs";
import { createContinuationDriver } from "../../packages/runtime/index.mjs";
import { deterministicNextActionProposer } from "../../packages/planning/next-action.mjs";
import {
  createProductResearchHost, createProductResearchWork, PRODUCT_RESEARCH_ARTIFACT_KIND, PRODUCT_RESEARCH_ARTIFACT_VERSION,
  PRODUCT_RESEARCH_CAPABILITY, PRODUCT_SELECTION_RESEARCH_SKILL, validateProductResearchArtifact,
} from "../../packages/product/product-research.mjs";
import { createNovaProductResearchSeed } from "../../fixtures/seeds/nova-product-researcher.mjs";
import { openTempKernel, reopenKernel } from "../support/kernel.mjs";

const REVIEW_CAPABILITY = "review.independent";
const URLS = Array.from({ length: 5 }, (_, index) => `https://products.example/feeder-${index + 1}`);
const DNS = async () => [{ address: "93.184.215.14", family: 4 }];
const REVIEW_SKILL = Object.freeze({ skillId: "IndependentArtifactReview", version: "v0", rules: ["Judge the exact Artifact in the WorkPacket; report a REVIEW_JUDGMENT."],
  requiredCapabilities: [], allowedToolCapabilities: [] });

function productText(index) {
  return `Feeder ${index + 1}. Brand ${index + 1}. Price USD ${40 + index}. Timed feeding.` +
    (index === 3 ? "" : ` Rating 4.1 out of 5. Reviews ${100 + index}.`);
}

function candidate(content, sourceId) {
  const productName = content.match(/Feeder \d+/)?.[0] ?? null;
  const brand = content.match(/Brand \d+/)?.[0] ?? null;
  const price = content.match(/Price USD (\d+(?:\.\d+)?)/)?.[1] ?? null;
  const rating = content.match(/Rating (\d+(?:\.\d+)?) out of 5/)?.[1] ?? null;
  const reviewCount = content.match(/Reviews (\d+)/)?.[1] ?? null;
  return {
    productName, brand, price: price === null ? null : { amount: Number(price), currency: "USD" },
    rating: rating === null ? null : Number(rating),
    reviewCount: reviewCount === null ? null : Number(reviewCount),
    sellingPoints: content.includes("Timed feeding") ? ["Timed feeding"] : [],
    observedWeaknesses: [], sourceIds: [sourceId],
  };
}

function researchArtifact(sourceIds, contents = sourceIds.map((_, index) => productText(index))) {
  return {
    schemaVersion: PRODUCT_RESEARCH_ARTIFACT_VERSION,
    category: "automatic pet feeder", market: "US",
    candidates: sourceIds.map((id, index) => candidate(contents[index], id)),
    marketObservations: [{ text: "The observed pages mention timed feeding.", sourceIds: [...new Set(sourceIds)] }],
    opportunities: [],
    risks: [{ text: "One observed page omits rating and review count.", sourceIds: [sourceIds[3]] }],
  };
}

function finalResearch(sourceIds, contents) {
  return { type: "FINAL_RESULT", candidate: {
    resultVersion: 1, outcome: "SUCCEEDED", summary: "Five public product pages observed.", blockers: [],
    proposedArtifacts: [{ kind: PRODUCT_RESEARCH_ARTIFACT_KIND, title: "US automatic pet feeder candidates", content: JSON.stringify(researchArtifact(sourceIds, contents)) }],
    suggestedNextActions: [],
  } };
}

function researchSteps() {
  return [
    { type: "TOOL_REQUEST", callId: "search", capability: WEB_SEARCH, input: { query: "automatic pet feeder US", limit: 5 } },
    ...URLS.map((_, index) => ({ messages }) => {
      const search = JSON.parse(messages.find((message) => message.role === "tool").content);
      assert.equal(search.output.results.length, 5);
      assert.equal(Object.hasOwn(search.output, "sourceObservation"), false);
      return { type: "TOOL_REQUEST", callId: `read-${index + 1}`, capability: WEB_READ, input: { url: search.output.results[index].url } };
    }),
    ({ messages }) => {
      const reads = messages.filter((message) => message.role === "tool").slice(1).map((message) => JSON.parse(message.content));
      assert.equal(reads.length, 5);
      reads.forEach((read, index) => assert.match(read.output.sourceObservation.content, new RegExp(`Feeder ${index + 1}`)));
      return finalResearch(reads.map((read) => read.output.sourceObservation.sourceId),
        reads.map((read) => read.output.sourceObservation.content));
    },
  ];
}

function reviewStep(verdict) {
  return ({ messages, resultContract, tools }) => {
    assert.equal(resultContract.kind, "REVIEW_JUDGMENT");
    assert.deepEqual(tools, []);
    const input = JSON.parse(messages[1].content);
    const artifact = JSON.parse(input.workPacket.review.targetArtifact.content);
    assert.equal(artifact.candidates.length, 5);
    assert.notEqual(input.workPacket.employee.displayName, "Nova");
    return { type: "FINAL_RESULT", candidate: {
      schemaVersion: 1, workerRunId: input.workerRunId, generation: input.generation,
      verdict, findings: verdict === "REQUEST_REVISION" ? ["Clarify the candidate limitations."] : [],
      summary: verdict === "PASS" ? "The five candidates have observed source references." : "Clarify candidate limitations.",
    } };
  };
}

function openFlow({ revision = false } = {}) {
  const fixture = openTempKernel();
  const calls = [];
  const reader = createWebReader({ resolveHost: DNS, now: () => "2026-09-23T00:00:00.000Z",
    transport: async ({ url }) => {
      calls.push({ capability: WEB_READ, url });
      const index = URLS.indexOf(url.href);
      assert.ok(index >= 0);
      return { statusCode: 200, headers: { "content-type": "text/html" },
        body: Buffer.from(`<html><body>${productText(index)}</body></html>`) };
    } });
  const searchProvider = { async search({ query, limit }) {
    calls.push({ capability: WEB_SEARCH, query });
    assert.equal(limit, 5);
    return URLS.map((url, index) => ({ url, title: `Feeder ${index + 1}` }));
  } };
  const researchBackend = createTestModelBackend({ steps: revision ? [...researchSteps(), ...researchSteps()] : researchSteps() });
  const reviewerBackend = createTestModelBackend({ steps: revision ? [reviewStep("REQUEST_REVISION"), reviewStep("PASS")] : [reviewStep("PASS")] });
  const host = createProductResearchHost({
    kernel: fixture.kernel, runtimeRoot: fixture.dir, timeoutMs: 2_000,
    modelBackend: researchBackend,
    reviewerAdapter: createGenericModelWorkerAdapter({ modelBackend: reviewerBackend, skill: REVIEW_SKILL }),
    searchProvider, reader, approvedCapabilities: [WEB_SEARCH, WEB_READ],
  });
  return { ...fixture, calls, host, researchBackend, reviewerBackend };
}

async function close(flow, driver = null) {
  driver?.detach();
  await flow.host.stop();
  flow.kernel.close();
  flow.cleanup();
}

test("Nova research is autonomously assigned, observed, delivered and independently reviewed", async () => {
  const flow = openFlow();
  let driver;
  try {
    const company = flow.kernel.createCompany({ name: "Pet Commerce" });
    const seed = createNovaProductResearchSeed(company.id);
    assert.deepEqual(flow.kernel.bootstrapWorkforce({ companyId: company.id, ...seed }), { positions: 1, employees: 1, skipped: 0 });
    const reviewerPosition = flow.kernel.createPosition({ companyId: company.id, title: "Independent Reviewer", capabilities: [REVIEW_CAPABILITY] });
    const reviewer = flow.kernel.createEmployee({ companyId: company.id, positionId: reviewerPosition.id, displayName: "Reviewer" });
    driver = createContinuationDriver({ kernel: flow.kernel, proposer: deterministicNextActionProposer({
      requiredCapabilities: [PRODUCT_RESEARCH_CAPABILITY], reviewCapabilities: [REVIEW_CAPABILITY],
    }) });
    flow.host.start();
    const work = createProductResearchWork({ kernel: flow.kernel, companyId: company.id });
    await flow.host.idle();
    const runs = flow.kernel.workerRuns({ workId: work.id });
    const novaRuns = runs.filter((run) => run.employeeId === seed.employees[0].id);
    assert.equal(novaRuns.length, 1, JSON.stringify(flow.host.reports()));
    assert.equal(novaRuns[0].state, "COMPLETED", JSON.stringify(flow.host.reports()));
    assert.equal(flow.kernel.assignment(novaRuns[0].taskId).employeeId, novaRuns[0].employeeId);
    assert.equal(flow.kernel.employee(novaRuns[0].employeeId).displayName, "Nova");
    assert.equal(flow.kernel.position(novaRuns[0].positionId).title, "Product Researcher");
    assert.equal(flow.researchBackend.calls.length, 7);
    const receipt = flow.host.reportFor(novaRuns[0].id)[0];
    assert.equal(receipt.status, "DELIVERED");
    assert.equal(receipt.detail.evidence.toolSession.skillId, PRODUCT_SELECTION_RESEARCH_SKILL.skillId);
    assert.equal(receipt.detail.evidence.toolSession.sources.length, 5);
    const projection = flow.kernel.workProjection(work.id);
    const artifact = flow.kernel.artifact(projection.outcome.candidateArtifacts[0].id);
    assert.equal(artifact.workerRunId, novaRuns[0].id);
    const parsed = JSON.parse(artifact.content);
    assert.equal(parsed.candidates.length, 5);
    assert.equal(parsed.marketObservations.length, 1);
    assert.equal(parsed.risks.length, 1);
    assert.equal(parsed.candidates[3].rating, null);
    assert.equal(parsed.candidates[3].reviewCount, null);
    const observed = new Set(receipt.detail.evidence.toolSession.sources.map((source) => source.sourceId));
    assert.ok(parsed.candidates.every((candidate) => candidate.sourceIds.every((id) => observed.has(id))));
    const missingField = structuredClone(parsed);
    delete missingField.candidates[0].reviewCount;
    assert.equal(validateProductResearchArtifact({ run: novaRuns[0],
      proposedArtifact: { kind: PRODUCT_RESEARCH_ARTIFACT_KIND, content: JSON.stringify(missingField) },
      observedSources: receipt.detail.evidence.toolSession.sources }).code, "PRODUCT_RESEARCH_CANDIDATE_INVALID");
    const placeholder = structuredClone(parsed);
    placeholder.candidates[0].price = "unknown";
    assert.equal(validateProductResearchArtifact({ run: novaRuns[0],
      proposedArtifact: { kind: PRODUCT_RESEARCH_ARTIFACT_KIND, content: JSON.stringify(placeholder) },
      observedSources: receipt.detail.evidence.toolSession.sources }).code, "PRODUCT_RESEARCH_CANDIDATE_INVALID");
    const oversizedInsight = structuredClone(parsed);
    oversizedInsight.opportunities = Array(11).fill({ text: "Opportunity", sourceIds: [parsed.candidates[0].sourceIds[0]] });
    assert.equal(validateProductResearchArtifact({ run: novaRuns[0],
      proposedArtifact: { kind: PRODUCT_RESEARCH_ARTIFACT_KIND, content: JSON.stringify(oversizedInsight) },
      observedSources: receipt.detail.evidence.toolSession.sources }).code, "PRODUCT_RESEARCH_SCHEMA_INVALID");
    const reviews = flow.kernel.reviews({ workId: work.id });
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].verdict, "PASS");
    const reviewerRuns = runs.filter((run) => run.employeeId === reviewer.id);
    assert.equal(reviewerRuns.length, 1);
    assert.equal(reviews[0].reviewerWorkerRunId, reviewerRuns[0].id);
    assert.notEqual(reviewerRuns[0].employeeId, novaRuns[0].employeeId);
    assert.equal(flow.reviewerBackend.calls.length, 1);
    assert.deepEqual(flow.calls.map((call) => call.capability), [WEB_SEARCH, ...Array(5).fill(WEB_READ)]);
    assert.equal(projection.outcome.accepted, null, "Reviewer PASS is not Founder approval");
    const commands = flow.kernel.continuationTraces({ workId: work.id }).map((trace) => trace.actionCommand);
    assert.equal(commands.filter((command) => command === "materializeNextAction").length, 1);
    assert.equal(commands.filter((command) => command === "assignTask").length, 2);
    assert.equal(commands.filter((command) => command === "startWorkerRun").length, 2);
    assert.equal(projection.reviewRequests.length, 1);
  } finally { await close(flow, driver); }
});

test("REQUEST_REVISION creates the existing Repair and re-review without Founder coordination", async () => {
  const flow = openFlow({ revision: true });
  let driver;
  try {
    const company = flow.kernel.createCompany({ name: "Pet Commerce" });
    const seed = createNovaProductResearchSeed(company.id);
    flow.kernel.bootstrapWorkforce({ companyId: company.id, ...seed });
    const position = flow.kernel.createPosition({ companyId: company.id, title: "Independent Reviewer", capabilities: [REVIEW_CAPABILITY] });
    flow.kernel.createEmployee({ companyId: company.id, positionId: position.id, displayName: "Reviewer" });
    driver = createContinuationDriver({ kernel: flow.kernel, proposer: deterministicNextActionProposer({
      requiredCapabilities: [PRODUCT_RESEARCH_CAPABILITY], reviewCapabilities: [REVIEW_CAPABILITY],
    }) });
    flow.host.start();
    const work = createProductResearchWork({ kernel: flow.kernel, companyId: company.id });
    await flow.host.idle();
    const reviews = flow.kernel.reviews({ workId: work.id });
    assert.deepEqual(reviews.map((review) => review.verdict), ["REQUEST_REVISION", "PASS"], JSON.stringify(flow.host.reports()));
    const repairs = flow.kernel.workProjection(work.id).repairBindings;
    assert.equal(repairs.length, 1);
    assert.equal(flow.kernel.continuationTraces({ workId: work.id })
      .filter((trace) => trace.actionCommand === "createRepairTask").length, 1);
    const novaRuns = flow.kernel.workerRuns({ workId: work.id }).filter((run) => run.employeeId === seed.employees[0].id);
    assert.equal(novaRuns.length, 2, "one initial WorkerRun and one ordinary Repair WorkerRun");
    assert.ok(novaRuns.every((run) => run.state === "COMPLETED"));
    const artifacts = flow.kernel.workProjection(work.id).artifacts;
    assert.equal(artifacts.length, 2);
    assert.equal(artifacts[1].supersedesArtifactId, artifacts[0].id);
  } finally { await close(flow, driver); }
});

test("a search result or invented sourceId cannot enter a ProductResearchArtifact", async () => {
  const flow = openTempKernel();
  let host;
  try {
    const company = flow.kernel.createCompany({ name: "Pet Commerce" });
    const seed = createNovaProductResearchSeed(company.id);
    flow.kernel.bootstrapWorkforce({ companyId: company.id, ...seed });
    const work = createProductResearchWork({ kernel: flow.kernel, companyId: company.id });
    const task = flow.kernel.createTask({ workId: work.id, title: "Research five feeders", intent: work.intent,
      requiredCapabilities: [PRODUCT_RESEARCH_CAPABILITY] });
    flow.kernel.assignTask({ taskId: task.id, employeeId: seed.employees[0].id, reason: "test" });
    const invented = "src_00000000-0000-4000-8000-000000000000";
    const backend = createTestModelBackend({ steps: [
      { type: "TOOL_REQUEST", callId: "search", capability: WEB_SEARCH, input: { query: "feeder", limit: 5 } },
      finalResearch(Array(5).fill(invented)),
    ] });
    const actuator = createWebResearchActuator({ searchProvider: { async search() { return URLS.map((url) => ({ url })); } },
      reader: createWebReader({ resolveHost: DNS }) });
    host = createWorkerHost({ kernel: flow.kernel, runtimeRoot: flow.dir,
      adapter: createGenericModelWorkerAdapter({ modelBackend: backend, skill: PRODUCT_SELECTION_RESEARCH_SKILL }),
      resolver: createStaticWorkerBackendResolver({ backendType: GENERIC_MODEL_WORKER_ADAPTER_TYPE, backendVersion: "0.1.0-test" }),
      toolPolicy: { skill: PRODUCT_SELECTION_RESEARCH_SKILL, approvedCapabilities: [WEB_SEARCH, WEB_READ], actuators: [actuator] },
      artifactPostcondition: validateProductResearchArtifact });
    host.start();
    const { workerRun } = flow.kernel.startWorkerRun({ taskId: task.id });
    await host.idle();
    const run = flow.kernel.workerRun(workerRun.id);
    assert.equal(run.endReason, "WORKER_OUTPUT_REJECTED");
    assert.equal(host.reportFor(run.id)[0].detail.failureCode, "PRODUCT_RESEARCH_SOURCE_UNOBSERVED");
    assert.deepEqual(host.reportFor(run.id)[0].detail.evidence.toolSession.sources, []);
    assert.equal(flow.kernel.workProjection(work.id).outcome.candidateArtifacts.length, 0);
  } finally { await host?.stop(); flow.kernel.close(); flow.cleanup(); }
});

test("source IDs cannot cross WorkerRuns or generations of the same Task", async () => {
  const flow = openTempKernel();
  let host;
  try {
    const company = flow.kernel.createCompany({ name: "Pet Commerce" });
    const seed = createNovaProductResearchSeed(company.id);
    flow.kernel.bootstrapWorkforce({ companyId: company.id, ...seed });
    const makeTask = () => {
      const work = createProductResearchWork({ kernel: flow.kernel, companyId: company.id });
      const task = flow.kernel.createTask({ workId: work.id, title: "Research five feeders", intent: work.intent,
        requiredCapabilities: [PRODUCT_RESEARCH_CAPABILITY] });
      flow.kernel.assignTask({ taskId: task.id, employeeId: seed.employees[0].id, reason: "test" });
      return { work, task };
    };
    let firstSourceId;
    let priorGenerationSourceId;
    const backend = createTestModelBackend({ steps: [
      { type: "TOOL_REQUEST", callId: "first-read", capability: WEB_READ, input: { url: URLS[0] } },
      ({ messages }) => {
        firstSourceId = JSON.parse(messages.at(-1).content).output.sourceObservation.sourceId;
        return finalResearch(Array(5).fill(firstSourceId));
      },
      () => finalResearch(Array(5).fill(firstSourceId)),
      { type: "TOOL_REQUEST", callId: "prior-generation-read", capability: WEB_READ, input: { url: URLS[0] } },
      ({ messages }) => {
        priorGenerationSourceId = JSON.parse(messages.at(-1).content).output.sourceObservation.sourceId;
        return { type: "PROVIDER_ERROR", code: "DELIBERATE_TEST_FAILURE" };
      },
      () => finalResearch(Array(5).fill(priorGenerationSourceId)),
    ] });
    const reader = createWebReader({ resolveHost: DNS, now: () => "2026-09-23T00:00:00.000Z",
      transport: async () => ({ statusCode: 200, headers: { "content-type": "text/html" },
        body: Buffer.from(`<html><body>${productText(0)}</body></html>`) }) });
    host = createProductResearchHost({ kernel: flow.kernel, runtimeRoot: flow.dir, modelBackend: backend,
      reader, approvedCapabilities: [WEB_READ] });
    host.start();

    const first = makeTask();
    const firstRun = flow.kernel.startWorkerRun({ taskId: first.task.id }).workerRun;
    await host.idle();
    assert.equal(flow.kernel.workerRun(firstRun.id).state, "COMPLETED");
    assert.equal(flow.kernel.workProjection(first.work.id).outcome.candidateArtifacts.length, 1);
    assert.equal(host.reportFor(firstRun.id)[0].detail.evidence.toolSession.sources[0].sourceId, firstSourceId);

    const second = makeTask();
    const crossRun = flow.kernel.startWorkerRun({ taskId: second.task.id }).workerRun;
    await host.idle();
    assert.equal(flow.kernel.workerRun(crossRun.id).endReason, "WORKER_OUTPUT_REJECTED");
    assert.equal(host.reportFor(crossRun.id)[0].detail.failureCode, "PRODUCT_RESEARCH_SOURCE_UNOBSERVED");
    assert.deepEqual(host.reportFor(crossRun.id)[0].detail.evidence.toolSession.sources, []);

    const priorGeneration = flow.kernel.startWorkerRun({ taskId: second.task.id }).workerRun;
    await host.idle();
    assert.ok(priorGeneration.generation > crossRun.generation);
    assert.equal(flow.kernel.workerRun(priorGeneration.id).endReason, "WORKER_EXECUTION_FAILED");
    assert.equal(host.reportFor(priorGeneration.id)[0].detail.evidence.toolSession.sources[0].sourceId, priorGenerationSourceId);

    const crossGeneration = flow.kernel.startWorkerRun({ taskId: second.task.id }).workerRun;
    await host.idle();
    assert.ok(crossGeneration.generation > priorGeneration.generation);
    assert.equal(flow.kernel.workerRun(crossGeneration.id).endReason, "WORKER_OUTPUT_REJECTED");
    assert.equal(host.reportFor(crossGeneration.id)[0].detail.failureCode, "PRODUCT_RESEARCH_SOURCE_UNOBSERVED");
    assert.deepEqual(host.reportFor(crossGeneration.id)[0].detail.evidence.toolSession.sources, []);
    assert.equal(flow.kernel.workProjection(second.work.id).outcome.candidateArtifacts.length, 0);
  } finally { await host?.stop(); flow.kernel.close(); flow.cleanup(); }
});

test("a failed product-page read mints no source and cannot deliver research", async () => {
  const flow = openTempKernel();
  let host;
  try {
    const company = flow.kernel.createCompany({ name: "Pet Commerce" });
    const seed = createNovaProductResearchSeed(company.id);
    flow.kernel.bootstrapWorkforce({ companyId: company.id, ...seed });
    const work = createProductResearchWork({ kernel: flow.kernel, companyId: company.id });
    const task = flow.kernel.createTask({ workId: work.id, title: "Research five feeders", intent: work.intent,
      requiredCapabilities: [PRODUCT_RESEARCH_CAPABILITY] });
    flow.kernel.assignTask({ taskId: task.id, employeeId: seed.employees[0].id, reason: "test" });
    const backend = createTestModelBackend({ steps: [
      { type: "TOOL_REQUEST", callId: "failed-read", capability: WEB_READ, input: { url: URLS[0] } },
      () => { throw new Error("a failed read must not reach another model step"); },
    ] });
    const reader = createWebReader({ resolveHost: DNS,
      transport: async () => ({ statusCode: 503, headers: { "content-type": "text/html" }, body: Buffer.alloc(0) }) });
    host = createProductResearchHost({ kernel: flow.kernel, runtimeRoot: flow.dir, modelBackend: backend,
      reader, approvedCapabilities: [WEB_READ] });
    host.start();
    const run = flow.kernel.startWorkerRun({ taskId: task.id }).workerRun;
    await host.idle();
    assert.equal(flow.kernel.workerRun(run.id).endReason, "WORKER_EXECUTION_FAILED");
    assert.equal(host.reportFor(run.id)[0].detail.failureCode, "WEB_HTTP_STATUS");
    assert.deepEqual(host.reportFor(run.id)[0].detail.evidence.toolSession.sources, []);
    assert.equal(backend.calls.length, 1);
    assert.equal(flow.kernel.workProjection(work.id).outcome.candidateArtifacts.length, 0);
  } finally { await host?.stop(); flow.kernel.close(); flow.cleanup(); }
});

test("Nova seed is idempotent and the product Host grants no web access without explicit approval", async () => {
  const flow = openTempKernel();
  let host;
  try {
    const company = flow.kernel.createCompany({ name: "Pet Commerce" });
    const seed = createNovaProductResearchSeed(company.id);
    flow.kernel.bootstrapWorkforce({ companyId: company.id, ...seed });
    assert.deepEqual(flow.kernel.bootstrapWorkforce({ companyId: company.id, ...createNovaProductResearchSeed(company.id) }),
      { positions: 0, employees: 0, skipped: 2 });
    const secondCompany = flow.kernel.createCompany({ name: "Another Commerce" });
    assert.deepEqual(flow.kernel.bootstrapWorkforce({ companyId: secondCompany.id, ...createNovaProductResearchSeed(secondCompany.id) }),
      { positions: 1, employees: 1, skipped: 0 });
    assert.throws(() => createProductResearchWork({ kernel: flow.kernel, companyId: company.id, market: "CA" }), /invalid product research request/);
    assert.throws(() => createProductResearchWork({ kernel: flow.kernel, companyId: company.id,
      publicProductUrls: Array(5).fill("http://localhost/item") }), /invalid product research request/);
    const work = createProductResearchWork({ kernel: flow.kernel, companyId: company.id });
    const task = flow.kernel.createTask({ workId: work.id, title: "Research five feeders", intent: work.intent,
      requiredCapabilities: [PRODUCT_RESEARCH_CAPABILITY] });
    flow.kernel.assignTask({ taskId: task.id, employeeId: seed.employees[0].id, reason: "test" });
    let searchCalls = 0;
    host = createProductResearchHost({ kernel: flow.kernel, runtimeRoot: flow.dir,
      modelBackend: createTestModelBackend({ steps: [
        { type: "TOOL_REQUEST", callId: "search", capability: WEB_SEARCH, input: { query: "feeder", limit: 5 } },
      ] }),
      searchProvider: { async search() { searchCalls += 1; return []; } },
      approvedCapabilities: [],
    });
    host.start();
    const { workerRun } = flow.kernel.startWorkerRun({ taskId: task.id });
    await host.idle();
    const run = flow.kernel.workerRun(workerRun.id);
    assert.equal(run.endReason, "WORKER_EXECUTION_FAILED");
    assert.equal(host.reportFor(run.id)[0].detail.failureCode, "TOOL_DENIED");
    assert.equal(searchCalls, 0);
    assert.equal(flow.kernel.workProjection(work.id).outcome.candidateArtifacts.length, 0);
  } finally { await host?.stop(); flow.kernel.close(); flow.cleanup(); }
});

test("Nova remains an Employee after reopening Runtime storage", () => {
  const flow = openTempKernel();
  let reopened;
  try {
    const company = flow.kernel.createCompany({ name: "Pet Commerce" });
    const seed = createNovaProductResearchSeed(company.id);
    flow.kernel.bootstrapWorkforce({ companyId: company.id, ...seed });
    flow.kernel.close();
    reopened = reopenKernel(flow.dir);
    const nova = reopened.employee(seed.employees[0].id);
    const position = reopened.position(seed.positions[0].id);
    assert.equal(nova.displayName, "Nova");
    assert.equal(nova.positionId, position.id);
    assert.equal(position.title, "Product Researcher");
    assert.deepEqual(position.capabilities, [PRODUCT_RESEARCH_CAPABILITY]);
    for (const field of ["model", "provider", "workerRun", "skill", "agentLifecycle"])
      assert.equal(Object.hasOwn(nova, field), false);
    assert.deepEqual(reopened.bootstrapWorkforce({ companyId: company.id, ...createNovaProductResearchSeed(company.id) }),
      { positions: 0, employees: 0, skipped: 2 });
  } finally {
    reopened?.close();
    flow.cleanup();
  }
});

import { WEB_READ, WEB_SEARCH, createWebResearchActuator } from "../harness/adapters/web-research-actuator.mjs";
import { parsePublicWebUrl } from "../harness/web-network-policy.mjs";
import { createGenericModelWorkerAdapter, GENERIC_MODEL_WORKER_ADAPTER_TYPE } from "../harness/adapters/generic-model-worker.mjs";
import { assertAdapterManifest, assertWorkerAdapter } from "../harness/adapter.mjs";
import { createStaticWorkerBackendResolver } from "../harness/resolver.mjs";
import { createWorkerHost } from "../harness/host.mjs";

export const PRODUCT_RESEARCH_CAPABILITY = "commerce.product.research";
export const PRODUCT_RESEARCH_ARTIFACT_KIND = "product-research";
export const PRODUCT_RESEARCH_ARTIFACT_VERSION = "ProductResearchArtifact.v0";
export const PRODUCT_RESEARCH_REQUEST_KIND = "ProductSelectionResearch.v0";

export const PRODUCT_SELECTION_RESEARCH_SKILL = Object.freeze({
  skillId: "ProductSelectionResearch",
  version: "v0",
  requiredCapabilities: Object.freeze([PRODUCT_RESEARCH_CAPABILITY]),
  allowedToolCapabilities: Object.freeze([WEB_SEARCH, WEB_READ]),
  rules: Object.freeze([
    "Research the Work's category, market and candidate count. Search results are discovery only; read public product pages before citing them.",
    "Use only sourceId values returned by authorized read TOOL_RESULT observations. A URL, search hit or model-generated ID is not evidence.",
    "Return one product-research Artifact whose JSON content has schemaVersion ProductResearchArtifact.v0, category, market, candidates, marketObservations, opportunities and risks.",
    "Each candidate requires productName, brand, price, rating, reviewCount, sellingPoints, observedWeaknesses and sourceIds. Price is {amount,currency} or null; unknown facts are null, unknown lists are empty.",
    "Each market observation, opportunity or risk is {text,sourceIds}; cite only successful reads from this WorkerRun, or use an empty list when unsupported.",
    "Never infer unavailable price, rating, review count, strengths or weaknesses. Do not purchase, log in, submit forms or send POST requests.",
    "A Skill describes method, not permission. Use only tools offered in this WorkerRun and finish within its budget.",
  ]),
});

const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const text = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const nullableText = (value, max) => value === null || text(value, max);
const fail = (code) => Object.freeze({ ok: false, code });

function validRequest(request) {
  if (!exact(request, ["requestKind", "category", "market", "candidateCount", "publicProductUrls"]) ||
      request.requestKind !== PRODUCT_RESEARCH_REQUEST_KIND || !text(request.category, 120) ||
      request.market !== "US" || !Number.isInteger(request.candidateCount) ||
      request.candidateCount < 1 || request.candidateCount > 5 ||
      !Array.isArray(request.publicProductUrls) ||
      (request.publicProductUrls.length !== 0 && request.publicProductUrls.length !== request.candidateCount) ||
      request.publicProductUrls.some((url) => typeof url !== "string" || url.length > 300) ||
      new Set(request.publicProductUrls).size !== request.publicProductUrls.length) return false;
  try { for (const url of request.publicProductUrls) parsePublicWebUrl(url); }
  catch { return false; }
  return true;
}

export function createProductResearchWork({ kernel, companyId, category = "automatic pet feeder", market = "US", candidateCount = 5, publicProductUrls = [] } = {}) {
  if (!kernel || typeof kernel.createWork !== "function") throw new Error("createProductResearchWork requires a Kernel");
  const request = { requestKind: PRODUCT_RESEARCH_REQUEST_KIND, category, market, candidateCount, publicProductUrls };
  if (!validRequest(request)) throw new Error("invalid product research request");
  const intent = JSON.stringify(request);
  return kernel.createWork({ companyId, title: `Research ${category} for ${market}`, intent });
}

// Called by the trusted Host delivery seam. A valid result requires a fresh
// read observation in this WorkerRun for every cited sourceId. The model may
// choose which observations to cite but cannot mint or import their IDs.
export function validateProductResearchArtifact({ run, proposedArtifact, observedSources = [] } = {}) {
  if (!run?.workPacket?.requirements?.requiredCapabilities?.includes(PRODUCT_RESEARCH_CAPABILITY))
    return fail("PRODUCT_RESEARCH_CAPABILITY_MISSING");
  let request;
  let artifact;
  if (typeof proposedArtifact?.content !== "string" || Buffer.byteLength(proposedArtifact.content) > 100 * 1024)
    return fail("PRODUCT_RESEARCH_SCHEMA_INVALID");
  try {
    request = JSON.parse(run.workPacket.work.intent);
    artifact = JSON.parse(proposedArtifact?.content);
  } catch { return fail("PRODUCT_RESEARCH_INVALID_JSON"); }
  if (!validRequest(request))
    return fail("PRODUCT_RESEARCH_REQUEST_INVALID");
  if (proposedArtifact.kind !== PRODUCT_RESEARCH_ARTIFACT_KIND ||
      !exact(artifact, ["schemaVersion", "category", "market", "candidates", "marketObservations", "opportunities", "risks"]) ||
      artifact.schemaVersion !== PRODUCT_RESEARCH_ARTIFACT_VERSION ||
      artifact.category !== request.category || artifact.market !== request.market ||
      !Array.isArray(artifact.candidates) || artifact.candidates.length !== request.candidateCount)
    return fail("PRODUCT_RESEARCH_SCHEMA_INVALID");
  const observed = new Set(observedSources.map((source) => source.sourceId));
  const referenced = [];
  const validSourceIds = (ids) => Array.isArray(ids) && ids.length >= 1 && ids.length <= 10 &&
    ids.every((id) => typeof id === "string" && /^src_[0-9a-f-]{36}$/.test(id)) &&
    new Set(ids).size === ids.length;
  const candidateKeys = ["productName", "brand", "price", "rating", "reviewCount", "sellingPoints", "observedWeaknesses", "sourceIds"];
  for (const candidate of artifact.candidates) {
    if (!exact(candidate, candidateKeys) || !nullableText(candidate.productName, 200) ||
        !nullableText(candidate.brand, 120) ||
        !(candidate.price === null || (exact(candidate.price, ["amount", "currency"]) &&
          typeof candidate.price.amount === "number" && Number.isFinite(candidate.price.amount) &&
          candidate.price.amount >= 0 && candidate.price.amount <= 1_000_000 &&
          candidate.price.currency === "USD")) ||
        !(candidate.rating === null || (typeof candidate.rating === "number" && Number.isFinite(candidate.rating) && candidate.rating >= 0 && candidate.rating <= 5)) ||
        !(candidate.reviewCount === null || (Number.isSafeInteger(candidate.reviewCount) && candidate.reviewCount >= 0 && candidate.reviewCount <= 1_000_000_000)) ||
        !Array.isArray(candidate.sellingPoints) || candidate.sellingPoints.length > 10 || candidate.sellingPoints.some((item) => !text(item, 500)) ||
        !Array.isArray(candidate.observedWeaknesses) || candidate.observedWeaknesses.length > 10 || candidate.observedWeaknesses.some((item) => !text(item, 500)) ||
        !validSourceIds(candidate.sourceIds))
      return fail("PRODUCT_RESEARCH_CANDIDATE_INVALID");
    referenced.push(...candidate.sourceIds);
  }
  for (const field of ["marketObservations", "opportunities", "risks"]) {
    const entries = artifact[field];
    if (!Array.isArray(entries) || entries.length > 10) return fail("PRODUCT_RESEARCH_SCHEMA_INVALID");
    for (const entry of entries) {
      if (!exact(entry, ["text", "sourceIds"]) || !text(entry.text, 500) || !validSourceIds(entry.sourceIds))
        return fail("PRODUCT_RESEARCH_SCHEMA_INVALID");
      referenced.push(...entry.sourceIds);
    }
  }
  if (referenced.some((id) => !observed.has(id))) return fail("PRODUCT_RESEARCH_SOURCE_UNOBSERVED");
  return Object.freeze({ ok: true });
}

// Product composition: the postcondition is installed by construction, while
// tool approval stays an explicit Host input. A Reviewer adapter is supplied
// independently and receives the existing REVIEW_JUDGMENT contract.
export function createProductResearchHost({
  kernel, runtimeRoot, modelBackend, reviewerAdapter = null,
  searchProvider = null, reader, approvedCapabilities = [], timeoutMs = 30_000,
} = {}) {
  const researchAdapter = createGenericModelWorkerAdapter({ modelBackend, skill: PRODUCT_SELECTION_RESEARCH_SKILL });
  if (reviewerAdapter !== null) assertWorkerAdapter(reviewerAdapter);
  const adapter = Object.freeze({
    async manifest() {
      const manifest = await researchAdapter.manifest();
      if (reviewerAdapter && assertAdapterManifest(await reviewerAdapter.manifest()).adapterType !== manifest.adapterType)
        throw new Error("Reviewer adapter must use the generic-model-worker contract");
      return manifest;
    },
    async start(input, context) {
      const delegate = input.resultContract.kind === "REVIEW_JUDGMENT" ? reviewerAdapter : researchAdapter;
      if (!delegate) throw new Error("Reviewer adapter is not configured");
      return { delegate, handle: await delegate.start(input, context) };
    },
    events(wrapper) { return wrapper.delegate.events(wrapper.handle); },
    wait(wrapper, options) { return wrapper.delegate.wait(wrapper.handle, options); },
    cancel(wrapper, reason) { return wrapper.delegate.cancel(wrapper.handle, reason); },
  });
  const staticResolver = createStaticWorkerBackendResolver({
    backendType: GENERIC_MODEL_WORKER_ADAPTER_TYPE, backendVersion: modelBackend.backendVersion,
  });
  const resolver = Object.freeze({
    resolve(input) {
      let request;
      try { request = JSON.parse(input.workerRun?.workPacket?.work?.intent); }
      catch { return null; }
      if (!validRequest(request) ||
          (input.workerRun.workPacket.review && !reviewerAdapter)) return null;
      return staticResolver.resolve(input);
    },
  });
  return createWorkerHost({
    kernel, adapter, runtimeRoot, timeoutMs,
    resolver,
    requestedPolicy: { network: true, hostFilesystem: "workspace-only" },
    toolPolicy: {
      skill: PRODUCT_SELECTION_RESEARCH_SKILL,
      approvedCapabilities,
      actuators: [createWebResearchActuator({ searchProvider, reader })],
      budget: { maxToolCalls: 6, maxCallsByCapability: { [WEB_SEARCH]: 1, [WEB_READ]: 5 },
        maxElapsedMs: timeoutMs, toolTimeoutMs: Math.min(timeoutMs, 10_000) },
    },
    artifactPostcondition: validateProductResearchArtifact,
  });
}

// One bounded Founder-created Customer Researcher trial. Identity, trial Work,
// and confirmation are Runtime facts; Skills and tools are selected per run.
import { createEmployeeActivationResolver } from "../harness/employee-activation.mjs";
import { createAuthorizedWebReadActuator, createWebResearchActuator, WEB_READ } from "../harness/adapters/web-research-actuator.mjs";
import { createWebReader } from "../harness/web-reader.mjs";
import { createTrustedDohResolver } from "../harness/web-doh-resolver.mjs";
import { parsePublicWebUrl } from "../harness/web-network-policy.mjs";

const TRIAL_KIND = "EmployeeCustomerResearchTrial.v0";
const TRIAL_ARTIFACT_KIND = "customer-insight-trial";
const FOLLOWUP_KIND = "CapabilityCustomerResearch.v0";
const boundedText = value => typeof value === "string" && value.length > 0 && value.length <= 800;

export function validateCustomerInsightTrial({ run, proposedArtifact, observedSources = [] } = {}) {
  if (proposedArtifact?.kind !== TRIAL_ARTIFACT_KIND)
    return { ok: false, code: "TRIAL_ARTIFACT_KIND_INVALID" };
  if (typeof proposedArtifact.content !== "string" || Buffer.byteLength(proposedArtifact.content) > 24_000)
    return { ok: false, code: "TRIAL_ARTIFACT_SIZE_INVALID" };
  let body;
  try { body = JSON.parse(proposedArtifact.content); }
  catch { return { ok: false, code: "TRIAL_ARTIFACT_JSON_INVALID" }; }
  const expected = ["schemaVersion", "observations", "hypotheses", "unknowns", "sourceIds", "limitations"];
  if (!body || Array.isArray(body) || Object.keys(body).sort().join() !== expected.sort().join() ||
      body.schemaVersion !== 1 || !Array.isArray(body.observations) || body.observations.length > 12 ||
      !Array.isArray(body.hypotheses) || body.hypotheses.length > 12 ||
      !Array.isArray(body.unknowns) || body.unknowns.length < 1 || body.unknowns.length > 12 ||
      ![...body.observations, ...body.hypotheses, ...body.unknowns].every(boundedText) ||
      !boundedText(body.limitations))
    return { ok: false, code: "TRIAL_ARTIFACT_SCHEMA_INVALID" };
  if (!Array.isArray(body.sourceIds) || body.sourceIds.length !== 1 ||
      typeof body.sourceIds[0] !== "string" || !/^src_[0-9a-f-]{36}$/.test(body.sourceIds[0]) ||
      !observedSources.some(source => source.sourceId === body.sourceIds[0]))
    return { ok: false, code: "TRIAL_ARTIFACT_SOURCE_INVALID" };
  if (!run?.workPacket?.requirements?.requiredCapabilities?.includes("customer.research"))
    return { ok: false, code: "TRIAL_ARTIFACT_CAPABILITY_INVALID" };
  return { ok: true };
}

export function validateCustomerResearchDelivery({ run, proposedArtifact, observedSources = [] } = {}) {
  let goal;
  try { goal = JSON.parse(run?.workPacket?.work?.intent); } catch { return { ok: false, code: "RESEARCH_WORK_KIND_INVALID" }; }
  if (goal?.requestKind === TRIAL_KIND)
    return validateCustomerInsightTrial({ run, proposedArtifact, observedSources });
  if (goal?.requestKind !== FOLLOWUP_KIND || observedSources.length !== 0 ||
      proposedArtifact?.kind !== "customer-research-note" ||
      typeof proposedArtifact.content !== "string" || Buffer.byteLength(proposedArtifact.content) > 16_000)
    return { ok: false, code: "RESEARCH_DELIVERY_INVALID" };
  let body;
  try { body = JSON.parse(proposedArtifact.content); } catch { return { ok: false, code: "RESEARCH_JSON_INVALID" }; }
  const expected = ["schemaVersion", "evidenceArtifactId", "evidenceArtifactDigest",
    "observations", "hypotheses", "unknowns", "limitations"];
  if (!body || Array.isArray(body) || Object.keys(body).sort().join() !== expected.sort().join() ||
      body.schemaVersion !== 1 || body.evidenceArtifactId !== goal.evidenceArtifactId ||
      body.evidenceArtifactDigest !== goal.evidenceArtifactDigest ||
      ![body.observations, body.hypotheses, body.unknowns].every(list =>
        Array.isArray(list) && list.length <= 12 && list.every(boundedText)) ||
      body.unknowns.length < 1 || !boundedText(body.limitations))
    return { ok: false, code: "RESEARCH_SCHEMA_INVALID" };
  return { ok: true };
}

export function createCustomerResearchDraft({ kernel, companyId, displayName, positionTitle = "Customer Researcher" } = {}) {
  return kernel.createEmployeeDraft({ companyId, displayName, positionTitle,
    declaredCapabilities: ["customer.research", "evidence.analysis"],
    eligibleSkills: ["CustomerInsight@v1", "EvidenceSynthesis@v1"],
    authorityProfile: "PUBLIC_WEB_READ_ONLY", knowledgeScope: "NONE", reasoningProfile: "STANDARD" });
}

export function startCustomerResearchTrial({ kernel, companyId, employeeId, publicUrl } = {}) {
  const normalized = parsePublicWebUrl(publicUrl).href;
  return kernel.startEmployeeTrial({ companyId, employeeId, publicUrl: normalized });
}

export function createHiringActivationResolver({ kernel, modelBackend,
  reader = createWebReader({ resolveHost: createTrustedDohResolver(), sameHostRedirectsOnly: true }) } = {}) {
  if (!kernel || !modelBackend) throw new Error("Hiring Activation requires Runtime and ModelBackend");
  const web = createWebResearchActuator({ reader });
  return createEmployeeActivationResolver({ profiles: [
    { modelBackend, resultContracts: ["ARTIFACT_DELIVERY"], artifactPostcondition: validateCustomerResearchDelivery,
      skill: { skillId: "CustomerInsight", version: "v1", requiredCapabilities: ["customer.research"],
        allowedToolCapabilities: [WEB_READ], rules: [
          "For EmployeeCustomerResearchTrial.v0 only: read the single Founder-approved public URL before final delivery; deliver customer-insight-trial JSON with exactly schemaVersion:1, observations:string[], hypotheses:string[], unknowns:string[], sourceIds:[the Host-observed sourceId], limitations:string.",
          "For CapabilityCustomerResearch.v0 only: no web tool is authorized. Use the accepted evidence Artifact excerpt in Work intent. Deliver customer-research-note JSON with exactly schemaVersion:1, evidenceArtifactId and evidenceArtifactDigest from Work intent, observations:string[], hypotheses:string[], unknowns:string[], limitations:string. Never present inherited source IDs as observations of this run.",
          "A brand product page does not establish real customer complaints. Put unverified customer needs in hypotheses or unknowns; state evidence limitations.",
          "Do not infer ratings, customer testimony, or market size from absent evidence.",
        ] } },
    { modelBackend, resultContracts: ["ARTIFACT_DELIVERY"],
      skill: { skillId: "EvidenceSynthesis", version: "v1", requiredCapabilities: ["evidence.analysis"],
        allowedToolCapabilities: [], rules: [
          "Use only the bounded Work and Task instruction. No web tool is authorized in this run.",
          "Deliver one evidence-synthesis Artifact; distinguish supplied evidence from uncertainty.",
        ] } },
    { modelBackend, resultContracts: ["REVIEW_JUDGMENT"],
      skill: { skillId: "IndependentReview", version: "v0", requiredCapabilities: ["work.review"],
        allowedToolCapabilities: [], rules: [
          "Judge the exact Artifact independently. A public brand page does not prove customer complaints.",
          "Request revision for unsupported customer assertions or missing evidence limitations. PASS does not hire the Employee.",
        ] } },
  ], policyForRun({ workerRun, skill }) {
    const identity = kernel.employeeHiring(workerRun.employeeId);
    if (identity.origin === "FOUNDER_DRAFT" &&
        !identity.eligibleSkills.includes(`${skill.skillId}@${skill.version}`))
      throw new Error("Skill is not eligible for this Founder-created Employee");
    if (skill.skillId !== "CustomerInsight") return { approvedCapabilities: [], budget: { maxToolCalls: 0 } };
    const hiring = identity;
    let goal;
    try { goal = JSON.parse(workerRun.workPacket.work.intent); } catch { /* invalid trial */ }
    if (goal?.requestKind === FOLLOWUP_KIND && hiring.state === "ACTIVE" &&
        hiring.capabilityEvidence.some(evidence => evidence.capability === "customer.research" &&
          evidence.status === "TRIAL_VALIDATED")) {
      const source = goal.evidenceArtifactId ? kernel.artifact(goal.evidenceArtifactId) : null;
      const sourceWork = source ? kernel.work(source.workId) : null;
      if (source && sourceWork?.companyId === workerRun.companyId &&
          source.contentDigest === goal.evidenceArtifactDigest &&
          source.content.slice(0, 1000) === goal.evidenceExcerpt &&
          kernel.workProjection(sourceWork.id).outcome.accepted?.artifactId === source.id)
        return { approvedCapabilities: [], budget: { maxToolCalls: 0 } };
      throw new Error("future Work lacks exact accepted Company evidence");
    }
    if (hiring.origin !== "FOUNDER_DRAFT" || hiring.trial?.workId !== workerRun.workId ||
        goal?.requestKind !== TRIAL_KIND || goal.employeeId !== workerRun.employeeId ||
        hiring.authorityProfile !== "PUBLIC_WEB_READ_ONLY")
      throw new Error("no Founder-authorized trial binding");
    const approved = parsePublicWebUrl(goal.publicUrl).href;
    const actuator = createAuthorizedWebReadActuator({ base: web, allowedUrls: new Set([approved]) });
    return { approvedCapabilities: [WEB_READ], actuators: [actuator],
      requestedPolicy: { network: true, hostFilesystem: "workspace-only" },
      budget: { maxToolCalls: 1, maxCallsByCapability: { [WEB_READ]: 1 },
        maxElapsedMs: 180_000, toolTimeoutMs: 12_000 } };
  } });
}

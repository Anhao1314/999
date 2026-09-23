// Bounded, exact capability routing for Founder-created customer researchers.
// This is a pure policy used by the existing Continuation Driver and checked
// again by the Assignment command. It grants no tool or model authority.
import { createHash } from "node:crypto";

export const ROUTING_POLICY_VERSION = "customer-research-routing.v1";
export const ROUTED_CAPABILITY = "customer.research";
export const ROUTED_SKILL = "CustomerInsight@v1";
export const CAPABILITY_CONTRACT_VERSION = "v1";
export const MAX_ROUTING_CANDIDATES = 3;

// There are deliberately no aliases in v1. In particular, market-entry user
// insights and customer research are related tasks, not equivalent authority.
export const CAPABILITY_CONTRACT = Object.freeze({
  version: CAPABILITY_CONTRACT_VERSION,
  canonical: Object.freeze([
    "work.execute", "customer.research", "evidence.analysis", "commerce.product.research",
    "commerce.user.insights", "commerce.market.analysis",
    "commerce.market.synthesis", "commerce.market.review", "work.review",
  ]),
  aliases: Object.freeze({}),
  nonInterchangeable: Object.freeze([["customer.research", "commerce.user.insights"]]),
});

export function canonicalCapability(value) {
  return CAPABILITY_CONTRACT.canonical.includes(value) ? value : null;
}

export const routingBasisDigest = value => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

export function routeCustomerResearch({ companyId, taskId, workId, employees = [], positions = [],
  hiringByEmployeeId = new Map(), activeEmployeeIds = [], activationSkills = [] } = {}) {
  const positionsById = new Map(positions.map(position => [position.id, position]));
  const busy = new Set(activeEmployeeIds);
  const skillReady = activationSkills.includes(ROUTED_SKILL);
  const eligible = [];
  const rejected = [];
  for (const employee of employees) {
    if (employee.companyId !== companyId) continue;
    const position = positionsById.get(employee.positionId);
    if (!position || position.companyId !== companyId || !position.capabilities.includes(ROUTED_CAPABILITY)) {
      rejected.push({ employeeId: employee.id, reason: "POSITION_MISMATCH" });
      continue;
    }
    if (!employee.enabled) { rejected.push({ employeeId: employee.id, reason: "DISABLED" }); continue; }
    if (!skillReady) { rejected.push({ employeeId: employee.id, reason: "SKILL_UNAVAILABLE" }); continue; }
    const hiring = hiringByEmployeeId.get(employee.id);
    let evidence = null;
    if (hiring?.origin === "LEGACY_OR_SEEDED") {
      evidence = { status: "LEGACY_POSITION_FACT", artifactDigest: null, reviewId: null };
    } else if (hiring?.origin === "FOUNDER_DRAFT" && hiring.state === "ACTIVE" &&
        hiring.eligibleSkills?.includes(ROUTED_SKILL)) {
      const fact = hiring.capabilityEvidence?.find(item => item.capability === ROUTED_CAPABILITY);
      if (fact?.status === "TRIAL_VALIDATED" && fact.artifactId &&
          /^sha256:[0-9a-f]{64}$/.test(fact.artifactDigest ?? "") && fact.reviewId)
        evidence = { status: "TRIAL_VALIDATED", artifactDigest: fact.artifactDigest,
          reviewId: fact.reviewId };
    }
    if (!evidence) { rejected.push({ employeeId: employee.id, reason: "EVIDENCE_INSUFFICIENT" }); continue; }
    eligible.push({ employee, position, evidence, busy: busy.has(employee.id) });
  }
  // Evidence class, then current WorkerRun contention, then stable identity.
  // Display name, personality and aggregate quality never participate.
  const rank = { TRIAL_VALIDATED: 0, LEGACY_POSITION_FACT: 1 };
  eligible.sort((a, b) => rank[a.evidence.status] - rank[b.evidence.status] ||
    Number(a.busy) - Number(b.busy) || a.employee.id.localeCompare(b.employee.id));
  const overBound = eligible.length > MAX_ROUTING_CANDIDATES;
  const selected = overBound ? null : eligible.find(candidate => !candidate.busy) ?? null;
  const basis = selected ? {
    policyVersion: ROUTING_POLICY_VERSION, contractVersion: CAPABILITY_CONTRACT_VERSION,
    companyId, workId, taskId, employeeId: selected.employee.id,
    positionId: selected.position.id, capability: ROUTED_CAPABILITY,
    evidenceStatus: selected.evidence.status, evidenceArtifactDigest: selected.evidence.artifactDigest,
    evidenceReviewId: selected.evidence.reviewId, skill: ROUTED_SKILL,
    eligibleEmployeeIds: eligible.map(candidate => candidate.employee.id),
    candidateFacts: eligible.map(candidate => [candidate.employee.id,
      candidate.evidence.status, Number(candidate.busy)]),
  } : null;
  return { eligible, selected, rejected, basis: basis ? { ...basis, digest: routingBasisDigest(basis) } : null,
    gap: overBound ? "CANDIDATE_BOUND_EXCEEDED" :
      eligible.length === 0 ? "NO_ELIGIBLE_EMPLOYEE" : selected ? null : "ALL_ELIGIBLE_BUSY" };
}

// Existing immutable Assignment.reason is sufficient for the bounded v1 basis;
// no schema migration is needed. Identifiers already live on the Assignment.
export function routingAssignmentReason(basis) {
  if (!basis || basis.policyVersion !== ROUTING_POLICY_VERSION) throw new Error("invalid routing basis");
  const reason = `routing.v1:${JSON.stringify({ c: basis.capability,
    e: basis.evidenceStatus, a: basis.evidenceArtifactDigest,
    r: basis.evidenceReviewId, s: basis.skill,
    x: basis.candidateFacts, d: basis.digest })}`;
  if (reason.length > 500) throw new Error("routing basis exceeds Assignment bound");
  return reason;
}

export function parseRoutingAssignmentReason(reason) {
  if (typeof reason !== "string" || !reason.startsWith("routing.v1:")) return null;
  try {
    const raw = JSON.parse(reason.slice("routing.v1:".length));
    if (raw.c !== ROUTED_CAPABILITY || raw.s !== ROUTED_SKILL ||
        !["TRIAL_VALIDATED", "LEGACY_POSITION_FACT"].includes(raw.e) ||
        !/^sha256:[0-9a-f]{64}$/.test(raw.d) ||
        !Array.isArray(raw.x) || raw.x.length < 1 || raw.x.length > MAX_ROUTING_CANDIDATES ||
        raw.x.some(item => !Array.isArray(item) || item.length !== 3 ||
          typeof item[0] !== "string" || !["TRIAL_VALIDATED", "LEGACY_POSITION_FACT"].includes(item[1]) ||
          ![0, 1].includes(item[2]))) return null;
    return { capability: raw.c, evidence: raw.e, artifactDigest: raw.a,
      reviewId: raw.r, skill: raw.s, candidateFacts: raw.x, digest: raw.d };
  } catch { return null; }
}

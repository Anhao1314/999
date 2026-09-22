// Founder Decision — the one durable authority act of v0B3.
// Contract: docs/contracts/founder-attention-acceptance-v0.md §2–§4.
//
// A decision is what the Founder decided about an exact Artifact of an exact
// Work, at an exact revision of that Work's reality. It is written once, never
// edited and never deleted; a wrong decision is answered by a new cycle of
// work, never by rewriting history. The record states an act ("ACCEPT"); the
// derived Work outcome states the resulting condition ("ACCEPTED").
import { randomUUID } from "node:crypto";

export const FOUNDER_DECISION_ID_PREFIX = "dec_";

export const FOUNDER_DECISION_DISPOSITIONS = Object.freeze({
  ACCEPT: "ACCEPT",
});

export const FOUNDER_DECISION_DISPOSITION_VALUES = Object.freeze(
  Object.values(FOUNDER_DECISION_DISPOSITIONS),
);

export function isFounderDecisionDisposition(value) {
  return FOUNDER_DECISION_DISPOSITION_VALUES.includes(value);
}

export function newFounderDecisionId() {
  return `${FOUNDER_DECISION_ID_PREFIX}${randomUUID()}`;
}

export function newFounderDecision({
  id = newFounderDecisionId(),
  companyId,
  workId,
  disposition,
  artifactId,
  artifactDigest,
  basisSequence,
  createdAt,
}) {
  return Object.freeze({
    id,
    companyId,
    workId,
    disposition,
    artifactId,
    artifactDigest,
    basisSequence,
    createdAt,
  });
}

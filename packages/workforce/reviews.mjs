// Review — an immutable judgment about one exact Artifact.
// Contract: docs/contracts/review-repair-collaboration-v0.md §4.
//
// A Review says what one Employee concluded about the Artifact of another: it
// is not an acceptance, not an admission and not a Founder decision. The record
// is written once by `submitReview` and is immutable in storage.
import { randomUUID } from "node:crypto";

export const REVIEW_ID_PREFIX = "rev_";

export const REVIEW_VERDICTS = Object.freeze({
  PASS: "PASS",
  REQUEST_REVISION: "REQUEST_REVISION",
});

export const REVIEW_VERDICT_VALUES = Object.freeze(Object.values(REVIEW_VERDICTS));

export function newReviewId() {
  return `${REVIEW_ID_PREFIX}${randomUUID()}`;
}

export function newReview({
  id = newReviewId(),
  companyId,
  workId,
  reviewTaskId,
  reviewerWorkerRunId,
  targetArtifactId,
  targetArtifactDigest,
  verdict,
  summary,
  findings,
  createdAt,
}) {
  return Object.freeze({
    id,
    companyId,
    workId,
    reviewTaskId,
    reviewerWorkerRunId,
    targetArtifactId,
    targetArtifactDigest,
    verdict,
    summary,
    findings: Object.freeze([...findings]),
    createdAt,
  });
}

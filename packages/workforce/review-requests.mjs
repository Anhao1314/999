// ReviewRequest — the recorded fact that one Artifact owes a review.
// Contract: docs/contracts/review-repair-collaboration-v0.md §3.
//
// It is written in the same transaction that completes the producing Task and
// creates the Review Task, so a crash can never leave a Task that looks done
// while its review obligation quietly disappeared.
import { randomUUID } from "node:crypto";

export const REVIEW_REQUEST_ID_PREFIX = "rrq_";

export function newReviewRequestId() {
  return `${REVIEW_REQUEST_ID_PREFIX}${randomUUID()}`;
}

export function newReviewRequest({
  id = newReviewRequestId(),
  companyId,
  workId,
  reviewTaskId,
  sourceTaskId,
  targetArtifactId,
  targetArtifactDigest,
  createdAt,
}) {
  return Object.freeze({
    id,
    companyId,
    workId,
    reviewTaskId,
    sourceTaskId,
    targetArtifactId,
    targetArtifactDigest,
    createdAt,
  });
}

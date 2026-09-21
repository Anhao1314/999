// RepairBinding — the immutable lineage of a Repair Task.
// Contract: docs/contracts/review-repair-collaboration-v0.md §8.
//
// A repair exists because a review asked for one, and it replaces exactly the
// Artifact that review judged. One repair task per review, one review per
// binding; neither is ever rewritten.
import { randomUUID } from "node:crypto";

export const REPAIR_BINDING_ID_PREFIX = "rbd_";

export function newRepairBindingId() {
  return `${REPAIR_BINDING_ID_PREFIX}${randomUUID()}`;
}

export function newRepairBinding({
  id = newRepairBindingId(),
  companyId,
  workId,
  repairTaskId,
  reviewId,
  sourceTaskId,
  targetArtifactId,
  targetArtifactDigest,
  createdAt,
}) {
  return Object.freeze({
    id,
    companyId,
    workId,
    repairTaskId,
    reviewId,
    sourceTaskId,
    targetArtifactId,
    targetArtifactDigest,
    createdAt,
  });
}

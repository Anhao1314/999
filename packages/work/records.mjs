// Record shapes for the Persistent Work Kernel: Checkpoint, Artifact and
// Activity. Contracts: docs/contracts/persistent-work-kernel-v0.md §5–§8,
// docs/contracts/review-repair-collaboration-v0.md §9 (supersession).
//
// These are plain frozen records. The runtime command layer validates input
// against BOUNDS before constructing them; the store maps them to storage rows.
import { createHash, randomUUID } from "node:crypto";

export const CHECKPOINT_ID_PREFIX = "ckp_";
export const ARTIFACT_ID_PREFIX = "art_";

export const BOUNDS = Object.freeze({
  companyNameMax: 120,
  workTitleMax: 160,
  workIntentMax: 2000,
  taskTitleMax: 160,
  taskIntentMax: 2000,
  checkpointLabelMax: 120,
  checkpointStateMax: 64 * 1024,
  artifactKindMax: 48,
  artifactTitleMax: 200,
  artifactContentMax: 100 * 1024,
  cancelNoteMax: 2000,
  digestMax: 128,
  idMax: 128,
  positionTitleMax: 120,
  employeeNameMax: 120,
  providerPreferenceMax: 120,
  assignmentReasonMax: 500,
  reviewSummaryMax: 2000,
  reviewFindingMax: 1000,
  reviewFindingsMax: 50,
});

export function newCheckpointId() {
  return `${CHECKPOINT_ID_PREFIX}${randomUUID()}`;
}

export function newArtifactId() {
  return `${ARTIFACT_ID_PREFIX}${randomUUID()}`;
}

export function digestOf(text) {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

export function newCheckpoint({
  id = newCheckpointId(),
  taskId,
  generation,
  sequence,
  label,
  state,
  createdAt,
}) {
  return Object.freeze({
    id,
    taskId,
    generation,
    sequence,
    label,
    state,
    createdAt,
  });
}

export function newArtifact({
  id = newArtifactId(),
  companyId,
  workId,
  taskId,
  generation,
  workerRunId = null,
  kind,
  title,
  content,
  inputDigest = null,
  supersedesArtifactId = null,
  createdAt,
}) {
  return Object.freeze({
    id,
    companyId,
    workId,
    taskId,
    generation,
    workerRunId,
    kind,
    title,
    content,
    contentDigest: digestOf(content),
    inputDigest,
    supersedesArtifactId,
    createdAt,
  });
}

export function newActivityEvent({
  companyId,
  workId = null,
  taskId = null,
  generation = null,
  kind,
  detail = {},
  createdAt,
}) {
  return Object.freeze({
    companyId,
    workId,
    taskId,
    generation,
    kind,
    detail,
    createdAt,
  });
}

// Record shapes for the Persistent Work Kernel: Checkpoint, Artifact and
// Activity. Contract: docs/contracts/persistent-work-kernel-v0.md §5–§8.
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
});

export const ACTIVITY_KINDS = Object.freeze([
  "company.created",
  "work.created",
  "task.created",
  "task.execution_started",
  "checkpoint.written",
  "artifact.recorded",
  "task.completed",
  "task.interrupted",
  "task.cancelled",
]);

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
  kind,
  title,
  content,
  inputDigest = null,
  createdAt,
}) {
  return Object.freeze({
    id,
    companyId,
    workId,
    taskId,
    generation,
    kind,
    title,
    content,
    contentDigest: digestOf(content),
    inputDigest,
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

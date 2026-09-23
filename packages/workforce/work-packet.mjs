// WorkPacket — the minimum working context granted to an Employee for one run.
// Contract: docs/contracts/workforce-identity-assignment-v0.md §7.
//
// Deterministic and bounded: built only from persisted facts, keys in a fixed
// order, no database dump, no company history, no event log, no prompt.
import { digestOf } from "../work/records.mjs";

export const WORK_PACKET_VERSION = 2;
export const BOUNDED_INPUT_PACKET_VERSION = 3;
export const PACKET_ARTIFACT_LIMIT = 20;

const artifactSummary = (artifact) =>
  Object.freeze({
    id: artifact.id,
    kind: artifact.kind,
    title: artifact.title,
    contentDigest: artifact.contentDigest,
    generation: artifact.generation,
    createdAt: artifact.createdAt,
  });

const checkpointSummary = (checkpoint) =>
  checkpoint
    ? Object.freeze({
        id: checkpoint.id,
        label: checkpoint.label,
        sequence: checkpoint.sequence,
        generation: checkpoint.generation,
        state: checkpoint.state,
      })
    : null;

export function buildWorkPacket({
  company,
  work,
  task,
  requirements,
  assignment,
  employee,
  position,
  latestCheckpoint = null,
  artifacts = [],
  inputArtifacts = [],
  review = null,
  repair = null,
}) {
  const recent = artifacts.slice(-PACKET_ARTIFACT_LIMIT).map(artifactSummary);
  return Object.freeze({
    packetVersion: inputArtifacts.length ? BOUNDED_INPUT_PACKET_VERSION : WORK_PACKET_VERSION,
    company: Object.freeze({ id: company.id, name: company.name }),
    work: Object.freeze({ id: work.id, title: work.title, intent: work.intent }),
    task: Object.freeze({
      id: task.id,
      title: task.title,
      intent: task.intent,
      state: task.state,
      generation: task.generation,
    }),
    requirements: Object.freeze({
      requiredCapabilities: Object.freeze([
        ...(requirements?.requiredCapabilities ?? []),
      ]),
    }),
    assignment: Object.freeze({
      id: assignment.id,
      employeeId: assignment.employeeId,
      positionId: assignment.positionId,
      reason: assignment.reason ?? null,
      assignedAt: assignment.createdAt,
    }),
    employee: Object.freeze({ id: employee.id, displayName: employee.displayName }),
    position: Object.freeze({
      id: position.id,
      title: position.title,
      capabilities: Object.freeze([...position.capabilities]),
    }),
    context: Object.freeze({
      latestCheckpoint: checkpointSummary(latestCheckpoint),
      priorArtifacts: Object.freeze(recent),
      priorArtifactCount: artifacts.length,
      ...(inputArtifacts.length ? { inputArtifacts: Object.freeze(inputArtifacts.map((artifact) =>
        Object.freeze({ ...artifact }))) } : {}),
    }),
    review: review ? Object.freeze({ ...review }) : null,
    repair: repair ? Object.freeze({ ...repair }) : null,
  });
}

export function workPacketDigest(packet) {
  return digestOf(JSON.stringify(packet));
}

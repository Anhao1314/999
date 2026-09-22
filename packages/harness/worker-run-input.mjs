// WorkerRunInput — what the Host hands an adapter for one attempt.
// Contract: docs/contracts/worker-harness-v0.md §3, §4, §16.
//
// The durable WorkPacket is the working context the Runtime granted; the
// envelope adds only execution facts the packet does not own. Nothing here
// duplicates a WorkPacket field.
import { digestOf } from "../work/records.mjs";
import { REVIEW_VERDICT_VALUES } from "../workforce/reviews.mjs";

export const WORKER_RUN_INPUT_VERSION = 1;
export const RESULT_CONTRACT_VERSION = 1;

// The role-specific result contract (Harness Slice 1.1 §B). The Runtime decides
// what a Task's attempt must deliver, the durable WorkPacket carries that
// decision, and neither the adapter nor the Worker can change it.
export const RESULT_CONTRACT_KINDS = Object.freeze({
  ARTIFACT_DELIVERY: "ARTIFACT_DELIVERY",
  REVIEW_JUDGMENT: "REVIEW_JUDGMENT",
});

// An ordinary execution or Repair attempt delivers exactly one artifact.
export function defaultResultContract() {
  return Object.freeze({
    contractVersion: RESULT_CONTRACT_VERSION,
    kind: RESULT_CONTRACT_KINDS.ARTIFACT_DELIVERY,
    resultSchema: "worker-result-v0",
    maxProposedArtifacts: 1,
  });
}

// A Review attempt delivers a judgment about the exact Artifact the packet
// names — not an artifact of its own.
export function reviewResultContract() {
  return Object.freeze({
    contractVersion: RESULT_CONTRACT_VERSION,
    kind: RESULT_CONTRACT_KINDS.REVIEW_JUDGMENT,
    resultSchema: "worker-review-result-v0",
    verdicts: Object.freeze([...REVIEW_VERDICT_VALUES]),
  });
}

// The contract is derived from committed Runtime truth (the packet's review
// section), never from a Host option, an adapter declaration or a Task title.
export function resultContractForWorkPacket(workPacket) {
  return workPacket?.review ? reviewResultContract() : defaultResultContract();
}

// Requested vs effective containment. The contract is explicit: a requested
// restriction is not proven containment. `requested` records the intent the
// product asked for; `effective` records what this attempt actually gets.
export function defaultRequestedPolicy() {
  return Object.freeze({
    network: false,
    hostFilesystem: "workspace-only",
  });
}

export function buildWorkerRunInput({
  run,
  binding,
  requestedPolicy = defaultRequestedPolicy(),
  effectivePolicy,
  resultContract = defaultResultContract(),
}) {
  if (!run || typeof run !== "object") throw new Error("buildWorkerRunInput requires a WorkerRun");
  if (!run.workPacket || !run.workPacketDigest)
    throw new Error("the WorkerRun carries no durable WorkPacket");
  if (!binding || binding.workerRunId !== run.id)
    throw new Error("the execution binding does not belong to this WorkerRun");
  if (binding.generation !== run.generation)
    throw new Error("the execution binding generation does not match the attempt");
  return Object.freeze({
    schemaVersion: WORKER_RUN_INPUT_VERSION,
    workerRunId: run.id,
    generation: run.generation,
    workPacketDigest: run.workPacketDigest,
    workPacket: run.workPacket,
    executionBinding: binding,
    executionPolicy: Object.freeze({
      requested: Object.freeze({ ...requestedPolicy }),
      effective: Object.freeze({
        sandboxMode: effectivePolicy.sandboxMode,
        workspaceRoot: effectivePolicy.workspaceRoot,
        scratchRoot: effectivePolicy.scratchRoot,
        knownLimitations: Object.freeze([...(effectivePolicy.knownLimitations ?? [])]),
      }),
    }),
    resultContract,
  });
}

// The execution profile is what the binding digests: which backend, at which
// version, under which effective containment. Two attempts with the same
// profile digest were executed under the same declared conditions.
export function executionProfileDigest({
  backendType,
  backendVersion,
  effectivePolicy,
  requestedPolicy = defaultRequestedPolicy(),
}) {
  return digestOf(
    JSON.stringify({
      backendType,
      backendVersion,
      sandboxMode: effectivePolicy.sandboxMode,
      workspaceRoot: effectivePolicy.workspaceRoot,
      scratchRoot: effectivePolicy.scratchRoot,
      knownLimitations: [...(effectivePolicy.knownLimitations ?? [])].sort(),
      requested: {
        network: requestedPolicy.network ?? null,
        hostFilesystem: requestedPolicy.hostFilesystem ?? null,
      },
    }),
  );
}

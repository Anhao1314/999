// WorkerExecutionBinding — the immutable execution provenance of one WorkerRun.
// Contract: docs/contracts/worker-harness-v0.md §7, §8.
//
// One WorkerRun has exactly one binding: which backend attempted it, under
// which execution profile, and in which run-scoped workspace. The binding is
// frozen the moment it is written. It is not a lease record: the lease
// lifecycle is derived from WorkerRun state (RUNNING → ACTIVE, COMPLETED or
// CANCELLED → RELEASED, INTERRUPTED → INVALIDATED), never stored twice.
import { randomUUID } from "node:crypto";

export const WORKER_EXECUTION_BINDING_ID_PREFIX = "wxb_";

export function newWorkerExecutionBindingId() {
  return `${WORKER_EXECUTION_BINDING_ID_PREFIX}${randomUUID()}`;
}

export function newWorkerExecutionBinding({
  id = newWorkerExecutionBindingId(),
  companyId,
  workId,
  taskId,
  workerRunId,
  generation,
  backendType,
  backendVersion,
  executionProfileDigest,
  workspaceRoot,
  scratchRoot,
  baseRevision = null,
  branch = null,
  externalExecutionRef = null,
  externalSessionRef = null,
  createdAt,
}) {
  return Object.freeze({
    id,
    companyId,
    workId,
    taskId,
    workerRunId,
    generation,
    backendType,
    backendVersion,
    executionProfileDigest,
    workspaceRoot,
    scratchRoot,
    baseRevision,
    branch,
    externalExecutionRef,
    externalSessionRef,
    createdAt,
  });
}

// The immutable facts that identify a binding. A retry may present the same
// facts (benign existing return); any difference is a rebind attempt, which is
// refused rather than resolved.
export function sameExecutionBindingFacts(binding, candidate) {
  return (
    binding.workerRunId === candidate.workerRunId &&
    binding.generation === candidate.generation &&
    binding.backendType === candidate.backendType &&
    binding.backendVersion === candidate.backendVersion &&
    binding.executionProfileDigest === candidate.executionProfileDigest &&
    binding.workspaceRoot === candidate.workspaceRoot &&
    binding.scratchRoot === candidate.scratchRoot &&
    binding.baseRevision === candidate.baseRevision &&
    binding.branch === candidate.branch &&
    binding.externalExecutionRef === candidate.externalExecutionRef &&
    binding.externalSessionRef === candidate.externalSessionRef
  );
}

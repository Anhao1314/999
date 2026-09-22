// Worker Harness v0 — the execution layer of FlowCredit.
// Contract: docs/contracts/worker-harness-v0.md
//
// Slice 1.1 ships the production WorkerHost with both delivery seams (artifact
// delivery and Reviewer judgment), the execution-binding persistence seam,
// run-scoped workspace isolation and a deterministic test adapter. The real
// CodexExecAdapter is deliberately not part of this slice.
export {
  WORKER_ADAPTER_METHODS,
  WORKER_ADAPTER_TERMINAL_STATUSES,
  CONTAINMENT_LEVELS,
  assertAdapterManifest,
  assertWorkerAdapter,
  normalizeAdapterResult,
} from "./adapter.mjs";
export { WORKER_EVENT_KINDS, WORKER_EVENT_TERMINAL_KINDS, newWorkerEvent, normalizeWorkerEvent } from "./events.mjs";
export {
  RESULT_CONTRACT_KINDS,
  RESULT_CONTRACT_VERSION,
  WORKER_RUN_INPUT_VERSION,
  buildWorkerRunInput,
  defaultRequestedPolicy,
  defaultResultContract,
  executionProfileDigest,
  resultContractForWorkPacket,
  reviewResultContract,
} from "./worker-run-input.mjs";
export {
  HARNESS_BOUNDS,
  HARNESS_EVIDENCE_VERSION,
  REVIEW_RESULT_KEYS,
  WORKER_RESULT_OUTCOMES,
  WORKER_RESULT_VERSION,
  WORKER_REVIEW_RESULT_VERSION,
  WORKER_REVIEW_VERDICTS,
  buildHarnessEvidence,
  harnessEvidenceDigest,
  parseWorkerResult,
  parseWorkerReviewResult,
  workerResultDigest,
  workerReviewResultDigest,
} from "./result.mjs";
export {
  WORKSPACE_LEASE_STATES,
  ensureRunWorkspace,
  leaseStateForRun,
  runWorkspaceLayout,
} from "./execution-binding.mjs";
export { STATIC_RESOLVER_TYPE, createStaticWorkerBackendResolver } from "./resolver.mjs";
export { DEFAULT_WAIT_TIMEOUT_MS, HOST_STATUS, createWorkerHost } from "./host.mjs";

// Public entry point of the Persistent Work Kernel (v0A).
// Contracts: docs/contracts/persistent-work-kernel-v0.md,
// docs/contracts/work-continuity-v0.md
import { WorkKernel } from "./kernel.mjs";

export { WorkKernel } from "./kernel.mjs";
export { createContinuationDriver, MAX_WAKE_ROUNDS } from "./driver.mjs";
export { KernelError, isKernelError } from "./errors.mjs";
export { KernelStore, SCHEMA_VERSION, STORE_FILE_NAME } from "./store.mjs";
export {
  TASK_STATES,
  WORK_STATUSES,
  deriveWorkStatus,
  executionWriteFence,
  transitionAllowed,
  transitionsFrom,
} from "../work/work.mjs";
export { BOUNDS } from "../work/records.mjs";
export {
  COLLABORATION_STAGES,
  COLLABORATION_STATUSES,
  deriveCollaboration,
} from "../work/collaboration.mjs";
export { OUTCOME_STATES, currentOutcomeCandidates, deriveOutcome } from "../work/outcome.mjs";
export {
  ACTION_RESULTS,
  BOUNDARIES,
  COMPANY_WIDE_WAKE_CAUSES,
  CONTINUATION_ACTIONS,
  CONTINUATION_ASSIGNMENT_REASON,
  CONTINUATION_DIAGNOSTICS,
  CONTINUATION_POLICY_VERSION,
  CONTINUATION_REDISPATCH_REASON,
  MAX_CONTINUATION_STEPS,
  NEXT_ACTION_PROPOSAL_FIELDS,
  NEXT_ACTION_TASK_KINDS,
  TRIGGER_TYPES,
  WAKE_CAUSES,
  buildDecisionState,
  decisionStateDigest,
  deriveProgressBoundary,
  validateNextActionProposal,
} from "../work/continuation.mjs";
export {
  CONTINUATION_TRACE_ID_PREFIX,
  newContinuationTrace,
  newContinuationTraceId,
} from "../work/trace.mjs";
export {
  DEFAULT_REQUIRED_CAPABILITIES,
  DEFAULT_REVIEW_CAPABILITIES,
  NEXT_ACTION_PROPOSER_VERSION,
  deterministicNextActionProposer,
} from "../planning/next-action.mjs";
export {
  ACTION_EFFECTS,
  ATTENTION_ACTIONS,
  ATTENTION_DIAGNOSTICS,
  ATTENTION_KINDS,
  attentionItemId,
  deriveWorkAttention,
  sortAttentionItems,
} from "../work/attention.mjs";
export {
  FOUNDER_DECISION_DISPOSITIONS,
  FOUNDER_DECISION_DISPOSITION_VALUES,
  isFounderDecisionDisposition,
  newFounderDecision,
  newFounderDecisionId,
} from "../decision/decisions.mjs";
export { EVENTS, LEGACY_LIFECYCLE_KINDS } from "./events.mjs";
export * from "../workforce/index.mjs";

export function openKernel(options) {
  return new WorkKernel(options);
}

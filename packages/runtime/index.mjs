// Public entry point of the Persistent Work Kernel (v0A).
// Contract: docs/contracts/persistent-work-kernel-v0.md
import { WorkKernel } from "./kernel.mjs";

export { WorkKernel } from "./kernel.mjs";
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

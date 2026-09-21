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
export { ACTIVITY_KINDS, BOUNDS } from "../work/records.mjs";

export function openKernel(options) {
  return new WorkKernel(options);
}

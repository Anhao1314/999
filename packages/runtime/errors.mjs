// The kernel's error vocabulary. Domain modules decide what is true; the
// runtime decides how it fails, and transports map `status` to a response code.

const STATUS_BY_CODE = Object.freeze({
  INVALID_INPUT: 400,
  INVALID_REQUEST: 400,
  WORK_COMPANY_MISSING: 400,
  COMPANY_NOT_FOUND: 404,
  WORK_NOT_FOUND: 404,
  TASK_NOT_FOUND: 404,
  POSITION_NOT_FOUND: 404,
  EMPLOYEE_NOT_FOUND: 404,
  WORKER_RUN_NOT_FOUND: 404,
  REVIEW_NOT_FOUND: 404,
  REPAIR_BINDING_NOT_FOUND: 404,
  SUPERSEDES_NOT_FOUND: 404,
  ROUTE_NOT_FOUND: 404,
  INVALID_TRANSITION: 409,
  REVIEWER_NOT_INDEPENDENT: 409,
  WORK_ALREADY_ACTIVATED: 409,
  STALE_CONTINUATION_BASIS: 409,
  STALE_GENERATION: 409,
  TASK_NOT_RUNNING: 409,
  TASK_HAS_NO_ARTIFACT: 409,
  POSITION_EXISTS: 409,
  EMPLOYEE_EXISTS: 409,
  SEED_CONFLICT: 409,
  EMPLOYEE_DISABLED: 409,
  TASK_NOT_ASSIGNABLE: 409,
  TASK_ALREADY_RUNNING: 409,
  TASK_REQUIREMENTS_UNSATISFIED: 409,
  TASK_REQUIREMENTS_LOCKED: 409,
  TASK_NOT_ASSIGNED: 409,
  TASK_HAS_ACTIVE_RUN: 409,
  NO_ACTIVE_RUN: 409,
  REVIEW_REQUIRED: 409,
  REVIEW_NOT_REQUIRED: 409,
  REVIEW_ALREADY_EXISTS: 409,
  REVIEW_TARGET_MISMATCH: 409,
  REVIEW_TASK_NOT_REVIEWABLE: 409,
  REVISION_NOT_REQUESTED: 409,
  SUPERSEDES_REQUIRED: 409,
  SUPERSEDES_NOT_ALLOWED: 409,
  INVALID_CAPABILITY: 400,
  INVALID_PROPOSAL: 400,
  INVALID_VERDICT: 400,
  INVALID_DECISION_BASIS: 400,
  FOUNDER_DECISION_NOT_FOUND: 404,
  FINDINGS_REQUIRED: 400,
  SUPERSEDES_OUT_OF_SCOPE: 400,
  WORK_ALREADY_DECIDED: 409,
  WORK_NOT_READY_FOR_DECISION: 409,
  DECISION_TARGET_MISMATCH: 409,
  ARTIFACT_NOT_CURRENT: 409,
  OUTCOME_AMBIGUOUS: 409,
  STALE_DECISION_BASIS: 409,
  WORK_ACCEPTED_LOCKED: 409,
  CROSS_COMPANY_ASSIGNMENT: 400,
  SECRET_IN_OUTPUT: 422,
  INCOMPATIBLE_SCHEMA_VERSION: 500,
  STORAGE_ERROR: 500,
});

export class KernelError extends Error {
  constructor(code, message, { status, cause, details } = {}) {
    super(message, { cause });
    this.name = "KernelError";
    this.code = code;
    this.status = status ?? STATUS_BY_CODE[code] ?? 500;
    // Structured, non-authoritative context a caller may read instead of
    // parsing the message (v0B4: a refused materialization carries the Task
    // that already exists). It is never a second source of truth.
    this.details = details ?? null;
  }
}

export function kernelError(code, message, options) {
  return new KernelError(code, message, options);
}

export function isKernelError(error) {
  return error instanceof KernelError;
}

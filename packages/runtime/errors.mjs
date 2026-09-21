// The kernel's error vocabulary. Domain modules decide what is true; the
// runtime decides how it fails, and transports map `status` to a response code.

const STATUS_BY_CODE = Object.freeze({
  INVALID_INPUT: 400,
  INVALID_REQUEST: 400,
  WORK_COMPANY_MISSING: 400,
  COMPANY_NOT_FOUND: 404,
  WORK_NOT_FOUND: 404,
  TASK_NOT_FOUND: 404,
  ROUTE_NOT_FOUND: 404,
  INVALID_TRANSITION: 409,
  STALE_GENERATION: 409,
  TASK_NOT_RUNNING: 409,
  TASK_HAS_NO_ARTIFACT: 409,
  SECRET_IN_OUTPUT: 422,
  INCOMPATIBLE_SCHEMA_VERSION: 500,
  STORAGE_ERROR: 500,
});

export class KernelError extends Error {
  constructor(code, message, { status, cause } = {}) {
    super(message, { cause });
    this.name = "KernelError";
    this.code = code;
    this.status = status ?? STATUS_BY_CODE[code] ?? 500;
  }
}

export function kernelError(code, message, options) {
  return new KernelError(code, message, options);
}

export function isKernelError(error) {
  return error instanceof KernelError;
}

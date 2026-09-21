// Company — the organization root object of the Persistent Work Kernel (v0A).
// Contract: docs/contracts/persistent-work-kernel-v0.md §1.
//
// Company owns Work. It deliberately owns nothing else in v0A: no profile, no
// settings, no staff. Input validation lives in the runtime command layer
// (packages/runtime/guards.mjs); this module owns identity and shape only.
import { randomUUID } from "node:crypto";

export const COMPANY_ID_PREFIX = "cmp_";

export function newCompanyId() {
  return `${COMPANY_ID_PREFIX}${randomUUID()}`;
}

export function newCompany({ id = newCompanyId(), name, createdAt }) {
  return Object.freeze({ id, name, createdAt });
}

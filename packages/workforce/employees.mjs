// Employee — a stable AI employee identity owned by a company.
// Contract: docs/contracts/workforce-identity-assignment-v0.md §3.
//
// Identity only: no model, no provider, no run, no position definition. The
// stored lifecycle fact is `enabled`; availability is derived from active runs
// so a crash cannot leave an employee "busy" forever.
import { randomUUID } from "node:crypto";

export const EMPLOYEE_ID_PREFIX = "emp_";

export const AVAILABILITY = Object.freeze({
  AVAILABLE: "AVAILABLE",
  BUSY: "BUSY",
  DISABLED: "DISABLED",
});

export function newEmployeeId() {
  return `${EMPLOYEE_ID_PREFIX}${randomUUID()}`;
}

export function newEmployee({
  id = newEmployeeId(),
  companyId,
  positionId,
  displayName,
  enabled = true,
  providerPreference = null,
  createdAt,
}) {
  return Object.freeze({
    id,
    companyId,
    positionId,
    displayName,
    enabled,
    providerPreference,
    createdAt,
  });
}

export function deriveAvailability({ enabled, activeRunCount = 0 }) {
  if (!enabled) return AVAILABILITY.DISABLED;
  if (activeRunCount > 0) return AVAILABILITY.BUSY;
  return AVAILABILITY.AVAILABLE;
}

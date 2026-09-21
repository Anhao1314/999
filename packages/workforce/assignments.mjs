// Assignment — the recorded fact that an Employee was given a Task.
// Contract: docs/contracts/workforce-identity-assignment-v0.md §5.
//
// Append-only history: the current assignment is the most recent row, so a
// re-assignment adds a fact instead of erasing one.
import { randomUUID } from "node:crypto";

export const ASSIGNMENT_ID_PREFIX = "asg_";

export function newAssignmentId() {
  return `${ASSIGNMENT_ID_PREFIX}${randomUUID()}`;
}

export function newAssignment({
  id = newAssignmentId(),
  companyId,
  taskId,
  employeeId,
  positionId,
  reason = null,
  createdAt,
}) {
  return Object.freeze({
    id,
    companyId,
    taskId,
    employeeId,
    positionId,
    reason,
    createdAt,
  });
}

// Canonical Activity kinds written by the runtime.
// Contract: docs/contracts/review-repair-collaboration-v0.md §13.
//
// Vocabulary audit (recorded as debt, deliberately not "fixed"): the activity
// stream mixes this UPPER_SNAKE domain vocabulary with the older lower.dot.case
// lifecycle kinds listed in LEGACY_LIFECYCLE_KINDS. Both stay readable forever;
// rewriting recorded history into one style would be a data migration with no
// behavioural gain. New kinds are added here, in UPPER_SNAKE.
export const EVENTS = Object.freeze({
  POSITION_CREATED: "POSITION_CREATED",
  EMPLOYEE_CREATED: "EMPLOYEE_CREATED",
  EMPLOYEE_UPDATED: "EMPLOYEE_UPDATED",
  TASK_REQUIREMENTS_SET: "TASK_REQUIREMENTS_SET",
  TASK_ASSIGNED: "TASK_ASSIGNED",
  WORKER_RUN_STARTED: "WORKER_RUN_STARTED",
  WORKER_RUN_COMPLETED: "WORKER_RUN_COMPLETED",
  WORKER_RUN_INTERRUPTED: "WORKER_RUN_INTERRUPTED",
  WORKER_RUN_CANCELLED: "WORKER_RUN_CANCELLED",
  WORKER_RESULT_SUBMITTED: "WORKER_RESULT_SUBMITTED",
  WORKER_REVIEW_RESULT_SUBMITTED: "WORKER_REVIEW_RESULT_SUBMITTED",
  WORKER_EXECUTION_BOUND: "WORKER_EXECUTION_BOUND",
  ARTIFACT_HANDED_OFF: "ARTIFACT_HANDED_OFF",
  ARTIFACT_SUPERSEDED: "ARTIFACT_SUPERSEDED",
  REVIEW_REQUESTED: "REVIEW_REQUESTED",
  REVIEW_SUBMITTED: "REVIEW_SUBMITTED",
  REVIEW_PASSED: "REVIEW_PASSED",
  REVISION_REQUESTED: "REVISION_REQUESTED",
  REPAIR_TASK_CREATED: "REPAIR_TASK_CREATED",
  WORK_ACCEPTED: "WORK_ACCEPTED",
});

// Written by the v0A lifecycle and kept verbatim: old events must stay readable.
export const LEGACY_LIFECYCLE_KINDS = Object.freeze([
  "company.created",
  "work.created",
  "task.created",
  "task.execution_started",
  "task.completed",
  "task.interrupted",
  "task.cancelled",
  "checkpoint.written",
  "artifact.recorded",
]);

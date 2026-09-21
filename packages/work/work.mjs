// Work and Task domain rules (pure): states, transitions, generation fencing
// and the derived Work projection. No storage, no HTTP, no I/O.
// Contract: docs/contracts/persistent-work-kernel-v0.md §2, §3.
import { randomUUID } from "node:crypto";

export const WORK_ID_PREFIX = "wrk_";
export const TASK_ID_PREFIX = "tsk_";

export const TASK_STATES = Object.freeze({
  OPEN: "OPEN",
  RUNNING: "RUNNING",
  INTERRUPTED: "INTERRUPTED",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
});

export const TASK_STATE_LIST = Object.freeze(Object.values(TASK_STATES));
export const TERMINAL_TASK_STATES = Object.freeze([
  TASK_STATES.COMPLETED,
  TASK_STATES.CANCELLED,
]);

// The complete transition table. Everything not listed here is forbidden; a
// terminal state has no outgoing transition at all.
const TRANSITIONS = Object.freeze({
  [TASK_STATES.OPEN]: Object.freeze([
    TASK_STATES.RUNNING,
    TASK_STATES.CANCELLED,
  ]),
  [TASK_STATES.RUNNING]: Object.freeze([
    TASK_STATES.INTERRUPTED,
    TASK_STATES.COMPLETED,
    TASK_STATES.CANCELLED,
  ]),
  [TASK_STATES.INTERRUPTED]: Object.freeze([
    TASK_STATES.RUNNING,
    TASK_STATES.CANCELLED,
  ]),
  [TASK_STATES.COMPLETED]: Object.freeze([]),
  [TASK_STATES.CANCELLED]: Object.freeze([]),
});

export function transitionsFrom(state) {
  return TRANSITIONS[state] ?? [];
}

export function transitionAllowed(from, to) {
  return transitionsFrom(from).includes(to);
}

export function startAllowedFrom(state) {
  return transitionAllowed(state, TASK_STATES.RUNNING);
}

export function completeAllowedFrom(state) {
  return transitionAllowed(state, TASK_STATES.COMPLETED);
}

export function cancelAllowedFrom(state) {
  return transitionAllowed(state, TASK_STATES.CANCELLED);
}

export function interruptionAllowedFrom(state) {
  return transitionAllowed(state, TASK_STATES.INTERRUPTED);
}

// Execution-scoped writes (checkpoint, artifact, completion) must present the
// task's current fencing token while the task is RUNNING. Returns null when the
// write is allowed, otherwise the reason code the runtime turns into an error.
export function executionWriteFence(task, generation) {
  if (!Number.isInteger(generation) || generation < 0) return "STALE_GENERATION";
  if (generation !== task.generation) return "STALE_GENERATION";
  if (task.state !== TASK_STATES.RUNNING) return "TASK_NOT_RUNNING";
  return null;
}

export const WORK_STATUSES = Object.freeze([
  "OPEN",
  "ACTIVE",
  "NEEDS_ATTENTION",
  "COMPLETED",
  "CANCELLED",
]);

// Work status is a projection of Task truth, never a second stored state
// machine. Precedence is fixed by contract §2.1.
export function deriveWorkStatus(tasks) {
  if (tasks.some((task) => task.state === TASK_STATES.INTERRUPTED))
    return "NEEDS_ATTENTION";
  if (tasks.some((task) => task.state === TASK_STATES.RUNNING)) return "ACTIVE";
  if (tasks.length > 0 && tasks.every((t) => t.state === TASK_STATES.COMPLETED))
    return "COMPLETED";
  if (tasks.length > 0 && tasks.every((t) => t.state === TASK_STATES.CANCELLED))
    return "CANCELLED";
  return "OPEN";
}

export function newWorkId() {
  return `${WORK_ID_PREFIX}${randomUUID()}`;
}

export function newTaskId() {
  return `${TASK_ID_PREFIX}${randomUUID()}`;
}

export function newWork({ id = newWorkId(), companyId, title, intent, createdAt }) {
  return Object.freeze({ id, companyId, title, intent, createdAt });
}

export function newTask({
  id = newTaskId(),
  workId,
  title,
  intent,
  createdAt,
}) {
  return Object.freeze({
    id,
    workId,
    title,
    intent,
    state: TASK_STATES.OPEN,
    generation: 0,
    createdAt,
    updatedAt: createdAt,
  });
}

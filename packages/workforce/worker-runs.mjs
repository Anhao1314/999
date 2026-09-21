// WorkerRun — one actual execution of a Task by an Employee.
// Contract: docs/contracts/workforce-identity-assignment-v0.md §6.
//
// A WorkerRun is an execution record, not a Task lifecycle: four states, three
// of them terminal. Its binding (task, employee, position, generation, packet)
// is frozen at creation and can never be rewritten.
import { randomUUID } from "node:crypto";

export const WORKER_RUN_ID_PREFIX = "run_";

export const WORKER_RUN_STATES = Object.freeze({
  RUNNING: "RUNNING",
  COMPLETED: "COMPLETED",
  INTERRUPTED: "INTERRUPTED",
  CANCELLED: "CANCELLED",
});

export const TERMINAL_WORKER_RUN_STATES = Object.freeze([
  WORKER_RUN_STATES.COMPLETED,
  WORKER_RUN_STATES.INTERRUPTED,
  WORKER_RUN_STATES.CANCELLED,
]);

const TRANSITIONS = Object.freeze({
  [WORKER_RUN_STATES.RUNNING]: Object.freeze([
    WORKER_RUN_STATES.COMPLETED,
    WORKER_RUN_STATES.INTERRUPTED,
    WORKER_RUN_STATES.CANCELLED,
  ]),
  [WORKER_RUN_STATES.COMPLETED]: Object.freeze([]),
  [WORKER_RUN_STATES.INTERRUPTED]: Object.freeze([]),
  [WORKER_RUN_STATES.CANCELLED]: Object.freeze([]),
});

export function newWorkerRunId() {
  return `${WORKER_RUN_ID_PREFIX}${randomUUID()}`;
}

export function workerRunTransitionAllowed(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function newWorkerRun({
  id = newWorkerRunId(),
  companyId,
  workId,
  taskId,
  employeeId,
  positionId,
  generation,
  workPacket,
  workPacketDigest,
  startedAt,
}) {
  return Object.freeze({
    id,
    companyId,
    workId,
    taskId,
    employeeId,
    positionId,
    generation,
    state: WORKER_RUN_STATES.RUNNING,
    workPacket,
    workPacketDigest,
    startedAt,
    endedAt: null,
    endReason: null,
  });
}

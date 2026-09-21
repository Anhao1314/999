// Workforce identity & assignment domain package (v0B1).
// Contract: docs/contracts/workforce-identity-assignment-v0.md
export {
  CAPABILITY_MAX_LENGTH,
  CAPABILITY_PATTERN,
  isCapability,
  missingCapabilities,
  normalizeCapabilities,
  satisfiesCapabilities,
} from "./capabilities.mjs";
export { POSITION_ID_PREFIX, newPosition, newPositionId } from "./positions.mjs";
export {
  AVAILABILITY,
  EMPLOYEE_ID_PREFIX,
  deriveAvailability,
  newEmployee,
  newEmployeeId,
} from "./employees.mjs";
export { ASSIGNMENT_ID_PREFIX, newAssignment, newAssignmentId } from "./assignments.mjs";
export {
  TERMINAL_WORKER_RUN_STATES,
  WORKER_RUN_ID_PREFIX,
  WORKER_RUN_STATES,
  newWorkerRun,
  newWorkerRunId,
  workerRunTransitionAllowed,
} from "./worker-runs.mjs";
export {
  PACKET_ARTIFACT_LIMIT,
  WORK_PACKET_VERSION,
  buildWorkPacket,
  workPacketDigest,
} from "./work-packet.mjs";

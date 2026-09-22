// Continuation Trace: append-only observability for one Driver step.
// Contract: docs/contracts/work-continuity-v0.md §12, §14, §17.
//
// A trace records what the Continuation Policy *saw* and what the Driver *did*
// at one instant. It is never an input: neither the policy nor Founder
// Attention may read a trace to decide Runtime reality, and no Work projection
// carries a trace-derived field. It exists so a developer (and a future sensor
// adapter) can replay a step without the Runtime having stored a decision.
import { randomUUID } from "node:crypto";

export const CONTINUATION_TRACE_ID_PREFIX = "ctr_";

export function newContinuationTraceId() {
  return `${CONTINUATION_TRACE_ID_PREFIX}${randomUUID()}`;
}

// `signals` and the sensor columns are reserved for a future Semantic Sensor;
// every v0B4 row leaves them null, because this milestone integrates no sensor.
export function newContinuationTrace({
  id = newContinuationTraceId(),
  companyId,
  workId,
  step,
  triggerType,
  basisBefore = null,
  basisAfter = null,
  decisionStateDigest = null,
  decisionState = null,
  policyVersion,
  reasonCodes = [],
  diagnosticCode = null,
  actionCommand = null,
  actionTargetId = null,
  actionResult,
  actionErrorCode = null,
  sensorName = null,
  sensorVersion = null,
  signals = null,
  createdAt,
}) {
  return Object.freeze({
    id,
    companyId,
    workId,
    step,
    triggerType,
    basisBefore,
    basisAfter,
    decisionStateDigest,
    decisionState,
    policyVersion,
    reasonCodes: Object.freeze([...reasonCodes]),
    diagnosticCode,
    actionCommand,
    actionTargetId,
    actionResult,
    actionErrorCode,
    sensorName,
    sensorVersion,
    signals,
    createdAt,
  });
}

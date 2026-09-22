// WorkerEvent — the normalized execution progress vocabulary.
// Contract: docs/contracts/worker-harness-v0.md §6.
//
// These are the only event names the domain knows. Adapter-specific event
// names (tool calls, message deltas, provider traces) stay inside the adapter
// and never cross this seam. Events are observability: no event is truth, no
// event is persisted by the Runtime, and nothing may be decided from one.
export const WORKER_EVENT_KINDS = Object.freeze([
  "RUN_STARTED",
  "TOOL_FINISHED",
  "RESULT_READY",
  "RUN_FAILED",
  "PROGRESS",
]);

export const WORKER_EVENT_TERMINAL_KINDS = Object.freeze(["RESULT_READY", "RUN_FAILED"]);

const MAX_EVENT_DETAIL_BYTES = 4096;

export function newWorkerEvent({ kind, sequence, detail = null, at }) {
  if (!WORKER_EVENT_KINDS.includes(kind))
    throw new Error(`unknown worker event kind: ${kind}`);
  if (!Number.isInteger(sequence) || sequence < 1)
    throw new Error("worker event sequence must be a positive integer");
  if (detail !== null) {
    const text = JSON.stringify(detail);
    if (typeof text !== "string" || text.length > MAX_EVENT_DETAIL_BYTES)
      throw new Error("worker event detail must be a small JSON value");
  }
  return Object.freeze({ eventVersion: 1, kind, sequence, at, detail });
}

// Normalizes and bounds an adapter-reported event at the Host boundary. An
// adapter that reports nonsense is a protocol problem, not a Runtime fact.
export function normalizeWorkerEvent(raw) {
  if (!raw || typeof raw !== "object") throw new Error("worker event must be an object");
  if (!WORKER_EVENT_KINDS.includes(raw.kind)) throw new Error(`unknown worker event kind: ${raw.kind}`);
  if (!Number.isInteger(raw.sequence) || raw.sequence < 1)
    throw new Error("worker event sequence must be a positive integer");
  const detail = raw.detail ?? null;
  if (detail !== null) {
    const text = JSON.stringify(detail);
    if (typeof text !== "string" || text.length > MAX_EVENT_DETAIL_BYTES)
      throw new Error("worker event detail must be a small JSON value");
  }
  return Object.freeze({
    eventVersion: 1,
    kind: raw.kind,
    sequence: raw.sequence,
    at: raw.at ?? null,
    detail,
  });
}

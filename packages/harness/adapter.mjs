// WorkerAdapter — the execution interface the WorkerHost drives.
// Contract: docs/contracts/worker-harness-v0.md §2, §17.
//
//   manifest()
//   start(input, context) // context may carry a Host-owned authorizedToolSession
//   events(handle)
//   wait(handle, { timeoutMs })
//   cancel(handle, reason)
//
// There is deliberately no resume, fork, steer, session management, fallback
// or ranking. An adapter has zero Runtime authority: it cannot assign, start,
// complete, review, repair or accept anything. It reports what happened; the
// Runtime decides what that means.
export const WORKER_ADAPTER_METHODS = Object.freeze([
  "manifest",
  "start",
  "events",
  "wait",
  "cancel",
]);

export const CONTAINMENT_LEVELS = Object.freeze(["none", "process", "sandbox"]);

export function assertWorkerAdapter(adapter) {
  if (!adapter || typeof adapter !== "object")
    throw new Error("a WorkerAdapter must be an object");
  for (const method of WORKER_ADAPTER_METHODS)
    if (typeof adapter[method] !== "function")
      throw new Error(`WorkerAdapter is missing ${method}()`);
  return adapter;
}

// The smallest result shape a WorkerAdapter may hand back for one attempt. The
// adapter owns provider-specific extraction (raw final message → JSON → a
// candidate object); the Host owns provider-neutral validation. An adapter
// never states a verdict, a Task identity or a Runtime outcome — only what its
// backend produced.
export const WORKER_ADAPTER_TERMINAL_STATUSES = Object.freeze([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
]);

const ADAPTER_RESULT_KEYS = Object.freeze([
  "terminalStatus",
  "failureReason",
  "reason",
  "rawResultDigest",
  "resultCandidate",
  "adapterMeta",
]);

const MAX_ADAPTER_REASON = 200;
const MAX_ADAPTER_META_BYTES = 4096;

const isPlainAdapterObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const boundedAdapterText = (value, max) =>
  typeof value === "string" && value.length > 0 && value.length <= max;

// Normalizes what wait() resolved with. Anything that is not this shape is a
// protocol problem for the Host — never a Runtime fact, and never a delivery.
export function normalizeAdapterResult(raw) {
  if (!isPlainAdapterObject(raw))
    throw new Error("the adapter did not return a WorkerAdapterResult");
  for (const key of Object.keys(raw))
    if (!ADAPTER_RESULT_KEYS.includes(key))
      throw new Error(`unknown WorkerAdapterResult field: ${key}`);
  if (!WORKER_ADAPTER_TERMINAL_STATUSES.includes(raw.terminalStatus))
    throw new Error(`unknown adapter terminal status: ${raw.terminalStatus}`);
  const failureReason = raw.failureReason ?? null;
  if (raw.terminalStatus === "FAILED") {
    if (!boundedAdapterText(failureReason, MAX_ADAPTER_REASON))
      throw new Error("a FAILED adapter result must state a bounded failureReason");
  } else if (failureReason !== null) {
    throw new Error("failureReason belongs to a FAILED adapter result only");
  }
  const reason = raw.reason ?? null;
  if (reason !== null && !boundedAdapterText(reason, MAX_ADAPTER_REASON))
    throw new Error("an adapter result reason must be a bounded string");
  const rawResultDigest = raw.rawResultDigest ?? null;
  if (rawResultDigest !== null && !boundedAdapterText(rawResultDigest, 128))
    throw new Error("rawResultDigest must be a bounded digest or absent");
  const adapterMeta = raw.adapterMeta ?? null;
  if (adapterMeta !== null) {
    if (!isPlainAdapterObject(adapterMeta))
      throw new Error("adapterMeta must be a small object or absent");
    if (JSON.stringify(adapterMeta).length > MAX_ADAPTER_META_BYTES)
      throw new Error("adapterMeta must be a small object");
  }
  return Object.freeze({
    terminalStatus: raw.terminalStatus,
    failureReason,
    reason,
    rawResultDigest,
    resultCandidate: raw.resultCandidate ?? null,
    adapterMeta,
  });
}

// The adapter's honest self-description. `containment` states what the backend
// actually enforces, never what someone wished it enforced.
export function assertAdapterManifest(manifest) {
  if (!manifest || typeof manifest !== "object")
    throw new Error("adapter manifest() must return an object");
  if (typeof manifest.adapterType !== "string" || !manifest.adapterType)
    throw new Error("adapter manifest requires adapterType");
  if (typeof manifest.adapterVersion !== "string" || !manifest.adapterVersion)
    throw new Error("adapter manifest requires adapterVersion");
  const containment = manifest.containment ?? {};
  if (!CONTAINMENT_LEVELS.includes(containment.sandboxMode ?? "none"))
    throw new Error("adapter manifest containment.sandboxMode is not a known level");
  const knownLimitations = containment.knownLimitations ?? [];
  if (!Array.isArray(knownLimitations) || knownLimitations.some((entry) => typeof entry !== "string"))
    throw new Error("adapter manifest containment.knownLimitations must be a list of strings");
  return Object.freeze({
    adapterType: manifest.adapterType,
    adapterVersion: manifest.adapterVersion,
    containment: Object.freeze({
      sandboxMode: containment.sandboxMode ?? "none",
      knownLimitations: Object.freeze([...knownLimitations]),
    }),
  });
}

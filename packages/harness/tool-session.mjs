// Host-owned, run-scoped authorization for deterministic tool execution.
// Organizational capabilities establish eligibility; only the explicit
// approvedCapabilities input can grant an execution tool.
import { digestOf } from "../work/records.mjs";
import { randomUUID } from "node:crypto";

const MAX_TOOL_CALLS = 32;
const MAX_TOOL_INPUT_BYTES = 8 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
const CAPABILITY = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;

export class ToolSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ToolSessionError";
    this.code = code;
  }
}

const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));

function sourceOutput(output) {
  const observation = output?.sourceObservation;
  if (!plain(output) || Object.keys(output).length !== 1 || !plain(observation) ||
      Object.keys(observation).some((key) => !["canonicalUrl", "title", "observedAt", "contentDigest", "content"].includes(key)) ||
      typeof observation.canonicalUrl !== "string" || Buffer.byteLength(observation.canonicalUrl) > 2048 ||
      (observation.title !== null && (typeof observation.title !== "string" || observation.title.length > 200)) ||
      typeof observation.observedAt !== "string" || observation.observedAt.length > 40 ||
      !Number.isFinite(Date.parse(observation.observedAt)) ||
      typeof observation.contentDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(observation.contentDigest) ||
      typeof observation.content !== "string" || !observation.content ||
      Buffer.byteLength(observation.content) > 16 * 1024)
    throw new ToolSessionError("TOOL_OUTPUT_INVALID", "source observation must be bounded and complete");
  let url;
  try { url = new URL(observation.canonicalUrl); } catch { /* invalid Actuator output */ }
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new ToolSessionError("TOOL_OUTPUT_INVALID", "source observation URL is invalid");
  return observation;
}

function capabilityList(value, field) {
  if (!Array.isArray(value) || value.length > MAX_TOOL_CALLS ||
      value.some((entry) => typeof entry !== "string" || entry.length > 80 || !CAPABILITY.test(entry)))
    throw new Error(`${field} must be a list of capability names`);
  return Object.freeze([...new Set(value)].sort());
}

export function assertActuator(actuator) {
  if (!actuator || typeof actuator.supports !== "function" || typeof actuator.invoke !== "function")
    throw new Error("Actuator requires supports() and invoke()");
  return actuator;
}

export function createToolGrant({ run, skill, approvedCapabilities = [], actuators = [] } = {}) {
  if (!run?.id || !Number.isInteger(run.generation) || !run.workPacket)
    throw new Error("ToolGrant requires one persisted WorkerRun");
  if (!skill || typeof skill.skillId !== "string" || !skill.skillId || skill.skillId.length > 80 ||
      typeof skill.version !== "string" || !skill.version || skill.version.length > 80)
    throw new Error("ToolGrant requires a versioned static Skill");
  const required = capabilityList(skill.requiredCapabilities ?? [], "skill.requiredCapabilities");
  const allowed = capabilityList(skill.allowedToolCapabilities ?? [], "skill.allowedToolCapabilities");
  const approved = capabilityList(approvedCapabilities, "approvedCapabilities");
  const task = new Set(run.workPacket.requirements.requiredCapabilities);
  const position = new Set(run.workPacket.position.capabilities);
  const eligible = required.length > 0 && required.every((capability) => task.has(capability) && position.has(capability));
  const available = actuators.map(assertActuator);
  const capabilities = eligible
    ? allowed.filter((capability) => approved.includes(capability) && available.some((actuator) => actuator.supports(capability)))
    : [];
  const payload = Object.freeze({
    workerRunId: run.id,
    generation: run.generation,
    skillId: skill.skillId,
    skillVersion: skill.version,
    capabilities: Object.freeze(capabilities),
  });
  return Object.freeze({ ...payload, grantDigest: digestOf(JSON.stringify(payload)) });
}

export function createToolBudget({
  maxToolCalls = 4,
  maxCallsByCapability = {},
  maxElapsedMs = 30_000,
  toolTimeoutMs = 10_000,
} = {}) {
  if (!Number.isInteger(maxToolCalls) || maxToolCalls < 0 || maxToolCalls > MAX_TOOL_CALLS)
    throw new Error(`maxToolCalls must be between 0 and ${MAX_TOOL_CALLS}`);
  if (!Number.isInteger(maxElapsedMs) || maxElapsedMs < 1)
    throw new Error("maxElapsedMs must be positive");
  if (!Number.isInteger(toolTimeoutMs) || toolTimeoutMs < 1 || toolTimeoutMs > maxElapsedMs)
    throw new Error("toolTimeoutMs must be positive and at most maxElapsedMs");
  if (!plain(maxCallsByCapability)) throw new Error("maxCallsByCapability must be an object");
  if (Object.keys(maxCallsByCapability).length > MAX_TOOL_CALLS)
    throw new Error("maxCallsByCapability is too large");
  const limits = {};
  for (const capability of Object.keys(maxCallsByCapability).sort()) {
    const limit = maxCallsByCapability[capability];
    if (!CAPABILITY.test(capability) || !Number.isInteger(limit) || limit < 0 || limit > maxToolCalls)
      throw new Error("invalid per-capability tool budget");
    limits[capability] = limit;
  }
  return Object.freeze({ maxToolCalls, maxCallsByCapability: Object.freeze(limits), maxElapsedMs, toolTimeoutMs });
}

export function createAuthorizedToolSession({ run, grant, budget, actuators = [],
  now = () => performance.now(), onReceipt = null } = {}) {
  if (grant?.workerRunId !== run?.id || grant?.generation !== run?.generation)
    throw new Error("ToolGrant does not belong to this WorkerRun generation");
  if (!budget || !Number.isInteger(budget.maxToolCalls)) throw new Error("ToolBudget is required");
  if (onReceipt !== null && typeof onReceipt !== "function") throw new Error("onReceipt must be a function");
  const available = actuators.map(assertActuator);
  const sourceCapable = available.some((actuator) => Array.isArray(actuator.sourceObservationCapabilities) && actuator.sourceObservationCapabilities.length > 0);
  const controller = new AbortController();
  const startedAt = now();
  const used = new Map();
  const seen = new Set();
  const receipts = [];
  const sources = [];
  const issuedSourceIds = new Set();
  let calls = 0;
  let terminalFailure = null;

  const record = ({ callId, capability, status, inputDigest = null, outputDigest = null,
    durationMs = 0, source = null, actuator = null }) => {
    if (receipts.length >= MAX_TOOL_CALLS + 1) return;
    const receipt = Object.freeze({
      callId: typeof callId === "string" ? callId.slice(0, 80) : null,
      capability: typeof capability === "string" ? capability.slice(0, 80) : null,
      status, inputDigest, outputDigest, durationMs,
      ...(source ? { sourceId: source.sourceId } : {}),
    });
    receipts.push(receipt);
    try {
      onReceipt?.({ receipt: Object.freeze({ ...receipt, sequence: receipts.length }), source, actuator });
    } catch {
      terminalFailure = "EVIDENCE_PERSIST_FAILED";
      controller.abort();
      throw new ToolSessionError("EVIDENCE_PERSIST_FAILED", "durable tool evidence could not be recorded");
    }
  };
  const fail = (code, message, callId = null, capability = null, inputDigest = null) => {
    if (!terminalFailure) {
      terminalFailure = code;
      record({ callId, capability, status: code, inputDigest });
      controller.abort();
    }
    throw new ToolSessionError(code, message);
  };

  return Object.freeze({
    capabilities: grant.capabilities,
    maxToolCalls: budget.maxToolCalls,
    async invoke({ callId, capability, input, signal } = {}) {
      if (terminalFailure) throw new ToolSessionError(terminalFailure, "tool session is closed");
      if (controller.signal.aborted || signal?.aborted) {
        controller.abort();
        throw new ToolSessionError("ABORTED", "tool session was cancelled");
      }
      if (typeof callId !== "string" || !callId || callId.length > 80 || seen.has(callId))
        fail("TOOL_PROTOCOL_ERROR", "invalid or repeated tool callId");
      seen.add(callId);
      if (typeof capability !== "string" || capability.length > 80 || !CAPABILITY.test(capability) || !plain(input))
        fail("TOOL_PROTOCOL_ERROR", "malformed tool request", callId, capability ?? null);
      let encodedInput;
      try { encodedInput = JSON.stringify(input); } catch { /* malformed model data */ }
      if (typeof encodedInput !== "string" || Buffer.byteLength(encodedInput) > MAX_TOOL_INPUT_BYTES)
        fail("TOOL_PROTOCOL_ERROR", "tool input is too large", callId, capability);
      const inputDigest = digestOf(encodedInput);
      let actuator;
      const receipt = (status, outputDigest = null, durationMs = 0, source = null) => {
        record({ callId, capability, status, inputDigest, outputDigest, durationMs, source,
          actuator: status === "SUCCEEDED" ? actuator : null });
      };
      if (!grant.capabilities.includes(capability)) {
        fail("TOOL_DENIED", "tool capability was not granted", callId, capability, inputDigest);
      }
      try { actuator = available.find((candidate) => candidate.supports(capability)); }
      catch { fail("TOOL_UNAVAILABLE", "actuator availability check failed", callId, capability, inputDigest); }
      if (!actuator) {
        fail("TOOL_UNAVAILABLE", "no actuator supports the granted capability", callId, capability, inputDigest);
      }
      const remaining = budget.maxElapsedMs - (now() - startedAt);
      if (calls >= budget.maxToolCalls || (used.get(capability) ?? 0) >= (budget.maxCallsByCapability[capability] ?? budget.maxToolCalls) || remaining <= 0) {
        fail("TOOL_BUDGET_EXHAUSTED", "tool budget is exhausted", callId, capability, inputDigest);
      }
      calls += 1;
      used.set(capability, (used.get(capability) ?? 0) + 1);
      const began = now();
      const attempt = new AbortController();
      const abort = () => attempt.abort();
      controller.signal.addEventListener("abort", abort, { once: true });
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, Math.min(budget.toolTimeoutMs, remaining));
      try {
        let output = await actuator.invoke({ capability, input, signal: attempt.signal });
        if (controller.signal.aborted || signal?.aborted) throw new ToolSessionError("ABORTED", "tool session was cancelled");
        if (attempt.signal.aborted) throw new ToolSessionError("TOOL_TIMEOUT", "tool invocation timed out");
        if (!plain(output) || bytes(output) > MAX_TOOL_OUTPUT_BYTES)
          throw new ToolSessionError("TOOL_OUTPUT_INVALID", "tool output must be a bounded object");
        let source = null;
        if (actuator.sourceObservationCapabilities?.includes(capability)) {
          const observation = sourceOutput(output);
          let sourceId;
          do { sourceId = `src_${randomUUID()}`; } while (issuedSourceIds.has(sourceId));
          output = Object.freeze({ sourceObservation: Object.freeze({ sourceId, ...observation }) });
          if (bytes(output) > MAX_TOOL_OUTPUT_BYTES)
            throw new ToolSessionError("TOOL_OUTPUT_INVALID", "source observation exceeds tool output limit");
          const url = new URL(observation.canonicalUrl);
          source = Object.freeze({
            sourceId,
            receiptCallId: callId,
            // Origin is safe to expose in bounded Host evidence. The digest
            // binds the exact URL without persisting path/query secrets.
            safeUrl: url.origin.slice(0, 120),
            canonicalUrlDigest: digestOf(observation.canonicalUrl),
            contentDigest: observation.contentDigest,
            observedAt: observation.observedAt,
          });
        }
        const outputDigest = digestOf(JSON.stringify(output));
        if (source) {
          issuedSourceIds.add(source.sourceId);
          sources.push(source);
        }
        receipt("SUCCEEDED", outputDigest, now() - began, source);
        return Object.freeze({ type: "TOOL_RESULT", callId, capability, status: "SUCCEEDED", output });
      } catch (error) {
        if (error instanceof ToolSessionError && error.code === "EVIDENCE_PERSIST_FAILED") throw error;
        const code = controller.signal.aborted || signal?.aborted
          ? "ABORTED"
          : attempt.signal.aborted ? "TOOL_TIMEOUT"
          : error instanceof ToolSessionError ? error.code : "TOOL_EXECUTION_FAILED";
        receipt(code, null, now() - began);
        terminalFailure = code;
        controller.abort();
        throw new ToolSessionError(code, code === "TOOL_EXECUTION_FAILED" ? "actuator invocation failed" : code);
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", abort);
        signal?.removeEventListener("abort", abort);
      }
    },
    cancel() {
      terminalFailure ??= "ABORTED";
      controller.abort();
    },
    snapshot() {
      return Object.freeze({
        grantDigest: grant.grantDigest,
        skillId: grant.skillId,
        skillVersion: grant.skillVersion,
        budget,
        receipts: Object.freeze([...receipts]),
        ...(sourceCapable ? { sources: Object.freeze([...sources]) } : {}),
      });
    },
  });
}

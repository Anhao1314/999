// One WorkerRun, one bounded in-memory model/tool loop, one final candidate.
// The model requests; the Host-owned session authorizes; an Actuator acts.
import { digestOf } from "../../work/records.mjs";
import { newWorkerEvent } from "../events.mjs";
import { assertModelBackend } from "../model-backend.mjs";
import { ToolSessionError } from "../tool-session.mjs";

export const GENERIC_MODEL_WORKER_ADAPTER_TYPE = "generic-model-worker";
export const GENERIC_MODEL_WORKER_ADAPTER_VERSION = "0.1.0";
const MAX_CONTEXT_BYTES = 256 * 1024;
const MAX_MODEL_STEP_BYTES = 128 * 1024;

const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const adapterBackends = new WeakMap();
export function runtimeModelBackendForAdapter(adapter) {
  return adapterBackends.get(adapter) ?? null;
}

function modelPacketForReview(packet, contract) {
  if (contract.kind !== "REVIEW_JUDGMENT") return packet;
  let goal;
  try { goal = JSON.parse(packet.work.intent); } catch { return packet; }
  if (goal?.requestKind !== "MarketEntryResearch.v0" || !goal.method) return packet;
  const copy = structuredClone(packet);
  delete goal.method;
  copy.work.intent = JSON.stringify(goal);
  if (copy.review?.sourceTask) copy.review.sourceTask.intent =
    "Produce a decision-ready market entry brief from bounded upstream evidence.";
  return copy;
}

function normalizeStep(raw) {
  let encoded;
  try { encoded = JSON.stringify(raw); } catch { /* malformed provider data */ }
  if (!plain(raw) || typeof encoded !== "string" || Buffer.byteLength(encoded) > MAX_MODEL_STEP_BYTES)
    throw new ToolSessionError("MODEL_PROTOCOL_ERROR", "model step is not a bounded object");
  const keys = Object.keys(raw);
  const exact = (allowed) => keys.every((key) => allowed.includes(key));
  if (raw.type === "TOOL_REQUEST") {
    if (!exact(["type", "callId", "capability", "input"]) ||
        typeof raw.callId !== "string" || !raw.callId || raw.callId.length > 80 ||
        typeof raw.capability !== "string" || raw.capability.length > 80 || !plain(raw.input))
      throw new ToolSessionError("MODEL_PROTOCOL_ERROR", "malformed TOOL_REQUEST");
    return raw;
  }
  if (raw.type === "FINAL_RESULT") {
    if (!exact(["type", "candidate"]) || !plain(raw.candidate))
      throw new ToolSessionError("MODEL_PROTOCOL_ERROR", "malformed FINAL_RESULT");
    return raw;
  }
  if (raw.type === "PROVIDER_ERROR") {
    if (!exact(["type", "code"]) || typeof raw.code !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/.test(raw.code))
      throw new ToolSessionError("MODEL_PROTOCOL_ERROR", "malformed PROVIDER_ERROR");
    return raw;
  }
  throw new ToolSessionError("MODEL_PROTOCOL_ERROR", "unknown model step type");
}

export function createGenericModelWorkerAdapter({ modelBackend, skill, now = () => Date.now() } = {}) {
  const backend = assertModelBackend(modelBackend);
  if (!skill || typeof skill.skillId !== "string" || !skill.skillId || skill.skillId.length > 80 ||
      typeof skill.version !== "string" || !skill.version || skill.version.length > 80 ||
      !Array.isArray(skill.rules) || skill.rules.some((rule) => typeof rule !== "string") ||
      Buffer.byteLength(JSON.stringify(skill.rules)) > 4096)
    throw new Error("GenericModelWorkerAdapter requires a versioned Skill with bounded rules");
  const method = Object.freeze({
    skillId: skill.skillId,
    version: skill.version,
    rules: Object.freeze([...skill.rules]),
  });

  const emit = (handle, kind, detail = null) => {
    handle.events.push(newWorkerEvent({ kind, sequence: handle.events.length + 1, detail, at: new Date().toISOString() }));
    for (const wake of handle.eventWaiters.splice(0)) wake();
  };
  const settle = (handle, result) => {
    if (handle.terminal) return;
    handle.terminal = result;
    handle.resolveWait(result);
    for (const wake of handle.eventWaiters.splice(0)) wake();
  };

  async function run(handle) {
    const began = now();
    let modelSteps = 0;
    let inputDigest = null;
    try {
      emit(handle, "RUN_STARTED", { workerRunId: handle.input.workerRunId });
      const session = handle.session;
      const messages = [
        { role: "system", content: `Skill ${method.skillId}@${method.version}. ${method.rules.join(" ")}` },
        { role: "user", content: JSON.stringify({
          workerRunId: handle.input.workerRunId,
          generation: handle.input.generation,
          workPacket: modelPacketForReview(handle.input.workPacket, handle.input.resultContract),
          resultContract: handle.input.resultContract,
        }) },
      ];
      inputDigest = digestOf(JSON.stringify(messages));
      const maxSteps = (session?.maxToolCalls ?? 0) + 1;
      for (; modelSteps < maxSteps;) {
        if (handle.abort.signal.aborted) throw new ToolSessionError("ABORTED", "model run was cancelled");
        if (Buffer.byteLength(JSON.stringify(messages)) > MAX_CONTEXT_BYTES)
          throw new ToolSessionError("CONTEXT_TOO_LARGE", "model context is too large");
        modelSteps += 1;
        const raw = await backend.invoke({
          workerRunId: handle.input.workerRunId,
          messages: structuredClone(messages),
          tools: [...(session?.capabilities ?? [])],
          resultContract: handle.input.resultContract,
          abortSignal: handle.abort.signal,
        });
        if (handle.abort.signal.aborted) throw new ToolSessionError("ABORTED", "model run was cancelled");
        const step = normalizeStep(raw);
        if (step.type === "PROVIDER_ERROR")
          throw new ToolSessionError("PROVIDER_ERROR", `model provider reported ${step.code}`);
        if (step.type === "FINAL_RESULT") {
          emit(handle, "RESULT_READY", { modelSteps });
          settle(handle, {
            terminalStatus: "SUCCEEDED",
            rawResultDigest: digestOf(JSON.stringify(step.candidate)),
            resultCandidate: step.candidate,
            adapterMeta: {
              modelBackendType: backend.backendType,
              modelBackendVersion: backend.backendVersion,
              skillId: method.skillId,
              skillVersion: method.version,
              modelSteps,
              inputDigest,
              outputDigest: digestOf(JSON.stringify(step.candidate)),
              durationMs: now() - began,
            },
          });
          return;
        }
        if (!session) throw new ToolSessionError("TOOL_DENIED", "this run has no authorized tool session");
        const toolResult = await session.invoke({
          callId: step.callId,
          capability: step.capability,
          input: step.input,
          signal: handle.abort.signal,
        });
        emit(handle, "TOOL_FINISHED", { capability: step.capability, status: toolResult.status });
        messages.push({ role: "assistant", content: JSON.stringify(step) });
        messages.push({ role: "tool", content: JSON.stringify(toolResult) });
        // Let Host cancellation observe TOOL_FINISHED before the next model
        // invocation; the run-scoped context is checked again next iteration.
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new ToolSessionError("TOOL_BUDGET_EXHAUSTED", "model did not finalize within its step budget");
    } catch (error) {
      if (handle.abort.signal.aborted || error?.code === "ABORTED") {
        settle(handle, { terminalStatus: "CANCELLED", reason: handle.cancelReason ?? "CANCELLED" });
        return;
      }
      const code = error instanceof ToolSessionError ? error.code : "PROVIDER_ERROR";
      emit(handle, "RUN_FAILED", { reason: code });
      settle(handle, {
        terminalStatus: "FAILED",
        failureReason: ["MODEL_PROTOCOL_ERROR", "TOOL_PROTOCOL_ERROR"].includes(code)
          ? "PROTOCOL_ERROR" : code === "TOOL_TIMEOUT" ? "TIMEOUT" : "EXECUTION_FAILED",
        reason: error instanceof ToolSessionError ? error.message.slice(0, 200) : "model provider invocation failed",
        adapterMeta: {
          modelBackendType: backend.backendType,
          modelBackendVersion: backend.backendVersion,
          skillId: method.skillId,
          skillVersion: method.version,
          modelSteps,
          inputDigest,
          durationMs: now() - began,
          failureCode: code,
        },
      });
    }
  }

  const adapter = Object.freeze({
    manifest() {
      return {
        adapterType: GENERIC_MODEL_WORKER_ADAPTER_TYPE,
        adapterVersion: GENERIC_MODEL_WORKER_ADAPTER_VERSION,
        containment: { sandboxMode: "none", knownLimitations: ["ModelBackend and Actuator must honor AbortSignal; no OS containment is provided"] },
      };
    },
    start(input, context = {}) {
      const session = context.authorizedToolSession ?? null;
      const abort = new AbortController();
      let resolveWait;
      const completion = new Promise((resolve) => { resolveWait = resolve; });
      const handle = {
        input, session, abort, completion, resolveWait,
        events: [], eventWaiters: [], terminal: null, running: null, cancelReason: null,
      };
      handle.running = Promise.resolve().then(() => run(handle));
      return handle;
    },
    async *events(handle) {
      let index = 0;
      while (true) {
        while (index < handle.events.length) yield handle.events[index++];
        if (handle.terminal) return;
        await new Promise((resolve) => handle.eventWaiters.push(resolve));
      }
    },
    wait(handle) { return handle.completion; },
    async cancel(handle, reason) {
      if (handle.terminal) return;
      handle.cancelReason ??= String(reason ?? "CANCELLED").slice(0, 200);
      handle.abort.abort();
      handle.session?.cancel();
      await handle.running;
    },
  });
  adapterBackends.set(adapter, backend);
  return adapter;
}

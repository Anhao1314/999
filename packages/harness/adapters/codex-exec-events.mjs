// Codex JSONL mapping and final-message parsing.
// Contract: docs/contracts/codex-exec-adapter-v1.md §JSONL events, §Result parsing.
//
// Everything provider-specific lives here: raw Codex event names, reasoning
// items, the strict-JSON / one-fence extraction policy. What crosses this seam
// is only the frozen WorkerEvent vocabulary and a plain candidate object the
// WorkerHost validates provider-neutrally. Reasoning payloads are dropped at
// this boundary — never mapped, never persisted, never reported.
import { newWorkerEvent } from "../events.mjs";

export const CODEX_FINAL_MESSAGE_MAX_BYTES = 256 * 1024;
const AGENT_MESSAGE_MAX_BYTES = 64 * 1024;
const MAX_JSONL_LINE_BYTES = 256 * 1024;

const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const byteLength = (text) => Buffer.byteLength(text, "utf8");

const numberOrNull = (value) => (Number.isFinite(value) ? value : null);

// Provider JSONL in, frozen WorkerEvents out. The mapper owns no sequence:
// callers pass the emitter that assigns sequence numbers.
export function createCodexStreamMapper(emit) {
  const state = {
    malformedLines: 0,
    unknownEventTypes: 0,
    unknownItems: 0,
    reasoningItems: 0,
    errorItems: 0,
    toolExecutions: 0,
    agentMessages: 0,
    externalSessionRef: null,
    firstError: null,
    usage: null,
    lastAgentMessage: null,
    sawTurnCompleted: false,
  };

  function mapItem(item, completed) {
    if (!item || typeof item.type !== "string") {
      state.unknownItems += 1;
      return;
    }
    switch (item.type) {
      case "command_execution":
        if (!completed) return;
        state.toolExecutions += 1;
        // The command text and its output stay out of the domain: only the
        // fact that a tool ran, and its exit code, cross this seam.
        emit("TOOL_FINISHED", {
          tool: "command_execution",
          exitCode: Number.isInteger(item.exit_code) ? item.exit_code : null,
        });
        return;
      case "file_change":
      case "mcp_tool_call":
        if (!completed) return;
        state.toolExecutions += 1;
        emit("TOOL_FINISHED", { tool: item.type, exitCode: null });
        return;
      case "agent_message":
        if (!completed) return;
        state.agentMessages += 1;
        if (typeof item.text === "string")
          state.lastAgentMessage = item.text.slice(0, AGENT_MESSAGE_MAX_BYTES);
        return;
      case "reasoning":
        // Dropped on purpose: chain-of-thought is not observability the
        // company keeps. Only the fact that one occurred is counted.
        if (completed) state.reasoningItems += 1;
        return;
      case "error":
        if (completed) {
          state.errorItems += 1;
          if (state.firstError === null && typeof item.message === "string")
            state.firstError = item.message.slice(0, 400);
        }
        return;
      default:
        state.unknownItems += 1;
    }
  }

  return {
    state,
    consumeLine(rawLine) {
      const line = rawLine.trim();
      if (!line) return;
      if (byteLength(line) > MAX_JSONL_LINE_BYTES) {
        state.malformedLines += 1;
        return;
      }
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        state.malformedLines += 1;
        return;
      }
      if (!isPlainObject(event) || typeof event.type !== "string") {
        state.malformedLines += 1;
        return;
      }
      switch (event.type) {
        case "thread.started":
          if (state.externalSessionRef === null && typeof event.thread_id === "string")
            state.externalSessionRef = event.thread_id.slice(0, 256);
          emit("RUN_STARTED", { backend: "codex-exec" });
          return;
        case "item.started":
          mapItem(event.item, false);
          return;
        case "item.completed":
          mapItem(event.item, true);
          return;
        case "turn.completed":
          state.sawTurnCompleted = true;
          if (isPlainObject(event.usage))
            state.usage = Object.freeze({
              inputTokens: numberOrNull(event.usage.input_tokens),
              outputTokens: numberOrNull(event.usage.output_tokens),
              reasoningOutputTokens: numberOrNull(event.usage.reasoning_output_tokens),
            });
          return;
        case "turn.started":
          return;
        default:
          state.unknownEventTypes += 1;
      }
    },
  };
}

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: null };
  }
}

// A deterministic scan for top-level structured candidates. Braces and
// brackets are tracked with JSON-string awareness, so a candidate is a `{...}`
// span that starts and ends outside any enclosing container — inside markdown
// fences, inside prose, or standing alone. Real runs showed the CLI emitting
// both `prose + one fenced object` and `prose + one bare object`, so the scan
// is fence-agnostic on purpose.
function topLevelObjectCandidates(text) {
  const candidates = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === "{" || char === "[") {
      if (depth === 0) start = char === "{" ? index : -1;
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        candidates.push(text.slice(start, index + 1));
        start = -1;
      }
      continue;
    }
    if (char === '"' && depth > 0) inString = true;
  }
  return candidates;
}

// The parsing policy (contract §13): strict JSON first; then extraction only
// when the message contains exactly one top-level JSON object candidate —
// fenced or bare, with bounded surrounding prose. Missing fields are never
// inferred, and a message with two structured candidates is refused rather
// than guessed.
export function parseCodexFinalMessage(rawText) {
  if (typeof rawText !== "string" || rawText.trim().length === 0)
    return { method: "NO_CANDIDATE", candidate: null, reason: "the attempt produced no final message" };
  if (byteLength(rawText) > CODEX_FINAL_MESSAGE_MAX_BYTES)
    return { method: "NO_CANDIDATE", candidate: null, reason: "the final message exceeds the bounded payload" };
  const text = rawText.trim();
  const strict = tryParseJson(text);
  if (strict.ok) {
    if (!isPlainObject(strict.value))
      return { method: "NO_CANDIDATE", candidate: null, reason: "the final message is not a JSON object" };
    return { method: "STRICT_JSON", candidate: strict.value, reason: null };
  }
  const objects = topLevelObjectCandidates(text);
  const parsedObjects = objects
    .map((body) => tryParseJson(body))
    .filter((entry) => entry.ok)
    .map((entry) => entry.value);
  if (parsedObjects.length === 0)
    return {
      method: "NO_CANDIDATE",
      candidate: null,
      reason: "strict JSON parsing failed and the message contains no structured JSON candidate",
    };
  if (parsedObjects.length > 1)
    return {
      method: "NO_CANDIDATE",
      candidate: null,
      reason: "the message contains more than one structured JSON candidate",
    };
  if (!isPlainObject(parsedObjects[0]))
    return { method: "NO_CANDIDATE", candidate: null, reason: "the structured JSON candidate is not an object" };
  return { method: "EXTRACTED_JSON", candidate: parsedObjects[0], reason: null };
}

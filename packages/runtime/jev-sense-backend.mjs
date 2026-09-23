// Jev implementation of Relay Sense. This adapter can call only TypeSafe's
// System One endpoint. A trusted memory-only provider supplies the credential
// per invocation; it is never copied into Work or a trace.
import {
  RELAY_SENSE_QUESTIONS,
  parseRelaySenseAnswers,
  readBoundedSystemOneResponse,
} from "./relay-sense.mjs";

export const JEV_SYSTEM_ONE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

import { JEV_SECRET_NAME } from "./secret-provider.mjs";

export function createJevSenseBackend({ secretProvider, model = "jev-latest", fetchImpl = fetch,
  timeoutMs = 2_500 } = {}) {
  if (typeof secretProvider?.get !== "function")
    throw new Error("Jev Sense requires a trusted SecretProvider");
  if (typeof model !== "string" || !/^jev-[a-z0-9.-]{1,60}$/.test(model))
    throw new Error("Jev Sense requires a Jev model name");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000)
    throw new Error("Jev Sense timeout must be 1..10000 ms");
  return Object.freeze({
    name: "jev",
    version: model,
    async sense(state, questions = RELAY_SENSE_QUESTIONS) {
      const apiKey = await secretProvider.get(JEV_SECRET_NAME);
      if (typeof apiKey !== "string" || apiKey.length < 8 || apiKey.length > 512 || /\s/.test(apiKey))
        throw new Error("Jev Sense credential unavailable");
      const body = JSON.stringify({ model, state, questions });
      if (Buffer.byteLength(body, "utf8") > 12_288) throw new Error("Jev Sense request exceeds its bound");
      const response = await fetchImpl(JEV_SYSTEM_ONE_ENDPOINT, {
        method: "POST",
        headers: { "authorization": `Bearer ${apiKey}`, "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      const payload = await readBoundedSystemOneResponse(response);
      if (typeof payload?.model !== "string" || payload.model.length === 0 || payload.model.length > 80)
        throw new Error("Jev Sense response has no model identity");
      return { signals: parseRelaySenseAnswers(payload, { requireTypes: true }), model: payload.model };
    },
  });
}

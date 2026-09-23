// Optional local implementation of the Relay Sense question pack. Laya is a
// backend, not an authority or a required dependency of the Runtime.
import {
  RELAY_SENSE_QUESTIONS,
  compileRelaySenseState,
  parseRelaySenseAnswers,
  readBoundedSystemOneResponse,
  validateRelaySenseSignals,
} from "./relay-sense.mjs";

export const LAYA_SHADOW_SENSOR_NAME = "laya";
export const LAYA_SHADOW_SENSOR_VERSION = "v0";
// Compatibility exports for the first shadow slice. Relay Sense owns them now.
export const LAYA_SHADOW_QUESTIONS = RELAY_SENSE_QUESTIONS;
export const compileLayaShadowState = compileRelaySenseState;
export const parseLayaShadowAnswers = parseRelaySenseAnswers;
export const validateLayaShadowSignals = validateRelaySenseSignals;

export function createLayaShadowSensor({
  endpoint = "http://127.0.0.1:8000/v1/systemone",
  fetchImpl = fetch,
  timeoutMs = 1_500,
} = {}) {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.pathname !== "/v1/systemone" || url.search || url.hash || url.username || url.password)
    throw new Error("Laya shadow endpoint must be a loopback HTTP /v1/systemone URL");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000)
    throw new Error("Laya shadow timeout must be 1..10000 ms");
  return Object.freeze({
    name: LAYA_SHADOW_SENSOR_NAME,
    version: LAYA_SHADOW_SENSOR_VERSION,
    async sense(state, questions = RELAY_SENSE_QUESTIONS) {
      const body = JSON.stringify({ state, questions });
      if (Buffer.byteLength(body, "utf8") > 12_288) throw new Error("Laya shadow request exceeds its bound");
      const response = await fetchImpl(url.href, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      const payload = await readBoundedSystemOneResponse(response);
      return {
        signals: parseRelaySenseAnswers(payload),
        model: typeof payload.model === "string" && payload.model.length <= 80 ? payload.model : "laya-local",
      };
    },
  });
}

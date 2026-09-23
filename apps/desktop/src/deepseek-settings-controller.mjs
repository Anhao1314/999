// Desktop's packaged shell is separate from its Runtime bundle.
export const DEEPSEEK_SECRET_NAME = "model.deepseek";
const ENDPOINT = "https://api.deepseek.com/chat/completions";
const MODEL = "deepseek-flash";
const MAX_PROBE_BYTES = 16_384;

async function boundedJson(response) {
  if (!response.body) throw new Error("Missing response body");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROBE_BYTES) throw new Error("Response too large");
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function probeDeepSeek({ key, fetchImpl }) {
  try {
    const response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ model: MODEL, thinking: { type: "disabled" },
        messages: [
          { role: "system", content: "Return one JSON object. Example JSON: {\"ping\":\"OK\"}." },
          { role: "user", content: "Return the JSON ping object with value OK." },
        ], response_format: { type: "json_object" }, max_tokens: 48, stream: false }),
      signal: AbortSignal.timeout(10_000), redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      return [401, 403].includes(response.status) ? "INVALID" : "UNAVAILABLE";
    }
    const data = await boundedJson(response);
    if (data?.choices?.[0]?.finish_reason !== "stop" ||
        typeof data.choices[0].message?.content !== "string") return "UNAVAILABLE";
    return JSON.parse(data.choices[0].message.content)?.ping === "OK" ? "CONNECTED" : "UNAVAILABLE";
  } catch { return "UNAVAILABLE"; }
}

// Settings renderer sees status only; Desktop main owns the encrypted store.
export function createDeepSeekSettingsController({ store, restartRuntime, fetchImpl = fetch }) {
  let lastTest = null;
  let pending = Promise.resolve();
  const serialize = action => {
    const next = pending.then(action);
    pending = next.catch(() => {});
    return next;
  };
  async function status() {
    if (!store.available()) return { status: "UNAVAILABLE", configured: false };
    try {
      const configured = await store.hasSecret(DEEPSEEK_SECRET_NAME);
      return { status: configured ? (lastTest ?? "CONFIGURED") : "NOT_CONFIGURED", configured };
    } catch { return { status: "UNAVAILABLE", configured: false }; }
  }
  return Object.freeze({
    status,
    async save(key) {
      return serialize(async () => {
        if (typeof key !== "string" || key.length < 8 || key.length > 512 || /\s/.test(key))
          return { status: "INVALID", configured: (await status()).configured };
        try {
          await store.setSecret(DEEPSEEK_SECRET_NAME, key);
          lastTest = null;
          await restartRuntime();
          return status();
        } catch { return { status: "UNAVAILABLE", configured: (await status()).configured }; }
      });
    },
    async remove() {
      return serialize(async () => {
        try {
          await store.deleteSecret(DEEPSEEK_SECRET_NAME);
          lastTest = null;
          await restartRuntime();
          return status();
        } catch { return { status: "UNAVAILABLE", configured: (await status()).configured }; }
      });
    },
    async test() {
      return serialize(async () => {
        let key;
        try { key = await store.getSecret(DEEPSEEK_SECRET_NAME); }
        catch { return { status: "UNAVAILABLE", configured: false }; }
        if (!key) return { status: "NOT_CONFIGURED", configured: false };
        lastTest = await probeDeepSeek({ key, fetchImpl });
        return { status: lastTest, configured: true };
      });
    },
  });
}

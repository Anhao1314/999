const SECRET_NAME = "relay-sense.jev";
const MODELS_URL = "https://api.typesafe.ai/v1/models";

export function createJevSettingsController({ store, restartRuntime, fetchImpl = fetch }) {
  let lastTest = null;
  let pending = Promise.resolve();
  const serialize = (action) => {
    const next = pending.then(action);
    pending = next.catch(() => {});
    return next;
  };

  async function status() {
    if (!store.available()) return { status: "UNAVAILABLE", configured: false };
    try {
      const configured = (await store.getSecret(SECRET_NAME)) !== null;
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
          await store.setSecret(SECRET_NAME, key);
          lastTest = null;
          await restartRuntime();
          return status();
        } catch { return { status: "UNAVAILABLE", configured: (await status()).configured }; }
      });
    },
    async remove() {
      return serialize(async () => {
        try {
          await store.deleteSecret(SECRET_NAME);
          lastTest = null;
          await restartRuntime();
          return status();
        } catch { return { status: "UNAVAILABLE", configured: (await status()).configured }; }
      });
    },
    async test() {
      return serialize(async () => {
        let key;
        try { key = await store.getSecret(SECRET_NAME); }
        catch { return { status: "UNAVAILABLE", configured: false }; }
        if (!key) return { status: "NOT_CONFIGURED", configured: false };
        try {
          const response = await fetchImpl(MODELS_URL, {
            method: "GET",
            headers: { authorization: `Bearer ${key}`, accept: "application/json" },
            signal: AbortSignal.timeout(5000),
            redirect: "error",
          });
          lastTest = response.ok ? "CONNECTED" :
            [401, 403].includes(response.status) ? "INVALID" : "UNAVAILABLE";
        } catch { lastTest = "UNAVAILABLE"; }
        return { status: lastTest, configured: true };
      });
    },
  });
}

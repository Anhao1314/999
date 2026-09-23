export const JEV_SECRET_NAME = "relay-sense.jev";

// This provider has no persistence or serialization surface. A child process
// receives its one startup credential, removes it from process.env, and only
// privileged execution adapters can ask for it.
export function createMemorySecretProvider(entries = {}) {
  const secrets = new Map(Object.entries(entries).filter(([, value]) =>
    typeof value === "string" && value.length > 0));
  return Object.freeze({
    get(name) { return secrets.get(name) ?? null; },
    has(name) { return secrets.has(name); },
  });
}

export function createProcessSecretProvider(env = process.env) {
  const key = env.TYPESAFE_API_KEY;
  const modelKey = env.FLOWCREDIT_DEEPSEEK_API_KEY;
  delete env.TYPESAFE_API_KEY;
  delete env.FLOWCREDIT_DEEPSEEK_API_KEY;
  return createMemorySecretProvider({ [JEV_SECRET_NAME]: key, "model.deepseek": modelKey });
}

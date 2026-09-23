// Provider-neutral intelligence boundary. A provider yields one structured
// step; the Adapter owns the conversation loop and all run-scoped context.
export function assertModelBackend(backend) {
  if (!backend || typeof backend.backendType !== "string" || !backend.backendType || backend.backendType.length > 80 ||
      typeof backend.backendVersion !== "string" || !backend.backendVersion || backend.backendVersion.length > 80 ||
      typeof backend.invoke !== "function")
    throw new Error("ModelBackend requires backendType, backendVersion and invoke()");
  return backend;
}

export function createTestModelBackend({ steps = [] } = {}) {
  const calls = [];
  let index = 0;
  return Object.freeze({
    backendType: "test-model",
    backendVersion: "0.1.0",
    calls,
    async invoke(request) {
      if (request.abortSignal?.aborted) throw new Error("model invocation aborted");
      calls.push(request);
      const step = steps[index++];
      if (step === undefined) throw new Error("TestModelBackend has no next step");
      const result = typeof step === "function" ? await step(request) : structuredClone(step);
      if (request.abortSignal?.aborted) throw new Error("model invocation aborted");
      return result;
    },
  });
}

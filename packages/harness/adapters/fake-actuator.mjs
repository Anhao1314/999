// Deterministic actuator for tests. It has no network or external credentials.
export function createFakeActuator({ responses = {}, onInvoke = null } = {}) {
  const calls = [];
  return Object.freeze({
    calls,
    supports(capability) { return Object.hasOwn(responses, capability); },
    async invoke({ capability, input, signal }) {
      if (signal?.aborted) throw new Error("fake actuator aborted");
      calls.push(Object.freeze({ capability, input }));
      if (onInvoke) await onInvoke({ capability, input, signal });
      if (signal?.aborted) throw new Error("fake actuator aborted");
      const response = responses[capability];
      return typeof response === "function" ? response(input) : structuredClone(response);
    },
  });
}

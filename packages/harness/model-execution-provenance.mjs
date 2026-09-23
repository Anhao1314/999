// Host readout for provider implementations that can attest a completed
// transport invocation. A text backendType or Adapter metadata is insufficient.
import { runtimeModelBackendForAdapter } from "./adapters/generic-model-worker.mjs";
import { verifiedDeepSeekInvocations } from "./deepseek-model-backend.mjs";

export function hostObservedModelExecution(adapter, workerRunId) {
  const backend = runtimeModelBackendForAdapter(adapter);
  if (!backend) return null;
  const calls = verifiedDeepSeekInvocations(backend, workerRunId);
  if (calls < 1) return null;
  return Object.freeze({ backendType: backend.backendType,
    backendVersion: backend.backendVersion, successfulCalls: calls });
}

// WorkerBackendResolver — which backend executes this attempt.
// Contract: docs/contracts/worker-harness-v0.md §10.
//
// v0 is deliberately static: no registry, no ranking, no fallback, no
// persistent EmployeeWorkerBinding. The resolver is a replaceable seam, not a
// policy engine.
export const STATIC_RESOLVER_TYPE = "static-v0";

export function createStaticWorkerBackendResolver({
  backendType = "test-worker",
  backendVersion = "0.1.0",
  baseRevision = null,
  externalSessionRef = null,
} = {}) {
  if (typeof backendType !== "string" || !backendType)
    throw new Error("a static resolver requires a backendType");
  if (typeof backendVersion !== "string" || !backendVersion)
    throw new Error("a static resolver requires a backendVersion");
  return Object.freeze({
    resolverType: STATIC_RESOLVER_TYPE,
    // Deterministic mapping: every eligible Employee/Position resolves to the
    // same declared backend. The identity of the employee never picks a
    // backend in v0, and no candidate list is produced.
    resolve({ workerRun, employee, position } = {}) {
      if (!workerRun) return null;
      return Object.freeze({
        backendType,
        backendVersion,
        baseRevision,
        externalSessionRef,
        resolvedFor: Object.freeze({
          workerRunId: workerRun.id,
          employeeId: employee?.id ?? null,
          positionId: position?.id ?? null,
        }),
      });
    },
  });
}

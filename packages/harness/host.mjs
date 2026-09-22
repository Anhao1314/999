// WorkerHost — production orchestration of one WorkerRun attempt.
// Contract: docs/contracts/worker-harness-v0.md §11–§13, §15–§19.
//
// The Host executes attempts the Runtime has already started. It never decides
// who works on what: assignment, startWorkerRun, review dispatch and repair
// dispatch belong to v0B4, and the Host holds no Work/Task/Review/Founder
// state at all.
//
// Runtime facts are read, never assumed: every observation re-reads WorkerRun
// truth, and a duplicate or stale notification is a no-op. The Host writes to
// the Runtime through four commands only — bindWorkerExecution,
// submitWorkerResult, submitWorkerReviewResult and interruptWorkerRun — and
// every one of them derives its own lineage from the WorkerRun.
import { assertAdapterManifest, assertWorkerAdapter, normalizeAdapterResult } from "./adapter.mjs";
import { ensureRunWorkspace, leaseStateForRun, runWorkspaceLayout } from "./execution-binding.mjs";
import { normalizeWorkerEvent } from "./events.mjs";
import {
  buildHarnessEvidence,
  parseWorkerResult,
  parseWorkerReviewResult,
  workerResultDigest,
  workerReviewResultDigest,
} from "./result.mjs";
import {
  RESULT_CONTRACT_KINDS,
  buildWorkerRunInput,
  defaultRequestedPolicy,
  executionProfileDigest,
  resultContractForWorkPacket,
} from "./worker-run-input.mjs";

export const HOST_STATUS = Object.freeze({
  DELIVERED: "DELIVERED",
  INTERRUPTED: "INTERRUPTED",
  CANCELLED: "CANCELLED",
  DEFERRED_NO_BACKEND: "DEFERRED_NO_BACKEND",
  SKIPPED_NOT_RUNNING: "SKIPPED_NOT_RUNNING",
  REFUSED: "REFUSED",
  START_FAILED: "START_FAILED",
  HOST_ERROR: "HOST_ERROR",
});

export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const MAX_OBSERVED_EVENTS = 256;

export function createWorkerHost({
  kernel,
  adapter,
  resolver,
  runtimeRoot,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  requestedPolicy = defaultRequestedPolicy(),
  now = () => new Date().toISOString(),
} = {}) {
  if (!kernel) throw new Error("createWorkerHost requires a kernel");
  assertWorkerAdapter(adapter);
  if (!resolver || typeof resolver.resolve !== "function")
    throw new Error("createWorkerHost requires a WorkerBackendResolver");
  if (!runtimeRoot) throw new Error("createWorkerHost requires a runtimeRoot");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("timeoutMs must be a positive integer");

  const inFlight = new Map();
  const handles = new Map();
  const reports = [];
  let observing = false;
  let stopped = false;

  function report(workerRunId, generation, status, detail = null) {
    const entry = Object.freeze({
      workerRunId,
      generation,
      status,
      detail,
      at: now(),
    });
    reports.push(entry);
    return entry;
  }

  const safeCancel = async (handle, reason) => {
    try {
      await adapter.cancel(handle, reason);
    } catch (error) {
      process.stderr.write(`worker adapter cancel failed: ${error?.message ?? error}\n`);
    }
  };

  // The adapter's terminal report, normalized at the Host boundary. A wait that
  // fails, times out or returns something that is not a WorkerAdapterResult is
  // all one thing here: a protocol problem, never a delivery.
  async function waitWithHostTimeout(handle) {
    let timer = null;
    try {
      const budget = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ kind: "TIMEOUT" }), timeoutMs);
      });
      const settled = Promise.resolve()
        .then(() => adapter.wait(handle, { timeoutMs }))
        .then((raw) => ({ kind: "SETTLED", result: normalizeAdapterResult(raw) }))
        .catch((error) => ({ kind: "PROTOCOL_ERROR", reason: error?.message ?? String(error) }));
      return await Promise.race([settled, budget]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function execute(workerRunId) {
    const run = kernel.workerRun(workerRunId);
    if (!run || run.state !== "RUNNING") {
      report(workerRunId, run?.generation ?? null, HOST_STATUS.SKIPPED_NOT_RUNNING, {
        state: run?.state ?? "MISSING",
      });
      return;
    }

    const task = kernel.task(run.taskId);
    const employee = kernel.employee(run.employeeId);
    const position = kernel.position(run.positionId);
    const company = kernel.company(run.companyId);
    const resolved = resolver.resolve({ workerRun: run, task, employee, position, company });
    if (!resolved) {
      report(run.id, run.generation, HOST_STATUS.DEFERRED_NO_BACKEND, { taskId: run.taskId });
      return;
    }

    const manifest = assertAdapterManifest(await adapter.manifest());
    if (manifest.adapterType !== resolved.backendType) {
      report(run.id, run.generation, HOST_STATUS.REFUSED, {
        code: "ADAPTER_BACKEND_MISMATCH",
        detail: `the resolver chose ${resolved.backendType}; the adapter reports ${manifest.adapterType}`,
      });
      return;
    }

    const layout = runWorkspaceLayout({
      runtimeRoot,
      workId: run.workId,
      workerRunId: run.id,
      generation: run.generation,
    });
    ensureRunWorkspace(layout);
    const effectivePolicy = Object.freeze({
      sandboxMode: manifest.containment.sandboxMode,
      workspaceRoot: layout.workspaceRoot,
      scratchRoot: layout.scratchRoot,
      knownLimitations: manifest.containment.knownLimitations,
    });

    let binding = null;
    try {
      const bound = kernel.bindWorkerExecution({
        workerRunId: run.id,
        generation: run.generation,
        backendType: resolved.backendType,
        backendVersion: resolved.backendVersion,
        executionProfileDigest: executionProfileDigest({
          backendType: resolved.backendType,
          backendVersion: resolved.backendVersion,
          effectivePolicy,
          requestedPolicy,
        }),
        workspaceRoot: layout.workspaceRoot,
        scratchRoot: layout.scratchRoot,
        baseRevision: resolved.baseRevision ?? null,
        externalSessionRef: resolved.externalSessionRef ?? null,
      });
      binding = bound.binding;
    } catch (error) {
      report(run.id, run.generation, HOST_STATUS.REFUSED, {
        code: error?.code ?? "BINDING_FAILED",
        detail: error?.message ?? String(error),
      });
      return;
    }

    // The role-specific contract is derived from committed Runtime truth: the
    // durable packet's review section says this attempt must judge an Artifact
    // rather than produce one. Neither the Host, the adapter nor the Worker can
    // choose it.
    const resultContract = resultContractForWorkPacket(run.workPacket);
    const input = buildWorkerRunInput({
      run,
      binding,
      requestedPolicy,
      effectivePolicy,
      resultContract,
    });

    let handle = null;
    try {
      handle = await adapter.start(input, {
        binding,
        workspaceRoot: layout.workspaceRoot,
        scratchRoot: layout.scratchRoot,
        effectiveExecutionPolicy: effectivePolicy,
      });
    } catch (error) {
      kernel.interruptWorkerRun({
        workerRunId: run.id,
        generation: run.generation,
        reason: "WORKER_PROCESS_EXIT",
      });
      report(run.id, run.generation, HOST_STATUS.START_FAILED, {
        detail: error?.message ?? String(error),
      });
      return;
    }
    handles.set(run.id, handle);

    const observed = [];
    let eventsError = null;
    const drain = (async () => {
      try {
        for await (const raw of adapter.events(handle)) {
          if (observed.length < MAX_OBSERVED_EVENTS) observed.push(normalizeWorkerEvent(raw));
        }
      } catch (error) {
        eventsError = error?.message ?? String(error);
      }
    })();

    // One report shape for every interrupted attempt: the Runtime records the
    // fact, the Host says what it observed. Nothing is written on the way.
    const interrupt = async (reason, detail = null) => {
      await safeCancel(handle, reason);
      kernel.interruptWorkerRun({ workerRunId: run.id, generation: run.generation, reason });
      await drain.catch(() => {});
      report(run.id, run.generation, HOST_STATUS.INTERRUPTED, { reason, detail });
    };

    // An invalid candidate is never delivered and never patched up: the attempt
    // ends through the Runtime's one interruption primitive, so the ordinary
    // continuation policy decides what may happen next.
    const refuseCandidate = (detail) => interrupt("WORKER_PROTOCOL_ERROR", detail);

    try {
      const settled = await waitWithHostTimeout(handle);

      if (settled.kind === "TIMEOUT") {
        await interrupt("WORKER_TIMEOUT");
        return;
      }
      if (settled.kind === "PROTOCOL_ERROR") {
        await interrupt("WORKER_PROTOCOL_ERROR", settled.reason);
        return;
      }

      const adapterResult = settled.result;
      if (adapterResult.terminalStatus === "CANCELLED") {
        // A cancelled execution writes nothing: an attempt nobody reported on
        // stays RUNNING in Runtime truth, and recovery owns its resolution.
        await drain.catch(() => {});
        report(run.id, run.generation, HOST_STATUS.CANCELLED, { reason: adapterResult.reason });
        return;
      }
      if (adapterResult.terminalStatus === "FAILED") {
        // `PROCESS_EXIT` is the one failure the adapter itself can certify; any
        // other failure is the adapter telling us the execution protocol broke.
        const processExit = adapterResult.failureReason === "PROCESS_EXIT";
        await interrupt(
          processExit ? "WORKER_PROCESS_EXIT" : "WORKER_PROTOCOL_ERROR",
          adapterResult.reason ?? adapterResult.failureReason,
        );
        return;
      }

      // SUCCEEDED: what it means depends on the contract the packet granted.
      const isReview = resultContract.kind === RESULT_CONTRACT_KINDS.REVIEW_JUDGMENT;

      if (isReview) {
        const parsed = parseWorkerReviewResult(adapterResult.resultCandidate);
        if (!parsed.ok) {
          await refuseCandidate(parsed.reason);
          return;
        }
        const judgment = parsed.result;
        if (judgment.workerRunId !== run.id || judgment.generation !== run.generation) {
          await refuseCandidate(
            `the judgment names ${judgment.workerRunId} g${judgment.generation}, not this attempt ${run.id} g${run.generation}`,
          );
          return;
        }
        if (judgment.summary === null) {
          await refuseCandidate(
            "a delivered judgment must carry a bounded summary; the Harness never invents Review text",
          );
          return;
        }

        await drain.catch(() => {});
        const evidence = buildHarnessEvidence({
          run,
          processOutcome: "SUCCEEDED",
          events: observed,
          resultParse: "PARSED",
          reportedVerification: null,
          containment: effectivePolicy,
          observedAt: now(),
        });

        try {
          const delivered = kernel.submitWorkerReviewResult({
            workerRunId: run.id,
            generation: run.generation,
            resultDigest: workerReviewResultDigest(judgment),
            evidenceDigest: evidence.evidenceDigest,
            verdict: judgment.verdict,
            findings: judgment.findings,
            summary: judgment.summary,
          });
          report(run.id, run.generation, HOST_STATUS.DELIVERED, {
            idempotent: delivered.idempotent,
            reviewId: delivered.review.id,
            verdict: delivered.review.verdict,
            evidenceDigest: evidence.evidenceDigest,
            evidence,
            eventsError,
          });
        } catch (error) {
          report(run.id, run.generation, HOST_STATUS.REFUSED, {
            code: error?.code ?? "DELIVERY_FAILED",
            detail: error?.message ?? String(error),
          });
        }
        return;
      }

      const parsed = parseWorkerResult(adapterResult.resultCandidate);
      if (!parsed.ok) {
        await refuseCandidate(parsed.reason);
        return;
      }
      const result = parsed.result;

      // A validated result that reports failure is an attempt that ended
      // without a deliverable output. The interruption vocabulary has no
      // dedicated worker-reported-failure reason yet (remaining gap), so the
      // closest truthful mapping is the attempt's process ending.
      if (result.outcome !== "SUCCEEDED") {
        await interrupt("WORKER_PROCESS_EXIT", "the Worker reported FAILED rather than a successful result");
        return;
      }

      // Delivery needs exactly one proposed output; the Repair target, when the
      // Task has one, is Runtime truth carried by the durable packet.
      if (result.proposedArtifacts.length !== 1) {
        await refuseCandidate(
          `a successful result must propose exactly one output, got ${result.proposedArtifacts.length}`,
        );
        return;
      }
      const proposed = result.proposedArtifacts[0];
      const artifact = {
        kind: proposed.kind,
        title: proposed.title,
        content: proposed.content,
        supersedesArtifactId:
          proposed.supersedesArtifactId ?? run.workPacket.repair?.targetArtifact?.id ?? null,
      };

      await drain.catch(() => {});
      const evidence = buildHarnessEvidence({
        run,
        processOutcome: "SUCCEEDED",
        events: observed,
        resultParse: "PARSED",
        reportedVerification: result.reportedVerification,
        containment: effectivePolicy,
        observedAt: now(),
      });

      try {
        const delivered = kernel.submitWorkerResult({
          workerRunId: run.id,
          generation: run.generation,
          resultDigest: workerResultDigest(result),
          evidenceDigest: evidence.evidenceDigest,
          artifact,
          verificationSummary: result.reportedVerification,
        });
        report(run.id, run.generation, HOST_STATUS.DELIVERED, {
          idempotent: delivered.idempotent,
          artifactId: delivered.artifact.id,
          reviewRequired: delivered.reviewRequired,
          evidenceDigest: evidence.evidenceDigest,
          evidence,
          eventsError,
        });
      } catch (error) {
        report(run.id, run.generation, HOST_STATUS.REFUSED, {
          code: error?.code ?? "DELIVERY_FAILED",
          detail: error?.message ?? String(error),
        });
      }
    } finally {
      handles.delete(run.id);
    }
  }

  function observe(workerRunId) {
    if (stopped || !workerRunId) return undefined;
    if (inFlight.has(workerRunId)) return inFlight.get(workerRunId);
    const attempt = (async () => {
      try {
        await execute(workerRunId);
      } catch (error) {
        report(workerRunId, null, HOST_STATUS.HOST_ERROR, {
          detail: error?.message ?? String(error),
        });
      } finally {
        inFlight.delete(workerRunId);
      }
    })();
    inFlight.set(workerRunId, attempt);
    return attempt;
  }

  return Object.freeze({
    // Start observing committed WorkerRun starts. Duplicate notifications are
    // harmless; reconciliation heals anything missed while the Host was down.
    start() {
      if (stopped) throw new Error("a stopped WorkerHost cannot be restarted");
      if (!observing) {
        observing = true;
        kernel.setWorkerRunObserver(({ workerRunId }) => observe(workerRunId));
      }
      return { reconciled: this.reconcile() };
    },
    // Missed-observation repair: read committed truth and act on what is still
    // RUNNING. Never a resume: an interrupted attempt is not restarted here.
    reconcile() {
      const running = kernel.workerRuns({ state: "RUNNING" });
      for (const run of running) observe(run.id);
      return running.length;
    },
    observe,
    async stop() {
      if (stopped) return;
      stopped = true;
      observing = false;
      kernel.setWorkerRunObserver(null);
      for (const handle of handles.values()) await safeCancel(handle, "HOST_STOPPING");
      await this.idle();
    },
    async idle() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight.values()]);
    },
    reports() {
      return [...reports];
    },
    reportFor(workerRunId) {
      return reports.filter((entry) => entry.workerRunId === workerRunId);
    },
    leaseState(workerRunId) {
      const run = kernel.workerRun(workerRunId);
      return run ? leaseStateForRun(run.state) : null;
    },
  });
}

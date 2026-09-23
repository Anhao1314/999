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
import { createAuthorizedToolSession, createToolBudget, createToolGrant } from "./tool-session.mjs";
import { ensureRunWorkspace, leaseStateForRun, runWorkspaceLayout } from "./execution-binding.mjs";
import { normalizeWorkerEvent } from "./events.mjs";
import { hostObservedModelExecution } from "./model-execution-provenance.mjs";
import { isNetworkWebResearchActuator } from "./adapters/web-research-actuator.mjs";
import {
  buildHarnessEvidence,
  HARNESS_REJECTION_REASONS,
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
  activationResolver = null,
  runtimeRoot,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
  requestedPolicy = defaultRequestedPolicy(),
  toolPolicy = null,
  artifactPostcondition = null,
  now = () => new Date().toISOString(),
} = {}) {
  if (!kernel) throw new Error("createWorkerHost requires a kernel");
  if (activationResolver !== null && typeof activationResolver.activate !== "function")
    throw new Error("activationResolver requires activate()");
  if (activationResolver !== null && (adapter || resolver || toolPolicy || artifactPostcondition))
    throw new Error("Employee Activation owns Adapter, resolver, tool policy and postcondition selection");
  if (activationResolver === null) assertWorkerAdapter(adapter);
  if (activationResolver === null && (!resolver || typeof resolver.resolve !== "function"))
    throw new Error("createWorkerHost requires a WorkerBackendResolver");
  if (!runtimeRoot) throw new Error("createWorkerHost requires a runtimeRoot");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("timeoutMs must be a positive integer");
  if (artifactPostcondition !== null && typeof artifactPostcondition !== "function")
    throw new Error("artifactPostcondition must be a function");
  const configuredToolElapsedMs = toolPolicy?.budget?.maxElapsedMs ?? timeoutMs;
  const toolBudget = toolPolicy
    ? createToolBudget({
        ...(toolPolicy.budget ?? {}),
        maxElapsedMs: configuredToolElapsedMs,
        toolTimeoutMs: toolPolicy.budget?.toolTimeoutMs ?? Math.min(configuredToolElapsedMs, 10_000),
      })
    : null;
  if (toolBudget && toolBudget.maxElapsedMs > timeoutMs)
    throw new Error("ToolBudget maxElapsedMs cannot exceed WorkerHost timeoutMs");
  const trustedToolPolicy = toolPolicy
    ? Object.freeze({
        skill: Object.freeze({
          skillId: toolPolicy.skill?.skillId,
          version: toolPolicy.skill?.version,
          requiredCapabilities: Object.freeze([...(toolPolicy.skill?.requiredCapabilities ?? [])]),
          allowedToolCapabilities: Object.freeze([...(toolPolicy.skill?.allowedToolCapabilities ?? [])]),
        }),
        approvedCapabilities: Object.freeze([...(toolPolicy.approvedCapabilities ?? [])]),
        actuators: Object.freeze([...(toolPolicy.actuators ?? [])]),
      })
    : null;

  const inFlight = new Map();
  const handles = new Map();
  const sessions = new Map();
  // Bounded, process-local presentation facts. This is not Company truth or
  // replay history; the Experience layer may only project selected fields.
  const publicExecutions = new Map();
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

  const safeCancel = async (activeAdapter, handle, reason) => {
    try {
      await activeAdapter.cancel(handle, reason);
    } catch (error) {
      process.stderr.write(`worker adapter cancel failed: ${error?.message ?? error}\n`);
    }
  };

  // The adapter's terminal report, normalized at the Host boundary. A wait that
  // fails, times out or returns something that is not a WorkerAdapterResult is
  // all one thing here: a protocol problem, never a delivery.
  async function waitWithHostTimeout(activeAdapter, handle) {
    let timer = null;
    try {
      const budget = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ kind: "TIMEOUT" }), timeoutMs);
      });
      const settled = Promise.resolve()
        .then(() => activeAdapter.wait(handle, { timeoutMs }))
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
    let activation = null;
    if (activationResolver) {
      try {
        activation = activationResolver.activate({ workerRun: run, task, employee, position, company });
        if (!activation) throw new Error("no matching Employee Activation");
        assertWorkerAdapter(activation.adapter);
        if (!activation.resolution?.backendType || !activation.resolution?.backendVersion)
          throw new Error("Activation has no backend resolution");
      } catch {
        kernel.interruptWorkerRun({ workerRunId: run.id, generation: run.generation, reason: "WORKER_EXECUTION_FAILED" });
        report(run.id, run.generation, HOST_STATUS.INTERRUPTED, {
          reason: "WORKER_EXECUTION_FAILED", detail: "Employee Activation unavailable",
        });
        return;
      }
    }
    const activeAdapter = activation?.adapter ?? adapter;
    const resolved = activation?.resolution ?? resolver.resolve({ workerRun: run, task, employee, position, company });
    if (!resolved) {
      report(run.id, run.generation, HOST_STATUS.DEFERRED_NO_BACKEND, { taskId: run.taskId });
      return;
    }

    let manifest;
    try {
      manifest = assertAdapterManifest(await activeAdapter.manifest());
    } catch (error) {
      if (!activationResolver) throw error;
      kernel.interruptWorkerRun({ workerRunId: run.id, generation: run.generation, reason: "WORKER_EXECUTION_FAILED" });
      report(run.id, run.generation, HOST_STATUS.INTERRUPTED, {
        reason: "WORKER_EXECUTION_FAILED", detail: "Activation Adapter manifest unavailable",
      });
      return;
    }
    if (manifest.adapterType !== resolved.backendType) {
      if (activationResolver)
        kernel.interruptWorkerRun({ workerRunId: run.id, generation: run.generation, reason: "WORKER_EXECUTION_FAILED" });
      report(run.id, run.generation, activationResolver ? HOST_STATUS.INTERRUPTED : HOST_STATUS.REFUSED, {
        code: "ADAPTER_BACKEND_MISMATCH",
        detail: `the resolver chose ${resolved.backendType}; the adapter reports ${manifest.adapterType}`,
      });
      return;
    }

    const activeRequestedPolicy = activation?.requestedPolicy ?? requestedPolicy;
    const activeArtifactPostcondition = activation?.artifactPostcondition ?? artifactPostcondition;
    const activeToolPolicy = activationResolver ? activation.toolPolicy ?? null : trustedToolPolicy;
    let activeBudget = toolBudget;
    if (activationResolver && activeToolPolicy) {
      try {
        const elapsed = activeToolPolicy.budget?.maxElapsedMs ?? timeoutMs;
        activeBudget = createToolBudget({
          ...(activeToolPolicy.budget ?? {}), maxElapsedMs: elapsed,
          toolTimeoutMs: activeToolPolicy.budget?.toolTimeoutMs ?? Math.min(elapsed, 10_000),
        });
        if (activeBudget.maxElapsedMs > timeoutMs)
          throw new Error("Activation ToolBudget exceeds WorkerHost timeoutMs");
      } catch {
        kernel.interruptWorkerRun({ workerRunId: run.id, generation: run.generation, reason: "WORKER_EXECUTION_FAILED" });
        report(run.id, run.generation, HOST_STATUS.INTERRUPTED, {
          reason: "WORKER_EXECUTION_FAILED", detail: "Activation ToolBudget invalid",
        });
        return;
      }
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
          requestedPolicy: activeRequestedPolicy,
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
      requestedPolicy: activeRequestedPolicy,
      effectivePolicy,
      resultContract,
    });

    // A static, trusted policy is supplied by the Host composition. Neither
    // WorkPacket capabilities nor the Adapter can create a ToolGrant.
    let authorizedToolSession = null;
    let activeGrant = null;
    if (activeToolPolicy) {
      try {
        const grant = createToolGrant({
          run,
          skill: activeToolPolicy.skill,
          approvedCapabilities: activeToolPolicy.approvedCapabilities,
          actuators: activeToolPolicy.actuators,
        });
        authorizedToolSession = createAuthorizedToolSession({
          run, grant, budget: activeBudget, actuators: activeToolPolicy.actuators,
          onReceipt: ({ receipt, source, actuator }) => kernel.recordHostToolReceipt({
            workerRunId: run.id, generation: run.generation,
            grantDigest: grant.grantDigest, skillId: grant.skillId,
            skillVersion: grant.skillVersion, receipt, source,
            actuatorKind: receipt.status === "SUCCEEDED" && source &&
              isNetworkWebResearchActuator(actuator) ? "NETWORK_WEB_READ" : null,
          }),
        });
        activeGrant = grant;
        sessions.set(run.id, authorizedToolSession);
      } catch (error) {
        kernel.interruptWorkerRun({ workerRunId: run.id, generation: run.generation, reason: "WORKER_EXECUTION_FAILED" });
        report(run.id, run.generation, HOST_STATUS.INTERRUPTED, { reason: "WORKER_EXECUTION_FAILED", detail: "tool policy setup failed" });
        return;
      }
    }

    if (publicExecutions.size >= 256) publicExecutions.delete(publicExecutions.keys().next().value);
    publicExecutions.set(run.id, Object.freeze({
      workerRunId: run.id,
      skill: activeToolPolicy ? { id: activeToolPolicy.skill.skillId,
        version: activeToolPolicy.skill.version } : null,
      model: activation?.modelBackend ?? null,
      grantedTools: Object.freeze([...(activeGrant?.capabilities ?? [])]),
      budget: activeBudget ? { maxToolCalls: activeBudget.maxToolCalls,
        maxCallsByCapability: { ...activeBudget.maxCallsByCapability },
        maxElapsedMs: activeBudget.maxElapsedMs, toolTimeoutMs: activeBudget.toolTimeoutMs } : null,
      inputArtifacts: Object.freeze([...(run.workPacket.context?.inputArtifacts ?? [])]
        .slice(0, 8).map((artifact) => ({ artifactId: artifact.artifactId,
          title: artifact.title, digest: artifact.artifactDigest }))),
    }));

    let handle = null;
    try {
      handle = await activeAdapter.start(input, {
        binding,
        workspaceRoot: layout.workspaceRoot,
        scratchRoot: layout.scratchRoot,
        effectiveExecutionPolicy: effectivePolicy,
        ...(authorizedToolSession ? { authorizedToolSession } : {}),
      });
    } catch (error) {
      authorizedToolSession?.cancel();
      sessions.delete(run.id);
      kernel.interruptWorkerRun({
        workerRunId: run.id,
        generation: run.generation,
        reason: authorizedToolSession ? "WORKER_EXECUTION_FAILED" : "WORKER_PROCESS_EXIT",
      });
      report(run.id, run.generation, HOST_STATUS.START_FAILED, {
        detail: authorizedToolSession ? "generic worker start failed" : error?.message ?? String(error),
      });
      return;
    }
    handles.set(run.id, { adapter: activeAdapter, handle });

    // A stop can begin while this attempt is still starting: the adapter is
    // provisioning a workspace and has spawned nothing when the Host's stop
    // sweep runs. Ownership is completed here too, so a handle registered
    // after that sweep is cancelled by the executor that created it. The
    // handle is registered before this check and the check precedes the next
    // await, so neither order can leave an attempt unclaimed.
    if (stopped) {
      authorizedToolSession?.cancel();
      sessions.delete(run.id);
      await safeCancel(activeAdapter, handle, "HOST_STOPPING");
      handles.delete(run.id);
      report(run.id, run.generation, HOST_STATUS.CANCELLED, { reason: "HOST_STOPPING" });
      return;
    }

    const observed = [];
    let eventsError = null;
    let lastAdapterMeta = null;
    let modelReceiptAttempted = false;
    const persistModelExecution = () => {
      if (modelReceiptAttempted) return;
      modelReceiptAttempted = true;
      const observation = hostObservedModelExecution(activeAdapter, run.id);
      if (observation) kernel.recordHostModelExecution({ workerRunId: run.id,
        generation: run.generation, skillId: activeToolPolicy?.skill.skillId ?? "GenericModelWorker",
        skillVersion: activeToolPolicy?.skill.version ?? "v0", ...observation });
    };
    const drain = (async () => {
      try {
        for await (const raw of activeAdapter.events(handle)) {
          if (observed.length < MAX_OBSERVED_EVENTS) observed.push(normalizeWorkerEvent(raw));
        }
      } catch (error) {
        eventsError = error?.message ?? String(error);
      }
    })();

    // One report shape for every interrupted attempt: the Runtime records the
    // fact, the Host says what it observed. Nothing is written on the way.
    const interrupt = async (reason, detail = null, extra = null) => {
      try { persistModelExecution(); } catch { /* the attempt remains failed */ }
      authorizedToolSession?.cancel();
      await safeCancel(activeAdapter, handle, reason);
      kernel.interruptWorkerRun({ workerRunId: run.id, generation: run.generation, reason });
      await drain.catch(() => {});
      const proposedCode = extra?.failureCode ?? extra?.failureReason ?? reason;
      const failureCode = typeof proposedCode === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(proposedCode)
        ? proposedCode : reason;
      const evidence = buildHarnessEvidence({
        run,
        processOutcome: "INTERRUPTED",
        events: observed,
        resultParse: reason === "WORKER_OUTPUT_REJECTED" ? "PARSED_REJECTED" : "NOT_DELIVERED",
        containment: effectivePolicy,
        observedAt: now(),
        toolSessionEvidence: authorizedToolSession?.snapshot() ?? null,
        adapterExecution: lastAdapterMeta?.modelBackendType ? lastAdapterMeta : null,
        failureCode,
      });
      report(run.id, run.generation, HOST_STATUS.INTERRUPTED, {
        reason, detail, ...(extra ?? {}),
        evidenceDigest: evidence.evidenceDigest,
        evidence,
      });
    };

    // An invalid candidate is never delivered and never patched up: the attempt
    // ends through the Runtime's one interruption primitive, so the ordinary
    // continuation policy decides what may happen next.
    const refuseCandidate = (detail) => interrupt("WORKER_PROTOCOL_ERROR", detail);

    try {
      const settled = await waitWithHostTimeout(activeAdapter, handle);

      if (settled.kind === "TIMEOUT") {
        await interrupt("WORKER_TIMEOUT");
        return;
      }
      if (settled.kind === "PROTOCOL_ERROR") {
        await interrupt("WORKER_PROTOCOL_ERROR", settled.reason);
        return;
      }

      const adapterResult = settled.result;
      lastAdapterMeta = adapterResult.adapterMeta;
      if (adapterResult.terminalStatus === "CANCELLED") {
        // A cancelled execution writes nothing: an attempt nobody reported on
        // stays RUNNING in Runtime truth, and recovery owns its resolution.
        await drain.catch(() => {});
        report(run.id, run.generation, HOST_STATUS.CANCELLED, { reason: adapterResult.reason });
        return;
      }
      if (adapterResult.terminalStatus === "FAILED") {
        // Preserve the distinction between a process exit, an elapsed budget,
        // a non-process execution failure, an independent postcondition
        // rejection, and a malformed execution protocol.
        const failureReason = adapterResult.failureReason ?? null;
        if (failureReason === "PROCESS_EXIT") {
          await interrupt("WORKER_PROCESS_EXIT", adapterResult.reason ?? failureReason);
        } else if (failureReason === "TIMEOUT") {
          await interrupt("WORKER_TIMEOUT", adapterResult.reason ?? failureReason, {
            failureCode: adapterResult.adapterMeta?.failureCode ?? "WORKER_TIMEOUT",
          });
        } else if (failureReason === "EXECUTION_FAILED") {
          await interrupt("WORKER_EXECUTION_FAILED", adapterResult.reason ?? failureReason, {
            failureCode: adapterResult.adapterMeta?.failureCode ?? null,
          });
        } else if (HARNESS_REJECTION_REASONS.includes(failureReason)) {
          await interrupt("WORKER_OUTPUT_REJECTED", adapterResult.reason ?? failureReason, {
            failureReason,
          });
        } else {
          await interrupt("WORKER_PROTOCOL_ERROR", adapterResult.reason ?? failureReason, {
            failureCode: adapterResult.adapterMeta?.failureCode ?? "WORKER_PROTOCOL_ERROR",
          });
        }
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
        const resultDigest = workerReviewResultDigest(judgment);
        const evidence = buildHarnessEvidence({
          run,
          processOutcome: "SUCCEEDED",
          events: observed,
          resultParse: "PARSED",
          reportedVerification: null,
          containment: effectivePolicy,
          observedAt: now(),
          toolSessionEvidence: authorizedToolSession?.snapshot() ?? null,
          adapterExecution: adapterResult.adapterMeta?.modelBackendType ? adapterResult.adapterMeta : null,
          resultDigest,
        });

        try { persistModelExecution(); }
        catch { await interrupt("WORKER_EXECUTION_FAILED", "model provenance persistence failed", {
          failureCode: "MODEL_EVIDENCE_PERSIST_FAILED" }); return; }

        try {
          const delivered = kernel.submitWorkerReviewResult({
            workerRunId: run.id,
            generation: run.generation,
            resultDigest,
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

      // A validated result that reports failure is an execution without a
      // deliverable output, not evidence of a process exit.
      if (result.outcome !== "SUCCEEDED") {
        await interrupt("WORKER_EXECUTION_FAILED", "the Worker reported FAILED rather than a successful result");
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
      if (activeArtifactPostcondition) {
        let check;
        try {
          check = await activeArtifactPostcondition({
            run,
            result,
            proposedArtifact: proposed,
            observedSources: Object.freeze([...(authorizedToolSession?.snapshot().sources ?? [])]),
          });
        } catch {
          await interrupt("WORKER_OUTPUT_REJECTED", "artifact postcondition failed", {
            failureCode: "ARTIFACT_POSTCONDITION_FAILED",
          });
          return;
        }
        if (!check || check.ok !== true) {
          await interrupt("WORKER_OUTPUT_REJECTED", "artifact postcondition rejected the output", {
            failureCode: typeof check?.code === "string" ? check.code : "ARTIFACT_POSTCONDITION_FAILED",
          });
          return;
        }
      }
      const artifact = {
        kind: proposed.kind,
        title: proposed.title,
        content: proposed.content,
        supersedesArtifactId:
          proposed.supersedesArtifactId ?? run.workPacket.repair?.targetArtifact?.id ?? null,
      };

      await drain.catch(() => {});
      const resultDigest = workerResultDigest(result);
      const evidence = buildHarnessEvidence({
        run,
        processOutcome: "SUCCEEDED",
        events: observed,
        resultParse: "PARSED",
        reportedVerification: result.reportedVerification,
        containment: effectivePolicy,
        observedAt: now(),
        toolSessionEvidence: authorizedToolSession?.snapshot() ?? null,
        adapterExecution: adapterResult.adapterMeta?.modelBackendType ? adapterResult.adapterMeta : null,
        resultDigest,
      });

      try { persistModelExecution(); }
      catch { await interrupt("WORKER_EXECUTION_FAILED", "model provenance persistence failed", {
        failureCode: "MODEL_EVIDENCE_PERSIST_FAILED" }); return; }

      try {
        const delivered = kernel.submitWorkerResult({
          workerRunId: run.id,
          generation: run.generation,
          resultDigest,
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
      authorizedToolSession?.cancel();
      sessions.delete(run.id);
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
      // Ownership stays here: the Host cancels every attempt it is holding,
      // in parallel, and waits for each adapter to confirm that its child is
      // gone. A stopping Host therefore leaves no execution running behind it,
      // and the Desktop never has to look for processes to kill.
      for (const session of sessions.values()) session.cancel();
      await Promise.all([...handles.values()].map(({ adapter: activeAdapter, handle }) => safeCancel(activeAdapter, handle, "HOST_STOPPING")));
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
    publicRunEvidence(workerRunId) {
      const execution = publicExecutions.get(workerRunId);
      if (!execution) return null;
      const terminal = [...reports].reverse().find((entry) => entry.workerRunId === workerRunId &&
        entry.detail?.evidence?.toolSession);
      const snapshot = sessions.get(workerRunId)?.snapshot() ?? terminal?.detail?.evidence?.toolSession ?? null;
      const modelExecution = terminal?.detail?.evidence?.modelExecution ?? null;
      return {
        ...execution,
        terminal: terminal ? {
          status: terminal.status,
          reason: terminal.detail?.reason ?? null,
          failureCode: terminal.detail?.evidence?.failureCode ?? null,
          diagnostic: ["unknown model step type", "malformed FINAL_RESULT", "malformed TOOL_REQUEST",
            "model step is not a bounded object"].includes(terminal.detail?.detail)
            ? terminal.detail.detail : null,
        } : null,
        model: execution.model ?? (modelExecution ? {
          backendType: modelExecution.backendType,
          backendVersion: modelExecution.backendVersion,
        } : null),
        receipts: (snapshot?.receipts ?? []).slice(0, 33).map((receipt) => ({
          callId: receipt.callId, capability: receipt.capability, status: receipt.status,
          inputDigest: receipt.inputDigest, outputDigest: receipt.outputDigest,
          durationMs: receipt.durationMs, sourceId: receipt.sourceId ?? null,
        })),
        sources: (snapshot?.sources ?? []).slice(0, 32).map((source) => ({
          sourceId: source.sourceId, receiptCallId: source.receiptCallId,
          safeUrl: source.safeUrl, canonicalUrlDigest: source.canonicalUrlDigest,
          contentDigest: source.contentDigest, observedAt: source.observedAt,
        })),
      };
    },
    leaseState(workerRunId) {
      const run = kernel.workerRun(workerRunId);
      return run ? leaseStateForRun(run.state) : null;
    },
  });
}

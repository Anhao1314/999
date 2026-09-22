// The Continuation Driver: the actuator that closes the coordination gap.
// Contract: docs/contracts/work-continuity-v0.md §1, §3, §6, §8, §12.
//
//   Founder 组建团队，FlowCredit 调度团队.
//
// The Driver is not a scheduler. It has no clock, no queue, no ordering policy
// and no notion of "later": it runs when the Runtime tells it something already
// committed changed, and it stops the moment no single legal action is
// deterministically available. It holds *no* truth of its own — every step
// re-reads Runtime truth, and the only thing it writes is an observability
// trace, after the business transaction it describes has already committed.
import { AVAILABILITY } from "../workforce/employees.mjs";
import {
  ACTION_RESULTS,
  CONTINUATION_ACTIONS,
  CONTINUATION_ASSIGNMENT_REASON,
  CONTINUATION_DIAGNOSTICS,
  CONTINUATION_POLICY_VERSION,
  CONTINUATION_REDISPATCH_REASON,
  MAX_CONTINUATION_STEPS,
  TRIGGER_TYPES,
  buildDecisionState,
  decisionStateDigest,
  deriveProgressBoundary,
} from "../work/continuation.mjs";
import { isKernelError } from "./errors.mjs";
import { deterministicNextActionProposer } from "../planning/next-action.mjs";

// A wake loop can only be re-entered by the commands it itself runs; this fuse
// bounds that, exactly as MAX_CONTINUATION_STEPS bounds one drive.
export const MAX_WAKE_ROUNDS = 64;

function readWorkTruth(kernel, workId) {
  const work = kernel.work(workId);
  if (!work) return null;
  const projection = kernel.workProjection(workId);
  const tasks = kernel.tasks(workId);
  const employees = kernel.employees(work.companyId);
  const positions = kernel.positions(work.companyId);
  const requirementsByTask = new Map();
  const assignmentsByTask = new Map();
  for (const task of tasks) {
    const requirements = kernel.taskRequirements(task.id);
    if (requirements) requirementsByTask.set(task.id, requirements);
    const assignment = kernel.assignment(task.id);
    if (assignment) assignmentsByTask.set(task.id, assignment);
  }
  const artifactById = new Map(projection.artifacts.map((artifact) => [artifact.id, artifact]));
  const reviewProducerByTask = new Map();
  for (const request of projection.reviewRequests) {
    const artifact = artifactById.get(request.targetArtifactId);
    const run = artifact?.workerRunId ? kernel.workerRun(artifact.workerRunId) : null;
    if (run) reviewProducerByTask.set(request.reviewTaskId, run.employeeId);
  }
  return {
    work,
    projection,
    tasks,
    employees,
    positions,
    requirementsByTask,
    assignmentsByTask,
    reviewRequests: projection.reviewRequests,
    reviews: projection.reviews,
    repairBindings: projection.repairBindings,
    reviewProducerByTask,
    // Availability is the same derivation the rest of the Runtime uses: an
    // Employee is BUSY exactly while they hold a RUNNING WorkerRun.
    activeEmployeeIds: employees
      .filter((employee) => employee.availability === AVAILABILITY.BUSY)
      .map((employee) => employee.id),
    basis: projection.decisionBasis,
    decision: projection.outcome.accepted ?? null,
  };
}

function boundaryOf(truth) {
  return deriveProgressBoundary({
    work: truth.work,
    decision: truth.decision,
    tasks: truth.tasks,
    requirementsByTask: truth.requirementsByTask,
    assignmentsByTask: truth.assignmentsByTask,
    reviewRequests: truth.reviewRequests,
    reviews: truth.reviews,
    repairBindings: truth.repairBindings,
    employees: truth.employees,
    positions: truth.positions,
    activeEmployeeIds: truth.activeEmployeeIds,
    reviewProducerByTask: truth.reviewProducerByTask,
  });
}

export function createContinuationDriver({
  kernel,
  proposer = deterministicNextActionProposer(),
  maxSteps = MAX_CONTINUATION_STEPS,
  observe = true,
} = {}) {
  if (!kernel) throw new Error("createContinuationDriver requires a kernel");
  if (!proposer || typeof proposer.propose !== "function")
    throw new Error("createContinuationDriver requires a NextActionProposer");

  const pendingCompanies = new Set();
  const pendingWorks = new Set();
  // True while a drive or a drain owns the loop. Everything the commands of
  // that drive wake is queued and processed by the loop that is already running.
  let driving = false;

  // Traces are observability, never truth: a trace write failure is logged and
  // the Driver carries on. It may never invalidate a committed mutation, and
  // nothing reads a trace to decide anything.
  function trace(entry) {
    try {
      kernel.recordContinuationTrace({
        companyId: entry.companyId,
        workId: entry.workId,
        step: entry.step,
        triggerType: entry.triggerType,
        basisBefore: entry.basisBefore ?? null,
        basisAfter: entry.basisAfter ?? null,
        decisionState: entry.decisionState ?? null,
        decisionStateDigest: entry.decisionStateDigest ?? null,
        policyVersion: CONTINUATION_POLICY_VERSION,
        reasonCodes: entry.reasonCodes ?? [],
        diagnosticCode: entry.diagnosticCode ?? null,
        actionCommand: entry.actionCommand ?? null,
        actionTargetId: entry.actionTargetId ?? null,
        actionResult: entry.actionResult,
        actionErrorCode: entry.actionErrorCode ?? null,
      });
    } catch (error) {
      process.stderr.write(`continuation trace append failed: ${error?.message ?? error}\n`);
    }
  }

  // Exactly one Runtime command per call, and nothing else: the Driver never
  // writes store rows.
  function runAction(boundary, truth) {
    const action = boundary.action;
    try {
      if (action.command === CONTINUATION_ACTIONS.MATERIALIZE) {
        const proposal = proposer.propose({
          work: truth.work,
          basis: truth.basis,
          tasks: truth.tasks,
        });
        if (!proposal)
          return {
            result: ACTION_RESULTS.SKIPPED,
            diagnostic: {
              code: CONTINUATION_DIAGNOSTICS.PLANNING_EXHAUSTED,
              reason: "the proposer returned no proposal for an unactivated Work",
            },
          };
        const materialized = kernel.materializeNextAction({
          workId: truth.work.id,
          expectedBasis: truth.basis,
          proposal,
        });
        return { result: ACTION_RESULTS.EXECUTED, targetId: materialized.task.id };
      }
      if (action.command === CONTINUATION_ACTIONS.ASSIGN) {
        const assignment = kernel.assignTask({
          taskId: action.taskId,
          employeeId: action.employeeId,
          reason:
            boundary.boundary === "INTERRUPTED"
              ? CONTINUATION_REDISPATCH_REASON
              : CONTINUATION_ASSIGNMENT_REASON,
        });
        return { result: ACTION_RESULTS.EXECUTED, targetId: assignment.id };
      }
      if (action.command === CONTINUATION_ACTIONS.START) {
        const started = kernel.startWorkerRun({ taskId: action.taskId });
        return { result: ACTION_RESULTS.EXECUTED, targetId: started.workerRun.id };
      }
      if (action.command === CONTINUATION_ACTIONS.CREATE_REPAIR) {
        const created = kernel.createRepairTask({ reviewId: action.reviewId });
        return { result: ACTION_RESULTS.EXECUTED, targetId: created.task.id };
      }
      return {
        result: ACTION_RESULTS.SKIPPED,
        diagnostic: {
          code: CONTINUATION_DIAGNOSTICS.PLANNING_EXHAUSTED,
          reason: `the policy named an action this Runtime has no command for: ${action.command}`,
        },
      };
    } catch (error) {
      if (!isKernelError(error)) throw error;
      // Benign convergence, not a failed attempt: another attempt already
      // materialized the initial Task. It consumes no planning retry.
      if (error.code === "WORK_ALREADY_ACTIVATED")
        return { result: ACTION_RESULTS.NO_OP, reason: "ALREADY_CONVERGED", errorCode: error.code };
      if (error.code === "STALE_CONTINUATION_BASIS")
        return { result: ACTION_RESULTS.STALE, errorCode: error.code, message: error.message };
      return { result: ACTION_RESULTS.REFUSED, errorCode: error.code, message: error.message };
    }
  }

  // One drive: read, derive, act once, re-read. Never two mutations against
  // one snapshot — every iteration starts from fresh truth.
  function runDrive(workId, { triggerType, steps }) {
    const summary = {
      workId,
      triggerType,
      steps: 0,
      boundary: null,
      diagnostic: null,
      stopped: "NONE",
    };
    for (let step = 1; step <= steps; step += 1) {
      const truth = readWorkTruth(kernel, workId);
      if (!truth) {
        summary.stopped = "WORK_NOT_FOUND";
        return summary;
      }
      const boundary = boundaryOf(truth);
      summary.boundary = boundary.boundary;
      const decisionState = buildDecisionState({
        work: truth.work,
        tasks: truth.tasks,
        boundary,
        basis: truth.basis,
        candidates: boundary.candidates,
      });
      const digest = decisionStateDigest(decisionState);

      if (!boundary.action) {
        summary.diagnostic = boundary.diagnostic ?? null;
        summary.stopped = boundary.diagnostic ? "DIAGNOSTIC" : "BOUNDARY";
        // A boundary that simply says "nothing to do" (accepted, cancelled,
        // running, waiting on the Founder) is not a continuation decision, so
        // it is not traced. A boundary that stopped because something is
        // missing is.
        if (boundary.diagnostic)
          trace({
            companyId: truth.work.companyId,
            workId,
            step,
            triggerType,
            basisBefore: truth.basis,
            basisAfter: truth.basis,
            decisionState,
            decisionStateDigest: digest,
            actionResult: ACTION_RESULTS.DIAGNOSTIC,
            diagnosticCode: boundary.diagnostic.code,
            reasonCodes: [boundary.diagnostic.code],
          });
        return summary;
      }

      const outcome = runAction(boundary, truth);
      const after = readWorkTruth(kernel, workId);
      trace({
        companyId: truth.work.companyId,
        workId,
        step,
        triggerType,
        basisBefore: truth.basis,
        basisAfter: after?.basis ?? null,
        decisionState,
        decisionStateDigest: digest,
        actionCommand: boundary.action.command,
        actionTargetId: outcome.targetId ?? null,
        actionResult: outcome.result,
        actionErrorCode: outcome.errorCode ?? null,
        diagnosticCode: outcome.diagnostic?.code ?? null,
        reasonCodes: [outcome.reason ?? outcome.errorCode ?? boundary.boundary],
      });

      if (outcome.result === ACTION_RESULTS.EXECUTED) {
        summary.steps += 1;
        continue;
      }
      // Convergence: the Work already carries its initial Task. Re-read and
      // continue from that Task rather than treating a lost response as a
      // failure to plan.
      if (outcome.result === ACTION_RESULTS.NO_OP) continue;
      summary.stopped = outcome.result;
      summary.diagnostic = outcome.diagnostic ?? null;
      return summary;
    }

    const truth = readWorkTruth(kernel, workId);
    trace({
      companyId: truth?.work.companyId ?? null,
      workId,
      step: steps,
      triggerType,
      basisBefore: truth?.basis ?? null,
      basisAfter: truth?.basis ?? null,
      actionResult: ACTION_RESULTS.DIAGNOSTIC,
      diagnosticCode: CONTINUATION_DIAGNOSTICS.CONTINUATION_LIMIT_REACHED,
      reasonCodes: [CONTINUATION_DIAGNOSTICS.CONTINUATION_LIMIT_REACHED],
    });
    summary.stopped = "LIMIT";
    summary.diagnostic = {
      code: CONTINUATION_DIAGNOSTICS.CONTINUATION_LIMIT_REACHED,
      reason: `the drive stopped at its ${steps}-step safety fuse`,
    };
    return summary;
  }

  // Re-evaluate every Work whose continuation may have changed, in rounds, so
  // that a wake raised by one of these drives is itself processed. No
  // optimization: a Work with nothing to do stops immediately without a trace.
  function drainPending() {
    for (let round = 0; round < MAX_WAKE_ROUNDS; round += 1) {
      if (pendingCompanies.size > 0) {
        const companies = [...pendingCompanies];
        pendingCompanies.clear();
        for (const companyId of companies)
          for (const work of kernel.works(companyId)) pendingWorks.add(work.id);
      }
      if (pendingWorks.size === 0) return;
      const workIds = [...pendingWorks];
      pendingWorks.clear();
      for (const workId of workIds)
        runDrive(workId, { triggerType: TRIGGER_TYPES.WAKE, steps: maxSteps });
    }
  }

  function drain() {
    if (driving) return;
    driving = true;
    try {
      drainPending();
    } finally {
      driving = false;
    }
  }

  // Internal: the Kernel's post-commit seam calls this. It carries no truth —
  // it only says which Work (or which Company) deserves another look.
  function notify(signal) {
    if (signal?.workId) pendingWorks.add(signal.workId);
    if (signal?.companyId && !signal.workId) pendingCompanies.add(signal.companyId);
    drain();
  }

  // The public seam. A drive asked for while another drive is running is
  // deferred to the loop that already owns this Work: no nested drive ever
  // acts on a snapshot its parent is still holding.
  function driveWork(workId, { triggerType = TRIGGER_TYPES.EXPLICIT, steps = maxSteps } = {}) {
    if (driving) {
      pendingWorks.add(workId);
      return {
        workId,
        triggerType,
        steps: 0,
        boundary: null,
        diagnostic: null,
        stopped: "DEFERRED",
      };
    }
    driving = true;
    try {
      const summary = runDrive(workId, { triggerType, steps });
      drainPending();
      return summary;
    } finally {
      driving = false;
    }
  }

  // The startup seam: after recover(), the host drives every non-terminal Work
  // once. Terminal Works stop immediately and are never traced.
  function driveAll({ triggerType = TRIGGER_TYPES.STARTUP } = {}) {
    for (const company of kernel.companies())
      for (const work of kernel.works(company.id)) pendingWorks.add(work.id);
    drain();
    return { triggerType };
  }

  // `observe` is the host's composition choice, not a Runtime mode: with the
  // observer installed the Driver also runs on every committed change; without
  // it, it runs only when someone asks it to. `driveWork` behaves identically
  // either way — its loop always re-reads truth for itself.
  if (observe) kernel.setContinuationObserver(notify);

  return {
    driveWork,
    driveAll,
    detach() {
      kernel.setContinuationObserver(null);
    },
  };
}

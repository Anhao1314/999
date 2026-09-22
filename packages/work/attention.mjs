// Founder Attention projection (pure).
// Contract: docs/contracts/founder-attention-acceptance-v0.md §11–§15.
//
// The question this file answers is not "is something unfinished?" but:
//
//   Can this Work continue correctly without Founder intervention
//   under the Runtime that exists today?
//
// A condition becomes Founder Attention only when BOTH hold: no autonomous
// continuation path exists, and an existing legal command actually resolves or
// meaningfully advances the condition. A legal command is not automatically a
// valid exit. Everything else is a diagnostic: visible in the Work projection,
// never manufactured into an actionable item.
//
// Nothing here is stored, and nothing here mutates.
import { classifyEmployeeCandidates } from "../workforce/eligibility.mjs";
import { deriveWorkforceDispatch } from "../workforce/dispatch.mjs";
import { satisfiesCapabilities } from "../workforce/capabilities.mjs";
import { MAX_AUTONOMOUS_ATTEMPTS_PER_TASK } from "./continuation.mjs";
import { OUTCOME_STATES } from "./outcome.mjs";

export const ATTENTION_KINDS = Object.freeze({
  EXECUTION_INTERRUPTED: "EXECUTION_INTERRUPTED",
  REPAIR_UNASSIGNABLE: "REPAIR_UNASSIGNABLE",
  DECISION_REQUIRED: "DECISION_REQUIRED",
});

export const ATTENTION_DIAGNOSTICS = Object.freeze({
  COLLABORATION_BLOCKED: "COLLABORATION_BLOCKED",
  CAPABILITY_GAP: "CAPABILITY_GAP",
  NO_DISPATCHABLE_EMPLOYEE: "NO_DISPATCHABLE_EMPLOYEE",
  OUTCOME_AMBIGUOUS: "OUTCOME_AMBIGUOUS",
  NO_CANDIDATE: "NO_CANDIDATE",
  AUTO_RETRY_EXHAUSTED: "AUTO_RETRY_EXHAUSTED",
});

export const ATTENTION_ACTIONS = Object.freeze({
  ACCEPT: "ACCEPT",
  RESUME_EXECUTION: "RESUME_EXECUTION",
  ASSIGN_EMPLOYEE: "ASSIGN_EMPLOYEE",
  ENABLE_EMPLOYEE: "ENABLE_EMPLOYEE",
  ABANDON_TASK: "ABANDON_TASK",
});

export const ACTION_EFFECTS = Object.freeze({
  RESOLVES: "RESOLVES",
  ADVANCES: "ADVANCES",
});

// Precedence: the moment that most needs a human, first. Interruption outranks
// everything for the same reason v0A's Work status ranks it first: the Work
// stopped against our will.
const KIND_RANK = Object.freeze({
  [ATTENTION_KINDS.EXECUTION_INTERRUPTED]: 1,
  [ATTENTION_KINDS.REPAIR_UNASSIGNABLE]: 2,
  [ATTENTION_KINDS.DECISION_REQUIRED]: 3,
});

export const TASK_ROLES = Object.freeze({
  EXECUTION: "execution",
  REVIEW: "review",
  REPAIR: "repair",
});

const action = (kind, effect, detail = {}) => ({ kind, effect, ...detail });

export function attentionItemId(kind, workId) {
  return `att:${kind}:${workId}`;
}

export function deriveWorkAttention({
  work,
  status,
  tasks = [],
  reviewRequests = [],
  repairBindings = [],
  outcome,
  decision = null,
  employees = [],
  positions = [],
  requirementsByTask = new Map(),
  assignmentsByTask = new Map(),
  reviewProducerByTask = new Map(),
  activeEmployeeIds = [],
  attemptsByTask = new Map(),
  decisionBasis = null,
} = {}) {
  const reviewTaskIds = new Set(reviewRequests.map((request) => request.reviewTaskId));
  const repairTaskIds = new Set(repairBindings.map((binding) => binding.repairTaskId));
  const employeesById = new Map(employees.map((employee) => [employee.id, employee]));
  const positionsById = new Map(positions.map((position) => [position.id, position]));
  const conditions = [];
  const diagnostics = [];
  const candidates = [];

  const roleOf = (task) =>
    reviewTaskIds.has(task.id)
      ? TASK_ROLES.REVIEW
      : repairTaskIds.has(task.id)
        ? TASK_ROLES.REPAIR
        : TASK_ROLES.EXECUTION;

  const continuationFor = (task) => {
    const requirements = requirementsByTask.get(task.id)?.requiredCapabilities ?? [];
    const assignment = assignmentsByTask.get(task.id) ?? null;
    const assigned = assignment ? employeesById.get(assignment.employeeId) ?? null : null;
    const assignedPosition = assigned ? positionsById.get(assigned.positionId) ?? null : null;
    // A reviewer is never a candidate for the Artifact they produced, so the
    // producer is excluded from every continuation this Task can derive.
    const producerEmployeeId = reviewProducerByTask.get(task.id) ?? null;
    const assignedValid = Boolean(
      assigned &&
        assigned.enabled &&
        assignedPosition &&
        satisfiesCapabilities(requirements, assignedPosition.capabilities) &&
        assigned.id !== producerEmployeeId,
    );
    const workforce = classifyEmployeeCandidates({
      employees,
      positions,
      requiredCapabilities: requirements,
    });
    const dispatch = deriveWorkforceDispatch({
      employees,
      positions,
      requiredCapabilities: requirements,
      activeEmployeeIds,
      excludeEmployeeIds: producerEmployeeId ? [producerEmployeeId] : [],
    });
    const assignedDispatchable = Boolean(
      assigned && dispatch.dispatchable.some((entry) => entry.employee.id === assigned.id),
    );
    return { requirements, assignment, assignedValid, assignedDispatchable, workforce, dispatch };
  };

  // --- 1. EXECUTION_INTERRUPTED ---------------------------------------------
  //
  // v0B4 narrowed this: the Runtime continues an interrupted attempt whenever
  // it deterministically can, so only a condition the Runtime refuses to
  // resolve reaches the Founder (contract §11). Trace history plays no part —
  // everything below is current truth and nothing else.
  const interrupted = tasks.filter((task) => task.state === "INTERRUPTED");
  if (interrupted.length > 0) {
    const actions = [];
    const interruptedTasks = [];
    const contendedTaskIds = [];
    const capabilityGapTaskIds = [];
    const exhaustedTaskIds = [];
    let needsFounder = false;
    for (const task of interrupted) {
      const role = roleOf(task);
      const { assignedValid, assignedDispatchable, dispatch } = continuationFor(task);
      const dispatchable = dispatch.dispatchable;
      // The autonomous attempt budget, read from durable WorkerRun history.
      const attempts = attemptsByTask.get(task.id) ?? 0;
      const exhausted = attempts >= MAX_AUTONOMOUS_ATTEMPTS_PER_TASK;
      if (exhausted) exhaustedTaskIds.push(task.id);
      // Two deterministic continuations belong to the Runtime, not the Founder:
      // resume the usable Assignment, or hand the Task to the one Employee who
      // can take it. Neither becomes an Inbox item — and neither does an
      // Employee being busy, which clears itself when a WorkerRun ends. Once
      // the attempt budget is spent there is no autonomous continuation left,
      // so even these become Founder questions.
      if (!exhausted) {
        if (assignedValid && assignedDispatchable) continue;
        if (!assignedValid && dispatchable.length === 1) continue;
      }

      const taskActions = [];
      let founderAction = null;
      if (exhausted && assignedValid && assignedDispatchable) {
        // The Runtime will not restart this attempt again; only an explicit
        // Founder resume can, and it is the ordinary start command.
        founderAction = action(ATTENTION_ACTIONS.RESUME_EXECUTION, ACTION_EFFECTS.RESOLVES, {
          taskId: task.id,
        });
      } else if (dispatchable.length > 1) {
        // More than one Employee could take it and this Runtime never picks.
        // Assigning is only a resolution while the Runtime may still start the
        // Task itself; after exhaustion it merely advances the choice.
        founderAction = action(
          ATTENTION_ACTIONS.ASSIGN_EMPLOYEE,
          exhausted ? ACTION_EFFECTS.ADVANCES : ACTION_EFFECTS.RESOLVES,
          {
            taskId: task.id,
            dispatchableEmployeeIds: dispatchable.map((entry) => entry.employee.id),
          },
        );
      } else if (dispatch.eligible.length === 0 && dispatch.disabledCapable.length > 0) {
        founderAction = action(ATTENTION_ACTIONS.ENABLE_EMPLOYEE, ACTION_EFFECTS.ADVANCES, {
          taskId: task.id,
        });
      } else if (exhausted && !assignedValid && dispatchable.length === 1) {
        // Exactly one Employee could take it, but after exhaustion the Runtime
        // no longer reassigns by itself: the Founder does it, then resumes.
        founderAction = action(ATTENTION_ACTIONS.ASSIGN_EMPLOYEE, ACTION_EFFECTS.ADVANCES, {
          taskId: task.id,
          dispatchableEmployeeIds: dispatchable.map((entry) => entry.employee.id),
        });
      } else if (dispatch.eligible.length > 0 || assignedValid) {
        // Eligible, but nothing is dispatchable: contention clears itself when
        // a WorkerRun ends, so it is a diagnostic and never an Inbox item.
        contendedTaskIds.push(task.id);
      } else {
        capabilityGapTaskIds.push(task.id);
      }
      if (founderAction) taskActions.push(founderAction);
      // Cancelling an interrupted Review or Repair Task would leave an
      // obligation nothing can ever satisfy, so abandoning is offered only for
      // an execution Task — and only when this Task genuinely needs a choice.
      if (
        role === TASK_ROLES.EXECUTION &&
        (founderAction !== null || capabilityGapTaskIds.at(-1) === task.id)
      )
        taskActions.push(
          action(ATTENTION_ACTIONS.ABANDON_TASK, ACTION_EFFECTS.RESOLVES, { taskId: task.id }),
        );
      if (taskActions.length > 0) {
        needsFounder = true;
        actions.push(...taskActions);
      }
      interruptedTasks.push({
        taskId: task.id,
        title: task.title,
        role,
        generation: task.generation,
        resumeWithoutFounder: !exhausted && assignedValid && assignedDispatchable,
        attempts,
        automaticRetryExhausted: exhausted,
        dispatchableEmployeeIds: dispatchable.map((entry) => entry.employee.id),
      });
    }
    // The condition is reported only when it is actually unresolved: a
    // deterministically resumable interruption must leave this section silent.
    if (needsFounder || contendedTaskIds.length > 0 || capabilityGapTaskIds.length > 0)
      conditions.push(ATTENTION_KINDS.EXECUTION_INTERRUPTED);
    // Exhaustion is its own reason, stated in the item's conditions and in the
    // projection: the Work did not stall by accident, its budget was spent.
    if (exhaustedTaskIds.length > 0) {
      conditions.push(ATTENTION_DIAGNOSTICS.AUTO_RETRY_EXHAUSTED);
      diagnostics.push({
        code: ATTENTION_DIAGNOSTICS.AUTO_RETRY_EXHAUSTED,
        reason: `every autonomous continuation this Runtime allows was used (${MAX_AUTONOMOUS_ATTEMPTS_PER_TASK} attempts per Task); another attempt is a Founder decision`,
        evidence: {
          interruptedTaskIds: exhaustedTaskIds,
          maxAutonomousAttempts: MAX_AUTONOMOUS_ATTEMPTS_PER_TASK,
        },
      });
    }
    if (needsFounder)
      candidates.push({
        kind: ATTENTION_KINDS.EXECUTION_INTERRUPTED,
        evidence: { interruptedTasks },
        actions,
      });
    if (contendedTaskIds.length > 0)
      diagnostics.push({
        code: ATTENTION_DIAGNOSTICS.NO_DISPATCHABLE_EMPLOYEE,
        reason:
          "every Employee who can do this work is already executing something; availability clears this, not the Founder",
        evidence: { interruptedTaskIds: contendedTaskIds },
      });
    if (capabilityGapTaskIds.length > 0)
      diagnostics.push({
        code: ATTENTION_DIAGNOSTICS.CAPABILITY_GAP,
        reason:
          "no existing Employee satisfies the requirements of an interrupted Task, so the Work cannot continue",
        evidence: { interruptedTaskIds: capabilityGapTaskIds },
      });
  }

  // --- 2. REPAIR_UNASSIGNABLE ------------------------------------------------
  const openRepairTasks = tasks.filter(
    (task) => task.state === "OPEN" && repairTaskIds.has(task.id),
  );
  if (openRepairTasks.length > 0) {
    const actions = [];
    const unassignable = [];
    let sawCapabilityGap = false;
    for (const task of openRepairTasks) {
      const { requirements, assignedValid, workforce } = continuationFor(task);
      if (assignedValid) continue; // already has a valid path; merely not started
      if (workforce.eligible.length > 0)
        actions.push(action(ATTENTION_ACTIONS.ASSIGN_EMPLOYEE, ACTION_EFFECTS.RESOLVES, { taskId: task.id }));
      else if (workforce.disabledCapable.length > 0)
        actions.push(action(ATTENTION_ACTIONS.ENABLE_EMPLOYEE, ACTION_EFFECTS.ADVANCES, { taskId: task.id }));
      else sawCapabilityGap = true;
      unassignable.push({
        taskId: task.id,
        title: task.title,
        requiredCapabilities: requirements,
        eligibleEmployeeIds: workforce.eligible.map((candidate) => candidate.employee.id),
        disabledCandidateIds: workforce.disabledCapable.map((candidate) => candidate.employee.id),
      });
    }
    if (unassignable.length > 0) conditions.push(ATTENTION_KINDS.REPAIR_UNASSIGNABLE);
    if (actions.length > 0)
      candidates.push({
        kind: ATTENTION_KINDS.REPAIR_UNASSIGNABLE,
        evidence: { unassignableRepairTasks: unassignable },
        actions,
      });
    if (sawCapabilityGap)
      diagnostics.push({
        code: ATTENTION_DIAGNOSTICS.CAPABILITY_GAP,
        reason:
          "no existing Employee can satisfy the requirements of an unassigned Repair Task",
        evidence: { repairTaskIds: unassignable.map((entry) => entry.taskId) },
      });
  }

  // --- 3. DECISION_REQUIRED --------------------------------------------------
  if (status === "READY_FOR_DECISION" && !decision) {
    if (outcome?.state === OUTCOME_STATES.READY) {
      conditions.push(ATTENTION_KINDS.DECISION_REQUIRED);
      const candidate = outcome.candidateArtifacts[0];
      candidates.push({
        kind: ATTENTION_KINDS.DECISION_REQUIRED,
        evidence: {
          candidateArtifacts: outcome.candidateArtifacts,
          decisionBasis,
        },
        actions: [
          action(ATTENTION_ACTIONS.ACCEPT, ACTION_EFFECTS.RESOLVES, {
            artifactId: candidate.id,
            artifactDigest: candidate.digest,
            basis: decisionBasis,
          }),
        ],
      });
    } else if (outcome?.state === OUTCOME_STATES.AMBIGUOUS) {
      conditions.push(ATTENTION_DIAGNOSTICS.OUTCOME_AMBIGUOUS);
      diagnostics.push({
        code: ATTENTION_DIAGNOSTICS.OUTCOME_AMBIGUOUS,
        reason:
          "the Work has more than one current outcome candidate, and v0B3 has no way to choose between them",
        evidence: { candidateArtifactIds: outcome.candidateArtifacts.map((entry) => entry.id) },
      });
    } else if (outcome?.state === OUTCOME_STATES.NO_CANDIDATE) {
      conditions.push(ATTENTION_DIAGNOSTICS.NO_CANDIDATE);
      diagnostics.push({
        code: ATTENTION_DIAGNOSTICS.NO_CANDIDATE,
        reason: "the Work is ready for a decision but has no current outcome candidate",
        evidence: {},
      });
    }
  }

  // --- permanent collaboration block ----------------------------------------
  if (status === "BLOCKED") {
    const cancelledReviewRequests = reviewRequests.filter((request) => {
      const reviewTask = tasks.find((task) => task.id === request.reviewTaskId);
      return reviewTask?.state === "CANCELLED" && !decision;
    });
    const cancelledRepairs = repairBindings.filter((binding) => {
      const repairTask = tasks.find((task) => task.id === binding.repairTaskId);
      return repairTask?.state === "CANCELLED";
    });
    if (cancelledReviewRequests.length > 0 || cancelledRepairs.length > 0) {
      conditions.push(ATTENTION_DIAGNOSTICS.COLLABORATION_BLOCKED);
      diagnostics.push({
        code: ATTENTION_DIAGNOSTICS.COLLABORATION_BLOCKED,
        reason:
          "a cancelled Review or Repair left an obligation nothing in this Runtime can ever satisfy",
        evidence: {
          cancelledReviewTaskIds: cancelledReviewRequests.map((request) => request.reviewTaskId),
          cancelledRepairTaskIds: cancelledRepairs.map((binding) => binding.repairTaskId),
        },
      });
    }
  }

  const chosen = candidates.find((entry) => entry.actions.length > 0) ?? null;
  const item = chosen
    ? {
        id: attentionItemId(chosen.kind, work.id),
        kind: chosen.kind,
        companyId: work.companyId,
        workId: work.id,
        work: { id: work.id, title: work.title, intent: work.intent },
        summary: SUMMARY[chosen.kind],
        conditions: [...conditions],
        evidence: chosen.evidence,
        actions: chosen.actions,
        ...(chosen.kind === ATTENTION_KINDS.DECISION_REQUIRED ? { decisionBasis } : {}),
      }
    : null;

  return { item, conditions, diagnostics };
}

const SUMMARY = Object.freeze({
  [ATTENTION_KINDS.EXECUTION_INTERRUPTED]:
    "Execution was interrupted, and this Runtime cannot continue it without a Founder choice.",
  [ATTENTION_KINDS.REPAIR_UNASSIGNABLE]:
    "A Repair exists that nobody can currently be assigned to.",
  [ATTENTION_KINDS.DECISION_REQUIRED]:
    "An outcome candidate is ready and waiting for the Founder's decision.",
});

export function sortAttentionItems(items) {
  return [...items].sort((a, b) => {
    const rank = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    return rank !== 0 ? rank : a.workId.localeCompare(b.workId);
  });
}

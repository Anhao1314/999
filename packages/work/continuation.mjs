// Continuation policy (pure): where is this Work, and what ONE action may follow?
// Contract: docs/contracts/work-continuity-v0.md §6–§7, §13–§14.
//
// This file decides, and never acts. It reads one instant of Runtime truth and
// answers two questions:
//
//   ProgressBoundary — which named situation is this Work in?
//   the one legal action, or the diagnostic that says why there is none
//
// Nothing here is stored, nothing here mutates, and nothing here reads a trace:
// a policy that consulted history could not be replayed against truth.
import { createHash } from "node:crypto";
import { REVIEW_VERDICTS } from "../workforce/reviews.mjs";
import {
  isCapability,
  normalizeCapabilities,
  satisfiesCapabilities,
} from "../workforce/capabilities.mjs";
import { deriveWorkforceDispatch } from "../workforce/dispatch.mjs";
import { BOUNDS } from "./records.mjs";
import { TASK_STATES } from "./work.mjs";

export const CONTINUATION_POLICY_VERSION = "v0b4.1";
export const MAX_CONTINUATION_STEPS = 16;

// The named situations. Each one maps to at most one legal action, so "what is
// happening" and "what may happen next" can never disagree.
export const BOUNDARIES = Object.freeze({
  ACCEPTED: "ACCEPTED",
  CANCELLED: "CANCELLED",
  RUNNING: "RUNNING",
  INTERRUPTED: "INTERRUPTED",
  REVISION_UNOWNED: "REVISION_UNOWNED",
  UNASSIGNED_TASK: "UNASSIGNED_TASK",
  READY_TO_START: "READY_TO_START",
  NOT_ACTIVATED: "NOT_ACTIVATED",
  READY_FOR_DECISION: "READY_FOR_DECISION",
  BLOCKED: "BLOCKED",
});

export const CONTINUATION_ACTIONS = Object.freeze({
  MATERIALIZE: "materializeNextAction",
  ASSIGN: "assignTask",
  START: "startWorkerRun",
  CREATE_REPAIR: "createRepairTask",
});

export const CONTINUATION_DIAGNOSTICS = Object.freeze({
  NO_DISPATCHABLE_EMPLOYEE: "NO_DISPATCHABLE_EMPLOYEE",
  CAPABILITY_GAP: "CAPABILITY_GAP",
  DISPATCH_AMBIGUOUS: "DISPATCH_AMBIGUOUS",
  PLANNING_EXHAUSTED: "PLANNING_EXHAUSTED",
  CONTINUATION_LIMIT_REACHED: "CONTINUATION_LIMIT_REACHED",
  COLLABORATION_BLOCKED: "COLLABORATION_BLOCKED",
});

export const ACTION_RESULTS = Object.freeze({
  EXECUTED: "EXECUTED",
  NO_OP: "NO_OP",
  REFUSED: "REFUSED",
  STALE: "STALE",
  SKIPPED: "SKIPPED",
  DIAGNOSTIC: "DIAGNOSTIC",
});

export const TRIGGER_TYPES = Object.freeze({
  COMMAND: "COMMAND",
  STARTUP: "STARTUP",
  EXPLICIT: "EXPLICIT",
  WAKE: "WAKE",
});

// Why a Company-level re-evaluation was scheduled. Work-scoped Activity is the
// fourth cause: something happened to one Work, so that Work is reconsidered.
export const WAKE_CAUSES = Object.freeze({
  WORKER_RUN_ENDED: "WORKER_RUN_ENDED",
  EMPLOYEE_ENABLED_CHANGED: "EMPLOYEE_ENABLED_CHANGED",
  EMPLOYEE_CREATED: "EMPLOYEE_CREATED",
  WORK_CHANGED: "WORK_CHANGED",
});

// Causes that changed Company-wide workforce facts, and therefore require a
// Company scan rather than a single Work drive.
export const COMPANY_WIDE_WAKE_CAUSES = Object.freeze([
  WAKE_CAUSES.WORKER_RUN_ENDED,
  WAKE_CAUSES.EMPLOYEE_ENABLED_CHANGED,
  WAKE_CAUSES.EMPLOYEE_CREATED,
]);

// The Driver writes this reason on assignments it makes. A human assignment
// records whatever the human said; this one is distinguishable on purpose.
export const CONTINUATION_ASSIGNMENT_REASON = "continuation.dispatch";
export const CONTINUATION_REDISPATCH_REASON = "continuation.redispatch";

const byCreatedAtThenId = (a, b) =>
  a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt.localeCompare(b.createdAt);

const requirementsOf = (requirementsByTask, taskId) =>
  requirementsByTask.get(taskId)?.requiredCapabilities ?? [];

// What the Runtime knows about one Task: its requirements, its current
// Assignment, whether that Assignment is still usable, and who could take it.
function evaluateTask(task, context) {
  const {
    requirementsByTask,
    assignmentsByTask,
    employeesById,
    positionsById,
    activeEmployeeIds,
    reviewProducerByTask,
    employees,
    positions,
  } = context;
  const requirements = requirementsOf(requirementsByTask, task.id);
  const assignment = assignmentsByTask.get(task.id) ?? null;
  const assigned = assignment ? employeesById.get(assignment.employeeId) ?? null : null;
  const assignedPosition = assigned ? positionsById.get(assigned.positionId) ?? null : null;

  // A Review Task may never go to the producer of the Artifact it judges, so
  // the producer is excluded from every candidate set this Task derives.
  const producerEmployeeId = reviewProducerByTask.get(task.id) ?? null;
  const excludeEmployeeIds = producerEmployeeId ? [producerEmployeeId] : [];

  const dispatch = deriveWorkforceDispatch({
    employees,
    positions,
    requiredCapabilities: requirements,
    activeEmployeeIds,
    excludeEmployeeIds,
  });

  const assignedEligible = Boolean(
    assigned &&
      assigned.enabled &&
      assignedPosition &&
      satisfiesCapabilities(requirements, assignedPosition.capabilities) &&
      assigned.id !== producerEmployeeId,
  );
  const assignedDispatchable = Boolean(
    assigned && dispatch.dispatchable.some((candidate) => candidate.employee.id === assigned.id),
  );

  return { requirements, assignment, assigned, assignedEligible, assignedDispatchable, dispatch };
}

const STOP = (boundary, extra = {}) => ({
  boundary,
  action: null,
  diagnostic: null,
  taskId: null,
  reviewId: null,
  candidates: null,
  ...extra,
});

// The one decision this milestone adds: given current truth, is there exactly
// one legal next step?
export function deriveProgressBoundary({
  work,
  decision = null,
  tasks = [],
  requirementsByTask = new Map(),
  assignmentsByTask = new Map(),
  reviewRequests = [],
  reviews = [],
  repairBindings = [],
  employees = [],
  positions = [],
  activeEmployeeIds = [],
  reviewProducerByTask = new Map(),
} = {}) {
  const context = {
    requirementsByTask,
    assignmentsByTask,
    employeesById: new Map(employees.map((employee) => [employee.id, employee])),
    positionsById: new Map(positions.map((position) => [position.id, position])),
    activeEmployeeIds,
    reviewProducerByTask,
    employees,
    positions,
  };
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const repairsByReview = new Set(repairBindings.map((binding) => binding.reviewId));

  // 1. A Founder Decision closes the Work to the Runtime for good.
  if (decision) return STOP(BOUNDARIES.ACCEPTED);

  // 2. Nothing left to continue: every Task was cancelled.
  if (tasks.length > 0 && tasks.every((task) => task.state === TASK_STATES.CANCELLED))
    return STOP(BOUNDARIES.CANCELLED);

  // 3. An attempt is executing right now. Waiting is not an action.
  const running = tasks.filter((task) => task.state === TASK_STATES.RUNNING);
  if (running.length > 0) return STOP(BOUNDARIES.RUNNING, { taskId: running[0].id });

  // 4. An interrupted Task. v0B4 continues it when it deterministically can;
  // when it cannot, the Work needs the Founder (v0B3 attention, narrowed).
  const interrupted = tasks
    .filter((task) => task.state === TASK_STATES.INTERRUPTED)
    .sort(byCreatedAtThenId)[0];
  if (interrupted) {
    const evaluated = evaluateTask(interrupted, context);
    const resume = evaluated.assignedEligible && evaluated.assignedDispatchable;
    const candidates = candidateView(evaluated.dispatch);
    if (resume)
      return {
        boundary: BOUNDARIES.INTERRUPTED,
        action: { command: CONTINUATION_ACTIONS.START, taskId: interrupted.id },
        diagnostic: null,
        taskId: interrupted.id,
        reviewId: null,
        candidates,
      };
    if (evaluated.dispatch.dispatchable.length === 1)
      return {
        boundary: BOUNDARIES.INTERRUPTED,
        action: {
          command: CONTINUATION_ACTIONS.ASSIGN,
          taskId: interrupted.id,
          employeeId: evaluated.dispatch.dispatchable[0].employee.id,
        },
        diagnostic: null,
        taskId: interrupted.id,
        reviewId: null,
        candidates,
      };
    return STOP(BOUNDARIES.INTERRUPTED, {
      taskId: interrupted.id,
      candidates,
      diagnostic: contentionDiagnostic(evaluated.dispatch, interrupted.id),
    });
  }

  // 5. A revision the Reviewer asked for becomes a Repair. This is Runtime-owned
  // in v0B3 and stays Runtime-owned here.
  const unownedRevision = reviews
    .filter((review) => review.verdict === REVIEW_VERDICTS.REQUEST_REVISION)
    .filter((review) => !repairsByReview.has(review.id))
    .sort(byCreatedAtThenId)[0];
  if (unownedRevision)
    return {
      boundary: BOUNDARIES.REVISION_UNOWNED,
      action: { command: CONTINUATION_ACTIONS.CREATE_REPAIR, reviewId: unownedRevision.id },
      diagnostic: null,
      taskId: null,
      reviewId: unownedRevision.id,
      candidates: null,
    };

  // 6. Ordinary open work: dispatch it, or say precisely why it cannot be.
  const open = tasks.filter((task) => task.state === TASK_STATES.OPEN).sort(byCreatedAtThenId);
  if (open.length > 0) {
    const task = open[0];
    const evaluated = evaluateTask(task, context);
    const candidates = candidateView(evaluated.dispatch);
    if (evaluated.assignedEligible) {
      if (evaluated.assignedDispatchable)
        return {
          boundary: BOUNDARIES.READY_TO_START,
          action: { command: CONTINUATION_ACTIONS.START, taskId: task.id },
          diagnostic: null,
          taskId: task.id,
          reviewId: null,
          candidates,
        };
      return STOP(BOUNDARIES.READY_TO_START, {
        taskId: task.id,
        candidates,
        diagnostic: contentionDiagnostic(evaluated.dispatch, task.id),
      });
    }
    if (evaluated.dispatch.dispatchable.length === 1)
      return {
        boundary: BOUNDARIES.UNASSIGNED_TASK,
        action: {
          command: CONTINUATION_ACTIONS.ASSIGN,
          taskId: task.id,
          employeeId: evaluated.dispatch.dispatchable[0].employee.id,
        },
        diagnostic: null,
        taskId: task.id,
        reviewId: null,
        candidates,
      };
    return STOP(BOUNDARIES.UNASSIGNED_TASK, {
      taskId: task.id,
      candidates,
      diagnostic: contentionDiagnostic(evaluated.dispatch, task.id),
    });
  }

  // 7. A Work with no Tasks has never been activated. v0B4's only REPLAN: the
  // Driver asks the proposer for one initial Task and materializes it.
  if (tasks.length === 0)
    return {
      boundary: BOUNDARIES.NOT_ACTIVATED,
      action: { command: CONTINUATION_ACTIONS.MATERIALIZE, workId: work?.id ?? null },
      diagnostic: null,
      taskId: null,
      reviewId: null,
      candidates: null,
    };

  // 8. An obligation nothing can ever satisfy is not an action.
  const cancelledObligation =
    reviewRequests.some((request) => taskById.get(request.reviewTaskId)?.state === TASK_STATES.CANCELLED) ||
    repairBindings.some((binding) => taskById.get(binding.repairTaskId)?.state === TASK_STATES.CANCELLED);
  if (cancelledObligation)
    return STOP(BOUNDARIES.BLOCKED, {
      diagnostic: {
        code: CONTINUATION_DIAGNOSTICS.COLLABORATION_BLOCKED,
        reason: "a cancelled Review or Repair left an obligation this Runtime cannot satisfy",
        evidence: { workId: work?.id ?? null },
      },
    });

  // 9. Every Task is terminal and nothing is outstanding: the Founder's turn.
  return STOP(BOUNDARIES.READY_FOR_DECISION);
}

// Contention and ambiguity are different failures with different owners:
// contention clears itself when the busy Employee finishes, ambiguity never
// clears itself and the Runtime refuses to pick.
function contentionDiagnostic(dispatch, taskId) {
  if (dispatch.dispatchable.length > 1)
    return {
      code: CONTINUATION_DIAGNOSTICS.DISPATCH_AMBIGUOUS,
      reason: `${dispatch.dispatchable.length} Employees could take this Task and this Runtime never picks between them`,
      evidence: { taskId, dispatchableEmployeeIds: dispatch.dispatchable.map((c) => c.employee.id) },
    };
  if (dispatch.contention)
    return {
      code: CONTINUATION_DIAGNOSTICS.NO_DISPATCHABLE_EMPLOYEE,
      reason: "every eligible Employee is already executing work; nothing is missing except availability",
      evidence: { taskId, busyEmployeeIds: dispatch.busyEligible.map((c) => c.employee.id) },
    };
  return {
    code: CONTINUATION_DIAGNOSTICS.CAPABILITY_GAP,
    reason: "no existing Employee satisfies this Task's requirements",
    evidence: { taskId },
  };
}

function candidateView(dispatch) {
  return {
    eligibleEmployeeIds: dispatch.eligible.map((candidate) => candidate.employee.id),
    dispatchableEmployeeIds: dispatch.dispatchable.map((candidate) => candidate.employee.id),
    busyEmployeeIds: dispatch.busyEligible.map((candidate) => candidate.employee.id),
    disabledEmployeeIds: dispatch.disabledCapable.map((candidate) => candidate.employee.id),
    capabilityGap: dispatch.capabilityGap,
    contention: dispatch.contention,
  };
}

// --- DecisionState ---------------------------------------------------------
// A bounded, JSON-safe reading of the moment a step was decided. It is a
// reading, never an input: no decision may be derived from a stored one.
export function buildDecisionState({
  work,
  tasks = [],
  boundary = null,
  basis = 0,
  candidates = null,
} = {}) {
  return {
    version: CONTINUATION_POLICY_VERSION,
    workId: work?.id ?? null,
    companyId: work?.companyId ?? null,
    basis,
    boundary: boundary?.boundary ?? null,
    taskStates: [...tasks]
      .sort(byCreatedAtThenId)
      .slice(0, MAX_CONTINUATION_STEPS)
      .map((task) => `${task.id}:${task.state}`),
    candidates: candidates ?? null,
  };
}

export function decisionStateDigest(state) {
  return `sha256:${createHash("sha256").update(JSON.stringify(state), "utf8").digest("hex")}`;
}

// --- NextActionProposal validation (frozen, strict) -------------------------
export const NEXT_ACTION_TASK_KINDS = Object.freeze(["EXECUTION"]);

export const NEXT_ACTION_PROPOSAL_FIELDS = Object.freeze([
  "taskKind",
  "title",
  "intent",
  "requiredCapabilities",
  "reviewCapabilities",
]);

const invalid = (message) => ({ ok: false, code: "INVALID_PROPOSAL", message });

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Total validation: unknown fields are rejected, never ignored. A proposer may
// describe work; it may not smuggle authority (an employee, a verdict, a
// permission, a runtime state) through an extra field.
export function validateNextActionProposal(proposal) {
  if (!isPlainObject(proposal)) return invalid("proposal must be an object");
  const keys = Object.keys(proposal);
  const unknown = keys.filter((key) => !NEXT_ACTION_PROPOSAL_FIELDS.includes(key));
  if (unknown.length > 0)
    return invalid(`proposal contains fields this Runtime never accepts: ${unknown.join(", ")}`);
  const missing = NEXT_ACTION_PROPOSAL_FIELDS.filter((field) => !keys.includes(field));
  if (missing.length > 0) return invalid(`proposal is missing: ${missing.join(", ")}`);

  if (!NEXT_ACTION_TASK_KINDS.includes(proposal.taskKind))
    return invalid(`taskKind must be one of ${NEXT_ACTION_TASK_KINDS.join(", ")}`);

  const title = typeof proposal.title === "string" ? proposal.title.trim() : "";
  if (title.length < 1 || title.length > BOUNDS.taskTitleMax)
    return invalid(`title must be 1..${BOUNDS.taskTitleMax} characters`);

  const intent = typeof proposal.intent === "string" ? proposal.intent.trim() : "";
  if (intent.length < 1 || intent.length > BOUNDS.taskIntentMax)
    return invalid(`intent must be 1..${BOUNDS.taskIntentMax} characters`);

  for (const field of ["requiredCapabilities", "reviewCapabilities"]) {
    const list = proposal[field];
    if (!Array.isArray(list) || list.length === 0)
      return invalid(`${field} must be a non-empty array of capability identifiers`);
    for (const capability of list)
      if (!isCapability(capability))
        return invalid(`${field} contains an invalid capability: ${JSON.stringify(capability)}`);
  }

  return {
    ok: true,
    proposal: {
      taskKind: proposal.taskKind,
      title,
      intent,
      requiredCapabilities: normalizeCapabilities(proposal.requiredCapabilities),
      reviewCapabilities: normalizeCapabilities(proposal.reviewCapabilities),
    },
  };
}

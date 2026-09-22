// Workforce Experience v0A — frozen vocabulary, bounds and pure shaping.
// Contract: docs/contracts/workforce-experience-v0.md
//
// The Experience layer is a derived product read model and nothing else. It
// reads Runtime domain facts through the Kernel's public read seams, derives
// what the frozen Founder Workspace and the Employee Lobby render, and returns
// bounded plain objects. It never writes, never caches, never schedules and
// never learns a second truth: everything here is recomputable from Runtime
// truth, and UI state is never Company truth.
//
// Two vocabularies are frozen here and must not drift:
//
//   availability  AVAILABLE | WORKING | DISABLED  (derived, never stored)
//   role          EXECUTION | REVIEW | REPAIR     (derived, never stored)
//
// `ONLINE`, `OFFLINE`, `IDLE` and `DISCONNECTED` are deliberately absent: an
// Employee with no active WorkerRun is AVAILABLE, not offline, and backend or
// transport state is execution detail rather than Employee identity.
import { MAX_AUTONOMOUS_ATTEMPTS_PER_TASK } from "../work/continuation.mjs";
import { WORKER_RUN_STATES } from "../workforce/worker-runs.mjs";

export const EXPERIENCE_AVAILABILITY = Object.freeze({
  AVAILABLE: "AVAILABLE",
  WORKING: "WORKING",
  DISABLED: "DISABLED",
});

export const EXPERIENCE_ROLES = Object.freeze({
  EXECUTION: "EXECUTION",
  REVIEW: "REVIEW",
  REPAIR: "REPAIR",
});

// A derived diagnostic on an Employee card. It names a Runtime condition the
// projection refused to resolve, never an Employee status.
export const EXPERIENCE_CONDITIONS = Object.freeze({
  MULTIPLE_ACTIVE_RUNS: "MULTIPLE_ACTIVE_RUNS",
});

// What the product may show. Every list the Experience layer returns is capped
// here, so a large company degrades into "the most recent N" instead of an
// unbounded response.
export const EXPERIENCE_BOUNDS = Object.freeze({
  employeesMax: 500,
  capabilitiesMax: 32,
  onDutyMax: 8,
  attentionItemsMax: 20,
  deliveriesMax: 10,
  activityMax: 20,
  lineageStepsMax: 40,
  runsScannedPerEmployee: 20,
  titleMax: 200,
  summaryMax: 400,
});

export const DELIVERY_REVIEW_STATES = Object.freeze(["PASS", "REQUEST_REVISION"]);
export const DELIVERY_ACCEPTED_STATES = Object.freeze(["ACCEPTED", "NOT_ACCEPTED"]);

export function boundedText(value, max = EXPERIENCE_BOUNDS.titleMax) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

const boundedList = (values, max) => values.slice(0, max);

// The Employee's running attempts, in append order. A Task can hold exactly one
// RUNNING WorkerRun (a partial unique index enforces it), but nothing in the
// command layer forbids an Employee from having two RUNNING runs on different
// Tasks: the index is per Task, and only the v0B4 dispatch policy avoids the
// situation in production. Experience therefore cannot assume one focus.
export function activeRunsFor(runs) {
  return runs.filter((run) => run.state === WORKER_RUN_STATES.RUNNING);
}

// The Employee's current attempt, or the reason there is not exactly one.
// Exactly one active run is the current attempt. More than one is a Runtime
// condition the projection refuses to resolve by guessing: it fails closed
// with a diagnostic instead of naming “the last one”, and it never grows a
// currentWorks[] list — the frozen UI baseline assumes one focus per Employee.
export function currentAttemptFor(activeRuns) {
  if (activeRuns.length === 0) return { run: null, condition: null };
  if (activeRuns.length === 1) return { run: activeRuns[0], condition: null };
  return { run: null, condition: EXPERIENCE_CONDITIONS.MULTIPLE_ACTIVE_RUNS };
}

// Availability is a function of two Runtime facts and nothing else: whether the
// Employee is enabled, and whether any attempt of theirs is running right now.
// An ambiguous Employee is still WORKING — availability never pretends they
// are free just because the projection could not name the single attempt.
export function availabilityOf({ employee, activeRunCount = 0 }) {
  if (!employee.enabled) return EXPERIENCE_AVAILABILITY.DISABLED;
  if (activeRunCount > 0) return EXPERIENCE_AVAILABILITY.WORKING;
  return EXPERIENCE_AVAILABILITY.AVAILABLE;
}

export function positionView(position) {
  if (!position) return null;
  return { id: position.id, title: boundedText(position.title) };
}

export function capabilitiesView(position) {
  if (!position || !Array.isArray(position.capabilities)) return [];
  return boundedList(
    position.capabilities.map((entry) => boundedText(entry, 80)).filter(Boolean),
    EXPERIENCE_BOUNDS.capabilitiesMax,
  );
}

// The attempt an Employee is in, described only by facts the Runtime owns: the
// Work, the Task, the derived role, the WorkerRun, its generation and how many
// attempts this Task has already consumed. `role` is null when the role cannot
// be established structurally — the projection fails closed rather than
// guessing from a title.
export function currentWorkView({ work, task, role, run, attempt }) {
  if (!work || !task || !run) return null;
  return {
    workId: work.id,
    title: boundedText(work.title),
    taskId: task.id,
    role: role ?? null,
    workerRunId: run.id,
    generation: run.generation,
    attempt,
    // The Task budget comes from the Runtime, never from a product constant.
    maxAutonomousAttempts: MAX_AUTONOMOUS_ATTEMPTS_PER_TASK,
  };
}

// Execution detail, bounded on purpose: the Founder Lobby sees which backend
// ran the attempt, never the workspace, the scratch directory, the process or
// any opaque external reference.
export function executionView(binding) {
  if (!binding) return null;
  return {
    backendType: binding.backendType,
    backendVersion: binding.backendVersion,
  };
}

// An Artifact as a delivery, described without its content: the UI shows what
// was produced, by whom, and where its review and acceptance stand.
export function deliveryView({
  artifact,
  workTitle,
  producerEmployeeId,
  producerName,
  review,
  accepted,
}) {
  return {
    artifactId: artifact.id,
    kind: artifact.kind,
    title: boundedText(artifact.title),
    workId: artifact.workId,
    workTitle: boundedText(workTitle),
    generation: artifact.generation,
    producerEmployeeId: producerEmployeeId ?? null,
    producerName: producerName ?? null,
    reviewState: review ? review.verdict : null,
    acceptedState: accepted ? "ACCEPTED" : "NOT_ACCEPTED",
    createdAt: artifact.createdAt,
  };
}

// Bounded domain-level Activity: the kind of thing that happened, where, and
// when. Event payloads stay in Runtime storage — they are not product data.
export function activityView(record) {
  return {
    sequence: record.sequence,
    kind: record.kind,
    workId: record.workId ?? null,
    taskId: record.taskId ?? null,
    generation: record.generation ?? null,
    createdAt: record.createdAt,
  };
}

export function attentionItemView(item) {
  return {
    id: item.id,
    kind: item.kind,
    workId: item.workId,
    work: { id: item.work.id, title: boundedText(item.work.title) },
    summary: boundedText(item.summary, EXPERIENCE_BOUNDS.summaryMax),
    conditions: boundedList([...item.conditions], 12),
    actions: boundedList(
      item.actions.map((entry) => ({ kind: entry.kind, effect: entry.effect })),
      12,
    ),
    ...(item.decisionBasis === undefined ? {} : { decisionBasis: item.decisionBasis }),
  };
}

// The most recent review of an Artifact, read from Review truth. Reviews are
// immutable, so "the latest one that names this Artifact" is the whole rule.
export function latestReviewForArtifact(reviews, artifactId) {
  let found = null;
  for (const review of reviews) {
    if (review.targetArtifactId !== artifactId) continue;
    if (!found || review.createdAt > found.createdAt || (review.createdAt === found.createdAt && review.id > found.id))
      found = review;
  }
  return found;
}

export const newestFirst = (left, right) => {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? 1 : -1;
  return left.id < right.id ? 1 : -1;
};

// A product-facing read error: bounded, safe to render, and never a stack
// trace or a raw internal exception.
export function experienceError(code, message, status = 500) {
  const error = new Error(message);
  error.experience = true;
  error.code = code;
  error.status = status;
  return error;
}

// Lookups that fail closed. The Kernel's read seams answer `null` for an
// unknown id; a projection that dereferenced that null would leak a raw
// TypeError as a 500. The Experience layer turns it into the explicit,
// bounded not-found the product API promises (§9).
export function requireCompany(kernel, companyId) {
  const company = kernel.company(companyId);
  if (!company)
    throw experienceError(
      "COMPANY_NOT_FOUND",
      `company ${boundedText(String(companyId), 80)} does not exist`,
      404,
    );
  return company;
}

export function requireEmployee(kernel, employeeId) {
  const employee = kernel.employee(employeeId);
  if (!employee)
    throw experienceError(
      "EMPLOYEE_NOT_FOUND",
      `employee ${boundedText(String(employeeId), 80)} does not exist`,
      404,
    );
  return employee;
}

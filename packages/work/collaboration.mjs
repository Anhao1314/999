// Collaboration projection (pure): what a Work's review/repair truth means
// right now. No storage, no I/O, nothing cached.
// Contract: docs/contracts/review-repair-collaboration-v0.md §12.
//
// Two independent facts are derived here and must not be confused:
//   status — can this Work still move on its own? (coarse, for the Founder)
//   stage  — which collaboration moment are we in? (fine, for reading a story)
//
// Neither is ever stored: they are a function of Tasks, ReviewRequests,
// Reviews and RepairBindings, so no projection can drift from the truth.
import { TASK_STATES } from "./work.mjs";

export const COLLABORATION_STATUSES = Object.freeze([
  "OPEN",
  "ACTIVE",
  "NEEDS_ATTENTION",
  "READY_FOR_DECISION",
  "BLOCKED",
  "CANCELLED",
]);

export const COLLABORATION_STAGES = Object.freeze([
  "NOT_STARTED",
  "INTERRUPTED",
  "REPAIRING",
  "REVISION_REQUESTED",
  "REVIEWING",
  "AWAITING_REVIEW",
  "EXECUTING",
  "READY_FOR_DECISION",
  "CANCELLED",
  "BLOCKED",
]);

const OPEN_TASK_STATES = Object.freeze([TASK_STATES.OPEN, TASK_STATES.RUNNING]);

const isOpen = (task) => OPEN_TASK_STATES.includes(task.state);

export function deriveCollaboration({
  tasks = [],
  reviewRequests = [],
  reviews = [],
  repairBindings = [],
  artifacts = [],
} = {}) {
  const reviewByTask = new Map(reviews.map((review) => [review.reviewTaskId, review]));
  const repairByReview = new Map(
    repairBindings.map((binding) => [binding.reviewId, binding]),
  );
  const reviewTaskIds = new Set(
    reviewRequests.map((request) => request.reviewTaskId),
  );
  const repairTaskIds = new Set(repairBindings.map((binding) => binding.repairTaskId));
  const taskById = new Map(tasks.map((task) => [task.id, task]));

  const interrupted = tasks.filter((task) => task.state === TASK_STATES.INTERRUPTED);
  const openTasks = tasks.filter(isOpen);
  const runningTasks = tasks.filter((task) => task.state === TASK_STATES.RUNNING);
  const openRepairTask = openTasks.find((task) => repairTaskIds.has(task.id)) ?? null;
  const openReviewTask = openTasks.find((task) => reviewTaskIds.has(task.id)) ?? null;
  const runningReviewTask =
    runningTasks.find((task) => reviewTaskIds.has(task.id)) ?? null;
  const otherOpenTask =
    openTasks.find((task) => !repairTaskIds.has(task.id) && !reviewTaskIds.has(task.id)) ??
    null;

  // Outstanding obligations: a review nobody delivered, a revision nobody
  // picked up, or a repair that never finished. Each one is a fact, not a guess.
  const pendingReviewRequests = reviewRequests.filter(
    (request) => !reviewByTask.has(request.reviewTaskId),
  );
  const unownedRevisions = reviews.filter(
    (review) => review.verdict === "REQUEST_REVISION" && !repairByReview.has(review.id),
  );
  const unfinishedRepairs = repairBindings.filter((binding) => {
    const task = taskById.get(binding.repairTaskId);
    return !task || task.state !== TASK_STATES.COMPLETED;
  });
  const outstanding =
    pendingReviewRequests.length + unownedRevisions.length + unfinishedRepairs.length > 0;

  const stage = deriveStage({
    tasks,
    interrupted,
    openRepairTask,
    openReviewTask,
    runningReviewTask,
    otherOpenTask,
    pendingReviewRequests,
    unownedRevisions,
    outstanding,
  });

  return {
    status: deriveStatus({ interrupted, runningTasks, openTasks, tasks, outstanding }),
    stage,
    outstanding,
    round: repairBindings.length + 1,
    openReviewTaskId: openReviewTask?.id ?? null,
    openRepairTaskId: openRepairTask?.id ?? null,
    latestReviewId: latestByCreatedAt(reviews)?.id ?? null,
    latestArtifactId: latestArtifact(artifacts)?.id ?? null,
    pendingReviewTaskIds: pendingReviewRequests.map((request) => request.reviewTaskId),
    unownedRevisionReviewIds: unownedRevisions.map((review) => review.id),
    unfinishedRepairTaskIds: unfinishedRepairs.map((binding) => binding.repairTaskId),
  };
}

function deriveStatus({ interrupted, runningTasks, openTasks, tasks, outstanding }) {
  if (interrupted.length > 0) return "NEEDS_ATTENTION";
  if (runningTasks.length > 0) return "ACTIVE";
  if (tasks.length === 0) return "OPEN";
  if (tasks.length > 0 && tasks.every((task) => task.state === TASK_STATES.CANCELLED))
    return "CANCELLED";
  if (openTasks.length > 0) return "OPEN";
  if (!outstanding) return "READY_FOR_DECISION";
  return "BLOCKED";
}

function deriveStage({
  tasks,
  interrupted,
  openRepairTask,
  openReviewTask,
  runningReviewTask,
  otherOpenTask,
  pendingReviewRequests,
  unownedRevisions,
  outstanding,
}) {
  if (tasks.length === 0) return "NOT_STARTED";
  if (interrupted.length > 0) return "INTERRUPTED";
  if (openRepairTask) return "REPAIRING";
  if (unownedRevisions.length > 0) return "REVISION_REQUESTED";
  // REVIEWING means a reviewer is working right now; a review that is merely
  // queued is still waiting for one.
  if (runningReviewTask) return "REVIEWING";
  if (pendingReviewRequests.length > 0) return "AWAITING_REVIEW";
  if (otherOpenTask || openReviewTask) return "EXECUTING";
  if (tasks.every((task) => task.state === TASK_STATES.CANCELLED)) return "CANCELLED";
  if (!outstanding) return "READY_FOR_DECISION";
  return "BLOCKED";
}

function latestByCreatedAt(records) {
  return [...records].sort((a, b) =>
    a.createdAt === b.createdAt
      ? a.id.localeCompare(b.id)
      : a.createdAt.localeCompare(b.createdAt),
  ).at(-1) ?? null;
}

// "Latest" means "nothing supersedes it yet" — a projection over the
// supersession chain, never an overwrite of the artifacts it replaced.
export function latestArtifact(artifacts) {
  const superseded = new Set(
    artifacts.map((artifact) => artifact.supersedesArtifactId).filter(Boolean),
  );
  return latestByCreatedAt(artifacts.filter((artifact) => !superseded.has(artifact.id)));
}

export function supersessionChain(artifacts) {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  return artifacts
    .filter((artifact) => artifact.supersedesArtifactId)
    .map((artifact) => ({
      artifactId: artifact.id,
      supersedesArtifactId: artifact.supersedesArtifactId,
      supersededExists: byId.has(artifact.supersedesArtifactId),
    }));
}

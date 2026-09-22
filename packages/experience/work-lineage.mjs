// Work Lineage projection — the central Company Canvas Work card.
// Contract: docs/contracts/workforce-experience-v0.md §7
//
// A read-only lineage of what the Runtime actually did: the Work, its Tasks in
// creation order (execution, review, repair), the Employees assigned to them,
// the Artifacts they produced, the Review verdicts and the Founder boundary.
// It is a derived visualization: nodes exist because Runtime facts exist, and
// nothing here is an editable workflow graph.
import {
  EXPERIENCE_BOUNDS,
  boundedText,
  experienceError,
} from "./records.mjs";

const roleOfDetail = (detail) => {
  if (detail.reviewRequest) return "REVIEW";
  if (detail.repairBinding) return "REPAIR";
  return "EXECUTION";
};

export function projectWorkLineage({ kernel, workId, projection = null }) {
  const reads = projection ?? kernel.workProjection(workId);
  const { work, tasks, artifacts, reviews, reviewRequests, repairBindings, outcome } = reads;

  // Fail closed on a lineage mismatch: a projection that mixes two Works would
  // render a story that never happened. The Work owns its Tasks; every Task,
  // Artifact, Review, ReviewRequest and RepairBinding must resolve inside them.
  const ownedTaskIds = new Set(tasks.map((task) => task.id));
  const mismatched = [
    ...artifacts.map((artifact) => artifact.taskId),
    ...reviews.map((review) => review.reviewTaskId),
    ...reviewRequests.map((request) => request.reviewTaskId),
    ...repairBindings.map((binding) => binding.repairTaskId),
  ].filter((taskId) => !ownedTaskIds.has(taskId));
  for (const entry of [...reviews, ...reviewRequests, ...repairBindings])
    if (entry.workId !== work.id) mismatched.push(entry.id);
  if (mismatched.length > 0)
    throw experienceError(
      "EXPERIENCE_LINEAGE_MISMATCH",
      "the Runtime returned a lineage record that this Work does not own",
      409,
    );

  // Version labels are derived from the append order of the Work's Artifacts;
  // supersession itself is Runtime truth (supersedesArtifactId).
  const versionIndex = new Map(artifacts.map((artifact, index) => [artifact.id, index + 1]));
  const employeeNames = new Map();
  const nameOf = (employeeId) => {
    if (!employeeId) return null;
    if (!employeeNames.has(employeeId)) {
      const employee = kernel.employee(employeeId);
      employeeNames.set(employeeId, employee ? boundedText(employee.displayName) : null);
    }
    return employeeNames.get(employeeId);
  };

  const steps = [];
  for (const task of tasks) {
    if (steps.length >= EXPERIENCE_BOUNDS.lineageStepsMax) break;
    const detail = kernel.taskDetail(task.id);
    const lastRun = detail.runs.length > 0 ? detail.runs[detail.runs.length - 1] : null;
    const assignment = detail.assignment ?? null;
    const step = {
      kind: "TASK",
      role: roleOfDetail(detail),
      taskId: task.id,
      title: boundedText(task.title),
      state: task.state,
      generation: task.generation,
      attempt: detail.runs.length,
      employeeId: assignment?.employeeId ?? null,
      employeeName: nameOf(assignment?.employeeId),
      workerRunId: lastRun?.id ?? null,
      workerRunState: lastRun?.state ?? null,
      artifacts: detail.artifacts.map((artifact) => ({
        artifactId: artifact.id,
        title: boundedText(artifact.title),
        generation: artifact.generation,
        versionIndex: versionIndex.get(artifact.id) ?? null,
        supersedesArtifactId: artifact.supersedesArtifactId ?? null,
        createdAt: artifact.createdAt,
      })),
    };
    if (detail.reviewRequest) {
      step.review = {
        reviewId: detail.review?.id ?? null,
        verdict: detail.review?.verdict ?? null,
        summary: boundedText(detail.review?.summary ?? null, EXPERIENCE_BOUNDS.summaryMax),
        findingsCount: detail.review?.findings?.length ?? 0,
        targetArtifactId: detail.reviewRequest.targetArtifactId,
        targetArtifactDigest: detail.reviewRequest.targetArtifactDigest,
      };
    }
    if (detail.repairBinding) {
      step.repair = {
        repairBindingId: detail.repairBinding.id,
        reviewId: detail.repairBinding.reviewId,
        targetArtifactId: detail.repairBinding.targetArtifactId,
        targetArtifactDigest: detail.repairBinding.targetArtifactDigest,
      };
    }
    steps.push(step);
  }

  const attention = reads.founderAttention?.item ?? null;
  return {
    work: {
      workId: work.id,
      title: boundedText(work.title),
      intent: boundedText(work.intent, EXPERIENCE_BOUNDS.summaryMax),
      status: reads.status,
      stage: reads.stage,
    },
    steps,
    outcome: {
      state: outcome.state,
      candidateArtifactIds: outcome.candidateArtifacts.map((artifact) => artifact.id),
    },
    latestArtifactId: reads.latestArtifact?.id ?? null,
    founderBoundary: {
      waitingForFounder: attention !== null,
      attentionKind: attention?.kind ?? null,
      // The durable acceptance facts, read from the outcome — never from the
      // command invocation that committed them (v0B3 contract, decision view).
      decision: outcome.accepted
        ? {
            decisionId: outcome.accepted.decisionId,
            disposition: outcome.accepted.disposition,
            artifactId: outcome.accepted.artifactId,
            artifactDigest: outcome.accepted.artifactDigest,
            decidedAt: outcome.accepted.decidedAt,
            basis: outcome.accepted.basis,
          }
        : null,
    },
  };
}

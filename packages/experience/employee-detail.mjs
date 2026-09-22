// Employee Detail projection — what the right-side Context Inspector renders.
// Contract: docs/contracts/workforce-experience-v0.md §6
//
// Bounded by construction: identity, the current attempt, recent deliveries and
// a bounded window of recent domain-level Activity. No logs, no prompts, no
// session references, no raw rows and no artifact content.
import {
  EXPERIENCE_BOUNDS,
  activityView,
  capabilitiesView,
  deliveryView,
  latestReviewForArtifact,
  newestFirst,
  positionView,
  requireEmployee,
} from "./records.mjs";
import { deriveWorkforce } from "./workforce.mjs";

export function projectEmployeeDetail({ kernel, employeeId }) {
  const employee = requireEmployee(kernel, employeeId);
  const workforce = deriveWorkforce({ kernel, companyId: employee.companyId });
  const card = workforce.byEmployeeId.get(employee.id) ?? null;
  const position = kernel.position(employee.positionId);
  const runs = kernel.workerRuns({ employeeId: employee.id });

  const workProjections = new Map();
  const projectionFor = (workId) => {
    if (!workProjections.has(workId)) workProjections.set(workId, kernel.workProjection(workId));
    return workProjections.get(workId);
  };

  const deliveries = [];
  for (const run of runs.slice(-EXPERIENCE_BOUNDS.runsScannedPerEmployee)) {
    for (const artifact of kernel.artifacts({ taskId: run.taskId })) {
      if (artifact.workerRunId !== run.id) continue;
      const projection = projectionFor(artifact.workId);
      deliveries.push(
        deliveryView({
          artifact,
          workTitle: projection.work.title,
          producerEmployeeId: employee.id,
          producerName: employee.displayName,
          review: latestReviewForArtifact(projection.reviews, artifact.id),
          accepted: projection.outcome.accepted?.artifactId === artifact.id,
        }),
      );
    }
  }
  deliveries.sort(newestFirst);

  // Recent Activity is read from the newest end and then narrowed structurally
  // to the Employee's own Tasks. It stays a window — never a full history.
  const taskIds = new Set(runs.map((run) => run.taskId));
  const recentActivity = kernel
    .recentActivity({ companyId: employee.companyId, limit: 200 })
    .filter((record) => record.taskId && taskIds.has(record.taskId))
    .slice(0, EXPERIENCE_BOUNDS.activityMax)
    .map(activityView);

  return {
    employeeId: employee.id,
    displayName: employee.displayName,
    position: card?.position ?? positionView(position),
    capabilities: card?.capabilities ?? capabilitiesView(position),
    availability: card?.availability ?? (employee.enabled ? "AVAILABLE" : "DISABLED"),
    condition: card?.condition ?? null,
    currentRole: card?.currentWork?.role ?? null,
    currentWork: card?.currentWork ?? null,
    execution: card?.execution ?? null,
    recentDeliveries: deliveries.slice(0, EXPERIENCE_BOUNDS.deliveriesMax),
    recentActivity,
  };
}

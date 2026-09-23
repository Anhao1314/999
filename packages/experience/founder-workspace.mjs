// Founder Workspace projection — the frozen home screen, as content.
// Contract: docs/contracts/workforce-experience-v0.md §8
//
// Content only: Company status, Founder Attention, the primary Work with its
// lineage, the AI Workforce widget, recent deliveries and the Company Pulse.
// Canvas layout, positions and widget state are presentation and live nowhere
// near Runtime truth.
import {
  EXPERIENCE_BOUNDS,
  attentionItemView,
  deliveryView,
  latestReviewForArtifact,
  newestFirst,
  requireCompany,
} from "./records.mjs";
import { deriveWorkforce } from "./workforce.mjs";
import { workforceSummaryView } from "./workforce-lobby.mjs";
import { projectWorkLineage } from "./work-lineage.mjs";

const isAccepted = (projection) => projection.outcome.state === "ACCEPTED";
const isCancelled = (projection) => projection.status === "CANCELLED";
const isActive = (projection) => !isAccepted(projection) && !isCancelled(projection);

// The newest Runtime-written Task timestamp inside a Work. Task updates are
// Runtime facts; no projection invents a "last touched" time of its own.
const newestTaskUpdate = (projection) =>
  projection.tasks.reduce((latest, task) => (task.updatedAt > latest ? task.updatedAt : latest), "");

// The deterministic primary-Work policy (v0A §15):
//   1. the Work the Founder is actually needed on (Founder Attention is already
//      ordered by urgency),
//   2. otherwise the active Work whose newest Task update is most recent,
//   3. otherwise the most recently created Work,
//   4. otherwise nothing — never an invented ranking.
export function selectPrimaryWork(projections, attention) {
  if (attention.length > 0) {
    const projection = projections.find((entry) => entry.work.id === attention[0].workId);
    if (projection) return { projection, selection: "FOUNDER_ATTENTION" };
  }
  const active = projections.filter(isActive);
  if (active.length > 0) {
    const ordered = [...active].sort((left, right) => {
      const leftUpdate = newestTaskUpdate(left);
      const rightUpdate = newestTaskUpdate(right);
      if (leftUpdate !== rightUpdate) return leftUpdate < rightUpdate ? 1 : -1;
      return left.work.id < right.work.id ? -1 : 1;
    });
    return { projection: ordered[0], selection: "ACTIVE" };
  }
  if (projections.length > 0) {
    const ordered = [...projections].sort((left, right) => {
      if (left.work.createdAt !== right.work.createdAt)
        return left.work.createdAt < right.work.createdAt ? 1 : -1;
      return left.work.id < right.work.id ? -1 : 1;
    });
    return { projection: ordered[0], selection: "RECENT" };
  }
  return null;
}

function recentDeliveries({ kernel, projections }) {
  const employeeNames = new Map();
  const nameOf = (employeeId) => {
    if (!employeeId) return null;
    if (!employeeNames.has(employeeId)) {
      const employee = kernel.employee(employeeId);
      employeeNames.set(employeeId, employee ? employee.displayName : null);
    }
    return employeeNames.get(employeeId);
  };
  const deliveries = [];
  for (const projection of projections) {
    for (const artifact of projection.artifacts) {
      const run = artifact.workerRunId ? kernel.workerRun(artifact.workerRunId) : null;
      const producerEmployeeId = run?.employeeId ?? null;
      deliveries.push(
        deliveryView({
          artifact,
          workTitle: projection.work.title,
          producerEmployeeId,
          producerName: nameOf(producerEmployeeId),
          review: latestReviewForArtifact(projection.reviews, artifact.id),
          accepted: projection.outcome.accepted?.artifactId === artifact.id,
        }),
      );
    }
  }
  deliveries.sort(newestFirst);
  return deliveries.slice(0, EXPERIENCE_BOUNDS.deliveriesMax);
}

// Lightweight counts only. Every number is a count of Runtime facts; no score,
// ratio or rating is invented, and an unknown fact is simply absent.
export function companyPulse({ projections, attention, workforce }) {
  return {
    works: projections.length,
    activeWorks: projections.filter(isActive).length,
    readyForDecision: projections.filter((entry) => entry.status === "READY_FOR_DECISION").length,
    acceptedWorks: projections.filter(isAccepted).length,
    reviewsActive: projections.filter((entry) => entry.collaboration.openReviewTaskId !== null).length,
    repairsActive: projections.filter((entry) => entry.collaboration.openRepairTaskId !== null).length,
    founderAttentionCount: attention.length,
    employeesWorking: workforce.summary.working,
    employeesAvailable: workforce.summary.available,
    employeesDisabled: workforce.summary.disabled,
  };
}

export function projectFounderWorkspace({ kernel, companyId }) {
  const company = requireCompany(kernel, companyId);
  const projections = kernel.works(company.id).map((work) => kernel.workProjection(work.id));
  const attention = kernel.founderAttention({ companyId: company.id });
  const workforce = deriveWorkforce({ kernel, companyId: company.id });
  const primary = selectPrimaryWork(projections, attention);
  // This capability marks a real Employee assigned to the Founder-facing
  // assistant position. The pet surface must never invent an Employee.
  const assistant = workforce.employees.find((card) => card.capabilities.includes("founder.assistant")) ?? null;

  return {
    company: { id: company.id, name: company.name },
    // The smallest honest runtime state: this project answered, so the kernel
    // opened, the store is readable and the projection derived. Infrastructure
    // health and Worker-backend health are separate questions, deliberately not
    // collapsed into Employee availability.
    runtime: { available: true },
    attention: {
      count: attention.length,
      items: attention
        .slice(0, EXPERIENCE_BOUNDS.attentionItemsMax)
        .map((item) => attentionItemView(item)),
    },
    primaryWork: primary
      ? {
          selection: primary.selection,
          lineage: projectWorkLineage({
            kernel,
            workId: primary.projection.work.id,
            projection: primary.projection,
          }),
        }
      : null,
    workforce: workforceSummaryView(workforce),
    founderAssistant: assistant ? {
      employeeId: assistant.employeeId,
      displayName: assistant.displayName,
      position: assistant.position,
      availability: assistant.availability,
      condition: assistant.condition,
      currentWork: assistant.currentWork,
    } : null,
    recentDeliveries: recentDeliveries({ kernel, projections }),
    pulse: companyPulse({ projections, attention, workforce }),
  };
}

// Workforce Experience v0A — the derived product read model.
// Contract: docs/contracts/workforce-experience-v0.md
//
// A projection layer between Company Runtime truth and the frozen Founder
// Workspace / Employee Lobby. It reads Runtime facts through the Kernel's
// public read seams and returns bounded product models; it never writes,
// never schedules and never becomes a second source of truth.
export {
  EXPERIENCE_AVAILABILITY,
  EXPERIENCE_ROLES,
  EXPERIENCE_BOUNDS,
  EXPERIENCE_CONDITIONS,
  DELIVERY_ACCEPTED_STATES,
  DELIVERY_REVIEW_STATES,
  activityView,
  attentionItemView,
  activeRunsFor,
  availabilityOf,
  boundedText,
  currentAttemptFor,
  currentWorkView,
  deliveryView,
  executionView,
  experienceError,
  latestReviewForArtifact,
  newestFirst,
  positionView,
  requireCompany,
  requireEmployee,
} from "./records.mjs";
export { deriveWorkforce, employeeCard, roleForTaskDetail } from "./workforce.mjs";
export { projectWorkforceLobby, workforceSummaryView } from "./workforce-lobby.mjs";
export { projectEmployeeDetail } from "./employee-detail.mjs";
export { projectWorkLineage } from "./work-lineage.mjs";
export { companyPulse, projectFounderWorkspace, selectPrimaryWork } from "./founder-workspace.mjs";

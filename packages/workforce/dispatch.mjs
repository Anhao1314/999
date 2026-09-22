// Dispatchability — which Employees the Runtime may hand a Task to *right now*.
// Contract: docs/contracts/work-continuity-v0.md §2–§3.
//
// Two different questions live here and must never be merged:
//
//   eligible      — does this Company have the capability?      (organizational truth)
//   dispatchable  — is that Employee free in this instant?      (availability)
//
// A BUSY Employee does not mean the Company lost a capability, so resource
// contention is never reported as a capability gap. Availability stays derived
// from WorkerRuns (`deriveAvailability`), never stored, so a crash cannot leave
// an Employee "busy" forever.
import { classifyEmployeeCandidates } from "./eligibility.mjs";

// Pure split over an already-classified eligible set: the Driver must not start
// a second active run for an Employee who is already executing something.
export function classifyDispatchableCandidates({
  eligible = [],
  activeEmployeeIds = [],
} = {}) {
  const busy = new Set(activeEmployeeIds);
  const dispatchable = [];
  const busyEligible = [];
  for (const candidate of eligible) {
    if (candidate?.employee && busy.has(candidate.employee.id)) busyEligible.push(candidate);
    else dispatchable.push(candidate);
  }
  return { dispatchable, busyEligible };
}

// One instant of workforce dispatch truth for a Task's requirements.
//
// `excludeEmployeeIds` exists for one reason only: a Review Task must not be
// handed to the producer of the Artifact under review (contract §4), so the
// excluded Employee is not a candidate for that Task in any sense — including
// as the reason for reporting a capability gap.
export function deriveWorkforceDispatch({
  employees = [],
  positions = [],
  requiredCapabilities = [],
  activeEmployeeIds = [],
  excludeEmployeeIds = [],
} = {}) {
  const excluded = new Set(excludeEmployeeIds);
  const { eligible: allEligible, disabledCapable: allDisabled } = classifyEmployeeCandidates({
    employees,
    positions,
    requiredCapabilities,
  });
  const eligible = allEligible.filter((candidate) => !excluded.has(candidate.employee.id));
  const disabledCapable = allDisabled.filter(
    (candidate) => !excluded.has(candidate.employee.id),
  );
  const { dispatchable, busyEligible } = classifyDispatchableCandidates({
    eligible,
    activeEmployeeIds,
  });
  return {
    eligible,
    disabledCapable,
    dispatchable,
    busyEligible,
    capabilityGap: eligible.length === 0,
    contention: eligible.length > 0 && dispatchable.length === 0,
  };
}

export function activeEmployeeIdsOf(runs = []) {
  return [...new Set(runs.map((run) => run.employeeId))];
}

// Employee eligibility for a Task's capability requirements (pure).
// Contract: docs/contracts/founder-attention-acceptance-v0.md §13.
//
// Eligibility answers one narrow question: which Employees could legally be
// handed this Task right now — enabled, and their Position still covers the
// required capabilities. It is deliberately NOT an assignment policy:
//
//   eligible Employee exists  !=  the Runtime will assign the Task
//
// v0B3 ships no dispatcher, so an eligible Employee is a *capability* fact, not
// autonomous continuation. Nothing here ranks, scores, picks or schedules.
import { satisfiesCapabilities } from "./capabilities.mjs";

export function classifyEmployeeCandidates({
  employees = [],
  positions = [],
  requiredCapabilities = [],
} = {}) {
  const positionById = new Map(positions.map((position) => [position.id, position]));
  const eligible = [];
  const disabledCapable = [];
  for (const employee of employees) {
    const position = positionById.get(employee.positionId);
    if (!position) continue;
    if (!satisfiesCapabilities(requiredCapabilities, position.capabilities)) continue;
    if (employee.enabled) eligible.push({ employee, position });
    else disabledCapable.push({ employee, position });
  }
  return { eligible, disabledCapable };
}

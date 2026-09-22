// Workforce Lobby projection — the AI Workforce widget and the Employee Lobby.
// Contract: docs/contracts/workforce-experience-v0.md §5
import { EXPERIENCE_BOUNDS } from "./records.mjs";
import { deriveWorkforce } from "./workforce.mjs";

export function projectWorkforceLobby({ kernel, companyId }) {
  const workforce = deriveWorkforce({ kernel, companyId });
  return {
    company: { id: workforce.company.id, name: workforce.company.name },
    summary: { ...workforce.summary },
    employees: workforce.employees.slice(0, EXPERIENCE_BOUNDS.employeesMax),
  };
}

// The homepage widget: the same derived workforce, reduced to counts plus the
// Employees who are working right now — never a second roster, never a second
// availability rule.
export function workforceSummaryView(workforce) {
  const onDuty = workforce.employees
    .filter((card) => card.availability === "WORKING")
    .slice(0, EXPERIENCE_BOUNDS.onDutyMax)
    .map((card) => ({
      employeeId: card.employeeId,
      displayName: card.displayName,
      position: card.position,
      role: card.currentWork?.role ?? null,
      workTitle: card.currentWork?.title ?? null,
      condition: card.condition ?? null,
    }));
  return { ...workforce.summary, onDuty };
}

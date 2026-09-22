// Workforce derivation (pure): the one place where Employee cards are built
// from Runtime truth. The Lobby, the Employee detail Inspector and the Founder
// Workspace all read this, so three views can never disagree about the same
// Employee.
import {
  EXPERIENCE_BOUNDS,
  EXPERIENCE_ROLES,
  activeRunsFor,
  availabilityOf,
  capabilitiesView,
  currentWorkView,
  currentAttemptFor,
  executionView,
  positionView,
  requireCompany,
} from "./records.mjs";

// The role an attempt plays is a structural fact, never a title: a Review Task
// is the Task a ReviewRequest names, a Repair Task is the Task a RepairBinding
// names, and every other Task in a Work is execution. Anything else fails
// closed — the projection would rather say "WORKING, role unknown" than guess.
export function roleForTaskDetail(detail) {
  if (!detail || !detail.task) return null;
  if (detail.reviewRequest) return EXPERIENCE_ROLES.REVIEW;
  if (detail.repairBinding) return EXPERIENCE_ROLES.REPAIR;
  return EXPERIENCE_ROLES.EXECUTION;
}

function attemptOf(detail, runId) {
  const index = (detail.runs ?? []).findIndex((run) => run.id === runId);
  return index >= 0 ? index + 1 : (detail.runs ?? []).length;
}

// One instant of workforce truth for a company, read once. Every Employee is
// described by organizational identity plus the attempt the Runtime is running
// for them right now; nothing is stored, nothing is cached between calls.
export function deriveWorkforce({ kernel, companyId }) {
  const company = requireCompany(kernel, companyId);
  const positions = new Map(kernel.positions(company.id).map((entry) => [entry.id, entry]));
  const employees = kernel
    .employees(company.id)
    .slice(0, EXPERIENCE_BOUNDS.employeesMax);
  const cards = [];
  const byEmployeeId = new Map();
  const summary = { employees: employees.length, working: 0, available: 0, disabled: 0 };

  for (const employee of employees) {
    const position = positions.get(employee.positionId) ?? null;
    const runs = kernel.workerRuns({ employeeId: employee.id });
    const activeRuns = activeRunsFor(runs);
    const { run: activeRun, condition } = currentAttemptFor(activeRuns);
    const availability = availabilityOf({ employee, activeRunCount: activeRuns.length });

    let currentWork = null;
    let execution = null;
    let role = null;
    if (activeRun) {
      const task = kernel.task(activeRun.taskId);
      const work = task ? kernel.work(task.workId) : null;
      const detail = task ? kernel.taskDetail(task.id) : null;
      role = roleForTaskDetail(detail);
      currentWork = currentWorkView({
        work,
        task,
        role,
        run: activeRun,
        attempt: detail ? attemptOf(detail, activeRun.id) : 1,
      });
      execution = executionView(kernel.workerExecutionBinding(activeRun.id));
    }

    const card = {
      employeeId: employee.id,
      displayName: employee.displayName,
      position: positionView(position),
      capabilities: capabilitiesView(position),
      availability,
      condition,
      currentWork,
      execution,
    };
    cards.push(card);
    byEmployeeId.set(employee.id, card);

    if (availability === "WORKING") summary.working += 1;
    else if (availability === "DISABLED") summary.disabled += 1;
    else summary.available += 1;
  }

  return { company, employees: cards, byEmployeeId, summary };
}

// The Executive card of one Employee inside a derived workforce — the shape the
// Inspector and the Lobby both render.
export function employeeCard(workforce, employee) {
  const card = workforce.byEmployeeId.get(employee.id);
  if (!card) return null;
  return { ...card, currentRole: card.currentWork?.role ?? null };
}

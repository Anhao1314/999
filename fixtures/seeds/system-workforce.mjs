// System workforce seed — bootstrap configuration, NOT core logic.
//
// FlowCredit ships two system employees. They are *data*: the core packages
// (`packages/**`, `apps/runtime/**`) know only capabilities and ids, and
// scripts/check.mjs fails the build if any name or capability id from this file
// appears there. Apply it through the generic `bootstrapWorkforce` command
// (see scripts/seed-system-workforce.mjs); it is idempotent by id.
//
// Seeding is not Hiring. There is no JD, no hiring conversation, no trial task
// and no Founder confirmation here — that is MVP 3.
export const SYSTEM_WORKFORCE_SEED = Object.freeze({
  positions: Object.freeze([
    Object.freeze({
      id: "pos_system_research_analyst",
      title: "Research Analyst",
      capabilities: Object.freeze(["research.execute"]),
    }),
    Object.freeze({
      id: "pos_system_independent_reviewer",
      title: "Independent Reviewer",
      capabilities: Object.freeze(["review.independent"]),
    }),
  ]),
  employees: Object.freeze([
    Object.freeze({
      id: "emp_system_research_analyst",
      positionId: "pos_system_research_analyst",
      displayName: "Research Analyst",
    }),
    Object.freeze({
      id: "emp_system_independent_reviewer",
      positionId: "pos_system_independent_reviewer",
      displayName: "Independent Reviewer",
    }),
  ]),
});

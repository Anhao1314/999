import test from "node:test";
import assert from "node:assert/strict";
import { openTempKernel, reopenKernel } from "../support/kernel.mjs";
import { createContinuationDriver } from "../../packages/runtime/index.mjs";
import { createTestModelBackend, createWorkerHost, WEB_READ } from "../../packages/harness/index.mjs";
import { createCustomerResearchDraft, createHiringActivationResolver,
  startCustomerResearchTrial } from "../../packages/product/employee-hiring.mjs";
import { canonicalCapability, routeCustomerResearch, routingAssignmentReason,
  ROUTING_POLICY_VERSION } from
  "../../packages/workforce/capability-routing.mjs";
import { digestOf } from "../../packages/work/records.mjs";

const URL = "https://public.example/customer-research";
const waitFor = async predicate => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("routing test timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};
const final = (kind, content) => ({ type: "FINAL_RESULT", candidate: {
  resultVersion: 1, outcome: "SUCCEEDED", summary: "Bounded result", blockers: [],
  suggestedNextActions: [], proposedArtifacts: [{ kind, title: "Customer evidence", content }],
} });

test("capability contract rejects aliases and deterministic selection ignores employee names", () => {
  assert.equal(canonicalCapability("customer.research"), "customer.research");
  assert.equal(canonicalCapability("commerce.user.insights"), "commerce.user.insights");
  assert.equal(canonicalCapability("customer.insight"), null);
  const position = { id: "pos_1", companyId: "co_1", capabilities: ["customer.research"] };
  const employees = [
    { id: "emp_luna", companyId: "co_1", positionId: position.id, displayName: "Echo", enabled: true },
    { id: "emp_echo", companyId: "co_1", positionId: position.id, displayName: "Luna", enabled: true },
    { id: "emp_foreign", companyId: "co_2", positionId: position.id, displayName: "Other", enabled: true },
  ];
  const validated = { origin: "FOUNDER_DRAFT", state: "ACTIVE", eligibleSkills: ["CustomerInsight@v1"],
    capabilityEvidence: [{ capability: "customer.research", status: "TRIAL_VALIDATED",
      artifactId: "art_1", artifactDigest: digestOf("trial"), reviewId: "rev_1" }] };
  const declared = { ...validated, capabilityEvidence: [{ capability: "customer.research", status: "DECLARED" }] };
  const run = (hiring, changes = {}) => routeCustomerResearch({ companyId: "co_1", workId: "wrk_1",
    taskId: "tsk_1", employees: changes.employees ?? employees, positions: changes.positions ?? [position],
    hiringByEmployeeId: hiring, activeEmployeeIds: changes.busy ?? [],
    activationSkills: changes.skills ?? ["CustomerInsight@v1"] });
  const facts = new Map([["emp_luna", validated], ["emp_echo", { origin: "LEGACY_OR_SEEDED" }]]);
  assert.equal(run(facts).selected.employee.id, "emp_luna", "validated evidence precedes seeded Position fact");
  const renamed = employees.map(employee => ({ ...employee, displayName: `${employee.displayName}-renamed` }));
  assert.equal(run(facts, { employees: renamed }).selected.employee.id, "emp_luna");
  assert.equal(run(facts, { busy: ["emp_luna"] }).selected.employee.id, "emp_echo");
  assert.equal(run(new Map([["emp_luna", declared], ["emp_echo", { origin: "LEGACY_OR_SEEDED" }]]))
    .selected.employee.id, "emp_echo");
  assert.equal(run(facts, { employees: employees.map(employee =>
    employee.id === "emp_luna" ? { ...employee, enabled: false } : employee) }).selected.employee.id,
    "emp_echo");
  assert.equal(run(new Map([["emp_luna", declared]])).selected, null,
    "declared capability alone never routes");
  assert.equal(run(facts, { skills: [] }).gap, "NO_ELIGIBLE_EMPLOYEE");
  assert.equal(run(facts, { positions: [{ ...position, capabilities: ["commerce.user.insights"] }] }).selected,
    null, "related capability is not an alias");
  assert.equal(run(facts, { busy: ["emp_luna", "emp_echo"] }).gap, "ALL_ELIGIBLE_BUSY");
  const third = { ...employees[0], id: "emp_33333333-3333-4333-8333-333333333333" };
  const three = run(new Map([...facts, [third.id, { origin: "LEGACY_OR_SEEDED" }]]),
    { employees: [...employees, third] });
  assert.equal(three.basis.candidateFacts.length, 3);
  assert.ok(routingAssignmentReason(three.basis).length <= 500);
  const fourth = { ...third, id: "emp_44444444-4444-4444-8444-444444444444" };
  const four = run(new Map([...facts, [third.id, { origin: "LEGACY_OR_SEEDED" }],
    [fourth.id, { origin: "LEGACY_OR_SEEDED" }]]),
    { employees: [...employees, third, fourth] });
  assert.equal(four.selected, null);
  assert.equal(four.gap, "CANDIDATE_BOUND_EXCEEDED");
});

test("hired researcher is discovered after restart by a new Work with no employee identity", async () => {
  const env = openTempKernel();
  let kernel = env.kernel;
  let host;
  let driver;
  const sessions = [];
  const model = createTestModelBackend({ steps: [
    { type: "TOOL_REQUEST", callId: "trial-read", capability: WEB_READ, input: { url: URL } },
    ({ messages }) => {
      const sourceId = JSON.parse(messages.at(-1).content).output.sourceObservation.sourceId;
      return final("customer-insight-trial", JSON.stringify({ schemaVersion: 1,
        observations: ["A vendor describes a product."], hypotheses: [],
        unknowns: ["Independent customer complaints remain unknown."], sourceIds: [sourceId],
        limitations: "A brand page is not independent customer evidence." }));
    },
    ({ messages }) => {
      const packet = JSON.parse(messages[1].content);
      return { type: "FINAL_RESULT", candidate: { schemaVersion: 1,
        workerRunId: packet.workerRunId, generation: packet.generation,
        verdict: "PASS", findings: [], summary: "Evidence limitations are explicit." } };
    },
    ({ messages, tools }) => {
      assert.deepEqual(tools, [], "future Work has no inherited web grant");
      const packet = JSON.parse(messages[1].content);
      const goal = JSON.parse(packet.workPacket.work.intent);
      return final("customer-research-note", JSON.stringify({ schemaVersion: 1,
        evidenceArtifactId: goal.evidenceArtifactId,
        evidenceArtifactDigest: goal.evidenceArtifactDigest,
        observations: ["The accepted trial records a vendor product description."],
        hypotheses: [], unknowns: ["Independent customer complaints remain unknown."],
        limitations: "This run uses an accepted trial Artifact and makes no new web observation." }));
    },
  ] });
  const reader = { async read({ url }) { assert.equal(url, URL); return {
    canonicalUrl: url, title: "Vendor page", observedAt: "2026-09-24T00:00:00.000Z",
    contentDigest: digestOf("vendor bytes"), content: "Vendor product description.",
  }; } };
  const activation = () => {
    const base = createHiringActivationResolver({ kernel, modelBackend: model, reader });
    return { activate(facts) {
      const selected = base.activate(facts);
      sessions.push({ runId: facts.workerRun.id, grants: selected.toolPolicy.approvedCapabilities,
        skill: selected.toolPolicy.skill.skillId });
      return selected;
    } };
  };
  try {
    const company = kernel.createCompany({ name: "Capability company" });
    const reviewerPosition = kernel.createPosition({ companyId: company.id, title: "Reviewer",
      capabilities: ["work.review"] });
    kernel.createEmployee({ companyId: company.id, positionId: reviewerPosition.id, displayName: "Iris" });
    const draft = createCustomerResearchDraft({ kernel, companyId: company.id, displayName: "Luna" });
    host = createWorkerHost({ kernel, runtimeRoot: env.dir, activationResolver: activation(), timeoutMs: 180_000 });
    driver = createContinuationDriver({ kernel, activationSkills: ["CustomerInsight@v1"] });
    host.start();
    const trial = startCustomerResearchTrial({ kernel, companyId: company.id,
      employeeId: draft.employee.id, publicUrl: URL });
    await waitFor(() => kernel.workProjection(trial.work.id).status === "READY_FOR_DECISION");
    await host.idle();
    const candidate = kernel.workProjection(trial.work.id).outcome.candidateArtifacts[0];
    const accepted = kernel.artifact(candidate.id);
    const projection = kernel.workProjection(trial.work.id);
    kernel.acceptWork({ workId: trial.work.id, artifactId: accepted.id,
      artifactDigest: accepted.contentDigest, basis: projection.decisionBasis });
    const hiring = kernel.employeeHiring(draft.employee.id);
    const trialGrantDigest = host.reportFor(trial.workerRun.id)[0].detail.evidence.toolSession.grantDigest;
    kernel.confirmEmployeeHire({ companyId: company.id, employeeId: draft.employee.id,
      expectedBasis: hiring.basis, reviewId: hiring.trial.reviewId,
      artifactDigest: accepted.contentDigest });
    driver.detach(); await host.stop(); kernel.close();
    kernel = reopenKernel(env.dir);
    assert.equal(kernel.employeeHiring(draft.employee.id).state, "ACTIVE");
    assert.equal(kernel.employeeHiring(draft.employee.id).capabilityEvidence[0].status, "TRIAL_VALIDATED");
    const echoPosition = kernel.createPosition({ companyId: company.id, title: "Seeded researcher",
      capabilities: ["customer.research"] });
    const echo = kernel.createEmployee({ companyId: company.id, positionId: echoPosition.id,
      displayName: "Echo" });
    host = createWorkerHost({ kernel, runtimeRoot: env.dir, activationResolver: activation(), timeoutMs: 180_000 });
    driver = createContinuationDriver({ kernel, activationSkills: ["CustomerInsight@v1"] });
    host.start();
    const followup = kernel.createCapabilityResearchWork({ companyId: company.id,
      title: "Follow-up customer research", instruction: "Summarize the bounded evidence and unknowns.",
      evidenceArtifactId: accepted.id });
    assert.equal(followup.work.intent.includes("Luna"), false);
    assert.equal(followup.work.intent.includes(draft.employee.id), false);
    assert.deepEqual(kernel.taskRequirements(followup.task.id).requiredCapabilities, ["customer.research"]);
    await waitFor(() => kernel.artifacts({ workId: followup.work.id }).length === 1).catch(error => {
      throw new Error(`${error.message}: ${JSON.stringify({
        projection: kernel.workProjection(followup.work.id),
        runs: kernel.workerRuns({ workId: followup.work.id }).map(run => ({ id: run.id,
          state: run.state, reason: run.endReason, report: host.reportFor(run.id) })),
        traces: kernel.continuationTraces({ workId: followup.work.id, limit: 30 }),
      })}`);
    });
    await host.idle();
    const assignment = kernel.assignment(followup.task.id);
    const run = kernel.workerRuns({ taskId: followup.task.id })[0];
    const basis = kernel.assignmentRoutingBasis(followup.task.id);
    assert.equal(assignment.employeeId, draft.employee.id);
    assert.notEqual(assignment.employeeId, echo.id, "validated Luna wins the bounded two-candidate policy");
    assert.equal(basis.policyVersion, ROUTING_POLICY_VERSION);
    assert.equal(basis.evidence, "TRIAL_VALIDATED");
    assert.equal(run.employeeId, draft.employee.id);
    assert.notEqual(run.id, trial.workerRun.id);
    assert.equal(run.state, "COMPLETED");
    assert.deepEqual(sessions.find(session => session.runId === trial.workerRun.id).grants, [WEB_READ]);
    assert.deepEqual(sessions.find(session => session.runId === run.id).grants, []);
    assert.notEqual(host.reportFor(run.id)[0].detail.evidence.toolSession.grantDigest,
      trialGrantDigest, "a fresh run has a different Host-minted grant");
    assert.equal(kernel.sourceObservations({ workerRunId: run.id }).length, 0);
    assert.equal(kernel.artifacts({ workId: followup.work.id })[0].workerRunId, run.id);
    assert.equal(kernel.workProjection(followup.work.id).routingSelections[0].digest, basis.digest);
    driver.detach(); await host.stop(); kernel.close();
    kernel = reopenKernel(env.dir);
    assert.equal(kernel.assignmentRoutingBasis(followup.task.id).digest, basis.digest);
    assert.equal(kernel.artifacts({ workId: followup.work.id }).length, 1);
    kernel.setEmployeeEnabled({ employeeId: draft.employee.id, enabled: false });
    kernel.setEmployeeEnabled({ employeeId: echo.id, enabled: false });
    assert.equal(kernel.employeeHiring(draft.employee.id).state, "DISABLED");
    assert.equal(kernel.artifact(accepted.id).contentDigest, accepted.contentDigest);
    const count = kernel.employees(company.id).length;
    driver = createContinuationDriver({ kernel, activationSkills: ["CustomerInsight@v1"] });
    const gap = kernel.createCapabilityResearchWork({ companyId: company.id,
      title: "Unstaffed customer research", instruction: "State the remaining evidence gaps.",
      evidenceArtifactId: accepted.id });
    assert.equal(kernel.assignment(gap.task.id), null);
    assert.equal(kernel.workerRuns({ taskId: gap.task.id }).length, 0);
    assert.equal(kernel.employees(company.id).length, count, "no automatic hiring");
    assert.equal(kernel.continuationTraces({ workId: gap.work.id, limit: 20 })
      .some(trace => trace.diagnosticCode === "CAPABILITY_GAP"), true);
    assert.throws(() => kernel.assignTask({ taskId: gap.task.id, employeeId: draft.employee.id,
      routingPolicyVersion: ROUTING_POLICY_VERSION }), { code: "EMPLOYEE_DISABLED" });
  } finally {
    driver?.detach(); await host?.stop(); if (kernel.store.db.isOpen) kernel.close(); env.cleanup();
  }
});

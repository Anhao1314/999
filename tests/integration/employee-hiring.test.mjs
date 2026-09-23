import test from "node:test";
import assert from "node:assert/strict";
import { openTempKernel, reopenKernel } from "../support/kernel.mjs";
import { createContinuationDriver } from "../../packages/runtime/index.mjs";
import { createTestModelBackend, createWorkerHost, WEB_READ } from "../../packages/harness/index.mjs";
import { createCustomerResearchDraft, createHiringActivationResolver,
  startCustomerResearchTrial } from "../../packages/product/employee-hiring.mjs";
import { digestOf } from "../../packages/work/records.mjs";

const URL = "https://public.example/customer-research";
const artifact = (kind, content) => ({ type: "FINAL_RESULT", candidate: {
  resultVersion: 1, outcome: "SUCCEEDED", summary: "Bounded delivery", blockers: [], suggestedNextActions: [],
  proposedArtifacts: [{ kind, title: "Customer evidence note", content }],
} });
const waitFor = async predicate => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Work did not reach the expected boundary");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

test("Founder draft -> ordinary trial/review -> explicit hire -> restart -> fresh future run", async () => {
  const env = openTempKernel();
  let kernel = env.kernel;
  let driver;
  let host;
  const sessions = [];
  const model = createTestModelBackend({ steps: [
    { type: "TOOL_REQUEST", callId: "approved-read", capability: WEB_READ, input: { url: URL } },
    ({ messages }) => {
      const sourceId = JSON.parse(messages.at(-1).content).output.sourceObservation.sourceId;
      return artifact("customer-insight-trial", JSON.stringify({ schemaVersion: 1,
        observations: ["The public page describes a product."], hypotheses: [],
        unknowns: ["Actual customer complaints are unknown."], sourceIds: [sourceId],
        limitations: "A brand page is not independent customer evidence." }));
    },
    ({ messages, tools }) => {
      assert.deepEqual(tools, []);
      const packet = JSON.parse(messages[1].content);
      return { type: "FINAL_RESULT", candidate: { schemaVersion: 1,
        workerRunId: packet.workerRunId, generation: packet.generation, verdict: "PASS", findings: [],
        summary: "Observed page and unknown customer evidence are separated." } };
    },
    ({ tools }) => { assert.deepEqual(tools, []); return artifact("evidence-synthesis", "Evidence remains bounded and uncertain."); },
  ] });
  const reader = { async read({ url }) { assert.equal(url, URL); return {
    canonicalUrl: url, title: "Public page", observedAt: "2026-09-24T00:00:00.000Z",
    contentDigest: digestOf("public fixture bytes"), content: "Public product information only.",
  }; } };
  const activation = runtime => {
    const base = createHiringActivationResolver({ kernel: runtime, modelBackend: model, reader });
    return { activate(facts) {
      const selected = base.activate(facts);
      const adapter = selected.adapter;
      return { ...selected, adapter: { ...adapter, start(input, context) {
        sessions.push({ runId: input.workerRunId, session: context.authorizedToolSession,
          skill: selected.toolPolicy.skill.skillId, grant: selected.toolPolicy.approvedCapabilities });
        return adapter.start(input, context);
      } } };
    } };
  };
  try {
    const company = kernel.createCompany({ name: "Founder-created workforce" });
    const reviewerPosition = kernel.createPosition({ companyId: company.id, title: "Independent Reviewer",
      capabilities: ["work.review"] });
    const reviewer = kernel.createEmployee({ companyId: company.id, positionId: reviewerPosition.id,
      displayName: "Iris" });
    const draft = createCustomerResearchDraft({ kernel, companyId: company.id, displayName: "Luna" });
    const employeeId = draft.employee.id;
    assert.equal(draft.employee.enabled, false);
    assert.equal(draft.employee.providerPreference, null);
    assert.equal(kernel.employeeHiring(employeeId).state, "DRAFT");
    assert.deepEqual(kernel.employeeHiring(employeeId).capabilityEvidence.map(item => item.status), ["DECLARED", "DECLARED"]);
    assert.equal(kernel.employeeHiring(reviewer.id).origin, "LEGACY_OR_SEEDED");
    const unrelated = kernel.createWork({ companyId: company.id, title: "Production", intent: "Normal work" });
    const unrelatedTask = kernel.createTask({ workId: unrelated.id, title: "Research", intent: "Normal task",
      requiredCapabilities: ["customer.research"] });
    assert.throws(() => kernel.assignTask({ taskId: unrelatedTask.id, employeeId }), { code: "EMPLOYEE_DISABLED" });
    assert.throws(() => kernel.setEmployeeEnabled({ employeeId, enabled: true }), { code: "HIRING_NOT_CONFIRMED" });
    host = createWorkerHost({ kernel, runtimeRoot: env.dir, activationResolver: activation(kernel), timeoutMs: 180_000 });
    driver = createContinuationDriver({ kernel });
    host.start();
    const trial = startCustomerResearchTrial({ kernel, companyId: company.id, employeeId, publicUrl: URL });
    await waitFor(() => kernel.workProjection(trial.work.id).status === "READY_FOR_DECISION");
    await host.idle();
    assert.equal(kernel.workerRun(trial.workerRun.id).state, "COMPLETED");
    assert.equal(kernel.modelExecutionReceipt(trial.workerRun.id), null,
      "a deterministic TestModelBackend run is never presented as a real model call");
    assert.equal(kernel.toolActionReceipts({ workerRunId: trial.workerRun.id })[0].actuatorKind, null,
      "a fixture WebReader is never attested as network egress");
    assert.equal(kernel.reviews({ workId: trial.work.id })[0].verdict, "PASS");
    assert.notEqual(kernel.reviews({ workId: trial.work.id })[0].reviewerWorkerRunId, trial.workerRun.id);
    assert.equal(kernel.employeeHiring(employeeId).state, "READY_FOR_FOUNDER_CONFIRMATION",
      "Review PASS invites a Founder decision but does not hire");
    assert.equal(kernel.employeeHiring(employeeId).trial.acceptedArtifactId, null,
      "Review PASS still does not accept the trial Work");
    assert.equal(kernel.employee(employeeId).enabled, false);
    const p = kernel.workProjection(trial.work.id);
    const candidate = p.outcome.candidateArtifacts[0];
    kernel.acceptWork({ workId: trial.work.id, artifactId: candidate.id,
      artifactDigest: kernel.artifact(candidate.id).contentDigest, basis: p.decisionBasis });
    const pending = kernel.employeeHiring(employeeId);
    assert.equal(pending.state, "READY_FOR_FOUNDER_CONFIRMATION");
    assert.deepEqual(pending.capabilityEvidence.map(item => item.status), ["TRIAL_VALIDATED", "DECLARED"]);
    assert.throws(() => kernel.confirmEmployeeHire({ companyId: company.id, employeeId,
      expectedBasis: pending.basis - 1, reviewId: pending.trial.reviewId,
      artifactDigest: kernel.artifact(candidate.id).contentDigest }), { code: "HIRING_STALE_BASIS" });
    const foreign = kernel.createCompany({ name: "Other company" });
    assert.throws(() => kernel.confirmEmployeeHire({ companyId: foreign.id, employeeId,
      expectedBasis: pending.basis, reviewId: pending.trial.reviewId,
      artifactDigest: kernel.artifact(candidate.id).contentDigest }), { code: "CROSS_COMPANY_ASSIGNMENT" });
    kernel.confirmEmployeeHire({ companyId: company.id, employeeId,
      expectedBasis: pending.basis, reviewId: pending.trial.reviewId,
      artifactDigest: kernel.artifact(candidate.id).contentDigest });
    assert.equal(kernel.employeeHiring(employeeId).state, "ACTIVE");
    assert.equal(kernel.employee(employeeId).enabled, true);
    assert.equal(sessions.find(item => item.runId === trial.workerRun.id).skill, "CustomerInsight");
    await assert.rejects(sessions.find(item => item.runId === trial.workerRun.id).session.invoke({
      callId: "late", capability: WEB_READ, input: { url: URL },
    }), { code: "ABORTED" });
    const originalTrialDigest = kernel.artifact(candidate.id).contentDigest;
    driver.detach(); await host.stop(); kernel.close();
    kernel = reopenKernel(env.dir);
    assert.equal(kernel.employeeHiring(employeeId).state, "ACTIVE");
    assert.equal(kernel.employeeHiring(employeeId).trial.acceptedArtifactId, candidate.id);
    assert.equal(kernel.artifact(candidate.id).contentDigest, originalTrialDigest);
    host = createWorkerHost({ kernel, runtimeRoot: env.dir, activationResolver: activation(kernel), timeoutMs: 180_000 });
    host.start();
    const future = kernel.startConfirmedEmployeeWork({ companyId: company.id, employeeId,
      instruction: "Summarize known limits. No additional source or web access is approved." });
    await host.idle();
    assert.equal(kernel.workerRun(future.workerRun.id).state, "COMPLETED");
    assert.equal(kernel.modelExecutionReceipt(future.workerRun.id), null);
    assert.notEqual(future.workerRun.id, trial.workerRun.id);
    assert.equal(future.workerRun.employeeId, employeeId);
    assert.equal(kernel.artifacts({ workId: future.work.id }).length, 1);
    assert.equal(sessions.find(item => item.runId === future.workerRun.id).skill, "EvidenceSynthesis");
    assert.deepEqual(sessions.find(item => item.runId === future.workerRun.id).grant, []);
    kernel.setEmployeeEnabled({ employeeId, enabled: false });
    assert.equal(kernel.employeeHiring(employeeId).state, "DISABLED");
    assert.throws(() => kernel.startConfirmedEmployeeWork({ companyId: company.id, employeeId,
      instruction: "No further work" }), { code: "HIRING_NOT_CONFIRMED" });
    assert.equal(kernel.artifact(candidate.id).contentDigest, originalTrialDigest);
  } finally {
    driver?.detach(); await host?.stop();
    if (kernel.store.db.isOpen) kernel.close();
    env.cleanup();
  }
});

test("trial output without a Host-observed source cannot hire or create an Artifact", async () => {
  const env = openTempKernel();
  const { kernel } = env;
  const model = createTestModelBackend({ steps: [artifact("customer-insight-trial", JSON.stringify({
    schemaVersion: 1, observations: ["Unsupported"], hypotheses: [],
    unknowns: ["Unknown"], sourceIds: ["src_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
    limitations: "No actual source was read.",
  }))] });
  const host = createWorkerHost({ kernel, runtimeRoot: env.dir,
    activationResolver: createHiringActivationResolver({ kernel, modelBackend: model,
      reader: { async read() { throw new Error("reader must not run"); } } }), timeoutMs: 180_000 });
  try {
    const company = kernel.createCompany({ name: "Trial source fence" });
    const draft = createCustomerResearchDraft({ kernel, companyId: company.id, displayName: "Luna" });
    host.start();
    const trial = startCustomerResearchTrial({ kernel, companyId: company.id,
      employeeId: draft.employee.id, publicUrl: URL });
    await host.idle();
    assert.equal(kernel.workerRun(trial.workerRun.id).endReason, "WORKER_OUTPUT_REJECTED",
      JSON.stringify(host.reportFor(trial.workerRun.id)));
    assert.equal(host.reportFor(trial.workerRun.id)[0].detail.failureCode, "TRIAL_ARTIFACT_SOURCE_INVALID");
    assert.equal(kernel.artifacts({ workId: trial.work.id }).length, 0);
    assert.equal(kernel.employeeHiring(draft.employee.id).state, "TRIAL_FAILED");
    assert.equal(kernel.employee(draft.employee.id).enabled, false);
    assert.throws(() => kernel.confirmEmployeeHire({ companyId: company.id,
      employeeId: draft.employee.id, expectedBasis: trial.basis }), { code: "HIRING_NOT_READY" });
  } finally { await host.stop(); kernel.close(); env.cleanup(); }
});

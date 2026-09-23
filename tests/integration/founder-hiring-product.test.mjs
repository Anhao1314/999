import test from "node:test";
import assert from "node:assert/strict";
import { openTempKernel, reopenKernel } from "../support/kernel.mjs";
import { createContinuationDriver } from "../../packages/runtime/index.mjs";
import { createTestModelBackend, createWorkerHost, WEB_READ } from "../../packages/harness/index.mjs";
import { createHiringActivationResolver } from "../../packages/product/employee-hiring.mjs";
import { createFounderHiringCommands } from "../../packages/product/founder-hiring.mjs";
import { digestOf } from "../../packages/work/records.mjs";

const URL = "https://public.example/customer-research";
const final = (kind, content) => ({ type: "FINAL_RESULT", candidate: {
  resultVersion: 1, outcome: "SUCCEEDED", summary: "Bounded result", blockers: [], suggestedNextActions: [],
  proposedArtifacts: [{ kind, title: "Customer evidence", content }],
} });
const waitFor = async (predicate, diagnostic = () => "") => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`trial did not reach review: ${diagnostic()}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

test("Founder product commands atomically hire a reviewed draft, replay across restart and disable without erasing history", async () => {
  const env = openTempKernel();
  let kernel = env.kernel;
  let host;
  let driver;
  try {
    const company = kernel.createCompany({ name: "Founder Hiring Company" });
    const reviewerPosition = kernel.createPosition({ companyId: company.id, title: "Independent Reviewer",
      capabilities: ["work.review"] });
    const reviewer = kernel.createEmployee({ companyId: company.id, positionId: reviewerPosition.id,
      displayName: "Iris" });
    const model = createTestModelBackend({ steps: [
      { type: "TOOL_REQUEST", callId: "read-once", capability: WEB_READ, input: { url: URL } },
      ({ messages }) => {
        const sourceId = JSON.parse(messages.at(-1).content).output.sourceObservation.sourceId;
        return final("customer-insight-trial", JSON.stringify({ schemaVersion: 1,
          observations: ["The public product page states its own features."], hypotheses: [],
          unknowns: ["Independent customer complaints remain unknown."], sourceIds: [sourceId],
          limitations: "One vendor page does not establish customer sentiment." }));
      },
      ({ messages }) => {
        const packet = JSON.parse(messages[1].content);
        return { type: "FINAL_RESULT", candidate: { schemaVersion: 1,
          workerRunId: packet.workerRunId, generation: packet.generation, verdict: "PASS", findings: [],
          summary: "Observation and uncertainty are separated." } };
      },
    ] });
    const reader = { async read({ url }) { assert.equal(url, URL); return {
      canonicalUrl: url, title: "Public page", observedAt: "2026-09-24T00:00:00.000Z",
      contentDigest: digestOf("fixture page"), content: "Vendor product information.",
    }; } };
    host = createWorkerHost({ kernel, runtimeRoot: env.dir,
      activationResolver: createHiringActivationResolver({ kernel, modelBackend: model, reader }),
      timeoutMs: 180_000 });
    driver = createContinuationDriver({ kernel });
    host.start();
    const commands = createFounderHiringCommands({ kernel, trialExecutionReady: () => true });
    const create = { requestId: "hiring-create-1", companyId: company.id, name: "Luna",
      positionTitle: "Customer Researcher" };
    assert.throws(() => commands.CreateEmployeeDraft({ ...create, proven: true }), { code: "HIRING_INPUT_INVALID" });
    assert.throws(() => commands.CreateEmployeeDraft({ ...create, authority: true }), { code: "HIRING_INPUT_INVALID" });
    assert.throws(() => commands.CreateEmployeeDraft({ ...create, apiKey: "sk-forged" }), { code: "HIRING_INPUT_INVALID" });
    const created = commands.CreateEmployeeDraft(create);
    assert.deepEqual(commands.CreateEmployeeDraft(create), created);
    assert.throws(() => commands.CreateEmployeeDraft({ ...create, name: "Different" }), { code: "HIRING_REQUEST_CONFLICT" });
    assert.equal(kernel.employeeHiring(created.employeeId).state, "DRAFT");
    assert.deepEqual(kernel.employeeHiring(created.employeeId).capabilityEvidence.map(item => item.status),
      ["DECLARED", "DECLARED"]);
    const trialInput = { requestId: "hiring-trial-1", companyId: company.id,
      employeeId: created.employeeId, publicUrl: URL };
    const started = commands.StartEmployeeTrial(trialInput);
    assert.deepEqual(commands.StartEmployeeTrial(trialInput), started);
    assert.equal(kernel.works(company.id).filter(work => work.id === started.trialWorkId).length, 1);
    assert.throws(() => commands.StartEmployeeTrial({ ...trialInput, requestId: "hiring-trial-2" }),
      { code: "HIRING_TRIAL_UNAVAILABLE" });
    await waitFor(() => kernel.workProjection(started.trialWorkId).status === "READY_FOR_DECISION",
      () => JSON.stringify({ status: kernel.workProjection(started.trialWorkId).status,
        report: host.reportFor(started.workerRunId), runs: kernel.workerRuns({ workId: started.trialWorkId })
          .map(run => ({ id: run.id, state: run.state, endReason: run.endReason })) }));
    await host.idle();
    const before = kernel.employeeHiring(created.employeeId);
    assert.equal(before.state, "READY_FOR_FOUNDER_CONFIRMATION");
    assert.equal(before.enabled, false);
    assert.equal(before.trial.acceptedArtifactId, null);
    assert.equal(kernel.employeeHiring(reviewer.id).origin, "LEGACY_OR_SEEDED");
    const projection = kernel.workProjection(started.trialWorkId);
    const confirm = { requestId: "hiring-confirm-1", companyId: company.id, employeeId: created.employeeId,
      trialWorkId: started.trialWorkId, artifactId: before.trial.reviewedArtifactId,
      artifactDigest: before.trial.reviewedArtifactDigest, reviewId: before.trial.reviewId,
      expectedHiringBasis: before.basis, expectedWorkBasis: projection.decisionBasis };
    const foreign = kernel.createCompany({ name: "Foreign Company" });
    assert.throws(() => commands.StartEmployeeTrial({ ...trialInput,
      requestId: "foreign-trial", companyId: foreign.id }), { code: "HIRING_CROSS_COMPANY" });
    assert.throws(() => commands.ConfirmEmployeeHire({ ...confirm, companyId: foreign.id }),
      { code: "HIRING_CROSS_COMPANY" });
    assert.throws(() => commands.ConfirmEmployeeHire({ ...confirm, expectedHiringBasis: before.basis - 1 }),
      { code: "HIRING_BASIS_STALE" });
    assert.throws(() => commands.ConfirmEmployeeHire({ ...confirm, expectedWorkBasis: projection.decisionBasis - 1 }),
      { code: "HIRING_BASIS_STALE" });
    assert.throws(() => commands.ConfirmEmployeeHire({ ...confirm, artifactDigest: digestOf("forged") }),
      { code: "HIRING_EVIDENCE_MISMATCH" });
    assert.throws(() => commands.ConfirmEmployeeHire({ ...confirm, reviewId: "rev_forged" }),
      { code: "HIRING_EVIDENCE_MISMATCH" });
    assert.equal(kernel.employee(created.employeeId).enabled, false);
    assert.equal(kernel.workProjection(started.trialWorkId).outcome.accepted, null);
    const hired = commands.ConfirmEmployeeHire(confirm);
    assert.equal(hired.lifecycleState, "ACTIVE");
    assert.deepEqual(commands.ConfirmEmployeeHire(confirm), hired);
    assert.equal(kernel.employeeHiring(created.employeeId).state, "ACTIVE");
    assert.equal(kernel.workProjection(started.trialWorkId).outcome.accepted.artifactId, confirm.artifactId);
    assert.throws(() => commands.ConfirmEmployeeHire({ ...confirm, requestId: "hiring-confirm-2" }),
      { code: "HIRING_ALREADY_ACTIVE" });
    const originalDigest = kernel.artifact(confirm.artifactId).contentDigest;
    driver.detach(); await host.stop(); kernel.close();
    kernel = reopenKernel(env.dir);
    const resumed = createFounderHiringCommands({ kernel, trialExecutionReady: () => false });
    assert.deepEqual(resumed.CreateEmployeeDraft(create), created);
    assert.deepEqual(resumed.StartEmployeeTrial(trialInput), started);
    assert.deepEqual(resumed.ConfirmEmployeeHire(confirm), hired);
    assert.equal(kernel.employeeHiring(created.employeeId).state, "ACTIVE");
    const disable = { requestId: "hiring-disable-1", companyId: company.id,
      employeeId: created.employeeId, expectedHiringBasis: kernel.employeeHiring(created.employeeId).basis };
    const disabled = resumed.DisableEmployee(disable);
    assert.equal(disabled.lifecycleState, "DISABLED");
    assert.deepEqual(resumed.DisableEmployee(disable), disabled);
    assert.throws(() => resumed.DisableEmployee({ ...disable, requestId: "foreign-disable",
      companyId: foreign.id }), { code: "HIRING_CROSS_COMPANY" });
    assert.throws(() => resumed.DisableEmployee({ ...disable, requestId: "hiring-disable-2" }),
      { code: "HIRING_ALREADY_DISABLED" });
    assert.equal(kernel.artifact(confirm.artifactId).contentDigest, originalDigest);
    assert.equal(kernel.review(confirm.reviewId).targetArtifactDigest, originalDigest);
    const normalWork = kernel.createWork({ companyId: company.id, title: "Future Work", intent: "Later" });
    const normalTask = kernel.createTask({ workId: normalWork.id, title: "Analyze", intent: "Later",
      requiredCapabilities: ["customer.research"] });
    assert.throws(() => kernel.assignTask({ taskId: normalTask.id, employeeId: created.employeeId }),
      { code: "EMPLOYEE_DISABLED" });
    assert.equal(kernel.store.founderHiringCommandReceipt(create.requestId).employeeId, created.employeeId);
    assert.equal(kernel.store.founderHiringCommandReceipt(confirm.requestId).result.artifactId, confirm.artifactId);
  } finally {
    driver?.detach(); await host?.stop(); if (kernel.store.db.isOpen) kernel.close(); env.cleanup();
  }
});

test("a rejected trial remains failed and the Founder product command cannot hire it", async () => {
  const env = openTempKernel();
  const { kernel } = env;
  const model = createTestModelBackend({ steps: [final("customer-insight-trial", JSON.stringify({
    schemaVersion: 1, observations: ["Unsupported claim"], hypotheses: [],
    unknowns: ["Actual evidence unknown"], sourceIds: ["src_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
    limitations: "No source was observed.",
  }))] });
  const host = createWorkerHost({ kernel, runtimeRoot: env.dir,
    activationResolver: createHiringActivationResolver({ kernel, modelBackend: model,
      reader: { async read() { throw new Error("reader must not be used"); } } }), timeoutMs: 180_000 });
  try {
    const company = kernel.createCompany({ name: "Failed trial" });
    const commands = createFounderHiringCommands({ kernel, trialExecutionReady: () => true });
    const created = commands.CreateEmployeeDraft({ requestId: "failed-create", companyId: company.id,
      name: "Luna", positionTitle: "Customer Researcher" });
    host.start();
    const trial = commands.StartEmployeeTrial({ requestId: "failed-trial", companyId: company.id,
      employeeId: created.employeeId, publicUrl: URL });
    await host.idle();
    assert.equal(kernel.employeeHiring(created.employeeId).state, "TRIAL_FAILED");
    assert.equal(kernel.artifacts({ workId: trial.trialWorkId }).length, 0);
    assert.throws(() => commands.ConfirmEmployeeHire({ requestId: "failed-confirm", companyId: company.id,
      employeeId: created.employeeId, trialWorkId: trial.trialWorkId,
      artifactId: "art_missing", artifactDigest: digestOf("missing"), reviewId: "rev_missing",
      expectedHiringBasis: kernel.employeeHiring(created.employeeId).basis,
      expectedWorkBasis: kernel.workProjection(trial.trialWorkId).decisionBasis }),
    { code: "HIRING_TRIAL_NOT_PASSED" });
    assert.equal(kernel.store.founderHiringCommandReceipt("failed-confirm"), null);
    assert.equal(kernel.employee(created.employeeId).enabled, false);
  } finally { await host.stop(); kernel.close(); env.cleanup(); }
});

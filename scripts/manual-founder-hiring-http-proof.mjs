// Manual, bounded, real HTTP Product Command proof. The key stays in the
// execution environment; this script prints only Runtime identifiers/facts.
import { resolve } from "node:path";
import { startRuntime } from "./lib/runtime-process.mjs";
import { openKernel } from "../packages/runtime/index.mjs";

const dir = process.env.FLOWCREDIT_HIRING_PROOF_DIR;
const key = process.env.FLOWCREDIT_DEEPSEEK_API_KEY;
delete process.env.FLOWCREDIT_DEEPSEEK_API_KEY;
if (!dir || resolve(dir).startsWith(resolve(import.meta.dirname, "..")) || !key)
  throw new Error("an external proof directory and an execution credential are required");
const source = "https://www.petsafe.com/p/smart-feed/PFD00-16828/";
let runtime;
let reopened;
let kernel;
const post = async (running, command, input) => {
  const response = await fetch(`${running.base}/product/commands`, { method: "POST",
    headers: { "content-type": "application/json", origin: running.base },
    body: JSON.stringify({ command, input }) });
  const body = await response.json();
  if (!response.ok) throw new Error(`product command ${command} failed: ${body?.error?.code ?? response.status}`);
  return body.result;
};
try {
  runtime = await startRuntime({ dir, coordination: true, workerBackend: "deepseek-hiring",
    extraEnv: { FLOWCREDIT_DEEPSEEK_API_KEY: key } });
  const company = await runtime.command("createCompany", { name: "Founder Hiring Product Proof" });
  const reviewerPosition = await runtime.command("createPosition", { companyId: company.id,
    title: "Independent Reviewer", capabilities: ["work.review"] });
  const reviewer = await runtime.command("createEmployee", { companyId: company.id,
    positionId: reviewerPosition.id, displayName: "Iris" });
  const createInput = { requestId: "http-real-create-1", companyId: company.id,
    name: "Luna", positionTitle: "Customer Researcher" };
  const created = await post(runtime, "CreateEmployeeDraft", createInput);
  const initial = await runtime.json(`/experience/employees/${created.employeeId}/hiring`);
  const trialInput = { requestId: "http-real-trial-1", companyId: company.id,
    employeeId: created.employeeId, publicUrl: source };
  const started = await post(runtime, "StartEmployeeTrial", trialInput);
  const deadline = Date.now() + 8 * 60_000;
  let ready;
  while (Date.now() < deadline) {
    ready = await runtime.json(`/experience/employees/${created.employeeId}/hiring`);
    if (ready.state === "READY_FOR_FOUNDER_CONFIRMATION" || ready.state === "TRIAL_FAILED") break;
    await new Promise(resolveWait => setTimeout(resolveWait, 500));
  }
  if (ready?.state !== "READY_FOR_FOUNDER_CONFIRMATION")
    throw new Error(`real HTTP trial did not pass: ${ready?.state ?? "TIMEOUT"}`);
  const work = await runtime.json(`/works/${started.trialWorkId}`);
  const confirmInput = { requestId: "http-real-confirm-1", companyId: company.id,
    employeeId: created.employeeId, trialWorkId: started.trialWorkId,
    artifactId: ready.trial.reviewedArtifactId, artifactDigest: ready.trial.reviewedArtifactDigest,
    reviewId: ready.trial.reviewId, expectedHiringBasis: ready.basis,
    expectedWorkBasis: work.decisionBasis };
  const confirmed = await post(runtime, "ConfirmEmployeeHire", confirmInput);
  const active = await runtime.json(`/experience/employees/${created.employeeId}/hiring`);
  await runtime.stop(); runtime = null;
  reopened = await startRuntime({ dir });
  const afterRestart = await reopened.json(`/experience/employees/${created.employeeId}/hiring`);
  const replayed = [
    await post(reopened, "CreateEmployeeDraft", createInput),
    await post(reopened, "StartEmployeeTrial", trialInput),
    await post(reopened, "ConfirmEmployeeHire", confirmInput),
  ];
  await reopened.stop(); reopened = null;
  kernel = openKernel({ dir });
  const producer = kernel.workerRun(started.workerRunId);
  const reviews = kernel.reviews({ workId: started.trialWorkId });
  const pass = reviews.find(review => review.verdict === "PASS" &&
    review.targetArtifactId === confirmInput.artifactId &&
    review.targetArtifactDigest === confirmInput.artifactDigest);
  const reviewerRun = pass ? kernel.workerRun(pass.reviewerWorkerRunId) : null;
  const toolReceipts = kernel.toolActionReceipts({ workerRunId: producer.id });
  const summary = { employeeId: created.employeeId, trialWorkId: started.trialWorkId,
    producerWorkerRunId: producer.id, reviewerWorkerRunId: reviewerRun?.id ?? null,
    initialState: initial.state, readyState: ready.state, confirmedState: confirmed.lifecycleState,
    restartedState: afterRestart.state, replaySameResults: JSON.stringify(replayed) ===
      JSON.stringify([created, started, confirmed]),
    realModelCalls: kernel.modelExecutionReceipt(producer.id)?.successfulCalls ?? 0,
    reviewerModelCalls: reviewerRun ? kernel.modelExecutionReceipt(reviewerRun.id)?.successfulCalls ?? 0 : 0,
    networkReadReceipts: toolReceipts.filter(receipt => receipt.actuatorKind === "NETWORK_WEB_READ").length,
    sourceObservations: kernel.sourceObservations({ workerRunId: producer.id }).length,
    artifactDigestMatches: kernel.artifact(confirmInput.artifactId)?.contentDigest === confirmInput.artifactDigest,
    independentReview: reviewerRun?.employeeId === reviewer.id && reviewerRun.employeeId !== producer.employeeId,
    founderConfirmationRecorded: Boolean(active.founderConfirmation && afterRestart.founderConfirmation),
    productCommandReceipts: [createInput.requestId, trialInput.requestId, confirmInput.requestId]
      .filter(requestId => kernel.store.founderHiringCommandReceipt(requestId)).length };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (summary.restartedState !== "ACTIVE" || !summary.replaySameResults || summary.realModelCalls < 1 ||
      summary.reviewerModelCalls < 1 || summary.networkReadReceipts !== 1 ||
      summary.sourceObservations !== 1 || !summary.artifactDigestMatches ||
      !summary.independentReview || !summary.founderConfirmationRecorded ||
      summary.productCommandReceipts !== 3) process.exitCode = 1;
} finally {
  await runtime?.stop(); await reopened?.stop();
  if (kernel?.store.db.isOpen) kernel.close();
}

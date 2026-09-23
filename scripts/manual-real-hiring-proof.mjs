// Bounded manual backend Reality Proof. Requires a DeepSeek credential in the
// process environment, consumes it immediately, and stores only Runtime facts.
import { writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openKernel, createContinuationDriver, createProcessSecretProvider } from "../packages/runtime/index.mjs";
import { createDeepSeekModelBackend, createWorkerHost } from "../packages/harness/index.mjs";
import { createHiringActivationResolver } from "../packages/product/employee-hiring.mjs";
import { createFounderHiringCommands } from "../packages/product/founder-hiring.mjs";

const dir = process.env.FLOWCREDIT_HIRING_PROOF_DIR;
if (!dir || resolve(dir).startsWith(resolve(import.meta.dirname, "..")))
  throw new Error("FLOWCREDIT_HIRING_PROOF_DIR must be outside the repository");
const phase = process.argv[2];
const proofFile = join(dir, "hiring-proof.json");
const SOURCE_URL = "https://www.petsafe.com/p/smart-feed/PFD00-16828/";

function snapshot(kernel, employeeId, trialWorkId, futureWorkId = null) {
  const hiring = kernel.employeeHiring(employeeId);
  const trialRuns = kernel.workerRuns({ workId: trialWorkId });
  const observations = trialRuns.flatMap(run => kernel.sourceObservations({ workerRunId: run.id }));
  const reviews = kernel.reviews({ workId: trialWorkId });
  const futureRuns = futureWorkId ? kernel.workerRuns({ workId: futureWorkId }) : [];
  return { employeeId, state: hiring.state, enabled: hiring.enabled,
    positionId: hiring.positionId, declaredCapabilities: hiring.declaredCapabilities,
    capabilityEvidence: hiring.capabilityEvidence.map(item => ({ capability: item.capability, status: item.status,
      reviewId: item.reviewId ?? null, artifactDigest: item.artifactDigest ?? null })),
    trialWorkId, trialRuns: trialRuns.map(run => ({ id: run.id, state: run.state,
      backend: kernel.workerExecutionBinding(run.id)?.backendVersion ?? null,
      modelReceipt: kernel.modelExecutionReceipt(run.id) ? {
        backendType: kernel.modelExecutionReceipt(run.id).backendType,
        skillId: kernel.modelExecutionReceipt(run.id).skillId,
        skillVersion: kernel.modelExecutionReceipt(run.id).skillVersion,
        successfulCalls: kernel.modelExecutionReceipt(run.id).successfulCalls } : null })),
    sourceObservationCount: observations.length,
    trialSourceOwnedByProducer: observations.length === 1 &&
      observations[0].workerRunId === trialRuns.find(run => run.employeeId === employeeId)?.id,
    networkReadReceiptCount: trialRuns.flatMap(run => kernel.toolActionReceipts({ workerRunId: run.id }))
      .filter(receipt => receipt.actuatorKind === "NETWORK_WEB_READ").length,
    trialArtifactId: hiring.trial?.acceptedArtifactId ?? null,
    reviews: reviews.map(review => ({ id: review.id, verdict: review.verdict,
      reviewerWorkerRunId: review.reviewerWorkerRunId,
      targetArtifactId: review.targetArtifactId, targetArtifactDigest: review.targetArtifactDigest })),
    founderConfirmation: hiring.founderConfirmation,
    futureWorkId, futureRuns: futureRuns.map(run => ({ id: run.id, employeeId: run.employeeId,
      state: run.state, backend: kernel.workerExecutionBinding(run.id)?.backendVersion ?? null,
      modelReceipt: kernel.modelExecutionReceipt(run.id) ? {
        backendType: kernel.modelExecutionReceipt(run.id).backendType,
        skillId: kernel.modelExecutionReceipt(run.id).skillId,
        skillVersion: kernel.modelExecutionReceipt(run.id).skillVersion,
        successfulCalls: kernel.modelExecutionReceipt(run.id).successfulCalls } : null })),
    futureToolReceiptCount: futureRuns.reduce((count, run) =>
      count + kernel.toolActionReceipts({ workerRunId: run.id }).length, 0),
    futureArtifactCount: futureWorkId ? kernel.artifacts({ workId: futureWorkId }).length : 0,
    productCommandReceipts: ["hiring-real-create-1", "hiring-real-trial-1", "hiring-real-confirm-1"]
      .map(requestId => kernel.store.founderHiringCommandReceipt(requestId))
      .filter(Boolean).map(receipt => ({ command: receipt.command, employeeId: receipt.employeeId })) };
}

async function settle({ kernel, driver, host, workId }) {
  const deadline = Date.now() + 8 * 60_000;
  while (Date.now() < deadline) {
    driver.driveWork(workId);
    await host.idle();
    driver.driveWork(workId);
    const projection = kernel.workProjection(workId);
    if (["READY_FOR_DECISION", "NEEDS_ATTENTION", "COMPLETED"].includes(projection.status) &&
        kernel.workerRuns({ workId, state: "RUNNING" }).length === 0) return projection;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Hiring proof Work did not settle within its bound");
}

if (phase === "run") {
  const secrets = createProcessSecretProvider();
  if (!secrets.has("model.deepseek")) throw new Error("DeepSeek credential unavailable");
  let kernel = openKernel({ dir });
  const backend = createDeepSeekModelBackend({ secretProvider: secrets });
  let host = null;
  let driver = null;
  try {
    const company = kernel.createCompany({ name: "Bounded Hiring Reality Proof" });
    const reviewerPosition = kernel.createPosition({ companyId: company.id, title: "Independent Reviewer",
      capabilities: ["work.review"] });
    kernel.createEmployee({ companyId: company.id, positionId: reviewerPosition.id, displayName: "Iris" });
    const commands = createFounderHiringCommands({ kernel, trialExecutionReady: () => true });
    const draft = commands.CreateEmployeeDraft({ requestId: "hiring-real-create-1",
      companyId: company.id, name: "Luna", positionTitle: "Customer Researcher" });
    const employeeId = draft.employeeId;
    host = createWorkerHost({ kernel, runtimeRoot: dir,
      activationResolver: createHiringActivationResolver({ kernel, modelBackend: backend }), timeoutMs: 180_000 });
    driver = createContinuationDriver({ kernel });
    host.start();
    const trial = commands.StartEmployeeTrial({ requestId: "hiring-real-trial-1",
      companyId: company.id, employeeId, publicUrl: SOURCE_URL });
    const trialProjection = await settle({ kernel, driver, host, workId: trial.trialWorkId });
    const trialReport = host.reportFor(trial.workerRunId)[0] ?? null;
    const modelUsed = trialReport?.detail?.evidence?.modelExecution?.backendType === "deepseek-chat-completions";
    const observed = kernel.sourceObservations({ workerRunId: trial.workerRunId });
    let confirmed = false;
    if (trialProjection.status === "READY_FOR_DECISION" && observed.length > 0 && modelUsed &&
        kernel.reviews({ workId: trial.trialWorkId }).some(review => review.verdict === "PASS")) {
      const pending = kernel.employeeHiring(employeeId);
      if (pending.state === "READY_FOR_FOUNDER_CONFIRMATION") {
        const result = commands.ConfirmEmployeeHire({ requestId: "hiring-real-confirm-1",
          companyId: company.id, employeeId, trialWorkId: trial.trialWorkId,
          artifactId: pending.trial.reviewedArtifactId,
          artifactDigest: pending.trial.reviewedArtifactDigest,
          reviewId: pending.trial.reviewId, expectedHiringBasis: pending.basis,
          expectedWorkBasis: trialProjection.decisionBasis });
        confirmed = result.lifecycleState === "ACTIVE";
      }
    }
    driver.detach(); await host.stop(); kernel.close();
    kernel = openKernel({ dir });
    let futureWorkId = null;
    let futureGrantCount = null;
    if (confirmed) {
      const trialArtifact = kernel.artifact(kernel.employeeHiring(employeeId).trial.acceptedArtifactId);
      host = createWorkerHost({ kernel, runtimeRoot: dir,
        activationResolver: createHiringActivationResolver({ kernel, modelBackend: backend }), timeoutMs: 180_000 });
      host.start();
      const future = kernel.startConfirmedEmployeeWork({ companyId: company.id, employeeId,
        instruction: `Synthesize the limits of accepted trial Artifact ${trialArtifact.id} with digest ${trialArtifact.contentDigest}. ` +
          `Its bounded content is: ${trialArtifact.content.slice(0, 400)}. Do not claim independent customer complaints.` });
      futureWorkId = future.work.id;
      await host.idle();
      futureGrantCount = host.publicRunEvidence(future.workerRun.id)?.grantedTools?.length ?? null;
    }
    await writeFile(proofFile, JSON.stringify({ companyId: company.id, employeeId,
      trialWorkId: trial.trialWorkId, futureWorkId }), { mode: 0o600 });
    process.stdout.write(JSON.stringify({ ...snapshot(kernel, employeeId, trial.trialWorkId, futureWorkId),
      realDeepSeekTrial: modelUsed, trialToolRead: observed.length > 0,
      trialHostStatus: trialReport?.status ?? null,
      trialFailureCode: trialReport?.detail?.failureCode ?? trialReport?.detail?.evidence?.failureCode ?? null,
      explicitFounderConfirmation: confirmed, futureGrantCount }) + "\n");
    if (!confirmed || futureWorkId === null || futureGrantCount !== 0) process.exitCode = 1;
  } finally {
    driver?.detach(); await host?.stop(); if (kernel.store.db.isOpen) kernel.close();
  }
} else if (phase === "verify") {
  const proof = JSON.parse(await readFile(proofFile, "utf8"));
  const kernel = openKernel({ dir });
  try { process.stdout.write(JSON.stringify(snapshot(kernel, proof.employeeId,
    proof.trialWorkId, proof.futureWorkId)) + "\n"); }
  finally { kernel.close(); }
} else throw new Error("usage: manual-real-hiring-proof.mjs run|verify");

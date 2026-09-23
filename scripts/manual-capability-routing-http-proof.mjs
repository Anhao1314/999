// Manual real DeepSeek routing proof from an already reviewed/hired Employee
// store. Copies the closed SQLite file into a fresh external Runtime directory.
// The new Work contains capability + accepted evidence, never Employee identity.
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startRuntime } from "./lib/runtime-process.mjs";
import { openKernel, STORE_FILE_NAME } from "../packages/runtime/index.mjs";

const sourceDir = process.env.FLOWCREDIT_ROUTING_SOURCE_DIR;
const key = process.env.FLOWCREDIT_DEEPSEEK_API_KEY;
delete process.env.FLOWCREDIT_DEEPSEEK_API_KEY;
if (!sourceDir || !key || resolve(sourceDir).startsWith(resolve(import.meta.dirname, "..")))
  throw new Error("external hired-Employee source store and execution credential are required");
const dir = mkdtempSync(join(tmpdir(), "relay-routing-proof-"));
copyFileSync(join(sourceDir, STORE_FILE_NAME), join(dir, STORE_FILE_NAME));
let kernel = openKernel({ dir });
let runtime;
try {
  const candidates = kernel.companies().flatMap(company => kernel.employees(company.id)
    .map(employee => ({ company, employee, hiring: kernel.employeeHiring(employee.id) }))
    .filter(item => item.hiring.origin === "FOUNDER_DRAFT" && item.hiring.state === "ACTIVE" &&
      item.hiring.capabilityEvidence.some(evidence => evidence.capability === "customer.research" &&
        evidence.status === "TRIAL_VALIDATED") && item.hiring.trial?.acceptedArtifactId));
  if (candidates.length !== 1) throw new Error(`expected exactly one hired researcher, found ${candidates.length}`);
  const { company, employee, hiring } = candidates[0];
  const evidenceArtifactId = hiring.trial.acceptedArtifactId;
  const prior = kernel.artifact(evidenceArtifactId);
  const priorRun = kernel.workerRun(prior.workerRunId);
  if (!kernel.modelExecutionReceipt(priorRun.id)?.successfulCalls ||
      kernel.sourceObservations({ workerRunId: priorRun.id }).length !== 1)
    throw new Error("source store lacks verified real trial execution");
  kernel.close(); kernel = null;
  runtime = await startRuntime({ dir, coordination: true, workerBackend: "deepseek-hiring",
    extraEnv: { FLOWCREDIT_DEEPSEEK_API_KEY: key } });
  const created = await runtime.command("createCapabilityResearchWork", {
    companyId: company.id, title: "Customer research from accepted evidence",
    instruction: "Summarize customer hypotheses and evidence gaps from the accepted trial. Make no new customer testimony claims.",
    evidenceArtifactId,
  });
  if (created.work.intent.includes(employee.id) || created.work.intent.includes(employee.displayName))
    throw new Error("new Work accidentally contains Employee identity");
  const deadline = Date.now() + 180_000;
  let status;
  while (Date.now() < deadline) {
    status = await runtime.json(`/works/${created.work.id}`);
    if (["READY_FOR_DECISION", "NEEDS_ATTENTION"].includes(status.status)) break;
    await new Promise(resolveWait => setTimeout(resolveWait, 500));
  }
  await runtime.stop(); runtime = null;
  kernel = openKernel({ dir });
  const assignment = kernel.assignment(created.task.id);
  const run = kernel.workerRuns({ taskId: created.task.id })[0];
  const artifacts = kernel.artifacts({ workId: created.work.id });
  const basis = kernel.assignmentRoutingBasis(created.task.id);
  const receipt = run ? kernel.modelExecutionReceipt(run.id) : null;
  const summary = {
    proofDir: dir, sourceTrialWorkId: hiring.trial.workId, workId: created.work.id,
    taskId: created.task.id, selectedEmployeeId: assignment?.employeeId ?? null,
    expectedEmployeeId: employee.id, selectionPolicy: basis?.policyVersion ?? null,
    selectionEvidence: basis?.evidence ?? null, selectionBasisDigest: basis?.digest ?? null,
    workHasEmployeeIdentity: false, workerRunId: run?.id ?? null,
    workerRunState: run?.state ?? null, realModelCalls: receipt?.successfulCalls ?? 0,
    artifactId: artifacts[0]?.id ?? null, artifactDigest: artifacts[0]?.contentDigest ?? null,
    futureToolReceipts: run ? kernel.toolActionReceipts({ workerRunId: run.id }).length : 0,
    futureSourceObservations: run ? kernel.sourceObservations({ workerRunId: run.id }).length : 0,
    schemaVersion: kernel.store.schemaVersion,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  if (assignment?.employeeId !== employee.id || basis?.evidence !== "TRIAL_VALIDATED" ||
      run?.state !== "COMPLETED" || !receipt?.successfulCalls || artifacts.length !== 1 ||
      summary.futureToolReceipts !== 0 || summary.futureSourceObservations !== 0) process.exitCode = 1;
} finally {
  await runtime?.stop();
  if (kernel?.store.db.isOpen) kernel.close();
}

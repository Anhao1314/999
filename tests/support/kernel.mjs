// Shared fixtures for kernel tests. Uses real store directories in the OS temp
// directory; nothing here touches the repository working tree.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKernel } from "../../packages/runtime/index.mjs";

export function tempStoreDir() {
  return mkdtempSync(join(tmpdir(), "flowcredit-kernel-"));
}

export function openTempKernel() {
  const dir = tempStoreDir();
  return {
    dir,
    kernel: openKernel({ dir }),
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function reopenKernel(dir) {
  return openKernel({ dir });
}

export function seedCompanyAndWork(
  kernel,
  {
    companyName = "Ultraviolet Labs",
    workTitle = "Launch readiness",
    workIntent = "The launch must not slip for avoidable reasons",
  } = {},
) {
  const company = kernel.createCompany({ name: companyName });
  const work = kernel.createWork({
    companyId: company.id,
    title: workTitle,
    intent: workIntent,
  });
  return { company, work };
}

export function seedTask(
  kernel,
  workId,
  {
    title = "Draft the readiness checklist",
    intent = "One checklist the founder can act on",
  } = {},
) {
  return kernel.createTask({ workId, title, intent });
}

// Generic workforce fixtures: no employee name and no capability id from the
// shipped seed — the core must work for any company.
export function seedPosition(
  kernel,
  companyId,
  { title = "Analyst", capabilities = ["capability.x"], id } = {},
) {
  return kernel.createPosition({
    companyId,
    title,
    capabilities,
    ...(id ? { id } : {}),
  });
}

export function seedEmployee(
  kernel,
  companyId,
  {
    positionId,
    displayName = "Analyst A",
    enabled = true,
    capabilities = ["capability.x"],
    id,
  } = {},
) {
  const position =
    (positionId ? kernel.position(positionId) : null) ??
    seedPosition(kernel, companyId, { capabilities });
  const employee = kernel.createEmployee({
    companyId,
    positionId: position.id,
    displayName,
    enabled,
    ...(id ? { id } : {}),
  });
  return { position, employee };
}

export function seedStaffedTask(
  kernel,
  {
    capabilities = ["capability.x"],
    requiredCapabilities = ["capability.x"],
    displayName = "Analyst A",
    taskTitle = "Produce the analysis",
  } = {},
) {
  const { company, work } = seedCompanyAndWork(kernel);
  const task = kernel.createTask({
    workId: work.id,
    title: taskTitle,
    intent: "One output the founder can act on",
    requiredCapabilities,
  });
  const { position, employee } = seedEmployee(kernel, company.id, {
    displayName,
    capabilities,
  });
  const assignment = kernel.assignTask({
    taskId: task.id,
    employeeId: employee.id,
    reason: "fixture assignment",
  });
  return { company, work, task, position, employee, assignment };
}

// A company with two employees: one who produces, one whose position carries
// the review capability. Nothing here uses a shipped employee name.
export function seedReviewTeam(
  kernel,
  {
    producerName = "Producer A",
    reviewerName = "Reviewer B",
    producerCapabilities = ["capability.produce"],
    reviewerCapabilities = ["capability.review"],
  } = {},
) {
  const { company, work } = seedCompanyAndWork(kernel);
  const producerPosition = kernel.createPosition({
    companyId: company.id,
    title: "Producer",
    capabilities: producerCapabilities,
  });
  const reviewerPosition = kernel.createPosition({
    companyId: company.id,
    title: "Reviewer",
    capabilities: reviewerCapabilities,
  });
  const producer = kernel.createEmployee({
    companyId: company.id,
    positionId: producerPosition.id,
    displayName: producerName,
  });
  const reviewer = kernel.createEmployee({
    companyId: company.id,
    positionId: reviewerPosition.id,
    displayName: reviewerName,
  });
  return { company, work, producer, reviewer, producerPosition, reviewerPosition };
}

// The producing half of a review flow: work → task (review required) → assigned
// → running → artifact recorded. Returns everything the next step needs.
export function seedTaskInReview(
  kernel,
  {
    capabilities = ["capability.produce"],
    reviewCapabilities = ["capability.review"],
    taskTitle = "Produce the analysis",
    artifactTitle = "Draft analysis",
    artifactContent = "draft v1\n",
  } = {},
) {
  const team = seedReviewTeam(kernel, {
    producerCapabilities: capabilities,
    reviewerCapabilities: reviewCapabilities,
  });
  const task = kernel.createTask({
    workId: team.work.id,
    title: taskTitle,
    intent: "One output the founder can act on",
  });
  kernel.setTaskRequirements({
    taskId: task.id,
    requiredCapabilities: capabilities,
    reviewCapabilities,
  });
  kernel.assignTask({ taskId: task.id, employeeId: team.producer.id, reason: "fixture" });
  const started = kernel.startWorkerRun({ taskId: task.id });
  const artifact = kernel.recordArtifact({
    taskId: task.id,
    generation: started.generation,
    workerRunId: started.workerRun.id,
    kind: "document",
    title: artifactTitle,
    content: artifactContent,
  });
  return { ...team, task, generation: started.generation, workerRun: started.workerRun, artifact };
}

// A reviewer run in progress for the review task created by requestReview.
export function startReviewRun(kernel, { reviewTaskId, reviewerId }) {
  kernel.assignTask({ taskId: reviewTaskId, employeeId: reviewerId, reason: "fixture" });
  return kernel.startWorkerRun({ taskId: reviewTaskId });
}

// Submit one review verdict: assign the reviewer, start the run, record the
// judgment. A review is ordinary work, so it takes the ordinary path.
export function reviewArtifact(
  kernel,
  { reviewTaskId, reviewerId, verdict, summary, findings = [] },
) {
  const run = startReviewRun(kernel, { reviewTaskId, reviewerId });
  return kernel.submitReview({
    reviewTaskId,
    generation: run.generation,
    verdict,
    summary,
    findings,
  }).review;
}

// The whole v0B2 protocol, ending exactly where v0B3 begins: a Work that went
// through a revision and a passing second review, leaving one current outcome
// candidate and no Founder Decision. Nothing here is a shortcut — every step is
// a public command.
export function seedWorkReadyForDecision(kernel) {
  const flow = seedTaskInReview(kernel);
  const firstHandoff = kernel.requestReview({
    taskId: flow.task.id,
    generation: flow.generation,
  });
  const requested = reviewArtifact(kernel, {
    reviewTaskId: firstHandoff.reviewTask.id,
    reviewerId: flow.reviewer.id,
    verdict: "REQUEST_REVISION",
    summary: "The recommendation is not supported by the evidence supplied.",
    findings: ["Add the downside case."],
  });
  const repair = kernel.createRepairTask({ reviewId: requested.id });
  const repairRun = kernel.startWorkerRun({ taskId: repair.task.id });
  const replacement = kernel.recordArtifact({
    taskId: repair.task.id,
    generation: repairRun.generation,
    workerRunId: repairRun.workerRun.id,
    supersedesArtifactId: flow.artifact.id,
    kind: "document",
    title: "Draft analysis v2",
    content: "draft v2 with the downside case\n",
  });
  const secondHandoff = kernel.requestReview({
    taskId: repair.task.id,
    generation: repairRun.generation,
  });
  const passed = reviewArtifact(kernel, {
    reviewTaskId: secondHandoff.reviewTask.id,
    reviewerId: flow.reviewer.id,
    verdict: "PASS",
    summary: "The recommendation now matches the evidence supplied.",
  });
  return {
    ...flow,
    firstArtifact: flow.artifact,
    artifact: replacement,
    requested,
    passed,
    repair,
    reviewTask: secondHandoff.reviewTask,
  };
}

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

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

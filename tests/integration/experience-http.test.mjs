// Workforce Experience v0A — the HTTP read surface.
// Contract: docs/contracts/workforce-experience-v0.md §9–§10.
//
// The Experience endpoints are GET-only product reads: bounded JSON, explicit
// 404s, no mutation of Company truth, and no in-memory state a restart could
// invalidate.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tempStoreDir } from "../support/kernel.mjs";
import { startRuntime } from "../../scripts/lib/runtime-process.mjs";

const MISSING = {
  company: "cmp_00000000-0000-4000-8000-000000000000",
  employee: "emp_00000000-0000-4000-8000-000000000000",
  work: "wrk_00000000-0000-4000-8000-000000000000",
};

const FORBIDDEN_KEYS = [
  "workspaceRoot",
  "scratchRoot",
  "externalSessionRef",
  "externalExecutionRef",
  "executionProfileDigest",
  "stack",
];

function assertNoInternalDetail(payload) {
  const text = JSON.stringify(payload);
  for (const key of FORBIDDEN_KEYS)
    assert.equal(text.includes(`"${key}"`), false, `${key} must not reach the product API`);
}

async function seedCompany(runtime, { start = false } = {}) {
  const company = await runtime.command("createCompany", { name: "Ultraviolet Labs" });
  const position = await runtime.command("createPosition", {
    companyId: company.id,
    title: "Analyst",
    capabilities: ["capability.x"],
  });
  const employee = await runtime.command("createEmployee", {
    companyId: company.id,
    positionId: position.id,
    displayName: "Analyst A",
  });
  const work = await runtime.command("createWork", {
    companyId: company.id,
    title: "Launch readiness",
    intent: "The launch must not slip for avoidable reasons",
  });
  const task = await runtime.command("createTask", {
    workId: work.id,
    title: "Draft the readiness checklist",
    intent: "One checklist the founder can act on",
  });
  let started = null;
  if (start) {
    await runtime.command("assignTask", {
      taskId: task.id,
      employeeId: employee.id,
      reason: "integration fixture",
    });
    started = await runtime.command("startWorkerRun", { taskId: task.id });
    await runtime.command("recordArtifact", {
      taskId: task.id,
      generation: started.generation,
      workerRunId: started.workerRun.id,
      kind: "document",
      title: "Readiness checklist",
      content: "draft\n",
    });
  }
  return { company, position, employee, work, task, started };
}

test("the Experience endpoints are bounded, GET-only reads that mutate nothing", async () => {
  const dir = tempStoreDir();
  let runtime = null;
  try {
    runtime = await startRuntime({ dir });
    const { company, employee, work, started } = await seedCompany(runtime, { start: true });

    const before = await runtime.json("/status");

    const workspace = await runtime.json(`/experience/companies/${company.id}/workspace`);
    assert.deepEqual(workspace.runtime, { available: true });
    assert.equal(workspace.company.id, company.id);
    assert.equal(workspace.company.name, "Ultraviolet Labs");
    assert.equal(workspace.primaryWork.selection, "ACTIVE");
    assert.equal(workspace.primaryWork.lineage.work.workId, work.id);
    assert.equal(workspace.attention.count, 0);
    assert.equal(workspace.workforce.working, 1);
    assert.equal(workspace.workforce.onDuty[0].role, "EXECUTION");
    assert.equal(workspace.recentDeliveries.length, 1);
    assert.equal(workspace.recentDeliveries[0].acceptedState, "NOT_ACCEPTED");
    assert.equal(workspace.pulse.employeesWorking, 1);

    const workforce = await runtime.json(`/experience/companies/${company.id}/workforce`);
    assert.deepEqual(workforce.summary, { employees: 1, working: 1, available: 0, disabled: 0 });
    const [card] = workforce.employees;
    assert.equal(card.availability, "WORKING");
    assert.equal(card.currentWork.role, "EXECUTION");
    assert.equal(card.currentWork.workerRunId, started.workerRun.id);
    assert.equal(card.currentWork.attempt, 1);
    assert.equal(card.currentWork.maxAutonomousAttempts, 3);
    assert.equal(card.execution, null, "no backend bound this attempt through the manual path");

    const detail = await runtime.json(`/experience/employees/${employee.id}`);
    assert.equal(detail.availability, "WORKING");
    assert.equal(detail.currentRole, "EXECUTION");
    assert.equal(detail.recentDeliveries.length, 1);
    assert.ok(detail.recentActivity.length >= 1);
    for (const record of detail.recentActivity)
      assert.equal(typeof record.sequence, "number");

    const lineage = await runtime.json(`/experience/works/${work.id}/lineage`);
    assert.equal(lineage.work.workId, work.id);
    assert.equal(lineage.work.status, "ACTIVE");
    assert.equal(lineage.steps.length, 1);
    assert.equal(lineage.steps[0].kind, "TASK");
    assert.equal(lineage.steps[0].role, "EXECUTION");
    assert.equal(lineage.steps[0].artifacts.length, 1);
    assert.equal(lineage.founderBoundary.waitingForFounder, false);

    for (const payload of [workspace, workforce, detail, lineage]) assertNoInternalDetail(payload);

    // Reading is not working: every GET above left Runtime truth untouched.
    const after = await runtime.json("/status");
    assert.deepEqual(after.counts, before.counts, "Experience reads create no Activity");
    for (const table of [
      "activity",
      "tasks",
      "assignments",
      "workerRuns",
      "artifacts",
      "reviews",
      "founderDecisions",
    ])
      assert.equal(after.counts[table], before.counts[table], `GET changed ${table}`);

    // Unknown ids fail cleanly, and the same URLs refuse anything but GET.
    for (const [path, code] of [
      [`/experience/companies/${MISSING.company}/workspace`, "COMPANY_NOT_FOUND"],
      [`/experience/companies/${MISSING.company}/workforce`, "COMPANY_NOT_FOUND"],
      [`/experience/employees/${MISSING.employee}`, "EMPLOYEE_NOT_FOUND"],
      [`/experience/works/${MISSING.work}/lineage`, "WORK_NOT_FOUND"],
    ]) {
      const error = await runtime.json(path).catch((caught) => caught);
      assert.equal(error.status, 404, path);
      assert.equal(error.code, code, path);
    }
    const refused = await fetch(
      `${runtime.base}/experience/companies/${company.id}/workspace`,
      { method: "POST" },
    );
    assert.equal(refused.status, 404);
    assert.equal((await refused.json()).error.code, "ROUTE_NOT_FOUND");
  } finally {
    if (runtime) await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the same Runtime truth projects identically after a restart", async () => {
  const dir = tempStoreDir();
  let runtime = null;
  try {
    runtime = await startRuntime({ dir });
    const { company, employee, work } = await seedCompany(runtime);
    const paths = [
      `/experience/companies/${company.id}/workspace`,
      `/experience/companies/${company.id}/workforce`,
      `/experience/employees/${employee.id}`,
      `/experience/works/${work.id}/lineage`,
    ];
    const before = [];
    for (const path of paths) before.push(await runtime.json(path));

    await runtime.stop();
    runtime = await startRuntime({ dir });

    const after = [];
    for (const path of paths) after.push(await runtime.json(path));
    assert.deepEqual(after, before, "a projection is derived, never cached in the process");
  } finally {
    if (runtime) await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a restart projects the recovered truth instead of a stale UI state", async () => {
  const dir = tempStoreDir();
  let runtime = null;
  try {
    runtime = await startRuntime({ dir });
    const { company, employee, work } = await seedCompany(runtime, { start: true });
    const before = await runtime.json(`/experience/companies/${company.id}/workforce`);
    assert.equal(before.employees[0].availability, "WORKING");

    const { signal } = await runtime.crash();
    assert.equal(signal, "SIGKILL");
    runtime = null;

    runtime = await startRuntime({ dir });
    const after = await runtime.json(`/experience/companies/${company.id}/workforce`);
    assert.equal(after.employees[0].availability, "AVAILABLE");
    assert.equal(after.employees[0].currentWork, null);

    const lineage = await runtime.json(`/experience/works/${work.id}/lineage`);
    assert.equal(lineage.steps[0].workerRunState, "INTERRUPTED");
    assert.equal((await runtime.json(`/works/${work.id}`)).status, "NEEDS_ATTENTION");
    assert.equal((await runtime.json(`/experience/employees/${employee.id}`)).currentRole, null);
  } finally {
    if (runtime) await runtime.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

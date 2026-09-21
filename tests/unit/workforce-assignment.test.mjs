import test from "node:test";
import assert from "node:assert/strict";
import {
  openTempKernel,
  reopenKernel,
  seedCompanyAndWork,
  seedEmployee,
  seedPosition,
  seedTask,
} from "../support/kernel.mjs";

function companyWithTask(kernel, { requiredCapabilities, capabilities = ["capability.x"] } = {}) {
  const { company, work } = seedCompanyAndWork(kernel);
  const task = kernel.createTask({
    workId: work.id,
    title: "Produce the analysis",
    intent: "One output the founder can act on",
    ...(requiredCapabilities ? { requiredCapabilities } : {}),
  });
  const { position, employee } = seedEmployee(kernel, company.id, {
    displayName: "Analyst A",
    capabilities,
  });
  return { company, work, task, position, employee };
}

test("task requirements persist, reload and are stored deterministically", () => {
  const { dir, kernel, cleanup } = openTempKernel();
  try {
    const { task } = companyWithTask(kernel, {
      requiredCapabilities: ["capability.b", "capability.a", "capability.a"],
    });
    assert.deepEqual(kernel.taskRequirements(task.id).requiredCapabilities, [
      "capability.a",
      "capability.b",
    ]);
    kernel.close();

    const reopened = reopenKernel(dir);
    assert.deepEqual(reopened.taskRequirements(task.id).requiredCapabilities, [
      "capability.a",
      "capability.b",
    ]);
    reopened.close();
  } finally {
    cleanup();
  }
});

test("a task with no requirements is assignable to any enabled employee", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { task, employee } = companyWithTask(kernel);
    assert.equal(kernel.taskRequirements(task.id), null);
    const assignment = kernel.assignTask({ taskId: task.id, employeeId: employee.id });
    assert.equal(assignment.taskId, task.id);
    assert.equal(assignment.employeeId, employee.id);
    assert.equal(kernel.assignment(task.id).id, assignment.id);
  } finally {
    cleanup();
  }
});

test("assignment enforces capability requirements", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { company, task } = companyWithTask(kernel, {
      requiredCapabilities: ["capability.x", "capability.y"],
    });
    const { employee: narrow } = seedEmployee(kernel, company.id, {
      displayName: "Analyst A",
      capabilities: ["capability.x"],
    });
    assert.throws(
      () => kernel.assignTask({ taskId: task.id, employeeId: narrow.id }),
      (error) =>
        error.code === "TASK_REQUIREMENTS_UNSATISFIED" &&
        /capability\.y/.test(error.message),
    );
    assert.equal(kernel.assignment(task.id), null, "a rejected assignment records nothing");

    const { employee: capable } = seedEmployee(kernel, company.id, {
      displayName: "Analyst B",
      capabilities: ["capability.x", "capability.y", "capability.z"],
    });
    const assignment = kernel.assignTask({
      taskId: task.id,
      employeeId: capable.id,
      reason: "capabilities match",
    });
    assert.equal(assignment.employeeId, capable.id);
    assert.equal(assignment.positionId, kernel.employee(capable.id).positionId);
    assert.equal(assignment.reason, "capabilities match");
    assert.equal(assignment.companyId, company.id);
  } finally {
    cleanup();
  }
});

test("assignment rejects disabled, cross-company and terminal cases", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { company, task, employee } = companyWithTask(kernel);
    const other = kernel.createCompany({ name: "Other Company" });
    const otherWork = kernel.createWork({
      companyId: other.id,
      title: "Other work",
      intent: "Not ours",
    });
    const otherTask = seedTask(kernel, otherWork.id, { title: "Other task" });
    const { employee: foreign } = seedEmployee(kernel, other.id, {
      displayName: "Analyst C",
    });

    assert.throws(
      () => kernel.assignTask({ taskId: otherTask.id, employeeId: employee.id }),
      { code: "CROSS_COMPANY_ASSIGNMENT" },
    );
    assert.throws(
      () => kernel.assignTask({ taskId: task.id, employeeId: foreign.id }),
      { code: "CROSS_COMPANY_ASSIGNMENT" },
    );
    assert.throws(
      () => kernel.assignTask({ taskId: task.id, employeeId: "emp_missing" }),
      { code: "EMPLOYEE_NOT_FOUND" },
    );
    assert.throws(
      () => kernel.assignTask({ taskId: "tsk_missing", employeeId: employee.id }),
      { code: "TASK_NOT_FOUND" },
    );

    kernel.assignTask({ taskId: task.id, employeeId: employee.id });
    kernel.startWorkerRun({ taskId: task.id });
    assert.throws(
      () => kernel.assignTask({ taskId: task.id, employeeId: employee.id }),
      { code: "TASK_ALREADY_RUNNING" },
      "v0B1 has no mid-execution handover",
    );

    const { task: second, employee: secondEmployee } = companyWithTask(kernel);
    kernel.setEmployeeEnabled({ employeeId: secondEmployee.id, enabled: false });
    assert.throws(
      () => kernel.assignTask({ taskId: second.id, employeeId: secondEmployee.id }),
      { code: "EMPLOYEE_DISABLED" },
    );

    const { task: third, employee: thirdEmployee } = companyWithTask(kernel);
    kernel.assignTask({ taskId: third.id, employeeId: thirdEmployee.id });
    const started = kernel.startWorkerRun({ taskId: third.id });
    kernel.recordArtifact({
      taskId: third.id,
      generation: started.generation,
      workerRunId: started.workerRun.id,
      kind: "document",
      title: "Output",
      content: "done",
    });
    kernel.completeWorkerRun({ taskId: third.id, generation: started.generation });
    assert.throws(
      () => kernel.assignTask({ taskId: third.id, employeeId: thirdEmployee.id }),
      { code: "TASK_NOT_ASSIGNABLE" },
    );
  } finally {
    cleanup();
  }
});

test("assignment history is append-only and current means most recent", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { company, task, employee } = companyWithTask(kernel);
    const { employee: second } = seedEmployee(kernel, company.id, {
      displayName: "Analyst B",
    });
    const first = kernel.assignTask({
      taskId: task.id,
      employeeId: employee.id,
      reason: "first choice",
    });
    const secondAssignment = kernel.assignTask({
      taskId: task.id,
      employeeId: second.id,
      reason: "reassigned before execution",
    });
    const history = kernel.assignments(task.id);
    assert.equal(history.length, 2, "re-assignment appends history");
    assert.deepEqual(history.map((entry) => entry.id), [first.id, secondAssignment.id]);
    assert.equal(kernel.assignment(task.id).id, secondAssignment.id);
    assert.equal(kernel.assignment(task.id).employeeId, second.id);

    assert.throws(
      () => kernel.store.db.prepare("UPDATE assignments SET reason=? WHERE id=?").run("rewritten", first.id),
      /ASSIGNMENT_APPEND_ONLY/,
    );
    assert.throws(
      () => kernel.store.db.prepare("DELETE FROM assignments WHERE id=?").run(first.id),
      /ASSIGNMENT_APPEND_ONLY/,
    );
    assert.equal(kernel.assignments(task.id).length, 2);
  } finally {
    cleanup();
  }
});

test("requirements are locked while an attempt is running and frozen when terminal", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { task, employee } = companyWithTask(kernel);
    kernel.assignTask({ taskId: task.id, employeeId: employee.id });
    const started = kernel.startWorkerRun({ taskId: task.id });
    assert.throws(
      () => kernel.setTaskRequirements({ taskId: task.id, requiredCapabilities: ["capability.z"] }),
      { code: "TASK_REQUIREMENTS_LOCKED" },
    );
    assert.equal(kernel.taskRequirements(task.id), null, "a rejected change writes nothing");

    kernel.cancelTask({ taskId: task.id, note: "not needed" });
    assert.throws(
      () => kernel.setTaskRequirements({ taskId: task.id, requiredCapabilities: ["capability.z"] }),
      { code: "INVALID_TRANSITION" },
    );
    assert.equal(kernel.task(task.id).generation, started.generation + 1);
  } finally {
    cleanup();
  }
});

test("requirements can be set before execution and carried into the run", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { task, employee } = companyWithTask(kernel);
    const updated = kernel.setTaskRequirements({
      taskId: task.id,
      requiredCapabilities: ["capability.x"],
    });
    assert.deepEqual(updated.requiredCapabilities, ["capability.x"]);
    assert.equal(updated.createdAt, updated.updatedAt);
    kernel.assignTask({ taskId: task.id, employeeId: employee.id, reason: "seed" });
    const started = kernel.startWorkerRun({ taskId: task.id });
    assert.deepEqual(started.workPacket.requirements.requiredCapabilities, ["capability.x"]);
    const events = kernel.activity({ taskId: task.id }).map((event) => event.kind);
    assert.deepEqual(events, [
      "task.created",
      "TASK_REQUIREMENTS_SET",
      "TASK_ASSIGNED",
      "task.execution_started",
      "WORKER_RUN_STARTED",
    ]);
  } finally {
    cleanup();
  }
});

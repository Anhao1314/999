import test from "node:test";
import assert from "node:assert/strict";
import {
  openTempKernel,
  reopenKernel,
  seedCompanyAndWork,
  seedEmployee,
  seedPosition,
  seedStaffedTask,
} from "../support/kernel.mjs";

test("a position is created, persisted and reloaded with stable capabilities", () => {
  const { dir, kernel, cleanup } = openTempKernel();
  try {
    const { company } = seedCompanyAndWork(kernel);
    const position = kernel.createPosition({
      companyId: company.id,
      title: "Analyst",
      capabilities: ["capability.b", "capability.a", "capability.a"],
    });
    assert.match(position.id, /^pos_/);
    assert.deepEqual(position.capabilities, ["capability.a", "capability.b"]);
    assert.deepEqual(kernel.positions(company.id), [position]);
    kernel.close();

    const reopened = reopenKernel(dir);
    assert.deepEqual(reopened.position(position.id), position);
    assert.deepEqual(reopened.positions(company.id), [position]);
    reopened.close();
  } finally {
    cleanup();
  }
});

test("positions validate their company, id and capabilities", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { company } = seedCompanyAndWork(kernel);
    assert.throws(
      () =>
        kernel.createPosition({
          companyId: "cmp_00000000-0000-4000-8000-000000000000",
          title: "Analyst",
          capabilities: [],
        }),
      { code: "COMPANY_NOT_FOUND" },
    );
    for (const bad of [[1], ["Capability.A"], ["capability..x"], ["x".repeat(65)], "capability.x"])
      assert.throws(
        () =>
          kernel.createPosition({
            companyId: company.id,
            title: "Analyst",
            capabilities: bad,
          }),
        { code: "INVALID_CAPABILITY" },
      );
    const position = seedPosition(kernel, company.id, { id: "pos_fixed_analyst" });
    assert.throws(
      () =>
        kernel.createPosition({
          companyId: company.id,
          title: "Analyst",
          capabilities: ["capability.x"],
          id: "pos_fixed_analyst",
        }),
      { code: "POSITION_EXISTS" },
    );
    assert.equal(kernel.positions(company.id).length, 1, "only the seeded position exists");
    assert.throws(
      () => kernel.createPosition({ companyId: company.id, title: "Analyst", capabilities: [], id: "bad id" }),
      { code: "INVALID_INPUT" },
    );
  } finally {
    cleanup();
  }
});

test("an employee binds to a position in the same company and persists", () => {
  const { dir, kernel, cleanup } = openTempKernel();
  try {
    const { company } = seedCompanyAndWork(kernel);
    const { position, employee } = seedEmployee(kernel, company.id, {
      displayName: "Analyst A",
    });
    assert.match(employee.id, /^emp_/);
    assert.equal(employee.companyId, company.id);
    assert.equal(employee.positionId, position.id);
    assert.equal(employee.enabled, true);
    assert.equal(employee.providerPreference, null);
    kernel.close();

    const reopened = reopenKernel(dir);
    assert.deepEqual(reopened.employee(employee.id), {
      ...employee,
      availability: "AVAILABLE",
      activeRunId: null,
    });
    assert.deepEqual(reopened.employees(company.id), [
      { ...employee, availability: "AVAILABLE", activeRunId: null },
    ]);
    reopened.close();
  } finally {
    cleanup();
  }
});

test("an employee record cannot express a model, a provider or a run", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { company } = seedCompanyAndWork(kernel);
    const { employee } = seedEmployee(kernel, company.id, { displayName: "Analyst A" });
    assert.deepEqual(Object.keys(employee).sort(), [
      "companyId",
      "createdAt",
      "displayName",
      "enabled",
      "id",
      "positionId",
      "providerPreference",
    ]);
    for (const forbidden of ["model", "modelId", "sessionId", "bootId", "provider", "status", "currentRunId"])
      assert.equal(forbidden in employee, false, `identity must not carry ${forbidden}`);
    assert.equal(kernel.employees(company.id).length, 1);
  } finally {
    cleanup();
  }
});

test("employee creation validates the position, the company and the id", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { company } = seedCompanyAndWork(kernel);
    const other = kernel.createCompany({ name: "Other Company" });
    const foreignPosition = seedPosition(kernel, other.id);
    assert.throws(
      () =>
        kernel.createEmployee({
          companyId: company.id,
          positionId: foreignPosition.id,
          displayName: "Analyst A",
        }),
      { code: "CROSS_COMPANY_ASSIGNMENT" },
    );
    assert.throws(
      () =>
        kernel.createEmployee({
          companyId: company.id,
          positionId: "pos_missing",
          displayName: "Analyst A",
        }),
      { code: "POSITION_NOT_FOUND" },
    );
    seedEmployee(kernel, company.id, { displayName: "Analyst A", id: "emp_fixed_a" });
    assert.throws(
      () =>
        kernel.createEmployee({
          companyId: company.id,
          positionId: kernel.positions(company.id)[0].id,
          displayName: "Analyst A",
          id: "emp_fixed_a",
        }),
      { code: "EMPLOYEE_EXISTS" },
    );
    assert.throws(
      () =>
        kernel.createEmployee({
          companyId: company.id,
          positionId: kernel.positions(company.id)[0].id,
          displayName: "Analyst A",
          enabled: "yes",
        }),
      { code: "INVALID_INPUT" },
    );
  } finally {
    cleanup();
  }
});

test("availability is derived from enabled plus active runs, never stored", () => {
  const { dir, kernel, cleanup } = openTempKernel();
  try {
    const { company } = seedCompanyAndWork(kernel);
    const { employee } = seedEmployee(kernel, company.id, { displayName: "Analyst A" });
    assert.equal(kernel.employee(employee.id).availability, "AVAILABLE");

    // A second employee who is disabled stays DISABLED regardless of runs.
    const { employee: disabled } = seedEmployee(kernel, company.id, {
      displayName: "Analyst B",
      enabled: false,
    });
    assert.equal(kernel.employee(disabled.id).availability, "DISABLED");

    assert.equal(
      kernel.setEmployeeEnabled({ employeeId: disabled.id, enabled: true }).availability,
      "AVAILABLE",
    );
    assert.equal(
      kernel.setEmployeeEnabled({ employeeId: employee.id, enabled: false }).availability,
      "DISABLED",
    );
    kernel.close();

    const reopened = reopenKernel(dir);
    assert.equal(reopened.employee(employee.id).availability, "DISABLED");
    assert.equal(reopened.employee(disabled.id).availability, "AVAILABLE");
    reopened.close();
  } finally {
    cleanup();
  }
});

test("availability becomes BUSY while a run is active", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { company, task, employee } = seedStaffedTask(kernel);
    const started = kernel.startWorkerRun({ taskId: task.id });
    const busy = kernel.employee(employee.id);
    assert.equal(busy.availability, "BUSY");
    assert.equal(busy.activeRunId, started.workerRun.id);
    assert.equal(kernel.employees(company.id)[0].availability, "BUSY");
    assert.equal(kernel.employee(employee.id).enabled, true, "enabled is the stored fact");
  } finally {
    cleanup();
  }
});

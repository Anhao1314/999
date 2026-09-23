import test from "node:test";
import assert from "node:assert/strict";
import { openTempKernel, reopenKernel } from "../support/kernel.mjs";

test("v10 Employees migrate without fabricated Founder draft or trial history", () => {
  const env = openTempKernel();
  let reopened;
  try {
    const company = env.kernel.createCompany({ name: "Legacy workforce" });
    const position = env.kernel.createPosition({ companyId: company.id, title: "Researcher",
      capabilities: ["customer.research"] });
    const employee = env.kernel.createEmployee({ companyId: company.id, positionId: position.id,
      displayName: "Existing employee" });
    env.kernel.store.db.exec("DROP TABLE employee_hiring_events; UPDATE schema_meta SET version=10");
    env.kernel.close();
    reopened = reopenKernel(env.dir);
    assert.equal(reopened.status().schemaVersion, 12);
    assert.equal(reopened.employee(employee.id).id, employee.id);
    assert.equal(reopened.employeeHiring(employee.id).origin, "LEGACY_OR_SEEDED");
    assert.equal(reopened.employeeHiring(employee.id).trial, null);
    assert.deepEqual(reopened.store.employeeHiringEvents(employee.id), []);
  } finally { reopened?.close(); if (env.kernel.store.db.isOpen) env.kernel.close(); env.cleanup(); }
});

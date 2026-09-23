import test from "node:test";
import assert from "node:assert/strict";
import { openTempKernel, reopenKernel } from "../support/kernel.mjs";
import { createFounderHiringCommands } from "../../packages/product/founder-hiring.mjs";

test("v11 Hiring facts migrate to v12 without invented Founder product requests", () => {
  const env = openTempKernel();
  let kernel = env.kernel;
  try {
    const company = kernel.createCompany({ name: "Existing Hiring Company" });
    const position = kernel.createPosition({ companyId: company.id, title: "Researcher",
      capabilities: ["customer.research"] });
    const legacy = kernel.createEmployee({ companyId: company.id, positionId: position.id,
      displayName: "Existing Employee" });
    const draft = kernel.createEmployeeDraft({ companyId: company.id, displayName: "Luna",
      positionTitle: "Customer Researcher", declaredCapabilities: ["customer.research"],
      eligibleSkills: ["CustomerInsight@v1"], authorityProfile: "PUBLIC_WEB_READ_ONLY",
      knowledgeScope: "NONE", reasoningProfile: "STANDARD" });
    const draftBasis = kernel.employeeHiring(draft.employee.id).basis;
    kernel.store.db.exec("DROP TABLE founder_hiring_command_receipts; UPDATE schema_meta SET version=11");
    kernel.close();
    kernel = reopenKernel(env.dir);
    assert.equal(kernel.status().schemaVersion, 12);
    assert.equal(kernel.employeeHiring(draft.employee.id).state, "DRAFT");
    assert.equal(kernel.employeeHiring(draft.employee.id).basis, draftBasis);
    assert.equal(kernel.employeeHiring(legacy.id).origin, "LEGACY_OR_SEEDED");
    assert.equal(kernel.store.founderHiringCommandReceipt("invented"), null);
    const commands = createFounderHiringCommands({ kernel });
    const created = commands.CreateEmployeeDraft({ requestId: "new-request", companyId: company.id,
      name: "New Employee", positionTitle: "Customer Researcher" });
    assert.equal(created.lifecycleState, "DRAFT");
    assert.throws(() => kernel.store.db.exec("DELETE FROM founder_hiring_command_receipts"),
      /HIRING_COMMAND_RECEIPT_IMMUTABLE/);
  } finally { if (kernel.store.db.isOpen) kernel.close(); env.cleanup(); }
});

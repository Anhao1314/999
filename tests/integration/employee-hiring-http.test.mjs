import test from "node:test";
import assert from "node:assert/strict";
import { openTempKernel } from "../support/kernel.mjs";
import { startRuntime } from "../../scripts/lib/runtime-process.mjs";
import { createCustomerResearchDraft } from "../../packages/product/employee-hiring.mjs";

test("additive Hiring Experience read reports draft and legacy truth without credentials", async () => {
  const env = openTempKernel();
  let runtime;
  try {
    const company = env.kernel.createCompany({ name: "Hiring read contract" });
    const draft = createCustomerResearchDraft({ kernel: env.kernel, companyId: company.id,
      displayName: "Luna" });
    const position = env.kernel.createPosition({ companyId: company.id, title: "Legacy Reviewer",
      capabilities: ["work.review"] });
    const legacy = env.kernel.createEmployee({ companyId: company.id, positionId: position.id,
      displayName: "Iris" });
    env.kernel.close();
    runtime = await startRuntime({ dir: env.dir });
    const hiring = await runtime.json(`/experience/employees/${draft.employee.id}/hiring`);
    assert.equal(hiring.state, "DRAFT");
    assert.equal(hiring.enabled, false);
    assert.deepEqual(hiring.capabilityEvidence.map(item => item.status), ["DECLARED", "DECLARED"]);
    assert.equal(hiring.reasoningProfile, "STANDARD");
    assert.doesNotMatch(JSON.stringify(hiring), /api.?key|password|secret|sk-[0-9a-z]/i);
    const existing = await runtime.json(`/experience/employees/${legacy.id}/hiring`);
    assert.equal(existing.origin, "LEGACY_OR_SEEDED");
    assert.equal(existing.trial, null);
    assert.equal((await runtime.json(`/experience/employees/${draft.employee.id}`)).employeeId,
      draft.employee.id, "existing Experience endpoint remains available");
  } finally { await runtime?.stop(); if (env.kernel.store.db.isOpen) env.kernel.close(); env.cleanup(); }
});

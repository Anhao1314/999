import test from "node:test";
import assert from "node:assert/strict";
import { openTempKernel } from "../support/kernel.mjs";
import { startRuntime } from "../../scripts/lib/runtime-process.mjs";

test("existing product endpoint exposes bounded Founder Hiring commands and keeps reads separate", async () => {
  const env = openTempKernel();
  let runtime;
  try {
    const company = env.kernel.createCompany({ name: "Hiring HTTP" });
    env.kernel.close();
    runtime = await startRuntime({ dir: env.dir });
    const post = async (command, input, origin = runtime.base) => {
      const response = await fetch(`${runtime.base}/product/commands`, {
        method: "POST", headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ command, input }),
      });
      return { status: response.status, body: await response.json() };
    };
    const input = { requestId: "http-draft-1", companyId: company.id,
      name: "Luna", positionTitle: "Customer Researcher" };
    const created = await post("CreateEmployeeDraft", input);
    assert.equal(created.status, 200);
    assert.equal(created.body.result.lifecycleState, "DRAFT");
    assert.deepEqual(await post("CreateEmployeeDraft", input), created);
    const employeeId = created.body.result.employeeId;
    const read = await runtime.json(`/experience/employees/${employeeId}/hiring`);
    assert.equal(read.state, "DRAFT");
    assert.equal(read.enabled, false);
    assert.doesNotMatch(JSON.stringify(created.body), /api.?key|secret|password|reasoning_content/i);
    const forged = await post("CreateEmployeeDraft", { ...input, requestId: "http-draft-2", proven: true });
    assert.equal(forged.status, 400);
    assert.equal(forged.body.error.code, "HIRING_INPUT_INVALID");
    const trial = await post("StartEmployeeTrial", { requestId: "http-trial-1", companyId: company.id,
      employeeId, publicUrl: "https://public.example/product" });
    assert.equal(trial.status, 409);
    assert.equal(trial.body.error.code, "HIRING_EXECUTION_UNAVAILABLE");
    assert.equal((await runtime.json(`/experience/employees/${employeeId}/hiring`)).state, "DRAFT");
    assert.equal((await runtime.json(`/companies/${company.id}/works`)).works.length, 0);
    assert.equal((await post("CreateEmployeeDraft", { ...input, requestId: "evil" },
      "https://evil.invalid")).status, 403);
    const rawToggle = await fetch(`${runtime.base}/commands`, { method: "POST",
      headers: { "content-type": "application/json", origin: runtime.base },
      body: JSON.stringify({ command: "setEmployeeEnabled", input: { employeeId, enabled: true } }) });
    assert.equal(rawToggle.status, 403);
    const founderWork = await post("CreateFounderWork", { requestId: "existing-command", companyId: company.id,
      title: "Unrelated", intent: "Original Founder Work command", contextId: "unconfigured" });
    assert.equal(founderWork.body.error.code, "PRODUCT_COORDINATION_UNAVAILABLE");
  } finally { await runtime?.stop(); if (env.kernel.store.db.isOpen) env.kernel.close(); env.cleanup(); }
});

test("dedicated real Hiring Host refuses startup without an execution credential", async () => {
  const env = openTempKernel();
  try {
    env.kernel.close();
    await assert.rejects(startRuntime({ dir: env.dir, coordination: true,
      workerBackend: "deepseek-hiring" }), /HIRING_EXECUTION_UNAVAILABLE/);
  } finally { if (env.kernel.store.db.isOpen) env.kernel.close(); env.cleanup(); }
});

import test from "node:test";
import assert from "node:assert/strict";
import { openTempKernel } from "../support/kernel.mjs";
import { startRuntime } from "../../scripts/lib/runtime-process.mjs";

test("Workspace product bridge reads real Hiring facts and refuses unavailable execution", async () => {
  const env = openTempKernel();
  let runtime;
  try {
    const company = env.kernel.createCompany({ name: "Product Bridge" });
    env.kernel.close();
    runtime = await startRuntime({ dir: env.dir });
    const get = async (path, origin = runtime.base) => {
      const response = await fetch(`${runtime.base}${path}`, { headers: { origin } });
      return { status: response.status, body: await response.json() };
    };
    const post = async (command, input) => {
      const response = await fetch(`${runtime.base}/product/commands`, {
        method: "POST", headers: { "content-type": "application/json", origin: runtime.base },
        body: JSON.stringify({ command, input }),
      });
      return { status: response.status, body: await response.json() };
    };
    const created = await post("CreateEmployeeDraft", { requestId: "bridge-draft-1",
      companyId: company.id, name: "Luna", positionTitle: "Customer Researcher" });
    assert.equal(created.status, 200);
    const hiring = await get(`/product/companies/${company.id}/hiring`);
    assert.equal(hiring.status, 200);
    assert.deepEqual(hiring.body.hiring.map(item => item.employeeId), [created.body.result.employeeId]);
    assert.equal(hiring.body.hiring[0].state, "DRAFT");
    assert.deepEqual((await get(`/product/companies/${company.id}/research-evidence`)).body.evidence, []);
    assert.equal((await get(`/product/companies/${company.id}/hiring`, "https://evil.invalid")).status, 403);
    const unavailable = await post("CreateCapabilityResearchWork", { companyId: company.id,
      title: "Research", instruction: "Summarize evidence", evidenceArtifactId: "art_missing" });
    assert.equal(unavailable.status, 409);
    assert.equal(unavailable.body.error.code, "RESEARCH_EXECUTION_UNAVAILABLE");
    const outOfScope = await post("AcceptCapabilityResearchWork", { companyId: company.id,
      workId: "work_missing", artifactId: "art_missing", artifactDigest: "sha256:0", basis: 1 });
    assert.equal(outOfScope.status, 409);
    assert.equal(outOfScope.body.error.code, "DECISION_SCOPE_INVALID");
  } finally {
    await runtime?.stop();
    if (env.kernel.store.db.isOpen) env.kernel.close();
    env.cleanup();
  }
});

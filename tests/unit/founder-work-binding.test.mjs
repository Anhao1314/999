import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKernel } from "../../packages/runtime/index.mjs";

test("Founder Work and its binding commit together; idempotency covers every material input", () => {
  const dir = mkdtempSync(join(tmpdir(), "flowcredit-founder-binding-"));
  const kernel = openKernel({ dir });
  try {
    const company = kernel.createCompany({ name: "Founder Binding Co" });
    const other = kernel.createCompany({ name: "Other Co" });
    const input = {
      requestId: "founder_request_1",
      companyId: company.id,
      title: "Summarize project",
      intent: "Deliver a concise summary",
      contextId: `local-repo:sha256:${"a".repeat(64)}`,
      baseRevision: "b".repeat(40),
    };
    const originalInsert = kernel.store.insertFounderWorkExecutionBinding;
    kernel.store.insertFounderWorkExecutionBinding = () => { throw new Error("injected binding failure"); };
    try {
      assert.throws(() => kernel.createFounderWork(input), /injected binding failure/);
    } finally {
      kernel.store.insertFounderWorkExecutionBinding = originalInsert;
    }
    assert.equal(kernel.works(company.id).length, 0, "the Work insert rolled back");
    assert.equal(kernel.store.founderWorkExecutionBindingByRequest(input.requestId), undefined);
    assert.equal(kernel.activity({ companyId: company.id }).some((event) => event.kind === "work.created"), false,
      "no creation event escaped the failed transaction");

    const first = kernel.createFounderWork(input);
    assert.equal(first.replayed, false);
    assert.notEqual(first.work.id, input.requestId, "requestId is not Work identity");
    const replay = kernel.createFounderWork({ ...input, title: ` ${input.title} `, intent: ` ${input.intent} `,
      baseRevision: "c".repeat(40) });
    assert.equal(replay.replayed, true);
    assert.equal(replay.work.id, first.work.id);
    assert.equal(replay.binding.baseRevision, input.baseRevision, "replay preserves the original pin");
    for (const changed of [
      { companyId: other.id },
      { title: "Different title" },
      { intent: "Different intent" },
      { contextId: `local-repo:sha256:${"d".repeat(64)}` },
    ]) {
      assert.throws(() => kernel.createFounderWork({ ...input, ...changed }), {
        code: "FOUNDER_WORK_REQUEST_CONFLICT",
      });
    }
    assert.equal(kernel.works(company.id).length, 1);
    assert.equal(kernel.works(other.id).length, 0);
  } finally {
    kernel.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

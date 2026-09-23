// Worker Harness v0 — the harness inside the real runtime process (Slice 1.1).
//
// The runtime process is started exactly as production starts it, with the
// execution switch on (`FLOWCREDIT_WORKER_BACKEND=test-worker`) and the
// Continuation Driver installed. Everything below travels over HTTP: the
// Founder's commands, the Runtime's coordination, the WorkerHost's execution
// of both the producing attempt and the Reviewer attempt.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRuntime } from "../../scripts/lib/runtime-process.mjs";

async function until(predicate, { label = "condition", timeoutMs = 8000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("the runtime process executes a Work, reviews it and waits for the Founder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flowcredit-harness-proc-"));
  let runtime = null;
  try {
    runtime = await startRuntime({ dir, coordination: true, workerBackend: "test-worker" });
    assert.match(runtime.output(), /worker=test-worker/, "the process announces its execution backend");

    const company = await runtime.command("createCompany", { name: "Process Harness Co" });
    const operator = await runtime.command("createPosition", {
      companyId: company.id,
      title: "Operator",
      capabilities: ["work.execute"],
    });
    const reviewer = await runtime.command("createPosition", {
      companyId: company.id,
      title: "Reviewer",
      capabilities: ["work.review"],
    });
    await runtime.command("createEmployee", {
      companyId: company.id,
      positionId: operator.id,
      displayName: "Atlas",
    });
    await runtime.command("createEmployee", {
      companyId: company.id,
      positionId: reviewer.id,
      displayName: "Iris",
    });

    const work = await runtime.command("createWork", {
      companyId: company.id,
      title: "Execute me without a host process",
      intent: "The Runtime coordinates and the WorkerHost executes",
    });

    await until(
      async () => (await runtime.json(`/works/${work.id}`)).status === "READY_FOR_DECISION",
      { label: "the Work to travel from creation to the decision boundary" },
    );
    const projection = await runtime.json(`/works/${work.id}`);
    assert.equal(projection.outcome.state, "READY");
    assert.equal(projection.outcome.accepted, null, "nothing accepted the Work but the Founder");
    assert.equal(projection.founderAttention.item.kind, "DECISION_REQUIRED");

    const tasks = (await runtime.json(`/works/${work.id}/tasks`)).tasks;
    const sourceTask = tasks.find((task) => !task.title.startsWith("Review:"));
    const reviewTask = tasks.find((task) => task.title.startsWith("Review:"));
    const sourceDetail = await runtime.json(`/tasks/${sourceTask.id}`);
    const reviewDetail = await runtime.json(`/tasks/${reviewTask.id}`);
    assert.equal(sourceDetail.task.state, "COMPLETED");
    assert.equal(sourceDetail.runs[0].state, "COMPLETED");
    assert.equal(
      sourceDetail.artifacts[0].workerRunId,
      sourceDetail.runs[0].id,
      "the artifact names the attempt the Host executed",
    );
    assert.equal(reviewDetail.task.state, "COMPLETED");
    assert.equal(reviewDetail.runs[0].state, "COMPLETED");
    assert.equal(reviewDetail.runs[0].endReason, "REVIEW_COMPLETED");
    assert.equal(reviewDetail.review.verdict, "PASS");
    assert.equal(reviewDetail.review.reviewerWorkerRunId, reviewDetail.runs[0].id);

    const status = await runtime.json("/status");
    assert.equal(status.schemaVersion, 12);
    assert.equal(status.counts.reviews, 1);
    assert.equal(status.counts.founderDecisions, 0);
    assert.equal(status.counts.workerExecutionBindings >= 2, true, "both attempts were bound");

    // The Founder's decision is the only thing that can close the Work, and it
    // travels over the same HTTP surface as everything else.
    const candidate = projection.outcome.candidateArtifacts[0];
    const accepted = await runtime.command("acceptWork", {
      workId: work.id,
      artifactId: candidate.id,
      artifactDigest: candidate.digest,
      basis: projection.decisionBasis,
    });
    assert.equal(accepted.decision.disposition, "ACCEPT");
    assert.equal((await runtime.json(`/works/${work.id}`)).outcome.state, "ACCEPTED");

    // The harness survives the process: bindings and the Reviewer receipt are
    // durable, and recovery finds nothing left running.
    await runtime.stop();
    runtime = null;
    runtime = await startRuntime({ dir, coordination: true, workerBackend: "test-worker" });
    assert.doesNotMatch(
      runtime.output(),
      /recovered \d+ interrupted/,
      "nothing was left RUNNING to recover",
    );
    assert.doesNotMatch(
      runtime.output(),
      /worker host reconciled/,
      "the Host found no orphaned attempt to reconcile",
    );
    const after = await runtime.json("/status");
    assert.equal(after.schemaVersion, 12);
    assert.equal(after.counts.reviews, 1, "the Review and its receipt survive the restart");
    assert.equal(after.counts.founderDecisions, 1);
    assert.equal(after.counts.workerExecutionBindings >= 2, true);
  } finally {
    if (runtime) await runtime.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

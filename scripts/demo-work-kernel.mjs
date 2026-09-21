// Demonstration for the Persistent Work Kernel v0A (milestone charter §38).
//
// Runs the whole sequence against a real runtime process and a real hard
// restart: Company → Work → Task → execution started → Checkpoint → restart →
// honest recovery of the interrupted attempt → new generation → Artifact →
// completion → Work projection. Generic Work only: no researcher, no reviewer.
// The Work projection ends at READY_FOR_DECISION (v0B2): done is not accepted.
//
//   node scripts/demo-work-kernel.mjs
import { rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startRuntime } from "./lib/runtime-process.mjs";

const dir = mkdtempSync(join(tmpdir(), "flowcredit-demo-"));
const steps = [];
const report = (step, detail) => {
  steps.push(step);
  console.log(`${String(steps.length).padStart(2, " ")}. ${step} — ${detail}`);
};

let runtime = null;
try {
  console.log(`\n== Persistent Work Kernel v0A — restart demonstration ==`);
  console.log(`store: ${dir}\n`);

  runtime = await startRuntime({ dir });
  report("runtime A started", runtime.base);

  const company = await runtime.command("createCompany", { name: "Ultraviolet Labs" });
  report("company created", `${company.id} "${company.name}"`);

  const work = await runtime.command("createWork", {
    companyId: company.id,
    title: "Launch readiness",
    intent: "The launch must not slip for avoidable reasons",
  });
  report("work created", `${work.id} "${work.title}"`);

  const task = await runtime.command("createTask", {
    workId: work.id,
    title: "Draft the readiness checklist",
    intent: "One checklist the founder can act on",
  });
  report("task created", `${task.id} state=${task.state} generation=${task.generation}`);

  const first = await runtime.command("startTask", { taskId: task.id });
  report("execution started", `generation ${first.generation}`);

  await runtime.command("checkpointTask", {
    taskId: task.id,
    generation: first.generation,
    label: "outline",
    state: { sections: ["intro", "risks"] },
  });
  await runtime.command("checkpointTask", {
    taskId: task.id,
    generation: first.generation,
    label: "draft",
    state: { sections: ["intro", "risks", "plan"] },
  });
  report("checkpoints persisted", "sequence 1, 2");
  report("work projection before restart", (await runtime.json(`/works/${work.id}`)).status);

  const { signal } = await runtime.crash();
  report("runtime killed", `SIGKILL (${signal}) — no cleanup, no graceful shutdown`);
  runtime = null;

  runtime = await startRuntime({ dir });
  report("runtime B started on the same store", runtime.base);

  const status = await runtime.json("/status");
  assert.equal(status.recovery.count, 1);
  report(
    "interrupted attempt recovered honestly",
    `task=${status.recovery.interrupted[0].taskId} reason=PROCESS_INTERRUPTED automaticRetry=false`,
  );

  const workView = await runtime.json(`/works/${work.id}`);
  assert.equal(workView.status, "NEEDS_ATTENTION");
  report("work projection after restart", `${workView.status} (attention: ${workView.attention[0].taskId})`);

  const detail = await runtime.json(`/tasks/${task.id}`);
  assert.equal(detail.task.state, "INTERRUPTED");
  assert.equal(detail.checkpoints.length, 2);
  assert.equal(detail.activity.at(-1).kind, "task.interrupted");
  report(
    "history preserved",
    `state=${detail.task.state} checkpoints=${detail.checkpoints.length} lastEvent=${detail.activity.at(-1).kind}`,
  );

  const resumed = await runtime.command("startTask", { taskId: task.id });
  assert.ok(resumed.generation > first.generation);
  report("new generation starts", `generation ${first.generation} → ${resumed.generation}`);

  const stale = await fetch(`${runtime.base}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command: "completeTask",
      input: { taskId: task.id, generation: first.generation },
    }),
  });
  assert.equal(stale.status, 409);
  report("dead attempt rejected", `completeTask(generation ${first.generation}) → 409 ${(await stale.json()).error.code}`);

  const artifact = await runtime.command("recordArtifact", {
    taskId: task.id,
    generation: resumed.generation,
    kind: "document",
    title: "Readiness checklist",
    content: "- owner: founder\n- date: Friday\n",
  });
  report("artifact recorded", `${artifact.id} ${artifact.contentDigest.slice(0, 20)}…`);

  const completed = await runtime.command("completeTask", {
    taskId: task.id,
    generation: resumed.generation,
  });
  report("task completed", `state=${completed.state} generation=${completed.generation}`);

  const finalView = await runtime.json(`/works/${work.id}`);
  // v0B2 retired the Work status `COMPLETED`: a finished Task means the Work is
  // ready for a Founder decision, not accepted. The task-only reading is still
  // available (and unchanged) as `taskStatus`.
  assert.equal(finalView.status, "READY_FOR_DECISION");
  assert.equal(finalView.taskStatus, "COMPLETED");
  report(
    "work projection reflects completion",
    `${finalView.status} (taskStatus ${finalView.taskStatus}) ${JSON.stringify(finalView.taskCounts)}`,
  );

  const finalDetail = await runtime.json(`/tasks/${task.id}`);
  report("audit trail across both processes", finalDetail.activity.map((event) => event.kind).join(" | "));

  const { code } = await runtime.stop();
  assert.equal(code, 0);
  runtime = null;
  report("runtime stopped", "exit code 0");
  console.log("\nresult: demonstration complete — persistence, recovery and generation isolation held.\n");
} catch (error) {
  console.error(`\ndemonstration failed at step ${steps.length + 1}: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (runtime) await runtime.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}

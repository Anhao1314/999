// Demonstration for Workforce Identity & Assignment v0B1 (milestone charter §37).
//
// Runs the whole sequence against a real runtime process and a real hard
// restart: Company → Position → Employee → Work → Task requirement → Assignment
// → WorkerRun #1 → Checkpoint → SIGKILL → honest recovery → Employee available
// again → WorkerRun #2 → Artifact (handed off) → completion.
//
// Generic product language only: a position, an employee, a capability id. The
// shipped analyst/reviewer seed data lives in fixtures/ and never appears here.
//
//   node scripts/demo-workforce-v0b1.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startRuntime } from "./lib/runtime-process.mjs";

const dir = mkdtempSync(join(tmpdir(), "flowcredit-workforce-demo-"));
const steps = [];
const report = (step, detail) => {
  steps.push(step);
  console.log(`${String(steps.length).padStart(2, " ")}. ${step} — ${detail}`);
};

let runtime = null;
try {
  console.log(`\n== Workforce Identity & Assignment v0B1 — restart demonstration ==`);
  console.log(`store: ${dir}\n`);

  runtime = await startRuntime({ dir });
  report("runtime A started", runtime.base);

  const company = await runtime.command("createCompany", { name: "Acme" });
  report("company created", `${company.id} "${company.name}"`);

  const position = await runtime.command("createPosition", {
    companyId: company.id,
    title: "Analyst",
    capabilities: ["analysis.execute"],
  });
  report("position created", `${position.id} "${position.title}" capabilities=[${position.capabilities}]`);

  const employee = await runtime.command("createEmployee", {
    companyId: company.id,
    positionId: position.id,
    displayName: "Atlas",
  });
  report(
    "employee hired into the position",
    `${employee.id} "${employee.displayName}" — identity, no model and no run attached`,
  );

  const work = await runtime.command("createWork", {
    companyId: company.id,
    title: "Evaluate market option",
    intent: "The founder needs a defensible read before committing",
  });
  report("work created", `${work.id} "${work.title}"`);

  const task = await runtime.command("createTask", {
    workId: work.id,
    title: "Analyze evidence",
    intent: "One analysis the founder can act on",
  });
  report("task created", `${task.id} state=${task.state} generation=${task.generation}`);

  await runtime.command("setTaskRequirements", {
    taskId: task.id,
    requiredCapabilities: ["analysis.execute"],
  });
  report("task requirement set", "requiredCapabilities=[analysis.execute]");

  const assignment = await runtime.command("assignTask", {
    taskId: task.id,
    employeeId: employee.id,
    reason: "the analyst owns this analysis",
  });
  assert.equal(assignment.employeeId, employee.id);
  report("task assigned", `${assignment.id} → employee ${assignment.employeeId}`);

  const first = await runtime.command("startWorkerRun", { taskId: task.id });
  assert.equal(first.workerRun.state, "RUNNING");
  report(
    "worker run #1 started",
    `${first.workerRun.id} generation=${first.workerRun.generation} employee=${first.workerRun.employeeId}`,
  );
  report(
    "employee availability is derived, not stored",
    (await runtime.json(`/employees/${employee.id}`)).employee.availability,
  );

  await runtime.command("checkpointTask", {
    taskId: task.id,
    generation: first.generation,
    label: "sources gathered",
    state: { sources: 4 },
  });
  report("checkpoint persisted", "sequence 1 label=sources gathered");

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

  const employeeAfterRestart = (await runtime.json(`/employees/${employee.id}`)).employee;
  assert.equal(employeeAfterRestart.availability, "AVAILABLE");
  assert.equal(employeeAfterRestart.activeRunId, null);
  report(
    "employee survived the crash",
    `${employeeAfterRestart.displayName} ${employeeAfterRestart.id} availability=${employeeAfterRestart.availability}`,
  );

  const detail = await runtime.json(`/tasks/${task.id}`);
  assert.equal(detail.task.state, "INTERRUPTED");
  assert.deepEqual(detail.runs.map((run) => run.state), ["INTERRUPTED"]);
  report(
    "run #1 is interrupted, the work is not lost",
    `task=${detail.task.state} generation=${detail.task.generation} checkpoints=${detail.checkpoints.length} lastEvent=${detail.activity.at(-1).kind}`,
  );

  const second = await runtime.command("startWorkerRun", { taskId: task.id });
  assert.notEqual(second.workerRun.id, first.workerRun.id);
  assert.ok(second.generation > first.generation);
  report(
    "worker run #2 started",
    `${second.workerRun.id} generation=${first.generation} → ${second.generation}`,
  );

  const unattributed = await fetch(`${runtime.base}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      command: "recordArtifact",
      input: {
        taskId: task.id,
        generation: second.generation,
        kind: "document",
        title: "Unattributed draft",
        content: "this output names no producer\n",
      },
    }),
  });
  assert.equal(unattributed.status, 409);
  const unattributedError = await unattributed.json();
  report(
    "output without a named producer rejected",
    `recordArtifact(no workerRunId) → 409 ${unattributedError.error.code}`,
  );

  const artifact = await runtime.command("recordArtifact", {
    taskId: task.id,
    generation: second.generation,
    workerRunId: second.workerRun.id,
    kind: "document",
    title: "Market option read",
    content: "# Option A\n- upside: reachable\n- risk: concentration\n",
  });
  assert.equal(artifact.workerRunId, second.workerRun.id);
  report("artifact recorded", `${artifact.id} producer=${artifact.workerRunId}`);

  const handoff = (await runtime.json(`/tasks/${task.id}`)).activity.at(-1);
  assert.equal(handoff.kind, "ARTIFACT_HANDED_OFF");
  report("artifact handed off", `${handoff.kind} workerRunId=${handoff.detail.workerRunId}`);

  const completed = await runtime.command("completeWorkerRun", {
    taskId: task.id,
    generation: second.generation,
  });
  assert.equal(completed.task.state, "COMPLETED");
  report(
    "run #2 completed the work",
    `task=${completed.task.state} run=${completed.workerRun.state} — worker completion, not an acceptance`,
  );
  report(
    "employee is free again",
    (await runtime.json(`/employees/${employee.id}`)).employee.availability,
  );

  const runs = await runtime.command("startWorkerRun", { taskId: task.id }).catch((error) => error);
  assert.equal(runs.code, "INVALID_TRANSITION");
  report("a completed task cannot silently start another run", `startWorkerRun → 409 ${runs.code}`);

  const finalDetail = await runtime.json(`/tasks/${task.id}`);
  report(
    "two runs, one employee, one durable assignment",
    finalDetail.runs.map((run) => `${run.id.slice(0, 12)}…:${run.state}`).join(" | "),
  );
  report("audit trail across both processes", finalDetail.activity.map((event) => event.kind).join(" | "));

  const { code } = await runtime.stop();
  assert.equal(code, 0);
  runtime = null;
  report("runtime stopped", "exit code 0");
  console.log(
    "\nresult: demonstration complete — employee identity outlived the run, assignment outlived the process, and the output named its producer.\n",
  );
} catch (error) {
  console.error(`\ndemonstration failed at step ${steps.length + 1}: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (runtime) await runtime.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}

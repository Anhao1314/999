import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tempStoreDir } from "../support/kernel.mjs";
import { startRuntime } from "../../scripts/lib/runtime-process.mjs";

test("a work survives a hard process restart, is recovered honestly, and can be finished", async () => {
  const dir = tempStoreDir();
  let runtime = null;
  try {
    runtime = await startRuntime({ dir });
    assert.equal((await runtime.json("/health")).status, "ok");
    assert.equal((await runtime.json("/nope").catch((error) => error.status)), 404);

    const company = await runtime.command("createCompany", { name: "Ultraviolet Labs" });
    const work = await runtime.command("createWork", {
      companyId: company.id,
      title: "Launch readiness",
      intent: "The launch must not slip for avoidable reasons",
    });
    const task = await runtime.command("createTask", {
      workId: work.id,
      title: "Draft the readiness checklist",
      intent: "One checklist the founder can act on",
    });
    const started = await runtime.command("startTask", { taskId: task.id });
    assert.equal(started.generation, 1);
    await runtime.command("checkpointTask", {
      taskId: task.id,
      generation: started.generation,
      label: "outline",
      state: { sections: ["intro", "risks"] },
    });
    await runtime.command("checkpointTask", {
      taskId: task.id,
      generation: started.generation,
      label: "draft",
      state: { sections: ["intro", "risks", "plan"] },
    });
    assert.equal((await runtime.json(`/works/${work.id}`)).status, "ACTIVE");

    const { signal } = await runtime.crash();
    assert.equal(signal, "SIGKILL", "the first process is killed without cleanup");
    runtime = null;

    runtime = await startRuntime({ dir });
    assert.match(
      runtime.output(),
      /recovered 1 interrupted execution/,
      "the restarted process reports what it recovered",
    );
    const status = await runtime.json("/status");
    assert.equal(status.schemaVersion, 2, "a fresh v0A store migrates to schema v2");
    assert.equal(status.recovery.count, 1);
    assert.equal(status.tasksByState.INTERRUPTED, 1);

    const workAfterRestart = await runtime.json(`/works/${work.id}`);
    assert.equal(workAfterRestart.status, "NEEDS_ATTENTION");
    assert.deepEqual(workAfterRestart.attention, [
      { taskId: task.id, title: task.title, generation: started.generation + 1 },
    ]);

    const detail = await runtime.json(`/tasks/${task.id}`);
    assert.equal(detail.task.state, "INTERRUPTED");
    assert.equal(detail.task.generation, started.generation + 1);
    assert.deepEqual(detail.checkpoints.map((checkpoint) => checkpoint.sequence), [1, 2]);
    assert.deepEqual(detail.checkpoints[1].state, {
      sections: ["intro", "risks", "plan"],
    });
    assert.equal(detail.artifacts.length, 0);
    assert.equal(detail.activity.at(-1).kind, "task.interrupted");
    assert.equal(detail.activity.at(-1).detail.automaticRetry, false);

    const resumed = await runtime.command("startTask", { taskId: task.id });
    assert.ok(resumed.generation > started.generation);
    await runtime.command("recordArtifact", {
      taskId: task.id,
      generation: resumed.generation,
      kind: "document",
      title: "Readiness checklist",
      content: "- owner: founder\n- date: Friday\n",
    });
    const completed = await runtime.command("completeTask", {
      taskId: task.id,
      generation: resumed.generation,
    });
    assert.equal(completed.state, "COMPLETED");
    assert.deepEqual(await runtime.json(`/works/${work.id}`).then((view) => view.status), "COMPLETED");

    const staleResponse = await fetch(`${runtime.base}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: "completeTask",
        input: { taskId: task.id, generation: started.generation },
      }),
    });
    assert.equal(staleResponse.status, 409, "the dead attempt is still rejected over HTTP");
    assert.equal((await staleResponse.json()).error.code, "STALE_GENERATION");

    const finalDetail = await runtime.json(`/tasks/${task.id}`);
    assert.deepEqual(
      finalDetail.activity.map((event) => event.kind),
      [
        "task.created",
        "task.execution_started",
        "checkpoint.written",
        "checkpoint.written",
        "task.interrupted",
        "task.execution_started",
        "artifact.recorded",
        "task.completed",
      ],
      "the audit trail spans both processes",
    );
    assert.equal(finalDetail.artifacts[0].generation, resumed.generation);

    const { code } = await runtime.stop();
    assert.equal(code, 0);
    runtime = null;
  } finally {
    if (runtime) await runtime.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an employee and its assignment survive a hard restart, and a new run finishes the work", async () => {
  const dir = tempStoreDir();
  let runtime = null;
  try {
    runtime = await startRuntime({ dir });

    const company = await runtime.command("createCompany", { name: "Northwind Instruments" });
    const position = await runtime.command("createPosition", {
      companyId: company.id,
      title: "Analyst",
      capabilities: ["analysis.execute"],
    });
    const employee = await runtime.command("createEmployee", {
      companyId: company.id,
      positionId: position.id,
      displayName: "Atlas",
    });
    const work = await runtime.command("createWork", {
      companyId: company.id,
      title: "Evaluate the market option",
      intent: "The founder needs a defensible read before committing",
    });
    const task = await runtime.command("createTask", {
      workId: work.id,
      title: "Analyze the evidence",
      intent: "One analysis the founder can act on",
    });
    await runtime.command("setTaskRequirements", {
      taskId: task.id,
      requiredCapabilities: ["analysis.execute"],
    });
    const assignment = await runtime.command("assignTask", {
      taskId: task.id,
      employeeId: employee.id,
      reason: "the analyst owns this analysis",
    });
    assert.equal(assignment.employeeId, employee.id, "the assignment names the employee, not a run");
    assert.equal(assignment.workerRunId, undefined, "an assignment never names a run");

    const first = await runtime.command("startWorkerRun", { taskId: task.id });
    assert.equal(first.workerRun.state, "RUNNING");
    assert.equal(first.workerRun.generation, 1);
    assert.equal(first.workerRun.employeeId, employee.id);
    assert.equal(
      (await runtime.json(`/employees/${employee.id}`)).employee.availability,
      "BUSY",
      "a running worker run is what makes an employee busy",
    );
    await runtime.command("checkpointTask", {
      taskId: task.id,
      generation: first.generation,
      label: "sources gathered",
      state: { sources: 4 },
    });

    const { signal } = await runtime.crash();
    assert.equal(signal, "SIGKILL", "the first process is killed without cleanup");
    runtime = null;

    runtime = await startRuntime({ dir });
    assert.match(runtime.output(), /recovered 1 interrupted execution/);

    // Identity, position and assignment are durable facts, not run state.
    const employeeView = (await runtime.json(`/employees/${employee.id}`)).employee;
    assert.equal(employeeView.id, employee.id);
    assert.equal(employeeView.displayName, "Atlas");
    assert.equal(employeeView.positionId, position.id);
    assert.equal(employeeView.enabled, true);
    assert.equal(employeeView.activeRunId, null, "the interrupted run is no longer active");
    assert.equal(
      employeeView.availability,
      "AVAILABLE",
      "availability is derived, so a crash cannot leave an employee busy forever",
    );
    const employees = (await runtime.json(`/companies/${company.id}/employees`)).employees;
    assert.deepEqual(employees.map((entry) => entry.id), [employee.id]);
    const positions = (await runtime.json(`/companies/${company.id}/positions`)).positions;
    assert.deepEqual(positions.map((entry) => entry.id), [position.id]);

    const detail = await runtime.json(`/tasks/${task.id}`);
    assert.equal(detail.task.state, "INTERRUPTED");
    assert.equal(detail.task.generation, first.generation + 1);
    assert.equal(detail.assignment.employeeId, employee.id, "the assignment outlives the run");
    assert.deepEqual(detail.checkpoints.map((checkpoint) => checkpoint.label), ["sources gathered"]);
    assert.deepEqual(detail.runs.map((run) => run.state), ["INTERRUPTED"]);
    assert.equal(detail.runs[0].id, first.workerRun.id);
    assert.equal(detail.activity.at(-1).kind, "WORKER_RUN_INTERRUPTED");

    // A new attempt is a new run on top of the same durable identity.
    const second = await runtime.command("startWorkerRun", { taskId: task.id });
    assert.notEqual(second.workerRun.id, first.workerRun.id, "a new attempt is a new run id");
    assert.equal(second.workerRun.employeeId, employee.id);
    assert.ok(second.generation > first.generation);

    const artifact = await runtime.command("recordArtifact", {
      taskId: task.id,
      generation: second.generation,
      workerRunId: second.workerRun.id,
      kind: "document",
      title: "Market option read",
      content: "# Option A\n- upside: reachable\n- risk: concentration\n",
    });
    assert.equal(artifact.workerRunId, second.workerRun.id, "the output names its producer run");
    const handoff = (await runtime.json(`/tasks/${task.id}`)).activity.at(-1);
    assert.equal(handoff.kind, "ARTIFACT_HANDED_OFF");
    assert.equal(handoff.detail.workerRunId, second.workerRun.id);

    const completed = await runtime.command("completeWorkerRun", {
      taskId: task.id,
      generation: second.generation,
    });
    assert.equal(completed.task.state, "COMPLETED", "worker completion says COMPLETED, not accepted");
    assert.equal(completed.workerRun.state, "COMPLETED");
    assert.equal(
      (await runtime.json(`/employees/${employee.id}`)).employee.availability,
      "AVAILABLE",
    );

    const finishedDetail = await runtime.json(`/tasks/${task.id}`);
    assert.deepEqual(
      finishedDetail.activity.map((event) => event.kind),
      [
        "task.created",
        "TASK_REQUIREMENTS_SET",
        "TASK_ASSIGNED",
        "task.execution_started",
        "WORKER_RUN_STARTED",
        "checkpoint.written",
        "task.interrupted",
        "WORKER_RUN_INTERRUPTED",
        "task.execution_started",
        "WORKER_RUN_STARTED",
        "artifact.recorded",
        "ARTIFACT_HANDED_OFF",
        "WORKER_RUN_COMPLETED",
        "task.completed",
      ],
      "the audit trail spans both processes and both runs",
    );

    const { code } = await runtime.stop();
    assert.equal(code, 0);
    runtime = null;
  } finally {
    if (runtime) await runtime.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

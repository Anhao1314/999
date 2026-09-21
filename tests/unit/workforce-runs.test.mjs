import test from "node:test";
import assert from "node:assert/strict";
import { openTempKernel, reopenKernel, seedStaffedTask } from "../support/kernel.mjs";

function startRun(kernel) {
  const fixture = seedStaffedTask(kernel);
  const started = kernel.startWorkerRun({ taskId: fixture.task.id });
  return { ...fixture, ...started };
}

function recordOutput(kernel, { task, generation, workerRun, content = "the result" }) {
  return kernel.recordArtifact({
    taskId: task.id,
    generation,
    workerRunId: workerRun.id,
    kind: "document",
    title: "Analysis",
    content,
  });
}

test("starting a worker run starts the task and the run in one transaction", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { task, employee, position, generation, workerRun, workPacket } = startRun(kernel);
    const storedTask = kernel.task(task.id);
    const storedRun = kernel.workerRun(workerRun.id);
    assert.equal(storedTask.state, "RUNNING");
    assert.equal(storedTask.generation, generation);
    assert.equal(storedRun.state, "RUNNING");
    assert.equal(storedRun.generation, generation);
    assert.equal(storedRun.employeeId, employee.id);
    assert.equal(storedRun.positionId, position.id);
    assert.equal(storedRun.taskId, task.id);
    assert.equal(storedRun.endedAt, null);
    assert.equal(workPacket.packetVersion, 2);
    assert.equal(kernel.workerRuns({ taskId: task.id }).length, 1);
    assert.equal(kernel.workerRuns({ employeeId: employee.id }).length, 1);
  } finally {
    cleanup();
  }
});

test("a failed start leaves neither a run nor a running task", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { company, task, employee } = seedStaffedTask(kernel);
    kernel.setEmployeeEnabled({ employeeId: employee.id, enabled: false });
    assert.throws(() => kernel.startWorkerRun({ taskId: task.id }), {
      code: "EMPLOYEE_DISABLED",
    });
    assert.equal(kernel.task(task.id).state, "OPEN");
    assert.equal(kernel.workerRuns({ taskId: task.id }).length, 0);
    assert.equal(kernel.employee(employee.id).availability, "DISABLED");

    assert.throws(() => kernel.startWorkerRun({ taskId: task.id }), {
      code: "EMPLOYEE_DISABLED",
    });
    const unassigned = kernel.createTask({
      workId: kernel.works(company.id)[0].id,
      title: "Unassigned task",
      intent: "Nobody owns it yet",
    });
    assert.throws(() => kernel.startWorkerRun({ taskId: unassigned.id }), {
      code: "TASK_NOT_ASSIGNED",
    });
    assert.equal(kernel.task(unassigned.id).state, "OPEN");
    assert.equal(kernel.workerRuns({ taskId: unassigned.id }).length, 0);
  } finally {
    cleanup();
  }
});

test("a task can never have two active runs", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { task, generation, workerRun } = startRun(kernel);
    assert.throws(
      () => kernel.startWorkerRun({ taskId: task.id }),
      { code: "INVALID_TRANSITION" },
      "a running task cannot start a second attempt",
    );
    assert.throws(
      () =>
        kernel.store.db
          .prepare(
            "INSERT INTO worker_runs(id,company_id,work_id,task_id,employee_id,position_id,generation,state,work_packet,work_packet_digest,started_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run("run_duplicate", workerRun.companyId, workerRun.workId, task.id, workerRun.employeeId, workerRun.positionId, generation + 1, "RUNNING", "{}", "sha256:x", new Date().toISOString()),
      /UNIQUE constraint failed/,
      "storage refuses a second active run even if a caller bypasses the command",
    );
    assert.equal(
      kernel.store.db.prepare("SELECT count(*) AS n FROM worker_runs WHERE task_id=? AND state='RUNNING'").get(task.id).n,
      1,
    );
  } finally {
    cleanup();
  }
});

test("workerRun id and generation are separate facts", () => {
  const { dir, kernel, cleanup } = openTempKernel();
  try {
    const { task, generation, workerRun } = startRun(kernel);
    assert.match(workerRun.id, /^run_/);
    assert.equal(typeof generation, "number");
    assert.notEqual(workerRun.id, String(generation));
    assert.equal(workerRun.generation, generation);
    assert.throws(
      () =>
        kernel.store.db
          .prepare(
            "INSERT INTO worker_runs(id,company_id,work_id,task_id,employee_id,position_id,generation,state,work_packet,work_packet_digest,started_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run("run_same_generation", workerRun.companyId, workerRun.workId, task.id, workerRun.employeeId, workerRun.positionId, generation, "INTERRUPTED", "{}", "sha256:x", new Date().toISOString()),
      /UNIQUE constraint failed/,
      "one generation is granted to exactly one run",
    );
    kernel.close();

    const afterRestart = reopenKernel(dir);
    const resumed = afterRestart.startWorkerRun({ taskId: task.id });
    assert.notEqual(resumed.workerRun.id, workerRun.id, "a new attempt is a new run");
    assert.ok(resumed.generation > generation, "and a new generation");
    const runs = afterRestart.workerRuns({ taskId: task.id });
    assert.equal(runs.length, 2);
    assert.deepEqual(
      runs.map((run) => [run.id, run.generation, run.state]),
      [
        [workerRun.id, generation, "INTERRUPTED"],
        [resumed.workerRun.id, resumed.generation, "RUNNING"],
      ],
      "the interrupted run keeps its own id and generation forever",
    );
    afterRestart.close();
  } finally {
    cleanup();
  }
});

test("an artifact produced by a run must name that run", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { task, generation, workerRun } = startRun(kernel);
    assert.throws(
      () =>
        kernel.recordArtifact({
          taskId: task.id,
          generation,
          kind: "document",
          title: "Unattributed",
          content: "no producer named",
        }),
      { code: "NO_ACTIVE_RUN" },
    );
    assert.throws(
      () =>
        kernel.recordArtifact({
          taskId: task.id,
          generation,
          workerRunId: "run_someone_else",
          kind: "document",
          title: "Wrong producer",
          content: "not this run",
        }),
      { code: "NO_ACTIVE_RUN" },
    );

    const artifact = recordOutput(kernel, { task, generation, workerRun });
    assert.equal(artifact.workerRunId, workerRun.id);
    const stored = kernel.artifacts({ taskId: task.id });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].workerRunId, workerRun.id);
    assert.equal(stored[0].employeeId, undefined, "identity is reached through the run, not duplicated");

    const handoff = kernel
      .activity({ taskId: task.id })
      .filter((event) => event.kind === "ARTIFACT_HANDED_OFF");
    assert.equal(handoff.length, 1);
    assert.deepEqual(handoff[0].detail, {
      taskId: task.id,
      artifactId: artifact.id,
      workerRunId: workerRun.id,
    });
  } finally {
    cleanup();
  }
});

test("an artifact recorded without a run stays unattributed and valid", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { task } = seedStaffedTask(kernel);
    const started = kernel.startTask({ taskId: task.id });
    const artifact = kernel.recordArtifact({
      taskId: task.id,
      generation: started.generation,
      kind: "document",
      title: "Output",
      content: "produced without an employee",
    });
    assert.equal(artifact.workerRunId, null);
    assert.equal(
      kernel.activity({ taskId: task.id }).filter((e) => e.kind === "ARTIFACT_HANDED_OFF").length,
      0,
      "no handoff without a run",
    );
  } finally {
    cleanup();
  }
});

test("worker completion closes the run and the task together", () => {
  const { dir, kernel, cleanup } = openTempKernel();
  try {
    const { task, generation, workerRun } = startRun(kernel);
    assert.throws(
      () => kernel.completeWorkerRun({ taskId: task.id, generation }),
      { code: "TASK_HAS_NO_ARTIFACT" },
    );
    assert.equal(kernel.task(task.id).state, "RUNNING", "a completion without output changes nothing");
    assert.equal(kernel.workerRun(workerRun.id).state, "RUNNING");

    recordOutput(kernel, { task, generation, workerRun });
    assert.throws(
      () => kernel.completeTask({ taskId: task.id, generation }),
      { code: "TASK_HAS_ACTIVE_RUN" },
      "the v0A path must not finish a task that an employee is executing",
    );

    const completed = kernel.completeWorkerRun({ taskId: task.id, generation });
    assert.equal(completed.task.state, "COMPLETED");
    assert.equal(completed.workerRun.state, "COMPLETED");
    assert.ok(completed.workerRun.endedAt);
    assert.equal(completed.workerRun.endReason, "WORK_COMPLETED");
    assert.equal(kernel.employee(completed.workerRun.employeeId).availability, "AVAILABLE");
    assert.equal(
      kernel.workProjection(task.workId).status,
      "READY_FOR_DECISION",
      "nothing is open and no review is owed — the founder decides, nothing is accepted",
    );
    assert.equal(typeof kernel.accept, "undefined", "there is no Accepted concept in v0B2");
    kernel.close();

    const reopened = reopenKernel(dir);
    assert.equal(reopened.task(task.id).state, "COMPLETED");
    assert.equal(reopened.workerRun(workerRun.id).state, "COMPLETED");
    reopened.close();
  } finally {
    cleanup();
  }
});

test("cancelling a task cancels its run and frees the employee", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { task, generation, workerRun, employee } = startRun(kernel);
    kernel.checkpointTask({ taskId: task.id, generation, label: "half", state: { step: 1 } });
    const cancelled = kernel.cancelTask({ taskId: task.id, note: "stopped by the founder" });
    assert.equal(cancelled.state, "CANCELLED");
    const run = kernel.workerRun(workerRun.id);
    assert.equal(run.state, "CANCELLED");
    assert.ok(run.endedAt);
    assert.equal(run.endReason, "TASK_CANCELLED");
    assert.equal(kernel.employee(employee.id).availability, "AVAILABLE");
    assert.equal(kernel.employee(employee.id).activeRunId, null);
    assert.equal(kernel.checkpoints(task.id).length, 1, "history stays readable");
    assert.equal(
      kernel.activity({ taskId: task.id }).filter((event) => event.kind === "WORKER_RUN_CANCELLED").length,
      1,
    );
    assert.throws(
      () => kernel.completeWorkerRun({ taskId: task.id, generation }),
      { code: "STALE_GENERATION" },
    );
  } finally {
    cleanup();
  }
});

test("recovery interrupts the task and its run in one transaction", () => {
  const { dir, kernel, cleanup } = openTempKernel();
  try {
    const { task, generation, workerRun, employee } = startRun(kernel);
    kernel.checkpointTask({ taskId: task.id, generation, label: "half", state: { step: 1 } });
    kernel.close();

    const reopened = reopenKernel(dir);
    assert.deepEqual(reopened.recovery.interrupted, [
      {
        taskId: task.id,
        workId: task.workId,
        companyId: workerRun.companyId,
        interruptedGeneration: generation,
        workerRunId: workerRun.id,
      },
    ]);
    assert.equal(reopened.task(task.id).state, "INTERRUPTED");
    assert.equal(reopened.workerRun(workerRun.id).state, "INTERRUPTED");
    assert.equal(reopened.workerRun(workerRun.id).endReason, "PROCESS_INTERRUPTED");
    assert.equal(
      reopened.employee(employee.id).availability,
      "AVAILABLE",
      "an interrupted run cannot leave an employee busy forever",
    );
    assert.equal(reopened.checkpoints(task.id).length, 1);
    const kinds = reopened.activity({ taskId: task.id }).map((event) => event.kind);
    assert.deepEqual(kinds.slice(-2), ["task.interrupted", "WORKER_RUN_INTERRUPTED"]);

    const resumed = reopened.startWorkerRun({ taskId: task.id });
    assert.ok(resumed.generation > generation);
    assert.notEqual(resumed.workerRun.id, workerRun.id);
    reopened.close();
  } finally {
    cleanup();
  }
});

test("run binding is frozen in storage", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { task, generation, workerRun } = startRun(kernel);
    for (const column of ["employee_id", "position_id", "generation", "task_id", "work_packet_digest"])
      assert.throws(
        () =>
          kernel.store.db
            .prepare(`UPDATE worker_runs SET ${column}=? WHERE id=?`)
            .run(column === "generation" ? generation + 5 : "tampered", workerRun.id),
        /WORKER_RUN_BINDING_FROZEN/,
        `binding column ${column} must be frozen`,
      );
    const run = kernel.workerRun(workerRun.id);
    assert.equal(run.employeeId, workerRun.employeeId);
    assert.equal(run.generation, generation);
    assert.equal(kernel.task(task.id).generation, generation);
  } finally {
    cleanup();
  }
});

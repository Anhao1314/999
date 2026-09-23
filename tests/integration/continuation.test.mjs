// v0B4 over the real process: the Runtime coordinates itself, a hard restart
// converges on the same Work, and one Work's availability change resumes
// another. Contract: docs/contracts/work-continuity-v0.md §8, §19.
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tempStoreDir } from "../support/kernel.mjs";
import { startRuntime } from "../../scripts/lib/runtime-process.mjs";

// One position that can execute what the deterministic proposer proposes, and
// one that can review it: the two capabilities the v0 adapter names.
async function seedTeam(runtime, companyId) {
  const operator = await runtime.command("createPosition", {
    companyId,
    title: "Operator",
    capabilities: ["work.execute"],
  });
  const reviewer = await runtime.command("createPosition", {
    companyId,
    title: "Reviewer",
    capabilities: ["work.review"],
  });
  const atlas = await runtime.command("createEmployee", {
    companyId,
    positionId: operator.id,
    displayName: "Atlas",
  });
  const iris = await runtime.command("createEmployee", {
    companyId,
    positionId: reviewer.id,
    displayName: "Iris",
  });
  return { operator, reviewer, atlas, iris };
}

async function taskOf(runtime, workId) {
  const { tasks } = await runtime.json(`/works/${workId}/tasks`);
  assert.equal(tasks.length, 1, `work ${workId} should carry exactly one Task`);
  return tasks[0];
}

test("a Work the Runtime activated survives kill -9 and converges with no duplicate work", async () => {
  const dir = tempStoreDir();
  let runtime = null;
  try {
    runtime = await startRuntime({ dir, coordination: true });
    const company = await runtime.command("createCompany", { name: "Ultraviolet Labs" });
    await seedTeam(runtime, company.id);
    const work = await runtime.command("createWork", {
      companyId: company.id,
      title: "Launch readiness",
      intent: "The launch must not slip for avoidable reasons",
    });

    // No command asked for this: committed changes woke the Driver, it planned
    // one initial Task, dispatched it and started it.
    const activated = await runtime.json(`/works/${work.id}`);
    assert.equal(activated.status, "ACTIVE");
    const before = await runtime.json("/status");
    assert.equal(before.counts.tasks, 1);
    assert.equal(before.counts.assignments, 1);
    assert.equal(before.counts.workerRuns, 1);
    assert.equal(before.tasksByState.RUNNING, 1);

    const { signal } = await runtime.crash();
    assert.equal(signal, "SIGKILL", "the process is killed without cleanup");
    runtime = null;

    runtime = await startRuntime({ dir, coordination: true });
    assert.match(runtime.output(), /recovered 1 interrupted execution/);

    // Recovery fences the dead attempt, and the startup drive continues the
    // same Work: a new run, the same single Task and Assignment.
    const after = await runtime.json("/status");
    assert.equal(after.schemaVersion, 7);
    assert.equal(after.counts.tasks, 1, "no duplicate Task");
    assert.equal(after.counts.assignments, 1, "no duplicate Assignment");
    assert.equal(after.counts.workerRuns, 2, "the interrupted run, and the continuation of it");
    assert.equal(after.tasksByState.RUNNING, 1, "the recovery continued into a new attempt");
    assert.equal(
      after.tasksByState.INTERRUPTED ?? 0,
      0,
      "and the Work is not left parked in INTERRUPTED waiting for a human",
    );
    assert.ok(after.counts.continuationTraces >= 1, "the steps are recorded as observability");

    const resumed = await runtime.json(`/works/${work.id}`);
    assert.equal(resumed.status, "ACTIVE");
    const explicit = await runtime.command("driveWork", { workId: work.id });
    assert.equal(explicit.steps, 0, "there is nothing left to do, and nothing to re-create");
    const idle = await runtime.json("/status");
    assert.equal(idle.counts.tasks, 1);
    assert.equal(idle.counts.assignments, 1);

    const { code } = await runtime.stop();
    assert.equal(code, 0);
    runtime = null;
  } finally {
    if (runtime) await runtime.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one Work's finished run wakes another Work that was blocked on that Employee", async () => {
  const dir = tempStoreDir();
  let runtime = null;
  try {
    runtime = await startRuntime({ dir, coordination: true });
    const company = await runtime.command("createCompany", { name: "Ultraviolet Labs" });
    const team = await seedTeam(runtime, company.id);

    // Work B takes the only Operator first.
    const busyWork = await runtime.command("createWork", {
      companyId: company.id,
      title: "The work that owns the operator",
      intent: "One output the founder can act on",
    });
    const busyTask = await taskOf(runtime, busyWork.id);
    assert.equal((await runtime.json(`/tasks/${busyTask.id}`)).task.state, "RUNNING");

    // Work A cannot dispatch: its Employee is eligible and busy, which is
    // contention, not a capability gap.
    const waitingWork = await runtime.command("createWork", {
      companyId: company.id,
      title: "The work that waits",
      intent: "One output the founder can act on",
    });
    const waitingTask = await taskOf(runtime, waitingWork.id);
    const waitingDetail = await runtime.json(`/tasks/${waitingTask.id}`);
    assert.equal(waitingDetail.task.state, "OPEN");
    assert.equal(waitingDetail.assignment, null);
    const { traces } = await runtime.json(`/works/${waitingWork.id}/traces`);
    assert.equal(traces.at(-1).diagnosticCode, "NO_DISPATCHABLE_EMPLOYEE");

    // The operator finishes Work B's attempt and hands the output off.
    const busyDetail = await runtime.json(`/tasks/${busyTask.id}`);
    const run = busyDetail.runs.at(-1);
    await runtime.command("recordArtifact", {
      taskId: busyTask.id,
      generation: run.generation,
      workerRunId: run.id,
      kind: "document",
      title: "The other output",
      content: "finished elsewhere\n",
    });
    await runtime.command("requestReview", { taskId: busyTask.id, generation: run.generation });

    // That committed run end freed the Operator, and the wake re-evaluated the
    // Work whose own facts never changed.
    const resumed = await runtime.json(`/tasks/${waitingTask.id}`);
    assert.equal(resumed.task.state, "RUNNING");
    assert.equal(resumed.assignment.employeeId, team.atlas.id);
    assert.equal(resumed.runs.length, 1);

    // The review of Work B was dispatched the same way, to the one reviewer.
    const busyProjection = await runtime.json(`/works/${busyWork.id}`);
    const reviewTaskId = busyProjection.collaboration.openReviewTaskId;
    const reviewDetail = await runtime.json(`/tasks/${reviewTaskId}`);
    assert.equal(reviewDetail.task.state, "RUNNING");
    assert.equal(reviewDetail.assignment.employeeId, team.iris.id);

    const { code } = await runtime.stop();
    assert.equal(code, 0);
    runtime = null;
  } finally {
    if (runtime) await runtime.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the harness is a kernel until its host installs the driver, and driveWork stays explicit", async () => {
  const dir = tempStoreDir();
  let runtime = null;
  try {
    runtime = await startRuntime({ dir });
    const company = await runtime.command("createCompany", { name: "Ultraviolet Labs" });
    await seedTeam(runtime, company.id);
    const work = await runtime.command("createWork", {
      companyId: company.id,
      title: "Launch readiness",
      intent: "The launch must not slip for avoidable reasons",
    });

    const untouched = await runtime.json(`/works/${work.id}`);
    assert.equal(untouched.status, "OPEN");
    assert.equal((await runtime.json("/status")).counts.tasks, 0);
    assert.equal((await runtime.json(`/works/${work.id}/traces`)).traces.length, 0);

    const summary = await runtime.command("driveWork", { workId: work.id });
    assert.equal(summary.steps, 3);
    assert.equal((await runtime.json(`/works/${work.id}`)).status, "ACTIVE");
    assert.equal((await runtime.json("/status")).counts.tasks, 1);

    const { code } = await runtime.stop();
    assert.equal(code, 0);
    runtime = null;
  } finally {
    if (runtime) await runtime.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

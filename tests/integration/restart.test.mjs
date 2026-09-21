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
    assert.equal(status.schemaVersion, 1);
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

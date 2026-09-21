import test from "node:test";
import assert from "node:assert/strict";
import {
  openTempKernel,
  reopenKernel,
  seedStaffedTask,
} from "../support/kernel.mjs";
import {
  PACKET_ARTIFACT_LIMIT,
  WORK_PACKET_VERSION,
  buildWorkPacket,
  workPacketDigest,
} from "../../packages/runtime/index.mjs";

test("the packet has exactly the contracted shape and facts", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { company, work, task, employee, position, assignment } = seedStaffedTask(kernel);
    const started = kernel.startWorkerRun({ taskId: task.id });
    const packet = started.workerRun.workPacket;

    assert.deepEqual(Object.keys(packet), [
      "packetVersion",
      "company",
      "work",
      "task",
      "requirements",
      "assignment",
      "employee",
      "position",
      "context",
    ]);
    assert.deepEqual(Object.keys(packet.context), [
      "latestCheckpoint",
      "priorArtifacts",
      "priorArtifactCount",
    ]);
    assert.equal(packet.packetVersion, WORK_PACKET_VERSION);
    assert.deepEqual(packet.company, { id: company.id, name: company.name });
    assert.deepEqual(packet.work, { id: work.id, title: work.title, intent: work.intent });
    assert.equal(packet.task.id, task.id);
    assert.equal(packet.task.generation, started.generation);
    assert.equal(packet.task.state, "RUNNING");
    assert.deepEqual(packet.requirements.requiredCapabilities, ["capability.x"]);
    assert.equal(packet.assignment.id, assignment.id);
    assert.equal(packet.assignment.reason, assignment.reason);
    assert.equal(packet.employee.displayName, employee.displayName);
    assert.deepEqual(packet.position.capabilities, position.capabilities);
    assert.equal(packet.context.latestCheckpoint, null);
    assert.deepEqual(packet.context.priorArtifacts, []);
    assert.equal(packet.context.priorArtifactCount, 0);

    const serialized = JSON.stringify(packet);
    for (const forbidden of ["prompt", "messages", "activity", "events", "password"])
      assert.equal(
        serialized.includes(forbidden),
        false,
        `a packet is not a ${forbidden} container`,
      );
    assert.equal(
      workPacketDigest(packet),
      started.workerRun.workPacketDigest,
      "the stored digest matches the granted packet",
    );
  } finally {
    cleanup();
  }
});

test("building the same facts twice yields the same bytes and digest", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { company, work, task, employee, position, assignment } = seedStaffedTask(kernel);
    const facts = {
      company,
      work,
      task,
      requirements: { requiredCapabilities: ["capability.x"] },
      assignment,
      employee,
      position,
      latestCheckpoint: null,
      artifacts: [],
    };
    const first = buildWorkPacket(facts);
    const second = buildWorkPacket(facts);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(workPacketDigest(first), workPacketDigest(second));
    const changed = buildWorkPacket({
      ...facts,
      task: { ...task, generation: task.generation + 1 },
    });
    assert.notEqual(workPacketDigest(first), workPacketDigest(changed));
  } finally {
    cleanup();
  }
});

test("prior artifacts are summarised, bounded and complete in count", () => {
  const { dir, kernel, cleanup } = openTempKernel();
  try {
    const { task, generation, workerRun } = (() => {
      const fixture = seedStaffedTask(kernel);
      return { ...fixture, ...kernel.startWorkerRun({ taskId: fixture.task.id }) };
    })();
    const total = PACKET_ARTIFACT_LIMIT + 5;
    for (let index = 0; index < total; index += 1)
      kernel.recordArtifact({
        taskId: task.id,
        generation,
        workerRunId: workerRun.id,
        kind: "document",
        title: `Output ${index}`,
        content: `content ${index}`,
      });
    kernel.checkpointTask({
      taskId: task.id,
      generation,
      label: "latest",
      state: { step: total },
    });
    kernel.close();

    const afterRestart = reopenKernel(dir);
    const resumed = afterRestart.startWorkerRun({ taskId: task.id });
    const packet = resumed.workerRun.workPacket;
    assert.equal(packet.context.priorArtifactCount, total);
    assert.equal(packet.context.priorArtifacts.length, PACKET_ARTIFACT_LIMIT);
    for (const summary of packet.context.priorArtifacts) {
      assert.deepEqual(Object.keys(summary), [
        "id",
        "kind",
        "title",
        "contentDigest",
        "generation",
        "createdAt",
      ]);
      assert.equal("content" in summary, false, "summaries carry no content");
    }
    assert.equal(packet.context.latestCheckpoint.label, "latest");
    assert.deepEqual(packet.context.latestCheckpoint.state, { step: total });
    assert.equal(packet.context.latestCheckpoint.generation, generation);
    afterRestart.close();
  } finally {
    cleanup();
  }
});

test("the granted packet does not change after the run starts", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { task } = seedStaffedTask(kernel);
    const started = kernel.startWorkerRun({ taskId: task.id });
    const granted = JSON.stringify(started.workerRun.workPacket);
    kernel.checkpointTask({
      taskId: task.id,
      generation: started.generation,
      label: "after start",
      state: { step: 1 },
    });
    kernel.recordArtifact({
      taskId: task.id,
      generation: started.generation,
      workerRunId: started.workerRun.id,
      kind: "document",
      title: "Output",
      content: "produced after the grant",
    });
    const reread = kernel.workerRun(started.workerRun.id);
    assert.equal(JSON.stringify(reread.workPacket), granted, "the grant is a point-in-time fact");
    assert.equal(reread.workPacketDigest, started.workerRun.workPacketDigest);
  } finally {
    cleanup();
  }
});

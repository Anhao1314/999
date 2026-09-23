// Workforce Experience v0A — the Founder Workspace projection.
// Contract: docs/contracts/workforce-experience-v0.md §8–§10.
//
// The home screen is content, never a second lifecycle: attention is Runtime
// truth recomputed at read time, the pulse counts facts that exist, and ACCEPT
// stays a Founder act that no reviewer verdict can stand in for.
import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPERIENCE_AVAILABILITY,
  projectFounderWorkspace,
  selectPrimaryWork,
  projectWorkforceLobby,
} from "../../packages/experience/index.mjs";
import {
  ATTENTION_DIAGNOSTICS,
  ATTENTION_KINDS,
  createContinuationDriver,
} from "../../packages/runtime/index.mjs";
import {
  openTempKernel,
  reviewArtifact,
  seedStaffedTask,
  seedTaskInReview,
  seedWorkReadyForDecision,
} from "../support/kernel.mjs";

test("the Founder companion appears only for an actual assistant Employee", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const company = kernel.createCompany({ name: "Companion test" });
    const ordinary = kernel.createPosition({ companyId: company.id, title: "Designer", capabilities: ["design.visual"] });
    kernel.createEmployee({ companyId: company.id, positionId: ordinary.id, displayName: "Designer A" });
    assert.equal(projectFounderWorkspace({ kernel, companyId: company.id }).founderAssistant, null);

    const position = kernel.createPosition({ companyId: company.id, title: "创始人助理", capabilities: ["founder.assistant"] });
    const employee = kernel.createEmployee({ companyId: company.id, positionId: position.id, displayName: "小流" });
    const companion = projectFounderWorkspace({ kernel, companyId: company.id }).founderAssistant;
    assert.equal(companion.employeeId, employee.id);
    assert.equal(companion.displayName, "小流");
    assert.equal(companion.position.title, "创始人助理");
    assert.equal(companion.availability, "AVAILABLE");
    assert.equal(companion.currentWork, null);
  } finally {
    cleanup();
  }
});

test("an exhausted autonomous budget reaches the Founder as attention, not as a failed Employee", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const staffed = seedStaffedTask(kernel);
    kernel.startWorkerRun({ taskId: staffed.task.id });
    const driver = createContinuationDriver({ kernel, observe: false });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const run = kernel.workerRuns({ taskId: staffed.task.id }).at(-1);
      kernel.interruptWorkerRun({
        workerRunId: run.id,
        generation: run.generation,
        reason: "WORKER_TIMEOUT",
      });
      driver.driveWork(staffed.work.id, { triggerType: "EXPLICIT" });
    }

    const workspace = projectFounderWorkspace({ kernel, companyId: staffed.company.id });
    assert.equal(workspace.attention.count, 1);
    const [item] = workspace.attention.items;
    assert.equal(item.kind, ATTENTION_KINDS.EXECUTION_INTERRUPTED);
    assert.ok(item.conditions.includes(ATTENTION_DIAGNOSTICS.AUTO_RETRY_EXHAUSTED));
    assert.equal(item.work.id, staffed.work.id);
    assert.equal(typeof item.summary, "string");
    assert.ok(item.actions.length >= 1);
    assert.ok(
      item.actions.every(
        (action) => typeof action.kind === "string" && typeof action.effect === "string",
      ),
    );

    // The primary Work is the one the Founder is needed on, and its lineage
    // marks the boundary without inventing a decision.
    assert.equal(workspace.primaryWork.selection, "FOUNDER_ATTENTION");
    assert.equal(workspace.primaryWork.lineage.work.workId, staffed.work.id);
    assert.equal(workspace.primaryWork.lineage.founderBoundary.waitingForFounder, true);
    assert.equal(workspace.primaryWork.lineage.founderBoundary.decision, null);
    assert.equal(workspace.pulse.founderAttentionCount, 1);

    // The Employee state is derived independently and never becomes FAILED:
    // the vocabulary has no such value, and the exhaustion is the Work's fact.
    const lobby = projectWorkforceLobby({ kernel, companyId: staffed.company.id });
    assert.equal(lobby.employees[0].availability, EXPERIENCE_AVAILABILITY.AVAILABLE);
    assert.equal(JSON.stringify(workspace).includes("FAILED"), false);
  } finally {
    cleanup();
  }
});

test("a passing review still waits at the founder boundary; ACCEPT is a separate human act", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedWorkReadyForDecision(kernel);
    const before = projectFounderWorkspace({ kernel, companyId: flow.company.id });

    assert.equal(before.pulse.readyForDecision, 1);
    assert.equal(before.pulse.acceptedWorks, 0);
    assert.equal(before.attention.count, 1);
    assert.equal(before.attention.items[0].kind, ATTENTION_KINDS.DECISION_REQUIRED);

    const lineageBefore = before.primaryWork.lineage;
    assert.equal(lineageBefore.work.status, "READY_FOR_DECISION");
    assert.equal(lineageBefore.founderBoundary.waitingForFounder, true);
    assert.equal(lineageBefore.founderBoundary.attentionKind, ATTENTION_KINDS.DECISION_REQUIRED);
    assert.equal(lineageBefore.founderBoundary.decision, null);

    const delivery = before.recentDeliveries.find(
      (entry) => entry.artifactId === flow.artifact.id,
    );
    assert.equal(delivery.workTitle, flow.work.title);
    assert.equal(delivery.reviewState, "PASS");
    assert.equal(delivery.acceptedState, "NOT_ACCEPTED");
    assert.equal(delivery.createdAt, kernel.artifact(flow.artifact.id).createdAt);

    // The Founder accepts the exact artifact at the exact digest.
    const projection = kernel.workProjection(flow.work.id);
    kernel.acceptWork({
      workId: flow.work.id,
      artifactId: flow.artifact.id,
      artifactDigest: flow.artifact.contentDigest,
      basis: projection.decisionBasis,
    });

    const after = projectFounderWorkspace({ kernel, companyId: flow.company.id });
    assert.equal(after.pulse.acceptedWorks, 1);
    assert.equal(
      after.pulse.readyForDecision,
      1,
      "ACCEPTED is an outcome state, not a collaboration status",
    );
    assert.equal(after.attention.count, 0, "the decision clears exactly the condition it answers");
    assert.equal(
      after.recentDeliveries.find((entry) => entry.artifactId === flow.artifact.id)
        .acceptedState,
      "ACCEPTED",
    );
    assert.equal(after.primaryWork.selection, "RECENT", "nothing needs the Founder anymore");

    const boundary = after.primaryWork.lineage.founderBoundary;
    assert.equal(boundary.waitingForFounder, false);
    assert.equal(boundary.decision.disposition, "ACCEPT");
    assert.equal(boundary.decision.artifactId, flow.artifact.id);
    assert.equal(boundary.decision.artifactDigest, flow.artifact.contentDigest);
    assert.ok(boundary.decision.decidedAt);
  } finally {
    cleanup();
  }
});

test("pulse numbers move with the Work instead of describing a dashboard", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedTaskInReview(kernel);
    const workspace = () =>
      projectFounderWorkspace({ kernel, companyId: flow.company.id });

    let current = workspace();
    assert.equal(current.primaryWork.selection, "ACTIVE");
    assert.equal(current.primaryWork.lineage.work.workId, flow.work.id);
    assert.deepEqual(
      [
        current.pulse.works,
        current.pulse.activeWorks,
        current.pulse.readyForDecision,
        current.pulse.reviewsActive,
        current.pulse.repairsActive,
        current.pulse.employeesWorking,
        current.pulse.employeesAvailable,
        current.pulse.employeesDisabled,
      ],
      [1, 1, 0, 0, 0, 1, 1, 0],
    );

    const handoff = kernel.requestReview({ taskId: flow.task.id, generation: flow.generation });
    current = workspace();
    assert.equal(current.pulse.reviewsActive, 1);
    assert.equal(current.pulse.employeesWorking, 0);
    assert.equal(current.pulse.employeesAvailable, 2);

    const requested = reviewArtifact(kernel, {
      reviewTaskId: handoff.reviewTask.id,
      reviewerId: flow.reviewer.id,
      verdict: "REQUEST_REVISION",
      summary: "The recommendation is not supported by the evidence supplied.",
      findings: ["Add the downside case."],
    });
    current = workspace();
    assert.equal(current.pulse.reviewsActive, 0);
    assert.equal(current.pulse.repairsActive, 0, "a revision request is not a repair yet");

    const repair = kernel.createRepairTask({ reviewId: requested.id });
    current = workspace();
    assert.equal(current.pulse.repairsActive, 1);
    assert.equal(current.pulse.employeesWorking, 0);

    kernel.startWorkerRun({ taskId: repair.task.id });
    current = workspace();
    assert.equal(current.pulse.repairsActive, 1);
    assert.equal(current.pulse.employeesWorking, 1);
    assert.equal(current.pulse.employeesAvailable, 1);
  } finally {
    cleanup();
  }
});

test("primary Work selection is a deterministic policy, never a ranking", () => {
  const projection = (
    id,
    {
      status = "ACTIVE",
      outcome = "READY",
      updatedAt = "2026-01-01T00:00:00.000Z",
      createdAt = "2026-01-01T00:00:00.000Z",
    } = {},
  ) => ({
    work: { id, title: id, intent: "Intent", createdAt },
    status,
    stage: "RUNNING",
    tasks: [{ id: `tsk_${id}`, state: "RUNNING", updatedAt }],
    outcome: { state: outcome, candidateArtifacts: [] },
    collaboration: { openReviewTaskId: null, openRepairTaskId: null },
  });

  // 1. Founder Attention outranks everything.
  const attention = selectPrimaryWork(
    [projection("wrk_a", { updatedAt: "2099-01-01T00:00:00.000Z" }), projection("wrk_b")],
    [{ workId: "wrk_b" }],
  );
  assert.equal(attention.projection.work.id, "wrk_b");
  assert.equal(attention.selection, "FOUNDER_ATTENTION");

  // 2. Otherwise the active Work with the newest Task update wins.
  const newest = selectPrimaryWork(
    [
      projection("wrk_a", { updatedAt: "2026-01-01T00:00:00.000Z" }),
      projection("wrk_b", { updatedAt: "2026-02-01T00:00:00.000Z" }),
    ],
    [],
  );
  assert.equal(newest.projection.work.id, "wrk_b");
  assert.equal(newest.selection, "ACTIVE");

  // 3. A tie breaks on the lower workId, whichever order they arrive in.
  const tied = [projection("wrk_b"), projection("wrk_a")];
  assert.equal(selectPrimaryWork(tied, []).projection.work.id, "wrk_a");
  assert.equal(selectPrimaryWork([...tied].reverse(), []).projection.work.id, "wrk_a");

  // 4. An accepted Work never outranks an active one.
  const accepted = projection("wrk_a", {
    outcome: "ACCEPTED",
    updatedAt: "2099-01-01T00:00:00.000Z",
  });
  const active = projection("wrk_b", { updatedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(selectPrimaryWork([accepted, active], []).projection.work.id, "wrk_b");

  // 5. With nothing active, the most recent creation wins; ties again by id.
  const recent = selectPrimaryWork(
    [
      projection("wrk_a", { outcome: "ACCEPTED", createdAt: "2026-01-01T00:00:00.000Z" }),
      projection("wrk_b", { outcome: "ACCEPTED", createdAt: "2026-02-01T00:00:00.000Z" }),
    ],
    [],
  );
  assert.equal(recent.projection.work.id, "wrk_b");
  assert.equal(recent.selection, "RECENT");
  assert.equal(
    selectPrimaryWork(
      [projection("wrk_b", { outcome: "ACCEPTED" }), projection("wrk_a", { outcome: "ACCEPTED" })],
      [],
    ).projection.work.id,
    "wrk_a",
  );

  // 6. Nothing to show is never an invitation to invent a Work.
  assert.equal(selectPrimaryWork([], []), null);
});

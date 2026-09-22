// Workforce Experience v0A — the derived workforce read model.
// Contract: docs/contracts/workforce-experience-v0.md §4–§7, §11.
//
// Availability, role, current work and execution detail are derived at read
// time from Runtime truth. Every test here proves the projection follows the
// Runtime — and that nothing is stored, cached or guessed.
import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPERIENCE_AVAILABILITY,
  EXPERIENCE_BOUNDS,
  EXPERIENCE_CONDITIONS,
  EXPERIENCE_ROLES,
  projectEmployeeDetail,
  projectFounderWorkspace,
  projectWorkLineage,
  projectWorkforceLobby,
} from "../../packages/experience/index.mjs";
import { createContinuationDriver } from "../../packages/runtime/index.mjs";
import {
  openTempKernel,
  reopenKernel,
  reviewArtifact,
  seedEmployee,
  seedStaffedTask,
  seedTaskInReview,
  seedWorkReadyForDecision,
  startReviewRun,
} from "../support/kernel.mjs";

test("an empty company projects an empty, fully zeroed workforce", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const company = kernel.createCompany({ name: "Ultraviolet Labs" });

    assert.deepEqual(projectWorkforceLobby({ kernel, companyId: company.id }), {
      company: { id: company.id, name: "Ultraviolet Labs" },
      summary: { employees: 0, working: 0, available: 0, disabled: 0 },
      employees: [],
    });

    const workspace = projectFounderWorkspace({ kernel, companyId: company.id });
    assert.equal(workspace.primaryWork, null);
    assert.deepEqual(workspace.attention, { count: 0, items: [] });
    assert.deepEqual(workspace.recentDeliveries, []);
    assert.deepEqual(workspace.pulse, {
      works: 0,
      activeWorks: 0,
      readyForDecision: 0,
      acceptedWorks: 0,
      reviewsActive: 0,
      repairsActive: 0,
      founderAttentionCount: 0,
      employeesWorking: 0,
      employeesAvailable: 0,
      employeesDisabled: 0,
    });
  } finally {
    cleanup();
  }
});

test("an unknown company or employee fails closed as a bounded not-found", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    for (const [fn, code] of [
      [
        () => projectWorkforceLobby({ kernel, companyId: "cmp_missing" }),
        "COMPANY_NOT_FOUND",
      ],
      [
        () => projectFounderWorkspace({ kernel, companyId: "cmp_missing" }),
        "COMPANY_NOT_FOUND",
      ],
      [
        () => projectEmployeeDetail({ kernel, employeeId: "emp_missing" }),
        "EMPLOYEE_NOT_FOUND",
      ],
    ]) {
      assert.throws(fn, (error) => {
        assert.equal(error.experience, true, "a product error, not a raw exception");
        assert.equal(error.code, code);
        assert.equal(error.status, 404);
        return true;
      });
    }
    assert.throws(
      () => projectWorkLineage({ kernel, workId: "wrk_missing" }),
      (error) => error.status === 404 && error.code === "WORK_NOT_FOUND",
    );
  } finally {
    cleanup();
  }
});

test("employees with no active attempt are all AVAILABLE with no invented work", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const company = kernel.createCompany({ name: "Ultraviolet Labs" });
    const position = kernel.createPosition({
      companyId: company.id,
      title: "Analyst",
      capabilities: ["capability.a", "capability.b"],
    });
    const employees = ["A", "B", "C"].map((suffix) =>
      kernel.createEmployee({
        companyId: company.id,
        positionId: position.id,
        displayName: `Analyst ${suffix}`,
      }),
    );

    const lobby = projectWorkforceLobby({ kernel, companyId: company.id });
    assert.deepEqual(lobby.summary, { employees: 3, working: 0, available: 3, disabled: 0 });
    for (const card of lobby.employees) {
      assert.equal(card.availability, EXPERIENCE_AVAILABILITY.AVAILABLE);
      assert.deepEqual(card.position, { id: position.id, title: "Analyst" });
      assert.deepEqual(card.capabilities, ["capability.a", "capability.b"]);
      assert.equal(card.currentWork, null);
      assert.equal(card.execution, null);
    }
    assert.deepEqual(
      lobby.employees.map((card) => card.employeeId).sort(),
      employees.map((employee) => employee.id).sort(),
    );
  } finally {
    cleanup();
  }
});

test("an employee mid-attempt is WORKING with the attempt the Runtime is running", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const staffed = seedStaffedTask(kernel);
    const started = kernel.startWorkerRun({ taskId: staffed.task.id });

    const lobby = projectWorkforceLobby({ kernel, companyId: staffed.company.id });
    assert.equal(lobby.summary.working, 1);
    const [card] = lobby.employees;
    assert.equal(card.availability, EXPERIENCE_AVAILABILITY.WORKING);
    assert.deepEqual(card.currentWork, {
      workId: staffed.work.id,
      title: staffed.work.title,
      taskId: staffed.task.id,
      role: EXPERIENCE_ROLES.EXECUTION,
      workerRunId: started.workerRun.id,
      generation: started.generation,
      attempt: 1,
      maxAutonomousAttempts: 3,
    });
    assert.equal(card.execution, null, "no binding exists until a backend binds the attempt");
    assert.equal(card.condition, null, "one attempt needs no diagnostic");

    // A bound attempt shows which backend ran it — and nothing else about the
    // workspace, the process or the session behind it.
    kernel.bindWorkerExecution({
      workerRunId: started.workerRun.id,
      generation: started.generation,
      backendType: "test-worker",
      backendVersion: "v0.1",
      executionProfileDigest: `sha256:${"0".repeat(64)}`,
      workspaceRoot: "/tmp/fc-experience/work",
      scratchRoot: "/tmp/fc-experience/scratch",
    });
    const bound = projectWorkforceLobby({ kernel, companyId: staffed.company.id });
    assert.deepEqual(bound.employees[0].execution, {
      backendType: "test-worker",
      backendVersion: "v0.1",
    });
    assert.deepEqual(
      Object.keys(bound.employees[0].execution).sort(),
      ["backendType", "backendVersion"],
      "workspaceRoot, scratchRoot and session refs stay in debug views",
    );
    assert.equal(JSON.stringify(bound).includes("/tmp/fc-experience"), false);
  } finally {
    cleanup();
  }
});

test("an Employee with two active attempts fails closed instead of picking one", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const company = kernel.createCompany({ name: "Ultraviolet Labs" });
    const { employee } = seedEmployee(kernel, company.id, {
      displayName: "Analyst A",
      capabilities: ["capability.x"],
    });
    const work = kernel.createWork({
      companyId: company.id,
      title: "Work A",
      intent: "Intent",
    });
    const tasks = ["First", "Second"].map((title) =>
      kernel.createTask({
        workId: work.id,
        title,
        intent: "One output the founder can act on",
        requiredCapabilities: ["capability.x"],
      }),
    );
    for (const task of tasks) {
      kernel.assignTask({ taskId: task.id, employeeId: employee.id, reason: "audit fixture" });
      kernel.startWorkerRun({ taskId: task.id });
    }
    assert.equal(
      kernel.workerRuns({ employeeId: employee.id }).filter((run) => run.state === "RUNNING").length,
      2,
      "the command layer permits two active runs; the projection must not choose between them",
    );

    const lobby = projectWorkforceLobby({ kernel, companyId: company.id });
    const [card] = lobby.employees;
    assert.equal(card.availability, EXPERIENCE_AVAILABILITY.WORKING);
    assert.equal(card.currentWork, null, "no single attempt is named");
    assert.equal(card.execution, null);
    assert.equal(card.condition, EXPERIENCE_CONDITIONS.MULTIPLE_ACTIVE_RUNS);
    assert.equal(lobby.summary.working, 1, "the Employee is still counted as working");

    const detail = projectEmployeeDetail({ kernel, employeeId: employee.id });
    assert.equal(detail.availability, EXPERIENCE_AVAILABILITY.WORKING);
    assert.equal(detail.currentWork, null);
    assert.equal(detail.currentRole, null);
    assert.equal(detail.condition, EXPERIENCE_CONDITIONS.MULTIPLE_ACTIVE_RUNS);

    const workspace = projectFounderWorkspace({ kernel, companyId: company.id });
    const onDuty = workspace.workforce.onDuty.find(
      (entry) => entry.employeeId === employee.id,
    );
    assert.equal(onDuty.role, null);
    assert.equal(onDuty.workTitle, null);
    assert.equal(onDuty.condition, EXPERIENCE_CONDITIONS.MULTIPLE_ACTIVE_RUNS);
  } finally {
    cleanup();
  }
});

test("a disabled employee is DISABLED even while colleagues keep working", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const staffed = seedStaffedTask(kernel);
    kernel.startWorkerRun({ taskId: staffed.task.id });
    const { employee: disabled } = seedEmployee(kernel, staffed.company.id, {
      displayName: "Analyst D",
      enabled: false,
    });

    const lobby = projectWorkforceLobby({ kernel, companyId: staffed.company.id });
    assert.deepEqual(lobby.summary, { employees: 2, working: 1, available: 0, disabled: 1 });
    const card = lobby.employees.find((entry) => entry.employeeId === disabled.id);
    assert.equal(card.availability, EXPERIENCE_AVAILABILITY.DISABLED);
    assert.equal(card.currentWork, null);

    const detail = projectEmployeeDetail({ kernel, employeeId: disabled.id });
    assert.equal(detail.availability, EXPERIENCE_AVAILABILITY.DISABLED);
    assert.equal(detail.currentRole, null);
  } finally {
    cleanup();
  }
});

test("review is a role the reviewer's own run earns — never inherited from the producer", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedTaskInReview(kernel);
    const handoff = kernel.requestReview({ taskId: flow.task.id, generation: flow.generation });
    startReviewRun(kernel, {
      reviewTaskId: handoff.reviewTask.id,
      reviewerId: flow.reviewer.id,
    });

    const lobby = projectWorkforceLobby({ kernel, companyId: flow.company.id });
    const byName = new Map(lobby.employees.map((card) => [card.displayName, card]));
    const producer = byName.get("Producer A");
    const reviewer = byName.get("Reviewer B");

    assert.equal(
      producer.availability,
      EXPERIENCE_AVAILABILITY.AVAILABLE,
      "the producer's attempt ended at handoff",
    );
    assert.equal(producer.currentWork, null);
    assert.equal(
      reviewer.availability,
      EXPERIENCE_AVAILABILITY.WORKING,
      "the reviewer's own running attempt is what makes them WORKING",
    );
    assert.equal(reviewer.currentWork.role, EXPERIENCE_ROLES.REVIEW);
    assert.equal(reviewer.currentWork.taskId, handoff.reviewTask.id);
    assert.equal(reviewer.currentWork.workId, flow.work.id);

    const reviewerDetail = projectEmployeeDetail({ kernel, employeeId: flow.reviewer.id });
    assert.equal(reviewerDetail.currentRole, EXPERIENCE_ROLES.REVIEW);
    const producerDetail = projectEmployeeDetail({ kernel, employeeId: flow.producer.id });
    assert.equal(producerDetail.currentRole, null);
  } finally {
    cleanup();
  }
});

test("a repair is REPAIR work for the Employee the RepairBinding assigned", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedTaskInReview(kernel);
    const handoff = kernel.requestReview({ taskId: flow.task.id, generation: flow.generation });
    const requested = reviewArtifact(kernel, {
      reviewTaskId: handoff.reviewTask.id,
      reviewerId: flow.reviewer.id,
      verdict: "REQUEST_REVISION",
      summary: "The recommendation is not supported by the evidence supplied.",
      findings: ["Add the downside case."],
    });
    const repair = kernel.createRepairTask({ reviewId: requested.id });
    const repairRun = kernel.startWorkerRun({ taskId: repair.task.id });
    const replacement = kernel.recordArtifact({
      taskId: repair.task.id,
      generation: repairRun.generation,
      workerRunId: repairRun.workerRun.id,
      supersedesArtifactId: flow.artifact.id,
      kind: "document",
      title: "Draft analysis v2",
      content: "draft v2 with the downside case\n",
    });

    const lobby = projectWorkforceLobby({ kernel, companyId: flow.company.id });
    const producer = lobby.employees.find((card) => card.employeeId === flow.producer.id);
    assert.equal(producer.availability, EXPERIENCE_AVAILABILITY.WORKING);
    assert.equal(producer.currentWork.role, EXPERIENCE_ROLES.REPAIR);
    assert.equal(producer.currentWork.taskId, repair.task.id);
    assert.equal(producer.currentWork.workId, flow.work.id);

    // The lineage keeps the supersession exact: v2 replaces v1, and the repair
    // step names the review it answers.
    const lineage = projectWorkLineage({ kernel, workId: flow.work.id });
    const executionStep = lineage.steps.find((step) => step.role === EXPERIENCE_ROLES.EXECUTION);
    const repairStep = lineage.steps.find((step) => step.role === EXPERIENCE_ROLES.REPAIR);
    assert.equal(executionStep.artifacts[0].versionIndex, 1);
    assert.equal(repairStep.repair.reviewId, requested.id);
    assert.equal(repairStep.repair.targetArtifactId, flow.artifact.id);
    assert.equal(repairStep.artifacts[0].artifactId, replacement.id);
    assert.equal(repairStep.artifacts[0].supersedesArtifactId, flow.artifact.id);
    assert.equal(repairStep.artifacts[0].versionIndex, 2);
    assert.equal(lineage.latestArtifactId, replacement.id);
  } finally {
    cleanup();
  }
});

test("an Employee released by one Work can be picked up by the next one", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const company = kernel.createCompany({ name: "Ultraviolet Labs" });
    const { employee } = seedEmployee(kernel, company.id, {
      displayName: "Analyst A",
      capabilities: ["work.execute"],
    });
    const workA = kernel.createWork({
      companyId: company.id,
      title: "Work A",
      intent: "The first thing the company must do",
    });
    const taskA = kernel.createTask({
      workId: workA.id,
      title: "Produce: Work A",
      intent: "One output the founder can act on",
      requiredCapabilities: ["work.execute"],
    });
    kernel.assignTask({ taskId: taskA.id, employeeId: employee.id, reason: "fixture" });
    const started = kernel.startWorkerRun({ taskId: taskA.id });
    kernel.recordArtifact({
      taskId: taskA.id,
      generation: started.generation,
      workerRunId: started.workerRun.id,
      kind: "document",
      title: "Work A output",
      content: "done\n",
    });

    const during = projectWorkforceLobby({ kernel, companyId: company.id });
    assert.equal(during.employees[0].availability, EXPERIENCE_AVAILABILITY.WORKING);
    assert.equal(during.employees[0].currentWork.workId, workA.id);

    // The attempt releases the Employee; the projection follows Runtime truth
    // instead of remembering what it showed a moment ago.
    kernel.completeWorkerRun({ taskId: taskA.id, generation: started.generation });
    const released = projectWorkforceLobby({ kernel, companyId: company.id });
    assert.equal(released.employees[0].availability, EXPERIENCE_AVAILABILITY.AVAILABLE);
    assert.equal(released.employees[0].currentWork, null);

    // …and when the deterministic Runtime dispatches her to Work B, WORKING
    // must follow her there rather than staying stuck on the finished Work.
    const workB = kernel.createWork({
      companyId: company.id,
      title: "Work B",
      intent: "The next thing the company must do",
    });
    const driver = createContinuationDriver({ kernel, observe: false });
    driver.driveWork(workB.id, { triggerType: "EXPLICIT" });

    const after = projectWorkforceLobby({ kernel, companyId: company.id });
    assert.equal(after.employees[0].availability, EXPERIENCE_AVAILABILITY.WORKING);
    assert.equal(after.employees[0].currentWork.workId, workB.id);
    assert.equal(after.employees[0].currentWork.role, EXPERIENCE_ROLES.EXECUTION);
  } finally {
    cleanup();
  }
});

test("a lineage that mixes two Works fails closed instead of rendering", () => {
  const stub = {
    workProjection: (workId) => ({
      work: { id: workId, title: "Work A", intent: "Intent" },
      tasks: [{ id: "tsk_a" }],
      artifacts: [
        { id: "art_1", taskId: "tsk_other", generation: 1, title: "x", createdAt: "t" },
      ],
      reviews: [],
      reviewRequests: [],
      repairBindings: [],
      outcome: { state: "NO_CANDIDATE", candidateArtifacts: [] },
      status: "ACTIVE",
      stage: null,
      latestArtifact: null,
      founderAttention: { item: null },
    }),
  };
  assert.throws(
    () => projectWorkLineage({ kernel: stub, workId: "wrk_a" }),
    (error) => {
      assert.equal(error.experience, true);
      assert.equal(error.code, "EXPERIENCE_LINEAGE_MISMATCH");
      assert.equal(error.status, 409);
      return true;
    },
  );
});

test("projections are bounded: capabilities cap at the frozen bound", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const company = kernel.createCompany({ name: "Ultraviolet Labs" });
    const capabilities = Array.from(
      { length: EXPERIENCE_BOUNDS.capabilitiesMax + 8 },
      (_, index) => `capability.c${String(index).padStart(2, "0")}`,
    );
    const position = kernel.createPosition({
      companyId: company.id,
      title: "Generalist",
      capabilities,
    });
    kernel.createEmployee({
      companyId: company.id,
      positionId: position.id,
      displayName: "Analyst A",
    });

    const lobby = projectWorkforceLobby({ kernel, companyId: company.id });
    assert.equal(lobby.employees[0].capabilities.length, EXPERIENCE_BOUNDS.capabilitiesMax);
    assert.ok(lobby.employees[0].capabilities.every((entry) => typeof entry === "string"));
  } finally {
    cleanup();
  }
});

test("recent deliveries are bounded and carry the Runtime's own ordering fact", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const staffed = seedStaffedTask(kernel);
    const started = kernel.startWorkerRun({ taskId: staffed.task.id });
    const artifacts = [];
    for (let index = 1; index <= EXPERIENCE_BOUNDS.deliveriesMax + 2; index += 1) {
      artifacts.push(
        kernel.recordArtifact({
          taskId: staffed.task.id,
          generation: started.generation,
          workerRunId: started.workerRun.id,
          kind: "document",
          title: `Draft ${index}`,
          content: `draft ${index}\n`,
        }),
      );
    }

    const detail = projectEmployeeDetail({ kernel, employeeId: staffed.employee.id });
    assert.equal(detail.recentDeliveries.length, EXPERIENCE_BOUNDS.deliveriesMax);
    const returned = new Set(detail.recentDeliveries.map((delivery) => delivery.artifactId));
    const expectedIds = artifacts.map((artifact) => artifact.id);
    for (const delivery of detail.recentDeliveries) {
      assert.ok(expectedIds.includes(delivery.artifactId));
      assert.equal(delivery.workId, staffed.work.id);
      assert.equal(delivery.workTitle, staffed.work.title);
      assert.equal(delivery.producerEmployeeId, staffed.employee.id);
      assert.equal(delivery.reviewState, null, "no review happened, so none is invented");
      assert.equal(delivery.acceptedState, "NOT_ACCEPTED");
      assert.equal(
        delivery.createdAt,
        artifacts.find((artifact) => artifact.id === delivery.artifactId).createdAt,
        "the UI gets the authoritative timestamp, never a synthetic one",
      );
    }
    assert.equal(returned.size, EXPERIENCE_BOUNDS.deliveriesMax);
  } finally {
    cleanup();
  }
});

test("the same Runtime truth projects identically after a reopen", () => {
  const { kernel, dir, cleanup } = openTempKernel();
  try {
    const flow = seedWorkReadyForDecision(kernel);
    const companyId = flow.company.id;
    const capture = (open) => ({
      lobby: projectWorkforceLobby({ kernel: open, companyId }),
      workspace: projectFounderWorkspace({ kernel: open, companyId }),
      detail: projectEmployeeDetail({ kernel: open, employeeId: flow.producer.id }),
      lineage: projectWorkLineage({ kernel: open, workId: flow.work.id }),
    });
    const before = capture(kernel);
    kernel.close();

    const reopened = reopenKernel(dir);
    try {
      assert.deepEqual(
        capture(reopened),
        before,
        "a projection is derived from the store, not from memory a restart would drop",
      );
    } finally {
      reopened.close();
    }
  } finally {
    cleanup();
  }
});

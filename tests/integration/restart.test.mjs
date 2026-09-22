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
    assert.equal(status.schemaVersion, 4, "a fresh v0A store migrates to schema v4");
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
    assert.deepEqual(
      await runtime.json(`/works/${work.id}`).then((view) => view.status),
      "READY_FOR_DECISION",
      "the work is finished but nothing has been accepted",
    );

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

test("review and repair survive a hard restart without inventing a judgment", async () => {
  const dir = tempStoreDir();
  let runtime = null;
  try {
    runtime = await startRuntime({ dir });

    const company = await runtime.command("createCompany", { name: "Northwind Instruments" });
    const producerPosition = await runtime.command("createPosition", {
      companyId: company.id,
      title: "Analyst",
      capabilities: ["analysis.execute"],
    });
    const reviewerPosition = await runtime.command("createPosition", {
      companyId: company.id,
      title: "Quality Reviewer",
      capabilities: ["quality.review"],
    });
    const producer = await runtime.command("createEmployee", {
      companyId: company.id,
      positionId: producerPosition.id,
      displayName: "Atlas",
    });
    const reviewer = await runtime.command("createEmployee", {
      companyId: company.id,
      positionId: reviewerPosition.id,
      displayName: "Iris",
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
      requiredCapabilities: ["analysis.execute"],
    });
    await runtime.command("setTaskRequirements", {
      taskId: task.id,
      requiredCapabilities: ["analysis.execute"],
      reviewCapabilities: ["quality.review"],
    });
    await runtime.command("assignTask", {
      taskId: task.id,
      employeeId: producer.id,
      reason: "the analyst owns this analysis",
    });
    const firstRun = await runtime.command("startWorkerRun", { taskId: task.id });
    const firstArtifact = await runtime.command("recordArtifact", {
      taskId: task.id,
      generation: firstRun.generation,
      workerRunId: firstRun.workerRun.id,
      kind: "document",
      title: "Market option read v1",
      content: "# Option A\n- upside: reachable\n",
    });
    const handedOff = await runtime.command("requestReview", {
      taskId: task.id,
      generation: firstRun.generation,
    });
    assert.equal(handedOff.task.state, "COMPLETED");
    await runtime.command("assignTask", {
      taskId: handedOff.reviewTask.id,
      employeeId: reviewer.id,
      reason: "independent review",
    });
    const reviewRun = await runtime.command("startWorkerRun", { taskId: handedOff.reviewTask.id });
    await runtime.command("checkpointTask", {
      taskId: handedOff.reviewTask.id,
      generation: reviewRun.generation,
      label: "read the artifact",
      state: { read: true },
    });

    const { signal } = await runtime.crash();
    assert.equal(signal, "SIGKILL");
    runtime = null;

    runtime = await startRuntime({ dir });
    assert.match(runtime.output(), /recovered 1 interrupted execution/);
    const afterCrash = await runtime.json(`/tasks/${handedOff.reviewTask.id}`);
    assert.equal(afterCrash.task.state, "INTERRUPTED");
    assert.equal(afterCrash.runs[0].state, "INTERRUPTED");
    assert.equal(afterCrash.reviewRequest.targetArtifactId, firstArtifact.id);
    assert.deepEqual(
      await runtime.json("/reviews/rev_missing"),
      { review: null },
      "a missing review reads as null: the crash did not invent one",
    );
    assert.equal((await runtime.json("/status")).counts.reviews, 0, "a crash writes no judgment");

    const resumedReview = await runtime.command("startWorkerRun", {
      taskId: handedOff.reviewTask.id,
    });
    assert.ok(resumedReview.generation > reviewRun.generation);
    const review = await runtime.command("submitReview", {
      reviewTaskId: handedOff.reviewTask.id,
      generation: resumedReview.generation,
      verdict: "REQUEST_REVISION",
      summary: "The recommendation is not supported by the evidence given.",
      findings: ["The downside case is missing."],
    });
    assert.equal(review.review.verdict, "REQUEST_REVISION");

    const repair = await runtime.command("createRepairTask", { reviewId: review.review.id });
    assert.equal(repair.assignment.employeeId, producer.id);
    const repairRun = await runtime.command("startWorkerRun", { taskId: repair.task.id });

    const secondCrash = await runtime.crash();
    assert.equal(secondCrash.signal, "SIGKILL");
    runtime = null;

    runtime = await startRuntime({ dir });
    const afterRepairCrash = await runtime.json(`/tasks/${repair.task.id}`);
    assert.equal(afterRepairCrash.task.state, "INTERRUPTED");
    assert.equal(afterRepairCrash.repairBinding.targetArtifactId, firstArtifact.id);
    const survivedReview = await runtime.json(`/reviews/${review.review.id}`);
    assert.deepEqual(survivedReview.review.findings, ["The downside case is missing."]);
    assert.equal(
      (await runtime.json(`/artifacts/${firstArtifact.id}`)).artifact.contentDigest,
      firstArtifact.contentDigest,
      "the artifact under repair is untouched by the crash",
    );

    const resumedRepair = await runtime.command("startWorkerRun", { taskId: repair.task.id });
    assert.notEqual(resumedRepair.workerRun.id, repairRun.workerRun.id, "new attempt, new run");
    const replacement = await runtime.command("recordArtifact", {
      taskId: repair.task.id,
      generation: resumedRepair.generation,
      workerRunId: resumedRepair.workerRun.id,
      supersedesArtifactId: firstArtifact.id,
      kind: "document",
      title: "Market option read v2",
      content: "# Option A\n- upside: reachable\n- downside: concentration\n",
    });
    assert.equal(replacement.supersedesArtifactId, firstArtifact.id);

    const secondReview = await runtime.command("requestReview", {
      taskId: repair.task.id,
      generation: resumedRepair.generation,
    });
    await runtime.command("assignTask", {
      taskId: secondReview.reviewTask.id,
      employeeId: reviewer.id,
      reason: "independent review",
    });
    const secondReviewRun = await runtime.command("startWorkerRun", {
      taskId: secondReview.reviewTask.id,
    });
    const passed = await runtime.command("submitReview", {
      reviewTaskId: secondReview.reviewTask.id,
      generation: secondReviewRun.generation,
      verdict: "PASS",
      summary: "The recommendation now matches the evidence supplied.",
      findings: [],
    });
    assert.equal(passed.review.targetArtifactId, replacement.id);
    assert.equal(passed.task.state, "COMPLETED");

    const projection = (await runtime.json(`/companies/${company.id}/works`)).works;
    assert.equal(projection.length, 1);
    const finalWork = await runtime.json(`/works/${work.id}`);
    assert.equal(finalWork.status, "READY_FOR_DECISION");
    assert.equal(finalWork.stage, "READY_FOR_DECISION");
    assert.equal(finalWork.latestArtifact.id, replacement.id);
    assert.equal(finalWork.artifacts.length, 2, "both versions survive two crashes");
    assert.equal(
      finalWork.artifacts.find((artifact) => artifact.id === firstArtifact.id).supersedesArtifactId,
      null,
      "the replaced artifact is unchanged",
    );
    assert.equal(finalWork.reviews.length, 2);
    assert.equal(finalWork.repairBindings.length, 1);
    assert.equal(finalWork.status === "ACCEPTED", false, "nothing was accepted");

    const { code } = await runtime.stop();
    assert.equal(code, 0);
    runtime = null;
  } finally {
    if (runtime) await runtime.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Founder Decision survives a hard restart and is never re-adjudicated", async () => {
  const dir = tempStoreDir();
  let runtime = null;
  try {
    runtime = await startRuntime({ dir });

    const company = await runtime.command("createCompany", { name: "Founder Attention Ltd" });
    const producerPosition = await runtime.command("createPosition", {
      companyId: company.id,
      title: "Analyst",
      capabilities: ["analysis.execute"],
    });
    const reviewerPosition = await runtime.command("createPosition", {
      companyId: company.id,
      title: "Quality Reviewer",
      capabilities: ["quality.review"],
    });
    const producer = await runtime.command("createEmployee", {
      companyId: company.id,
      positionId: producerPosition.id,
      displayName: "Atlas",
    });
    const reviewer = await runtime.command("createEmployee", {
      companyId: company.id,
      positionId: reviewerPosition.id,
      displayName: "Iris",
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
      requiredCapabilities: ["analysis.execute"],
    });
    await runtime.command("setTaskRequirements", {
      taskId: task.id,
      requiredCapabilities: ["analysis.execute"],
      reviewCapabilities: ["quality.review"],
    });
    await runtime.command("assignTask", {
      taskId: task.id,
      employeeId: producer.id,
      reason: "the analyst owns this analysis",
    });
    const firstRun = await runtime.command("startWorkerRun", { taskId: task.id });
    const firstArtifact = await runtime.command("recordArtifact", {
      taskId: task.id,
      generation: firstRun.generation,
      workerRunId: firstRun.workerRun.id,
      kind: "document",
      title: "Market option read v1",
      content: "# Option A\n- upside: reachable\n",
    });
    const handedOff = await runtime.command("requestReview", {
      taskId: task.id,
      generation: firstRun.generation,
    });
    await runtime.command("assignTask", {
      taskId: handedOff.reviewTask.id,
      employeeId: reviewer.id,
      reason: "independent review",
    });
    const reviewRun = await runtime.command("startWorkerRun", { taskId: handedOff.reviewTask.id });
    const revision = await runtime.command("submitReview", {
      reviewTaskId: handedOff.reviewTask.id,
      generation: reviewRun.generation,
      verdict: "REQUEST_REVISION",
      summary: "The recommendation is not supported by the evidence supplied.",
      findings: ["The downside case is missing."],
    });
    const repair = await runtime.command("createRepairTask", { reviewId: revision.review.id });
    const repairRun = await runtime.command("startWorkerRun", { taskId: repair.task.id });
    const v2 = await runtime.command("recordArtifact", {
      taskId: repair.task.id,
      generation: repairRun.generation,
      workerRunId: repairRun.workerRun.id,
      supersedesArtifactId: firstArtifact.id,
      kind: "document",
      title: "Market option read v2",
      content: "# Option A\n- upside: reachable\n- downside: concentration\n",
    });
    const secondHandoff = await runtime.command("requestReview", {
      taskId: repair.task.id,
      generation: repairRun.generation,
    });
    await runtime.command("assignTask", {
      taskId: secondHandoff.reviewTask.id,
      employeeId: reviewer.id,
      reason: "independent review",
    });
    const secondReviewRun = await runtime.command("startWorkerRun", {
      taskId: secondHandoff.reviewTask.id,
    });
    await runtime.command("submitReview", {
      reviewTaskId: secondHandoff.reviewTask.id,
      generation: secondReviewRun.generation,
      verdict: "PASS",
      summary: "The recommendation now matches the evidence supplied.",
      findings: [],
    });

    const ready = await runtime.json(`/works/${work.id}`);
    assert.equal(ready.status, "READY_FOR_DECISION");
    assert.equal(ready.outcome.state, "READY");
    assert.equal(ready.outcome.accepted, null);

    const attention = (await runtime.json(`/companies/${company.id}/attention`)).attention;
    assert.equal(attention.length, 1);
    const [item] = attention;
    assert.equal(item.kind, "DECISION_REQUIRED");
    assert.equal(item.workId, work.id);
    assert.deepEqual(item.actions.map((entry) => entry.kind), ["ACCEPT"]);
    assert.equal(item.actions[0].artifactId, v2.id);
    assert.equal(item.actions[0].artifactDigest, v2.contentDigest);
    assert.equal(item.decisionBasis, ready.decisionBasis);

    const input = {
      workId: work.id,
      artifactId: item.actions[0].artifactId,
      artifactDigest: item.actions[0].artifactDigest,
      basis: item.decisionBasis,
    };
    const accepted = await runtime.command("acceptWork", input);
    assert.equal(accepted.idempotent, false);
    assert.equal(accepted.decision.disposition, "ACCEPT");
    assert.equal(accepted.work.outcome.state, "ACCEPTED");
    assert.equal(accepted.work.outcome.accepted.decisionId, accepted.decision.id);
    assert.equal(accepted.work.outcome.accepted.disposition, "ACCEPT");
    assert.equal(accepted.work.status, "READY_FOR_DECISION", "the collaboration status is not rewritten");
    assert.equal(
      Object.hasOwn(accepted.work.outcome.accepted, "idempotent"),
      false,
      "the response says how the call went; the projection does not",
    );
    const projectionAfterAccept = accepted.work;

    const retried = await runtime.command("acceptWork", input);
    assert.equal(retried.idempotent, true);
    assert.equal(retried.decision.id, accepted.decision.id);
    assert.deepEqual(retried.work, projectionAfterAccept);
    assert.deepEqual((await runtime.json(`/companies/${company.id}/attention`)).attention, []);

    const conflict = await fetch(`${runtime.base}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: "acceptWork",
        input: { ...input, artifactId: firstArtifact.id, artifactDigest: firstArtifact.contentDigest },
      }),
    });
    assert.equal(conflict.status, 409);
    assert.equal(
      (await conflict.json()).error.code,
      "WORK_ALREADY_DECIDED",
      "an existing decision is answered before any other check runs",
    );

    const locked = await fetch(`${runtime.base}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: "createTask",
        input: { workId: work.id, title: "Too late", intent: "too late" },
      }),
    });
    assert.equal(locked.status, 409);
    assert.equal((await locked.json()).error.code, "WORK_ACCEPTED_LOCKED");

    const { signal } = await runtime.crash();
    assert.equal(signal, "SIGKILL", "the runtime is killed without a clean shutdown");
    runtime = null;

    runtime = await startRuntime({ dir });
    assert.match(runtime.output(), /FlowCredit runtime ready/);
    const status = await runtime.json("/status");
    assert.equal(status.schemaVersion, 4);
    assert.equal(status.counts.founderDecisions, 1);
    assert.equal(
      status.recovery.count,
      0,
      "recovery never adjudicates a Founder Decision, and never invents one",
    );

    const after = await runtime.json(`/works/${work.id}`);
    assert.deepEqual(after, projectionAfterAccept, "a restart changes nothing about the decision");
    assert.equal(after.outcome.state, "ACCEPTED");
    assert.equal(after.outcome.accepted.decisionId, accepted.decision.id);
    assert.equal(after.founderAttention.item, null);
    assert.deepEqual((await runtime.json(`/companies/${company.id}/attention`)).attention, []);

    const replay = await runtime.command("acceptWork", input);
    assert.equal(replay.idempotent, true);
    assert.equal(replay.decision.id, accepted.decision.id);
    assert.equal(replay.decision.createdAt, accepted.decision.createdAt);

    const { code } = await runtime.stop();
    assert.equal(code, 0);
    runtime = null;
  } finally {
    if (runtime) await runtime.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
});

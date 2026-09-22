// The Persistent Work Kernel: the command seam over the store.
//
// Every state change goes through a command here; callers never assign task
// state. Each command runs in one transaction, so state and its activity entry
// commit together or not at all. Contract:
// docs/contracts/persistent-work-kernel-v0.md §3–§10.
import { newCompany } from "../company/company.mjs";
import {
  TASK_STATES,
  TERMINAL_TASK_STATES,
  cancelAllowedFrom,
  deriveWorkStatus,
  executionWriteFence,
  newTask,
  newWork,
  startAllowedFrom,
} from "../work/work.mjs";
import {
  deriveCollaboration,
  latestArtifact,
  supersessionChain,
} from "../work/collaboration.mjs";
import { deriveWorkAttention, sortAttentionItems } from "../work/attention.mjs";
import { deriveOutcome } from "../work/outcome.mjs";
import { WAKE_CAUSES, validateNextActionProposal } from "../work/continuation.mjs";
import { newContinuationTrace } from "../work/trace.mjs";
import {
  FOUNDER_DECISION_DISPOSITIONS,
  newFounderDecision,
} from "../decision/decisions.mjs";
import {
  BOUNDS,
  newActivityEvent,
  newArtifact,
  newCheckpoint,
} from "../work/records.mjs";
import { kernelError } from "./errors.mjs";
import {
  assertCapabilityList,
  assertEnabled,
  assertFindings,
  assertId,
  assertInteger,
  assertKind,
  assertNoSecret,
  assertRecordId,
  assertText,
  assertVerdict,
  serializeJsonValue,
} from "./guards.mjs";
import { KernelStore, SCHEMA_VERSION } from "./store.mjs";
import { EVENTS } from "./events.mjs";
import {
  AVAILABILITY,
  REVIEW_VERDICTS,
  WORKER_RUN_STATES,
  buildWorkPacket,
  deriveAvailability,
  missingCapabilities,
  newAssignment,
  newEmployee,
  newPosition,
  newRepairBinding,
  newReview,
  newReviewRequest,
  newWorkerExecutionBinding,
  newWorkerRun,
  sameExecutionBindingFacts,
  satisfiesCapabilities,
  workPacketDigest,
} from "../workforce/index.mjs";

const INTERRUPTION_REASON = "PROCESS_INTERRUPTED";

// The frozen v0 vocabulary of external Worker-host interruption reasons. These
// describe execution failure — never Founder authority, cancellation, a verdict
// or a success result.
//
// The four reasons draw one line precisely: how the attempt ended, and whether
// the Worker's own result was ever usable.
//   WORKER_TIMEOUT        the Host stopped an attempt that ran out of time;
//   WORKER_PROCESS_EXIT   the child process failed (spawn, signal, non-zero exit);
//   WORKER_PROTOCOL_ERROR the result was malformed, invalid or named facts the
//                         Worker does not own — no usable candidate existed;
//   WORKER_OUTPUT_REJECTED a protocol-valid candidate existed, but independent
//                         Harness evidence or an execution-policy postcondition
//                         rejected the delivery (failed verification, moved HEAD,
//                         a changed protected path, no required change, an
//                         oversized diff). The specific postcondition stays in
//                         HarnessEvidence; the Runtime sees only this reason.
export const WORKER_INTERRUPTION_REASONS = Object.freeze([
  "WORKER_TIMEOUT",
  "WORKER_PROCESS_EXIT",
  "WORKER_PROTOCOL_ERROR",
  "WORKER_OUTPUT_REJECTED",
]);

// Ending a WorkerRun always produces the matching audit event, from wherever
// the run was ended (completion, cancellation, recovery).
const RUN_END_EVENT_KIND = Object.freeze({
  [WORKER_RUN_STATES.COMPLETED]: "WORKER_RUN_COMPLETED",
  [WORKER_RUN_STATES.INTERRUPTED]: "WORKER_RUN_INTERRUPTED",
  [WORKER_RUN_STATES.CANCELLED]: "WORKER_RUN_CANCELLED",
});

export class WorkKernel {
  // Notices for the transaction in flight; null outside a command.
  #notices = null;
  // WorkerRun observations, same discipline: collected by the running command,
  // published only after COMMIT.
  #runNotices = null;

  constructor({ dir, now = () => new Date().toISOString() }) {
    this.store = new KernelStore(dir);
    this.now = now;
    this.openedAt = this.now();
    // Committed-fact notices collected by the running command, published only
    // after COMMIT (v0B4 §8). Never a queue: it lives for one transaction.
    this.#notices = null;
    this.#runNotices = null;
    this.continuationObserver = null;
    this.workerRunObserver = null;
    this.recovery = this.#recoverOpenAttempts();
  }

  // The one host seam of v0B4: after a command's transaction commits, the
  // Runtime hands the committed facts to whoever runs the Continuation Driver.
  // The Kernel detects; the Driver decides. Nothing is published while a
  // transaction is open, and a rolled-back command publishes nothing at all.
  setContinuationObserver(observer) {
    this.continuationObserver = typeof observer === "function" ? observer : null;
    return this;
  }

  // The execution seam of the Worker Harness: after a command's transaction
  // commits, the Runtime tells whoever runs the WorkerHost that a WorkerRun has
  // entered RUNNING. Observation only — the Host holds no WorkerRun truth, and
  // a missed notification is healed by reconciliation against committed state.
  setWorkerRunObserver(observer) {
    this.workerRunObserver = typeof observer === "function" ? observer : null;
    return this;
  }

  close() {
    this.store.close();
  }

  // Store path is exposed for diagnostics and tests only; it is not part of the
  // command surface.
  get storePath() {
    return this.store.path;
  }

  // --- commands -------------------------------------------------------------

  createPosition({ companyId, title, capabilities, id } = {}) {
    const company = assertId(companyId, "companyId");
    if (!this.store.getCompany(company))
      throw kernelError("COMPANY_NOT_FOUND", `company ${company} does not exist`);
    const position = newPosition({
      ...(id ? { id: assertRecordId(id, "id") } : {}),
      companyId: company,
      title: assertText(title, "title", BOUNDS.positionTitleMax),
      capabilities: assertCapabilityList(capabilities, "capabilities"),
      createdAt: this.now(),
    });
    if (this.store.getPosition(position.id))
      throw kernelError("POSITION_EXISTS", `position ${position.id} already exists`);
    this.store.transaction(() => {
      this.store.insertPosition(position);
      this.#event({
        companyId: company,
        kind: "POSITION_CREATED",
        detail: {
          positionId: position.id,
          title: position.title,
          capabilities: position.capabilities,
        },
      });
    });
    return position;
  }

  createEmployee({
    companyId,
    positionId,
    displayName,
    enabled = true,
    providerPreference = null,
    id,
  } = {}) {
    const company = assertId(companyId, "companyId");
    if (!this.store.getCompany(company))
      throw kernelError("COMPANY_NOT_FOUND", `company ${company} does not exist`);
    const position = this.#requirePosition(positionId);
    if (position.companyId !== company)
      throw kernelError(
        "CROSS_COMPANY_ASSIGNMENT",
        `position ${position.id} belongs to another company`,
      );
    const employee = newEmployee({
      ...(id ? { id: assertRecordId(id, "id") } : {}),
      companyId: company,
      positionId: position.id,
      displayName: assertText(displayName, "displayName", BOUNDS.employeeNameMax),
      enabled: assertEnabled(enabled, "enabled"),
      providerPreference:
        providerPreference === null || providerPreference === undefined
          ? null
          : assertText(providerPreference, "providerPreference", BOUNDS.providerPreferenceMax),
      createdAt: this.now(),
    });
    if (this.store.getEmployee(employee.id))
      throw kernelError("EMPLOYEE_EXISTS", `employee ${employee.id} already exists`);
    this.#mutate(() => {
      this.store.insertEmployee(employee);
      this.#event({
        companyId: company,
        kind: "EMPLOYEE_CREATED",
        detail: {
          employeeId: employee.id,
          positionId: employee.positionId,
          displayName: employee.displayName,
          enabled: employee.enabled,
        },
      });
      // A new Employee can change what already-active Works can dispatch,
      // without any of those Works changing. Recomputation, not Hiring.
      this.#notify({ cause: WAKE_CAUSES.EMPLOYEE_CREATED, companyId: company, companyWide: true });
    });
    return employee;
  }

  setEmployeeEnabled({ employeeId, enabled } = {}) {
    const employee = this.#requireEmployee(employeeId);
    const next = assertEnabled(enabled, "enabled");
    if (employee.enabled === next) return this.employee(employee.id);
    this.#mutate(() => {
      this.store.updateEmployeeEnabled(employee.id, next);
      this.#event({
        companyId: employee.companyId,
        kind: "EMPLOYEE_UPDATED",
        detail: { employeeId: employee.id, enabled: next },
      });
      // Both directions matter: enabling can unlock blocked Work, disabling can
      // make an existing Assignment unusable. A no-op change never gets here.
      this.#notify({
        cause: WAKE_CAUSES.EMPLOYEE_ENABLED_CHANGED,
        companyId: employee.companyId,
        companyWide: true,
      });
    });
    return this.employee(employee.id);
  }

  setTaskRequirements({ taskId, requiredCapabilities, reviewCapabilities } = {}) {
    const task = this.#requireTask(taskId);
    if (this.store.reviewRequestForTask(task.id))
      throw kernelError(
        "REVIEW_TASK_NOT_REVIEWABLE",
        `task ${task.id} is a review task; a review of a review is not a collaboration shape`,
      );
    if (task.state === TASK_STATES.RUNNING)
      throw kernelError(
        "TASK_REQUIREMENTS_LOCKED",
        `task ${task.id} is running; its requirements cannot change underneath an attempt`,
      );
    if (TERMINAL_TASK_STATES.includes(task.state))
      throw kernelError(
        "INVALID_TRANSITION",
        `the requirements of a ${task.state} task are frozen`,
      );
    const existing = this.store.getTaskRequirements(task.id);
    const requirements = this.#requirementsRecord(
      task.id,
      assertCapabilityList(requiredCapabilities, "requiredCapabilities"),
      reviewCapabilities === undefined
        ? (existing?.reviewCapabilities ?? [])
        : assertCapabilityList(reviewCapabilities, "reviewCapabilities"),
      existing,
    );
    this.#mutate(() => {
      this.store.upsertTaskRequirements(requirements);
      const { companyId, workId } = this.#contextOfTask(task);
      this.#event({
        companyId,
        workId,
        taskId: task.id,
        kind: "TASK_REQUIREMENTS_SET",
        detail: {
          requiredCapabilities: requirements.requiredCapabilities,
          reviewCapabilities: requirements.reviewCapabilities,
          previousCapabilities: existing?.requiredCapabilities ?? [],
        },
      });
    });
    return requirements;
  }

  assignTask({ taskId, employeeId, reason } = {}) {
    const task = this.#requireTask(taskId);
    const employee = this.#requireEmployee(employeeId);
    const { companyId, workId } = this.#contextOfTask(task);
    if (task.state === TASK_STATES.RUNNING)
      throw kernelError(
        "TASK_ALREADY_RUNNING",
        `task ${task.id} is running; v0B1 has no mid-execution handover`,
      );
    if (TERMINAL_TASK_STATES.includes(task.state))
      throw kernelError(
        "TASK_NOT_ASSIGNABLE",
        `a ${task.state} task cannot be assigned`,
      );
    if (employee.companyId !== companyId)
      throw kernelError(
        "CROSS_COMPANY_ASSIGNMENT",
        `employee ${employee.id} and task ${task.id} belong to different companies`,
      );
    if (!employee.enabled)
      throw kernelError("EMPLOYEE_DISABLED", `employee ${employee.id} is disabled`);
    // A Review Task carries a hard independence rule (v0B4 §4): the reviewer
    // must not be the Employee who produced the exact Artifact under review.
    // Checked before anything else about the candidate, so the refusal names
    // the real reason: Assignment is durable, and it is checked again before
    // the run starts — a hand-written or migrated Assignment must never execute.
    const producerEmployeeId = this.#reviewProducerEmployeeId(task);
    if (producerEmployeeId === employee.id)
      throw kernelError(
        "REVIEWER_NOT_INDEPENDENT",
        `employee ${employee.id} produced the artifact review task ${task.id} judges; an Employee never reviews their own output`,
      );
    const position = this.#requirePosition(employee.positionId);
    const requirements = this.store.getTaskRequirements(task.id);
    const missing = missingCapabilities(
      requirements?.requiredCapabilities ?? [],
      position.capabilities,
    );
    if (missing.length)
      throw kernelError(
        "TASK_REQUIREMENTS_UNSATISFIED",
        `position ${position.id} is missing [${missing.join(", ")}] required by task ${task.id}`,
      );
    const assignment = newAssignment({
      companyId,
      taskId: task.id,
      employeeId: employee.id,
      positionId: position.id,
      reason:
        reason === undefined || reason === null
          ? null
          : assertText(reason, "reason", BOUNDS.assignmentReasonMax, { min: 0 }),
      createdAt: this.now(),
    });
    this.#mutate(() => {
      this.store.insertAssignment(assignment);
      this.#event({
        companyId,
        workId,
        taskId: task.id,
        kind: "TASK_ASSIGNED",
        detail: {
          assignmentId: assignment.id,
          employeeId: employee.id,
          positionId: position.id,
          reason: assignment.reason,
          requiredCapabilities: requirements?.requiredCapabilities ?? [],
        },
      });
    });
    return assignment;
  }

  createCompany({ name } = {}) {
    const company = newCompany({
      name: assertText(name, "name", BOUNDS.companyNameMax),
      createdAt: this.now(),
    });
    this.#mutate(() => {
      this.store.insertCompany(company);
      this.#event({
        companyId: company.id,
        kind: "company.created",
        detail: { name: company.name },
      });
    });
    return company;
  }

  createWork({ companyId, title, intent } = {}) {
    const id = assertId(companyId, "companyId");
    if (!this.store.getCompany(id))
      throw kernelError(
        "WORK_COMPANY_MISSING",
        `company ${id} does not exist; a Work cannot exist without one`,
      );
    const work = newWork({
      companyId: id,
      title: assertText(title, "title", BOUNDS.workTitleMax),
      intent: assertText(intent, "intent", BOUNDS.workIntentMax),
      createdAt: this.now(),
    });
    this.#mutate(() => {
      this.store.insertWork(work);
      this.#event({
        companyId: work.companyId,
        workId: work.id,
        kind: "work.created",
        detail: { title: work.title },
      });
    });
    return work;
  }

  createTask({ workId, title, intent, requiredCapabilities } = {}) {
    const work = this.#requireWork(workId);
    // Post-acceptance guard (v0B3 §10): an accepted Work is closed to new
    // Tasks. Only a Founder Decision locks it — a Work that merely derives
    // READY_FOR_DECISION is still open, and may still change under the Founder.
    if (this.store.founderDecisionForWork(work.id))
      throw kernelError(
        "WORK_ACCEPTED_LOCKED",
        `work ${work.id} has a Founder Decision; further work belongs to a new Work, not to this accepted one`,
      );
    const task = newTask({
      workId: work.id,
      title: assertText(title, "title", BOUNDS.taskTitleMax),
      intent: assertText(intent, "intent", BOUNDS.taskIntentMax),
      createdAt: this.now(),
    });
    const requirements =
      requiredCapabilities === undefined || requiredCapabilities === null
        ? null
        : this.#requirementsRecord(
            task.id,
            assertCapabilityList(requiredCapabilities, "requiredCapabilities"),
            [],
          );
    this.#mutate(() => {
      this.store.insertTask(task);
      this.#event({
        companyId: work.companyId,
        workId: work.id,
        taskId: task.id,
        kind: "task.created",
        detail: { title: task.title },
      });
      if (requirements) {
        this.store.upsertTaskRequirements(requirements);
        this.#event({
          companyId: work.companyId,
          workId: work.id,
          taskId: task.id,
          kind: "TASK_REQUIREMENTS_SET",
          detail: { requiredCapabilities: requirements.requiredCapabilities },
        });
      }
    });
    return task;
  }


  // The one Runtime authority seam the Continuation Driver uses to turn a
  // validated proposal into facts (v0B4 §5). It creates exactly ONE Task and
  // its requirements, atomically, and does nothing else: no Employee is
  // chosen, no run starts, no review is submitted, no Work is accepted.
  //
  // It is not a planner. The Runtime revalidates the initial-activation
  // preconditions inside the transaction, so a lost response can never produce
  // a second initial Task, and a Work that already has a Task is refused as
  // benign convergence rather than as a failure.
  materializeNextAction({ workId, expectedBasis, proposal } = {}) {
    const work = this.#requireWork(workId);
    const basis = assertInteger(expectedBasis, "expectedBasis", { min: 1 });
    const validated = validateNextActionProposal(proposal);
    if (!validated.ok)
      throw kernelError(validated.code, validated.message, { details: { workId: work.id } });
    const { taskKind, title, intent, requiredCapabilities, reviewCapabilities } =
      validated.proposal;
    const task = newTask({ workId: work.id, title, intent, createdAt: this.now() });
    const requirements = this.#requirementsRecord(
      task.id,
      requiredCapabilities,
      reviewCapabilities,
    );
    this.#mutate(() => {
      if (this.store.founderDecisionForWork(work.id))
        throw kernelError(
          "WORK_ACCEPTED_LOCKED",
          `work ${work.id} has a Founder Decision; an accepted Work is never activated again`,
        );
      const existing = this.store.listTasks(work.id);
      if (existing.length > 0) {
        const [first] = existing;
        throw kernelError(
          "WORK_ALREADY_ACTIVATED",
          `work ${work.id} already carries ${existing.length} Task(s) starting at ${first.id}; the initial activation already happened`,
          {
            details: {
              workId: work.id,
              taskId: first.id,
              taskCount: existing.length,
              basis: this.store.workActivityHead(work.id),
            },
          },
        );
      }
      const currentBasis = this.store.workActivityHead(work.id);
      if (currentBasis !== basis)
        throw kernelError(
          "STALE_CONTINUATION_BASIS",
          `work ${work.id} moved from basis ${basis} to ${currentBasis}; a proposal is materialized against the reality it named`,
          { details: { workId: work.id, basis: currentBasis } },
        );
      this.store.insertTask(task);
      this.#event({
        companyId: work.companyId,
        workId: work.id,
        taskId: task.id,
        kind: "task.created",
        detail: { title: task.title, taskKind, materializedFrom: "next_action_proposal" },
      });
      this.store.upsertTaskRequirements(requirements);
      this.#event({
        companyId: work.companyId,
        workId: work.id,
        taskId: task.id,
        kind: EVENTS.TASK_REQUIREMENTS_SET,
        detail: { requiredCapabilities, reviewCapabilities },
      });
    });
    return {
      task: this.task(task.id),
      requirements,
      work: this.workProjection(work.id),
      basis: this.store.workActivityHead(work.id),
    };
  }

  // Observability only: appending a trace never changes business truth, and a
  // trace write can never fail a committed mutation (the Driver calls this
  // after COMMIT and treats its own failure as an observability failure).
  recordContinuationTrace(trace) {
    if (!trace || typeof trace !== "object")
      throw kernelError("INVALID_INPUT", "a continuation trace must be an object");
    const record = newContinuationTrace({ ...trace, createdAt: trace.createdAt ?? this.now() });
    this.#mutate(() => {
      this.store.insertContinuationTrace(record);
    });
    return record;
  }

  startTask({ taskId } = {}) {
    const task = this.#requireTask(taskId);
    if (!startAllowedFrom(task.state))
      throw kernelError(
        "INVALID_TRANSITION",
        `a ${task.state} task cannot start an execution attempt`,
      );
    const generation = task.generation + 1;
    this.#mutate(() => {
      this.store.updateTask(task.id, {
        state: TASK_STATES.RUNNING,
        generation,
        updatedAt: this.now(),
      });
      const { companyId, workId } = this.#contextOfTask(task);
      this.#event({
        companyId,
        workId,
        taskId: task.id,
        generation,
        kind: "task.execution_started",
        detail: { previousState: task.state },
      });
    });
    return { task: this.task(task.id), generation };
  }

  checkpointTask({ taskId, generation, label, state } = {}) {
    const task = this.#requireTask(taskId);
    this.#assertExecutionWrite(task, generation);
    const cleanLabel = assertText(label, "label", BOUNDS.checkpointLabelMax);
    const serializedState = serializeJsonValue(
      state,
      "state",
      BOUNDS.checkpointStateMax,
    );
    assertNoSecret(serializedState, "state");
    const sequence = this.store.listCheckpoints(task.id).length + 1;
    const checkpoint = newCheckpoint({
      taskId: task.id,
      generation,
      sequence,
      label: cleanLabel,
      state,
      createdAt: this.now(),
    });
    this.#mutate(() => {
      this.store.insertCheckpoint(checkpoint);
      const { companyId, workId } = this.#contextOfTask(task);
      this.#event({
        companyId,
        workId,
        taskId: task.id,
        generation,
        kind: "checkpoint.written",
        detail: { checkpointId: checkpoint.id, sequence, label: cleanLabel },
      });
    });
    return checkpoint;
  }

  recordArtifact({
    taskId,
    generation,
    workerRunId = null,
    kind,
    title,
    content,
    inputDigest = null,
    supersedesArtifactId = null,
  } = {}) {
    const task = this.#requireTask(taskId);
    this.#assertExecutionWrite(task, generation);
    // Supersession is bound to a recorded review: only a Repair Task may replace
    // an Artifact, and it may replace exactly the one its binding names.
    const repairBinding = this.store.repairBindingForTask(task.id);
    const supersedes = this.#assertSupersession(task, repairBinding, supersedesArtifactId);
    // An artifact produced by an employee must name the run that produced it;
    // an artifact produced without a run must stay unattributed.
    const activeRun = this.#activeRun(task.id);
    if (activeRun && workerRunId !== activeRun.id)
      throw kernelError(
        "NO_ACTIVE_RUN",
        `task ${task.id} is executed by worker run ${activeRun.id}; the artifact must name it as producer`,
      );
    if (!activeRun && workerRunId)
      throw kernelError(
        "WORKER_RUN_NOT_FOUND",
        `task ${task.id} has no active worker run; an artifact cannot name ${workerRunId} as producer`,
      );
    // Content is recorded truth: keep it byte-for-byte, only bound its size.
    const cleanContent = assertText(content, "content", BOUNDS.artifactContentMax, {
      trim: false,
    });
    assertNoSecret(cleanContent, "content");
    const artifact = newArtifact({
      companyId: this.#contextOfTask(task).companyId,
      workId: task.workId,
      taskId: task.id,
      generation,
      workerRunId: activeRun ? activeRun.id : null,
      kind: assertKind(kind, "kind"),
      title: assertText(title, "title", BOUNDS.artifactTitleMax),
      content: cleanContent,
      inputDigest: inputDigest
        ? assertText(inputDigest, "inputDigest", BOUNDS.digestMax)
        : null,
      supersedesArtifactId: supersedes,
      createdAt: this.now(),
    });
    this.#mutate(() => {
      this.store.insertArtifact(artifact);
      const { companyId, workId } = this.#contextOfTask(task);
      this.#event({
        companyId,
        workId,
        taskId: task.id,
        generation,
        kind: "artifact.recorded",
        detail: {
          artifactId: artifact.id,
          kind: artifact.kind,
          contentDigest: artifact.contentDigest,
        },
      });
      if (activeRun)
        this.#event({
          companyId,
          workId,
          taskId: task.id,
          generation,
          kind: "ARTIFACT_HANDED_OFF",
          detail: {
            taskId: task.id,
            artifactId: artifact.id,
            workerRunId: activeRun.id,
          },
        });
      if (artifact.supersedesArtifactId)
        this.#event({
          companyId,
          workId,
          taskId: task.id,
          generation,
          kind: EVENTS.ARTIFACT_SUPERSEDED,
          detail: {
            artifactId: artifact.id,
            supersededArtifactId: artifact.supersedesArtifactId,
            repairTaskId: task.id,
            repairBindingId: repairBinding.id,
          },
        });
    });
    return artifact;
  }

  completeTask({ taskId, generation } = {}) {
    const task = this.#requireTask(taskId);
    this.#assertExecutionWrite(task, generation);
    if (this.#activeRun(task.id))
      throw kernelError(
        "TASK_HAS_ACTIVE_RUN",
        `task ${task.id} is executed by a worker run; finish it with completeWorkerRun`,
      );
    this.#assertReviewNotRequired(task);
    const outputs = this.store
      .listArtifacts({ taskId: task.id })
      .filter((artifact) => artifact.generation === generation);
    if (outputs.length === 0)
      throw kernelError(
        "TASK_HAS_NO_ARTIFACT",
        `task ${task.id} has no artifact from generation ${generation}; a completion must name the output it completes`,
      );
    this.#mutate(() => {
      this.store.updateTask(task.id, {
        state: TASK_STATES.COMPLETED,
        generation: task.generation,
        updatedAt: this.now(),
      });
      const { companyId, workId } = this.#contextOfTask(task);
      this.#event({
        companyId,
        workId,
        taskId: task.id,
        generation,
        kind: "task.completed",
        detail: {
          artifactId: outputs.at(-1).id,
          artifactCount: outputs.length,
        },
      });
    });
    return this.task(task.id);
  }

  cancelTask({ taskId, note } = {}) {
    const task = this.#requireTask(taskId);
    if (!cancelAllowedFrom(task.state))
      throw kernelError(
        "INVALID_TRANSITION",
        `a ${task.state} task cannot be cancelled`,
      );
    const cleanNote =
      note === undefined || note === null
        ? null
        : assertText(note, "note", BOUNDS.cancelNoteMax, { min: 0 });
    if (cleanNote) assertNoSecret(cleanNote, "note");
    const generation = task.generation + 1;
    this.#mutate(() => {
      const activeRun = this.#activeRun(task.id);
      this.store.updateTask(task.id, {
        state: TASK_STATES.CANCELLED,
        generation,
        updatedAt: this.now(),
      });
      if (activeRun) this.#endRun(activeRun, WORKER_RUN_STATES.CANCELLED, "TASK_CANCELLED");
      const { companyId, workId } = this.#contextOfTask(task);
      this.#event({
        companyId,
        workId,
        taskId: task.id,
        generation,
        kind: "task.cancelled",
        detail: { previousState: task.state, note: cleanNote },
      });
    });
    return this.task(task.id);
  }

  // Idempotent: a second call finds nothing left to fence.
  recover() {
    this.recovery = this.#recoverOpenAttempts();
    return this.recovery;
  }

  // Start a Task *and* the WorkerRun that executes it, in one transaction.
  // There is no window in which a task is running without a run, or a run is
  // running for a task that never started.
  startWorkerRun({ taskId } = {}) {
    const task = this.#requireTask(taskId);
    if (!startAllowedFrom(task.state))
      throw kernelError(
        "INVALID_TRANSITION",
        `a ${task.state} task cannot start an execution attempt`,
      );
    const assignment = this.store.currentAssignment(task.id);
    if (!assignment)
      throw kernelError(
        "TASK_NOT_ASSIGNED",
        `task ${task.id} has no assignment; assign an employee before starting a run`,
      );
    // Execution revalidates the same rule before anything else: an Assignment
    // recorded before the rule existed is still only readable history, never an
    // executable review.
    const producerEmployeeId = this.#reviewProducerEmployeeId(task);
    if (producerEmployeeId === assignment.employeeId)
      throw kernelError(
        "REVIEWER_NOT_INDEPENDENT",
        `employee ${assignment.employeeId} produced the artifact review task ${task.id} judges; an Employee never reviews their own output`,
      );
    const employee = this.#requireEmployee(assignment.employeeId);
    if (!employee.enabled)
      throw kernelError("EMPLOYEE_DISABLED", `employee ${employee.id} is disabled`);
    const position = this.#requirePosition(employee.positionId);
    const requirements = this.store.getTaskRequirements(task.id);
    const missing = missingCapabilities(
      requirements?.requiredCapabilities ?? [],
      position.capabilities,
    );
    if (missing.length)
      throw kernelError(
        "TASK_REQUIREMENTS_UNSATISFIED",
        `position ${position.id} no longer satisfies task ${task.id}: missing [${missing.join(", ")}]`,
      );

    const { companyId, workId } = this.#contextOfTask(task);
    const generation = task.generation + 1;
    const startedAt = this.now();
    const packet = buildWorkPacket({
      company: this.store.getCompany(companyId),
      work: this.store.getWork(workId),
      task: { ...task, state: TASK_STATES.RUNNING, generation },
      requirements,
      assignment,
      employee,
      position,
      latestCheckpoint: this.store.listCheckpoints(task.id).at(-1) ?? null,
      artifacts: this.store.listArtifacts({ taskId: task.id }),
      review: this.#reviewSection(task, requirements),
      repair: this.#repairSection(task),
    });
    const run = newWorkerRun({
      companyId,
      workId,
      taskId: task.id,
      employeeId: employee.id,
      positionId: position.id,
      generation,
      workPacket: packet,
      workPacketDigest: workPacketDigest(packet),
      startedAt,
    });
    this.#mutate(() => {
      this.store.updateTask(task.id, {
        state: TASK_STATES.RUNNING,
        generation,
        updatedAt: startedAt,
      });
      this.store.insertWorkerRun(run);
      this.#event({
        companyId,
        workId,
        taskId: task.id,
        generation,
        kind: "task.execution_started",
        detail: { previousState: task.state },
      });
      this.#event({
        companyId,
        workId,
        taskId: task.id,
        generation,
        kind: "WORKER_RUN_STARTED",
        detail: {
          workerRunId: run.id,
          employeeId: employee.id,
          positionId: position.id,
          workPacketDigest: run.workPacketDigest,
        },
      });
      // Execution observation, post-commit only (Harness v0 §19). Duplicate
      // notification is safe: the Host re-reads WorkerRun truth before acting.
      this.#notifyRun({ workerRunId: run.id });
    });
    return { task: this.task(task.id), generation, workerRun: run, workPacket: packet };
  }

  completeWorkerRun({ taskId, generation } = {}) {
    const task = this.#requireTask(taskId);
    this.#assertExecutionWrite(task, generation);
    const run = this.#activeRun(task.id);
    if (!run)
      throw kernelError(
        "NO_ACTIVE_RUN",
        `task ${task.id} has no running worker run to complete`,
      );
    if (run.generation !== generation)
      throw kernelError(
        "STALE_GENERATION",
        `worker run ${run.id} holds generation ${run.generation}, not ${generation}`,
      );
    const outputs = this.store
      .listArtifacts({ taskId: task.id })
      .filter((artifact) => artifact.generation === generation);
    if (outputs.length === 0)
      throw kernelError(
        "TASK_HAS_NO_ARTIFACT",
        `task ${task.id} has no artifact from generation ${generation}; a worker completion must name the output it produced`,
      );
    this.#assertReviewNotRequired(task);
    this.#mutate(() => {
      this.#endRun(run, WORKER_RUN_STATES.COMPLETED, "WORK_COMPLETED");
      this.store.updateTask(task.id, {
        state: TASK_STATES.COMPLETED,
        generation: task.generation,
        updatedAt: this.now(),
      });
      const { companyId, workId } = this.#contextOfTask(task);
      this.#event({
        companyId,
        workId,
        taskId: task.id,
        generation,
        kind: "task.completed",
        detail: {
          artifactId: outputs.at(-1).id,
          artifactCount: outputs.length,
          workerRunId: run.id,
        },
      });
    });
    return { task: this.task(task.id), workerRun: this.store.getWorkerRun(run.id) };
  }

  // The terminal successful delivery seam for one WorkerRun (H0.2). The Worker
  // host hands over a validated successful result; the Runtime derives the rest
  // from the Task's own requirements, so the host can never choose a handoff.
  //
  // Artifact recording, the WorkerRun end, the source Task transition and the
  // Review handoff happen in ONE transaction. There is no committed state in
  // which an Artifact exists and its WorkerRun is still RUNNING.
  submitWorkerResult({
    workerRunId,
    generation,
    resultDigest,
    evidenceDigest,
    artifact = {},
    verificationSummary = null,
    ...overrides
  } = {}) {
    this.#assertNoDeliveryOverride(overrides);
    const runId = assertId(workerRunId, "workerRunId");
    const run = this.store.getWorkerRun(runId);
    if (!run) throw kernelError("WORKER_RUN_NOT_FOUND", `worker run ${runId} does not exist`);
    assertInteger(generation, "generation", { min: 0 });
    if (run.generation !== generation)
      throw kernelError(
        "STALE_GENERATION",
        `worker run ${run.id} holds generation ${run.generation}, not ${generation}`,
      );
    const cleanResultDigest = assertText(resultDigest, "resultDigest", BOUNDS.digestMax);
    assertNoSecret(cleanResultDigest, "resultDigest");
    const cleanEvidenceDigest = assertText(evidenceDigest, "evidenceDigest", BOUNDS.digestMax);
    assertNoSecret(cleanEvidenceDigest, "evidenceDigest");
    const cleanSummary =
      verificationSummary === null || verificationSummary === undefined
        ? null
        : assertText(
            verificationSummary,
            "verificationSummary",
            BOUNDS.workerVerificationSummaryMax,
          );
    if (cleanSummary) assertNoSecret(cleanSummary, "verificationSummary");
    const task = this.#requireTask(run.taskId);

    let receipt = null;
    let idempotent = false;
    this.#mutate(() => {
      // Result identity is (WorkerRun + generation + resultDigest). The receipt
      // lives in the append-only Activity stream, so a replay after a lost
      // response returns the committed delivery instead of writing a second one.
      const existing = this.store.resultSubmissionForRun(run.id);
      if (existing) {
        if (existing.detail.resultDigest !== cleanResultDigest)
          throw kernelError(
            "WORKER_RESULT_CONFLICT",
            `worker run ${run.id} already submitted digest ${existing.detail.resultDigest}, not ${cleanResultDigest}; a different result is a new attempt, never a rewrite of a delivered one`,
          );
        receipt = existing;
        idempotent = true;
        return;
      }
      const current = this.store.getWorkerRun(run.id);
      if (current.state !== WORKER_RUN_STATES.RUNNING)
        throw current.state === WORKER_RUN_STATES.COMPLETED
          ? kernelError(
              "WORKER_RESULT_CONFLICT",
              `worker run ${run.id} is already COMPLETED without a submission receipt; there is nothing to replay`,
            )
          : kernelError(
              "INVALID_TRANSITION",
              `worker run ${run.id} is ${current.state}; only a RUNNING attempt can deliver a result`,
            );

      const written = this.recordArtifact({
        taskId: task.id,
        generation,
        workerRunId: run.id,
        kind: artifact?.kind,
        title: artifact?.title,
        content: artifact?.content,
        supersedesArtifactId: artifact?.supersedesArtifactId ?? null,
      });
      const requirements = this.store.getTaskRequirements(task.id);
      const reviewRequired = (requirements?.reviewCapabilities ?? []).length > 0;
      const delivered = reviewRequired
        ? this.requestReview({ taskId: task.id, generation })
        : this.completeWorkerRun({ taskId: task.id, generation });
      receipt = this.#writeResultSubmission({
        task,
        run,
        artifact: written,
        resultDigest: cleanResultDigest,
        evidenceDigest: cleanEvidenceDigest,
        verificationSummary: cleanSummary,
        reviewRequired,
        reviewRequest: delivered.reviewRequest ?? null,
      });
    });
    return this.#submissionView(task, run, receipt, idempotent);
  }

  // The Reviewer-delivery seam (Harness Slice 1.1 §C–§F). A Reviewer Worker
  // reports a judgment about one exact Artifact; the Runtime derives the whole
  // lineage from the WorkerRun — Review Task, ReviewRequest, target Artifact
  // and digest, reviewer — so the host can never name what is being judged.
  //
  // The Review, the Reviewer attempt's end, the Review Task's completion, the
  // existing Review Activity and this bounded receipt commit together. The
  // Review itself is written by the one Review implementation (`submitReview`);
  // this command adds no second Review protocol, and it never creates a Repair
  // — REQUEST_REVISION leaves that to the existing continuation policy.
  submitWorkerReviewResult({
    workerRunId,
    generation,
    resultDigest,
    evidenceDigest,
    verdict,
    findings = [],
    summary,
    verificationSummary = null,
    ...overrides
  } = {}) {
    this.#assertNoReviewDeliveryOverride(overrides);
    const runId = assertId(workerRunId, "workerRunId");
    const run = this.store.getWorkerRun(runId);
    if (!run) throw kernelError("WORKER_RUN_NOT_FOUND", `worker run ${runId} does not exist`);
    assertInteger(generation, "generation", { min: 0 });
    if (run.generation !== generation)
      throw kernelError(
        "STALE_GENERATION",
        `worker run ${run.id} holds generation ${run.generation}, not ${generation}`,
      );
    const cleanResultDigest = assertText(resultDigest, "resultDigest", BOUNDS.digestMax);
    assertNoSecret(cleanResultDigest, "resultDigest");
    const cleanEvidenceDigest = assertText(evidenceDigest, "evidenceDigest", BOUNDS.digestMax);
    assertNoSecret(cleanEvidenceDigest, "evidenceDigest");
    // The judgment's own words. The existing Review primitive requires a
    // bounded summary and bounded findings, so this seam requires them too: a
    // judgment with nothing to say is not a judgment this Runtime records.
    const cleanSummary = assertText(summary, "summary", BOUNDS.reviewSummaryMax);
    assertNoSecret(cleanSummary, "summary");
    const cleanVerdict = assertVerdict(verdict);
    const cleanFindings = assertFindings(findings, "findings");
    if (cleanVerdict === REVIEW_VERDICTS.REQUEST_REVISION && cleanFindings.length === 0)
      throw kernelError(
        "FINDINGS_REQUIRED",
        `a REQUEST_REVISION review must say what has to change`,
      );
    const cleanVerification =
      verificationSummary === null || verificationSummary === undefined
        ? null
        : assertText(
            verificationSummary,
            "verificationSummary",
            BOUNDS.workerVerificationSummaryMax,
          );
    if (cleanVerification) assertNoSecret(cleanVerification, "verificationSummary");
    const task = this.#requireTask(run.taskId);

    let receipt = null;
    let review = null;
    let idempotent = false;
    this.#mutate(() => {
      // Submission identity is (WorkerRun + generation + resultDigest), carried
      // by the append-only Activity stream, so a replay after a lost response
      // converges on the committed Review instead of writing a second one.
      const existing = this.store.reviewResultSubmissionForRun(run.id);
      if (existing) {
        if (existing.detail.resultDigest !== cleanResultDigest)
          throw kernelError(
            "WORKER_REVIEW_RESULT_CONFLICT",
            `worker run ${run.id} already submitted review digest ${existing.detail.resultDigest}, not ${cleanResultDigest}; a different judgment is a new attempt, never a rewrite of a recorded one`,
          );
        receipt = existing;
        review = this.store.getReview(existing.detail.reviewId);
        idempotent = true;
        return;
      }
      const current = this.store.getWorkerRun(run.id);
      if (current.state !== WORKER_RUN_STATES.RUNNING)
        throw current.state === WORKER_RUN_STATES.COMPLETED
          ? kernelError(
              "WORKER_REVIEW_RESULT_CONFLICT",
              `worker run ${run.id} is already COMPLETED without a submission receipt; there is nothing to replay`,
            )
          : kernelError(
              "INVALID_TRANSITION",
              `worker run ${run.id} is ${current.state}; only a RUNNING attempt can deliver a review result`,
            );

      // Lineage is derived, never accepted from the caller: the ReviewRequest
      // for the run's own Task names the exact Artifact and digest under review.
      const request = this.store.reviewRequestForTask(task.id);
      if (!request)
        throw kernelError(
          "REVIEW_TASK_NOT_REVIEWABLE",
          `task ${task.id} is not a review task; it has no artifact under review`,
        );
      const active = this.#activeRun(task.id);
      if (!active || active.id !== run.id)
        throw kernelError(
          "NO_ACTIVE_RUN",
          `worker run ${run.id} is not the running attempt of task ${task.id}`,
        );
      const assignment = this.store.currentAssignment(task.id);
      if (!assignment || assignment.employeeId !== run.employeeId)
        throw kernelError(
          "TASK_NOT_ASSIGNED",
          `review task ${task.id} is not assigned to the employee of run ${run.id}`,
        );
      // Independence is not renegotiated at delivery: the Artifact's own
      // producer can never judge it, and an unprovable producer fails closed.
      const producerEmployeeId = this.#reviewProducerEmployeeId(task);
      if (producerEmployeeId === run.employeeId)
        throw kernelError(
          "REVIEWER_NOT_INDEPENDENT",
          `worker run ${run.id} produced the artifact it is judging; independence was already required before this attempt started`,
        );
      const target = this.store.getArtifact(request.targetArtifactId);
      if (!target || target.contentDigest !== request.targetArtifactDigest)
        throw kernelError(
          "REVIEW_TARGET_MISMATCH",
          `review task ${task.id} is bound to artifact ${request.targetArtifactId} at digest ${request.targetArtifactDigest}`,
        );

      const submitted = this.submitReview({
        reviewTaskId: task.id,
        generation,
        verdict: cleanVerdict,
        summary: cleanSummary,
        findings: cleanFindings,
      });
      review = submitted.review;
      receipt = this.#writeReviewSubmission({
        task,
        run,
        review,
        resultDigest: cleanResultDigest,
        evidenceDigest: cleanEvidenceDigest,
        verificationSummary: cleanVerification,
      });
    });
    return this.#reviewSubmissionView(task, run, review, receipt, idempotent);
  }

  // The execution binding seam (Harness v0 §13): persist the one immutable
  // record of where and how one WorkerRun attempt executes. Lineage is derived
  // from Runtime truth — the Host states the backend and the paths, never the
  // Company/Work/Task identity. A retry with the same facts returns the
  // committed binding; a different backend or workspace for the same attempt is
  // a conflict, because an attempt is never rebound.
  bindWorkerExecution({
    workerRunId,
    generation,
    backendType,
    backendVersion,
    executionProfileDigest,
    workspaceRoot,
    scratchRoot,
    baseRevision = null,
    branch = null,
    externalExecutionRef = null,
    externalSessionRef = null,
  } = {}) {
    const runId = assertId(workerRunId, "workerRunId");
    const run = this.store.getWorkerRun(runId);
    if (!run) throw kernelError("WORKER_RUN_NOT_FOUND", `worker run ${runId} does not exist`);
    assertInteger(generation, "generation", { min: 0 });
    if (run.generation !== generation)
      throw kernelError(
        "STALE_GENERATION",
        `worker run ${run.id} holds generation ${run.generation}, not ${generation}`,
      );
    const task = this.#requireTask(run.taskId);
    const { companyId, workId } = this.#contextOfTask(task);
    const cleanText = (value, field, max) => {
      const text = assertText(value, field, max);
      assertNoSecret(text, field);
      return text;
    };
    const nullableText = (value, field) =>
      value === null || value === undefined ? null : cleanText(value, field, BOUNDS.externalRefMax);
    const binding = newWorkerExecutionBinding({
      companyId,
      workId,
      taskId: task.id,
      workerRunId: run.id,
      generation,
      backendType: cleanText(backendType, "backendType", BOUNDS.backendTypeMax),
      backendVersion: cleanText(backendVersion, "backendVersion", BOUNDS.backendVersionMax),
      executionProfileDigest: cleanText(
        executionProfileDigest,
        "executionProfileDigest",
        BOUNDS.digestMax,
      ),
      workspaceRoot: cleanText(workspaceRoot, "workspaceRoot", BOUNDS.executionPathMax),
      scratchRoot: cleanText(scratchRoot, "scratchRoot", BOUNDS.executionPathMax),
      baseRevision: nullableText(baseRevision, "baseRevision"),
      branch: nullableText(branch, "branch"),
      externalExecutionRef: nullableText(externalExecutionRef, "externalExecutionRef"),
      externalSessionRef: nullableText(externalSessionRef, "externalSessionRef"),
      createdAt: this.now(),
    });
    if (binding.workspaceRoot === binding.scratchRoot)
      throw kernelError(
        "INVALID_INPUT",
        "workspaceRoot and scratchRoot must be different directories; scratch is not part of the deliverable workspace",
      );
    let committed = binding;
    let idempotent = false;
    this.#mutate(() => {
      const existing = this.store.getWorkerExecutionBindingByRun(run.id);
      if (existing) {
        if (!sameExecutionBindingFacts(existing, binding))
          throw kernelError(
            "EXECUTION_BINDING_CONFLICT",
            `worker run ${run.id} is already bound to ${existing.backendType} at ${existing.workspaceRoot}; an attempt is never rebound to another backend or workspace`,
          );
        committed = existing;
        idempotent = true;
        return;
      }
      if (run.state !== WORKER_RUN_STATES.RUNNING)
        throw kernelError(
          "INVALID_TRANSITION",
          `worker run ${run.id} is ${run.state}; only a RUNNING attempt is bound to an execution`,
        );
      this.store.insertWorkerExecutionBinding(binding);
      this.#event({
        companyId,
        workId,
        taskId: task.id,
        generation,
        kind: EVENTS.WORKER_EXECUTION_BOUND,
        detail: {
          bindingId: binding.id,
          workerRunId: run.id,
          backendType: binding.backendType,
          backendVersion: binding.backendVersion,
          executionProfileDigest: binding.executionProfileDigest,
        },
      });
    });
    return { binding: committed, idempotent };
  }

  // The Worker host's execution report: the current attempt can no longer
  // continue. This is NOT Founder authority — it cannot accept Work, cancel
  // anything, create a Review or Repair, or change permissions. It records one
  // fact through the same interruption primitive startup recovery uses, and
  // after COMMIT the ordinary continuation seam decides what may follow.
  interruptWorkerRun({ workerRunId, generation, reason } = {}) {
    const runId = assertId(workerRunId, "workerRunId");
    const run = this.store.getWorkerRun(runId);
    if (!run) throw kernelError("WORKER_RUN_NOT_FOUND", `worker run ${runId} does not exist`);
    assertInteger(generation, "generation", { min: 0 });
    if (!WORKER_INTERRUPTION_REASONS.includes(reason))
      throw kernelError(
        "INVALID_INPUT",
        `reason must be one of ${WORKER_INTERRUPTION_REASONS.join(" | ")}`,
      );
    const task = this.#requireTask(run.taskId);

    // Retry-safe: the same attempt is already INTERRUPTED. Nothing is written
    // and no duplicate interruption Activity is produced.
    if (run.state === WORKER_RUN_STATES.INTERRUPTED) {
      if (run.generation !== generation)
        throw kernelError(
          "STALE_GENERATION",
          `worker run ${run.id} holds generation ${run.generation}, not ${generation}`,
        );
      return { workerRun: run, task, interrupted: false, alreadyInterrupted: true };
    }
    if (run.state !== WORKER_RUN_STATES.RUNNING)
      throw kernelError(
        "INVALID_TRANSITION",
        `worker run ${run.id} is ${run.state}; only a RUNNING attempt can be interrupted`,
      );
    if (run.generation !== generation)
      throw kernelError(
        "STALE_GENERATION",
        `worker run ${run.id} holds generation ${run.generation}, not ${generation}`,
      );
    if (task.state !== TASK_STATES.RUNNING)
      throw kernelError(
        "INVALID_TRANSITION",
        `task ${task.id} is ${task.state}; only a RUNNING task can be interrupted`,
      );
    const activeRun = this.#activeRun(task.id);
    if (!activeRun || activeRun.id !== run.id)
      throw kernelError(
        "INVALID_TRANSITION",
        `worker run ${run.id} is not the active attempt of task ${task.id}`,
      );
    if (task.generation !== run.generation)
      throw kernelError(
        "STALE_GENERATION",
        `task ${task.id} is at generation ${task.generation}; the attempt holds ${run.generation}`,
      );

    this.#mutate(() => {
      this.#interruptAttempt(task, run, reason);
    });
    return {
      workerRun: this.store.getWorkerRun(run.id),
      task: this.task(task.id),
      interrupted: true,
      alreadyInterrupted: false,
    };
  }

  // --- review and repair (v0B2) --------------------------------------------

  // Hand a delivered Artifact off for independent review. This is the *only*
  // legal completion for a Task whose requirements demand review, and it does
  // four things in one transaction: completes the run, completes the Task,
  // creates the Review Task, and records the obligation. A crash can therefore
  // never leave a Task that looks finished while its review silently vanished.
  requestReview({ taskId, generation } = {}) {
    const task = this.#requireTask(taskId);
    this.#assertExecutionWrite(task, generation);
    this.#assertNotReviewTask(task);
    const run = this.#activeRun(task.id);
    if (!run)
      throw kernelError(
        "NO_ACTIVE_RUN",
        `task ${task.id} has no running worker run to hand off`,
      );
    const requirements = this.store.getTaskRequirements(task.id);
    const reviewCapabilities = requirements?.reviewCapabilities ?? [];
    if (reviewCapabilities.length === 0)
      throw kernelError(
        "REVIEW_NOT_REQUIRED",
        `task ${task.id} does not require review; complete it with completeWorkerRun`,
      );
    const outputs = this.store
      .listArtifacts({ taskId: task.id })
      .filter((artifact) => artifact.generation === generation);
    if (outputs.length === 0)
      throw kernelError(
        "TASK_HAS_NO_ARTIFACT",
        `task ${task.id} has no artifact from generation ${generation}; there is nothing to review`,
      );
    const target = outputs.at(-1);
    const { companyId, workId } = this.#contextOfTask(task);
    const now = this.now();
    const reviewTask = newTask({
      workId,
      title: assertText(`Review: ${task.title}`, "title", BOUNDS.taskTitleMax),
      intent: `Independently review artifact ${target.id} produced by task ${task.id}.`,
      createdAt: now,
    });
    const reviewRequest = newReviewRequest({
      companyId,
      workId,
      reviewTaskId: reviewTask.id,
      sourceTaskId: task.id,
      targetArtifactId: target.id,
      targetArtifactDigest: target.contentDigest,
      createdAt: now,
    });
    this.#mutate(() => {
      this.#endRun(run, WORKER_RUN_STATES.COMPLETED, "WORK_COMPLETED");
      this.store.updateTask(task.id, {
        state: TASK_STATES.COMPLETED,
        generation: task.generation,
        updatedAt: now,
      });
      this.#event({
        companyId,
        workId,
        taskId: task.id,
        generation,
        kind: "task.completed",
        detail: {
          artifactId: target.id,
          artifactCount: outputs.length,
          workerRunId: run.id,
          handedOffForReview: true,
        },
      });
      this.store.insertTask(reviewTask);
      this.#event({
        companyId,
        workId,
        taskId: reviewTask.id,
        kind: "task.created",
        detail: { title: reviewTask.title, reviewsTaskId: task.id },
      });
      this.store.upsertTaskRequirements({
        taskId: reviewTask.id,
        requiredCapabilities: reviewCapabilities,
        reviewCapabilities: [],
        createdAt: now,
        updatedAt: now,
      });
      this.#event({
        companyId,
        workId,
        taskId: reviewTask.id,
        kind: EVENTS.TASK_REQUIREMENTS_SET,
        detail: { requiredCapabilities: reviewCapabilities, reviewCapabilities: [] },
      });
      this.store.insertReviewRequest(reviewRequest);
      this.#event({
        companyId,
        workId,
        taskId: reviewTask.id,
        generation,
        kind: EVENTS.REVIEW_REQUESTED,
        detail: {
          reviewRequestId: reviewRequest.id,
          sourceTaskId: task.id,
          targetArtifactId: target.id,
          targetArtifactDigest: target.contentDigest,
          requiredCapabilities: reviewCapabilities,
        },
      });
    });
    return {
      task: this.task(task.id),
      workerRun: this.store.getWorkerRun(run.id),
      targetArtifact: target,
      reviewTask,
      reviewRequest,
    };
  }

  // The reviewer's judgment, written once. The Review, the run end and the Task
  // completion commit together, so a Review can never exist without the
  // completion it belongs to, and a Review Task can never complete without its
  // Review.
  submitReview({ reviewTaskId, generation, verdict, summary, findings = [] } = {}) {
    const task = this.#requireTask(reviewTaskId);
    this.#assertExecutionWrite(task, generation);
    const request = this.store.reviewRequestForTask(task.id);
    if (!request)
      throw kernelError(
        "REVIEW_TASK_NOT_REVIEWABLE",
        `task ${task.id} is not a review task; it has no artifact under review`,
      );
    if (this.store.reviewForTask(task.id))
      throw kernelError(
        "REVIEW_ALREADY_EXISTS",
        `review task ${task.id} already has a recorded judgment; a wrong review is corrected by a new cycle`,
      );
    const run = this.#activeRun(task.id);
    if (!run)
      throw kernelError(
        "NO_ACTIVE_RUN",
        `review task ${task.id} has no running worker run to submit from`,
      );
    const assignment = this.store.currentAssignment(task.id);
    if (!assignment || assignment.employeeId !== run.employeeId)
      throw kernelError(
        "TASK_NOT_ASSIGNED",
        `review task ${task.id} is not assigned to the employee of run ${run.id}`,
      );
    const target = this.store.getArtifact(request.targetArtifactId);
    if (!target || target.contentDigest !== request.targetArtifactDigest)
      throw kernelError(
        "REVIEW_TARGET_MISMATCH",
        `review task ${task.id} is bound to artifact ${request.targetArtifactId} at digest ${request.targetArtifactDigest}`,
      );
    const { companyId, workId } = this.#contextOfTask(task);
    if (target.companyId !== companyId || target.workId !== workId || request.workId !== workId)
      throw kernelError(
        "REVIEW_TARGET_MISMATCH",
        `review task ${task.id}, artifact ${target.id} and its request do not share one company and work`,
      );
    const cleanVerdict = assertVerdict(verdict);
    const cleanSummary = assertText(summary, "summary", BOUNDS.reviewSummaryMax);
    assertNoSecret(cleanSummary, "summary");
    const cleanFindings = assertFindings(findings, "findings");
    if (cleanVerdict === REVIEW_VERDICTS.REQUEST_REVISION && cleanFindings.length === 0)
      throw kernelError(
        "FINDINGS_REQUIRED",
        `a REQUEST_REVISION review must say what has to change`,
      );
    const review = newReview({
      companyId,
      workId,
      reviewTaskId: task.id,
      reviewerWorkerRunId: run.id,
      targetArtifactId: target.id,
      targetArtifactDigest: target.contentDigest,
      verdict: cleanVerdict,
      summary: cleanSummary,
      findings: cleanFindings,
      createdAt: this.now(),
    });
    this.#mutate(() => {
      this.store.insertReview(review);
      this.#endRun(run, WORKER_RUN_STATES.COMPLETED, "REVIEW_COMPLETED");
      this.store.updateTask(task.id, {
        state: TASK_STATES.COMPLETED,
        generation: task.generation,
        updatedAt: review.createdAt,
      });
      this.#event({
        companyId,
        workId,
        taskId: task.id,
        generation,
        kind: EVENTS.REVIEW_SUBMITTED,
        detail: {
          reviewId: review.id,
          verdict: review.verdict,
          targetArtifactId: review.targetArtifactId,
          targetArtifactDigest: review.targetArtifactDigest,
          findingsCount: review.findings.length,
        },
      });
      this.#event({
        companyId,
        workId,
        taskId: task.id,
        generation,
        kind:
          review.verdict === REVIEW_VERDICTS.PASS
            ? EVENTS.REVIEW_PASSED
            : EVENTS.REVISION_REQUESTED,
        detail: {
          reviewId: review.id,
          targetArtifactId: review.targetArtifactId,
          findings: review.findings,
        },
      });
      this.#event({
        companyId,
        workId,
        taskId: task.id,
        generation,
        kind: "task.completed",
        detail: { reviewId: review.id, verdict: review.verdict, workerRunId: run.id },
      });
    });
    return {
      review,
      task: this.task(task.id),
      workerRun: this.store.getWorkerRun(run.id),
    };
  }

  // Turn a revision request into a Repair Task with immutable lineage. The
  // original Task, Artifact and Review are untouched: repair is new work, not a
  // reopening. One repair per review; a second call returns the existing one.
  createRepairTask({ reviewId } = {}) {
    const review = this.store.getReview(assertId(reviewId, "reviewId"));
    if (!review)
      throw kernelError("REVIEW_NOT_FOUND", `review ${reviewId} does not exist`);
    const existing = this.store.repairBindingForReview(review.id);
    if (existing)
      return {
        task: this.task(existing.repairTaskId),
        repairBinding: existing,
        assignment: this.store.currentAssignment(existing.repairTaskId) ?? null,
      };
    if (review.verdict !== REVIEW_VERDICTS.REQUEST_REVISION)
      throw kernelError(
        "REVISION_NOT_REQUESTED",
        `review ${review.id} is ${review.verdict}; a repair needs a REQUEST_REVISION review`,
      );
    const request = this.store.reviewRequestForTask(review.reviewTaskId);
    if (!request || request.targetArtifactId !== review.targetArtifactId)
      throw kernelError(
        "REVIEW_TARGET_MISMATCH",
        `review ${review.id} is not bound to a recorded review request`,
      );
    const sourceTask = this.#requireTask(request.sourceTaskId);
    const target = this.store.getArtifact(review.targetArtifactId);
    if (!target || target.contentDigest !== review.targetArtifactDigest)
      throw kernelError(
        "REVIEW_TARGET_MISMATCH",
        `review ${review.id} targets artifact ${review.targetArtifactId} at digest ${review.targetArtifactDigest}`,
      );
    const sourceRequirements = this.store.getTaskRequirements(sourceTask.id);
    const { companyId, workId } = this.#contextOfTask(sourceTask);
    const now = this.now();
    const repairTask = newTask({
      workId,
      title: assertText(`Repair: ${sourceTask.title}`, "title", BOUNDS.taskTitleMax),
      intent: `Produce a replacement for artifact ${target.id}, answering review ${review.id}.`,
      createdAt: now,
    });
    const repairBinding = newRepairBinding({
      companyId,
      workId,
      repairTaskId: repairTask.id,
      reviewId: review.id,
      sourceTaskId: sourceTask.id,
      targetArtifactId: review.targetArtifactId,
      targetArtifactDigest: review.targetArtifactDigest,
      createdAt: now,
    });
    // Deterministic policy, no allocation: the employee who produced the
    // artifact under review gets the repair, if it is still eligible. Otherwise
    // the Task stays unassigned — no second-choice employee, no Founder ping.
    const producerRun = target.workerRunId
      ? this.store.getWorkerRun(target.workerRunId)
      : null;
    const producer = producerRun ? this.store.getEmployee(producerRun.employeeId) : null;
    let eligible = null;
    if (producer && producer.enabled && producer.companyId === companyId) {
      const position = this.store.getPosition(producer.positionId);
      const missing = missingCapabilities(
        sourceRequirements?.requiredCapabilities ?? [],
        position.capabilities,
      );
      if (missing.length === 0) eligible = { employee: producer, position };
    }
    const assignment = eligible
      ? newAssignment({
          companyId,
          taskId: repairTask.id,
          employeeId: eligible.employee.id,
          positionId: eligible.position.id,
          reason: "original_producer",
          createdAt: now,
        })
      : null;
    this.#mutate(() => {
      this.store.insertTask(repairTask);
      this.#event({
        companyId,
        workId,
        taskId: repairTask.id,
        kind: "task.created",
        detail: { title: repairTask.title, repairsTaskId: sourceTask.id },
      });
      this.store.upsertTaskRequirements({
        taskId: repairTask.id,
        requiredCapabilities: sourceRequirements?.requiredCapabilities ?? [],
        reviewCapabilities: sourceRequirements?.reviewCapabilities ?? [],
        createdAt: now,
        updatedAt: now,
      });
      this.#event({
        companyId,
        workId,
        taskId: repairTask.id,
        kind: EVENTS.TASK_REQUIREMENTS_SET,
        detail: {
          requiredCapabilities: sourceRequirements?.requiredCapabilities ?? [],
          reviewCapabilities: sourceRequirements?.reviewCapabilities ?? [],
          copiedFromTaskId: sourceTask.id,
        },
      });
      this.store.insertRepairBinding(repairBinding);
      this.#event({
        companyId,
        workId,
        taskId: repairTask.id,
        kind: EVENTS.REPAIR_TASK_CREATED,
        detail: {
          repairBindingId: repairBinding.id,
          reviewId: review.id,
          sourceTaskId: sourceTask.id,
          targetArtifactId: repairBinding.targetArtifactId,
          targetArtifactDigest: repairBinding.targetArtifactDigest,
          assignedEmployeeId: eligible?.employee.id ?? null,
        },
      });
      if (assignment) {
        this.store.insertAssignment(assignment);
        this.#event({
          companyId,
          workId,
          taskId: repairTask.id,
          kind: EVENTS.TASK_ASSIGNED,
          detail: {
            assignmentId: assignment.id,
            employeeId: assignment.employeeId,
            positionId: assignment.positionId,
            reason: assignment.reason,
            requiredCapabilities: sourceRequirements?.requiredCapabilities ?? [],
          },
        });
      }
    });
    return { task: repairTask, repairBinding, assignment };
  }

  // --- founder acceptance (v0B3) --------------------------------------------

  // The Founder's ACCEPT: the one explicit human authority act of v0B3. It
  // records what the Founder decided about an exact Artifact at an exact
  // revision of the Work's reality — and nothing else. No Work status is
  // stored, no Task changes, no Review is touched, no Knowledge is written.
  // Contract: docs/contracts/founder-attention-acceptance-v0.md §8, §9.
  //
  // Every check that establishes current reality happens inside the
  // transaction, so a decision can never be committed against a Work state
  // that has already moved on. The idempotency check runs first, and before
  // staleness: a retry of an identical decision is not a second decision.
  acceptWork({ workId, artifactId, artifactDigest, basis } = {}) {
    const work = assertId(workId, "workId");
    const targetArtifactId = assertId(artifactId, "artifactId");
    const digest = assertText(artifactDigest, "artifactDigest", BOUNDS.digestMax);
    assertNoSecret(digest, "artifactDigest");
    const inspectedBasis = assertInteger(basis, "basis", { min: 1 });

    let decision = null;
    let idempotent = false;
    this.#mutate(() => {
      const existing = this.store.founderDecisionForWork(work);
      if (existing) {
        if (
          existing.artifactId !== targetArtifactId ||
          existing.artifactDigest !== digest ||
          existing.basisSequence !== inspectedBasis
        )
          throw kernelError(
            "WORK_ALREADY_DECIDED",
            `work ${work} already carries a Founder Decision (${existing.disposition}) on artifact ${existing.artifactId} at basis ${existing.basisSequence}; a different decision is a new cycle of work, never a rewrite of history`,
          );
        decision = existing;
        idempotent = true;
        return;
      }

      const record = this.#requireWork(work);
      const artifact = this.store.getArtifact(targetArtifactId);
      if (
        !artifact ||
        artifact.workId !== record.id ||
        artifact.companyId !== record.companyId
      )
        throw kernelError(
          "DECISION_TARGET_MISMATCH",
          `artifact ${targetArtifactId} is not an artifact of work ${record.id}`,
        );
      if (artifact.contentDigest !== digest)
        throw kernelError(
          "DECISION_TARGET_MISMATCH",
          `artifact ${artifact.id} is recorded at digest ${artifact.contentDigest}, not ${digest}`,
        );

      const reads = this.#workReads(record);
      // The same derivation the Founder read, checked again inside the
      // transaction: a decision is validated against the projection it names.
      const candidates = reads.outcome.candidateArtifacts;
      if (candidates.length > 1)
        throw kernelError(
          "OUTCOME_AMBIGUOUS",
          `work ${record.id} has ${candidates.length} current outcome candidates; the Runtime never picks one of them for the Founder`,
        );
      if (candidates.length === 0 || candidates[0].id !== artifact.id)
        throw kernelError(
          "ARTIFACT_NOT_CURRENT",
          `artifact ${artifact.id} is not the current outcome candidate of work ${record.id}`,
        );
      if (reads.collaboration.status !== "READY_FOR_DECISION")
        throw kernelError(
          "WORK_NOT_READY_FOR_DECISION",
          `work ${record.id} is ${reads.collaboration.status}; acceptance is a decision about a finished outcome`,
        );

      // The Founder must decide on the reality they inspected. The Work
      // Activity head says which reality that is.
      if (inspectedBasis < reads.decisionBasis)
        throw kernelError(
          "STALE_DECISION_BASIS",
          `work ${record.id} moved on since basis ${inspectedBasis} (now ${reads.decisionBasis}); read the Work again before deciding`,
        );
      if (inspectedBasis > reads.decisionBasis)
        throw kernelError(
          "INVALID_DECISION_BASIS",
          `basis ${inspectedBasis} is ahead of work ${record.id}'s current basis ${reads.decisionBasis}`,
        );

      decision = newFounderDecision({
        companyId: record.companyId,
        workId: record.id,
        disposition: FOUNDER_DECISION_DISPOSITIONS.ACCEPT,
        artifactId: artifact.id,
        artifactDigest: artifact.contentDigest,
        basisSequence: inspectedBasis,
        createdAt: this.now(),
      });
      this.store.insertFounderDecision(decision);
      this.#event({
        companyId: record.companyId,
        workId: record.id,
        kind: EVENTS.WORK_ACCEPTED,
        detail: {
          decisionId: decision.id,
          disposition: decision.disposition,
          artifactId: decision.artifactId,
          artifactDigest: decision.artifactDigest,
          basisSequence: decision.basisSequence,
        },
      });
    });

    return { decision, work: this.workProjection(work), idempotent };
  }

  // Generic, data-driven seed application: positions and employees with stable
  // ids. Idempotent — an identical redefinition is skipped, a conflicting one
  // fails instead of silently overwriting. The data itself lives outside the
  // core (fixtures/seeds/system-workforce.mjs).
  bootstrapWorkforce({ companyId, positions = [], employees = [] } = {}) {
    const company = assertId(companyId, "companyId");
    if (!this.store.getCompany(company))
      throw kernelError("COMPANY_NOT_FOUND", `company ${company} does not exist`);
    const result = { positions: 0, employees: 0, skipped: 0 };
    this.#mutate(() => {
      for (const spec of positions) {
        const desired = {
          id: assertRecordId(spec?.id, "positions[].id"),
          title: assertText(spec?.title, "positions[].title", BOUNDS.positionTitleMax),
          capabilities: assertCapabilityList(spec?.capabilities, "positions[].capabilities"),
        };
        const existing = this.store.getPosition(desired.id);
        if (existing) {
          if (
            existing.companyId !== company ||
            existing.title !== desired.title ||
            existing.capabilities.join("\u0000") !== desired.capabilities.join("\u0000")
          )
            throw kernelError(
              "SEED_CONFLICT",
              `position ${desired.id} already exists with different content`,
            );
          result.skipped += 1;
          continue;
        }
        this.store.insertPosition(
          newPosition({ ...desired, companyId: company, createdAt: this.now() }),
        );
        this.#event({
          companyId: company,
          kind: "POSITION_CREATED",
          detail: { ...desired, seeded: true },
        });
        result.positions += 1;
      }
      for (const spec of employees) {
        const desired = {
          id: assertRecordId(spec?.id, "employees[].id"),
          positionId: assertRecordId(spec?.positionId, "employees[].positionId"),
          displayName: assertText(spec?.displayName, "employees[].displayName", BOUNDS.employeeNameMax),
          enabled: assertEnabled(spec?.enabled ?? true, "employees[].enabled"),
        };
        const position = this.#requirePosition(desired.positionId);
        if (position.companyId !== company)
          throw kernelError(
            "CROSS_COMPANY_ASSIGNMENT",
            `position ${position.id} belongs to another company`,
          );
        const existing = this.store.getEmployee(desired.id);
        if (existing) {
          if (
            existing.companyId !== company ||
            existing.positionId !== desired.positionId ||
            existing.displayName !== desired.displayName ||
            existing.enabled !== desired.enabled
          )
            throw kernelError(
              "SEED_CONFLICT",
              `employee ${desired.id} already exists with different content`,
            );
          result.skipped += 1;
          continue;
        }
        this.store.insertEmployee(
          newEmployee({ ...desired, companyId: company, createdAt: this.now() }),
        );
        this.#event({
          companyId: company,
          kind: "EMPLOYEE_CREATED",
          detail: { ...desired, seeded: true },
        });
        result.employees += 1;
      }
      // One company wake for the whole bootstrap, and only when it actually
      // created Employees: seeding a roster can unblock existing Work.
      if (result.employees > 0)
        this.#notify({ cause: WAKE_CAUSES.EMPLOYEE_CREATED, companyId: company, companyWide: true });
    });
    return result;
  }

  // Every command body runs here: one transaction, and — only after COMMIT
  // succeeds — the committed facts are published to the continuation observer.
  // Nested calls belong to the outermost command, which owns the commit.
  #mutate(fn) {
    if (this.store.inTransaction) return this.store.transaction(fn);
    const notices = [];
    const runNotices = [];
    this.#notices = notices;
    this.#runNotices = runNotices;
    let result;
    try {
      result = this.store.transaction(fn);
    } finally {
      this.#notices = null;
      this.#runNotices = null;
    }
    this.#publish(notices);
    this.#publishRunNotices(runNotices);
    return result;
  }

  #notify(notice) {
    if (this.#notices) this.#notices.push(notice);
  }

  #notifyRun(notice) {
    if (this.#runNotices) this.#runNotices.push(notice);
  }

  // One signal per WorkerRun that entered RUNNING in this transaction. A
  // notification failure is an observability failure: the WorkerRun truth has
  // already committed and stays authoritative.
  #publishRunNotices(notices) {
    const observer = this.workerRunObserver;
    if (!observer || notices.length === 0) return;
    const seen = new Set();
    for (const notice of notices) {
      if (seen.has(notice.workerRunId)) continue;
      seen.add(notice.workerRunId);
      try {
        observer({ workerRunId: notice.workerRunId });
      } catch (error) {
        process.stderr.write(
          `worker run observer failed after commit: ${error?.message ?? error}\n`,
        );
      }
    }
  }

  // One signal per affected Work and one per company-wide cause: a transaction
  // that completed three runs of one company wakes that company once.
  #publish(notices) {
    const observer = this.continuationObserver;
    if (!observer || notices.length === 0) return;
    const signals = [];
    const companies = new Set();
    const works = new Set();
    for (const notice of notices) {
      if (notice.companyWide) {
        if (companies.has(notice.companyId)) continue;
        companies.add(notice.companyId);
        signals.push({ cause: notice.cause, companyId: notice.companyId, workId: null });
      } else if (notice.workId) {
        if (works.has(notice.workId)) continue;
        works.add(notice.workId);
        signals.push({ cause: notice.cause, companyId: notice.companyId, workId: notice.workId });
      }
    }
    for (const signal of signals) {
      try {
        observer(signal);
      } catch (error) {
        // Business truth already committed; an observer failure is an
        // observability failure, never a reason to fail the command.
        process.stderr.write(
          `continuation observer failed after commit: ${error?.message ?? error}\n`,
        );
      }
    }
  }

  #recoverOpenAttempts() {
    const interrupted = [];
    this.store.transaction(() => {
      for (const task of this.store.listTasksByState(TASK_STATES.RUNNING)) {
        const { companyId, workId } = this.#contextOfTask(task);
        const activeRun = this.#activeRun(task.id);
        const { interruptedGeneration } = this.#interruptAttempt(
          task,
          activeRun,
          INTERRUPTION_REASON,
        );
        interrupted.push({
          taskId: task.id,
          workId,
          companyId,
          interruptedGeneration,
          workerRunId: activeRun?.id ?? null,
        });
      }
    });
    return { interrupted, count: interrupted.length, at: this.openedAt };
  }

  // The ONE interruption primitive: fence the Task generation, mark the Task
  // INTERRUPTED, record the Activity, and end the attempt. Startup recovery and
  // the external `interruptWorkerRun` command both go through here, so there is
  // exactly one interruption semantics and one fencing rule.
  #interruptAttempt(task, run, reason) {
    const { companyId, workId } = this.#contextOfTask(task);
    const interruptedGeneration = task.generation;
    const fencedGeneration = interruptedGeneration + 1;
    this.store.updateTask(task.id, {
      state: TASK_STATES.INTERRUPTED,
      generation: fencedGeneration,
      updatedAt: this.now(),
    });
    this.#event({
      companyId,
      workId,
      taskId: task.id,
      generation: fencedGeneration,
      kind: "task.interrupted",
      detail: { interruptedGeneration, reason, automaticRetry: false },
    });
    if (run) this.#endRun(run, WORKER_RUN_STATES.INTERRUPTED, reason);
    return { interruptedGeneration, fencedGeneration };
  }

  // --- reads ----------------------------------------------------------------

  position(id) {
    return this.store.getPosition(assertId(id, "positionId")) ?? null;
  }

  positions(companyId) {
    return this.store.listPositions(assertId(companyId, "companyId"));
  }

  employee(id) {
    const employee = this.store.getEmployee(assertId(id, "employeeId"));
    return employee ? this.#withAvailability(employee) : null;
  }

  employees(companyId) {
    const company = assertId(companyId, "companyId");
    return this.store
      .listEmployees(company)
      .map((employee) => this.#withAvailability(employee, company));
  }

  taskRequirements(taskId) {
    return this.store.getTaskRequirements(assertId(taskId, "taskId")) ?? null;
  }

  assignment(taskId) {
    return this.store.currentAssignment(assertId(taskId, "taskId")) ?? null;
  }

  assignments(taskId) {
    return this.store.listAssignments(assertId(taskId, "taskId"));
  }

  workerRun(id) {
    return this.store.getWorkerRun(assertId(id, "workerRunId")) ?? null;
  }

  workerRuns({ taskId = null, employeeId = null, workId = null, state = null } = {}) {
    if (state !== null && !Object.values(WORKER_RUN_STATES).includes(state))
      throw kernelError(
        "INVALID_INPUT",
        `state must be one of ${Object.values(WORKER_RUN_STATES).join(" | ")}`,
      );
    return this.store.listWorkerRuns({
      taskId: taskId ? assertId(taskId, "taskId") : null,
      employeeId: employeeId ? assertId(employeeId, "employeeId") : null,
      workId: workId ? assertId(workId, "workId") : null,
      state,
    });
  }

  workerExecutionBinding(workerRunId) {
    return (
      this.store.getWorkerExecutionBindingByRun(assertId(workerRunId, "workerRunId")) ?? null
    );
  }

  workerExecutionBindings({ workId = null, taskId = null } = {}) {
    return this.store.listWorkerExecutionBindings({
      workId: workId ? assertId(workId, "workId") : null,
      taskId: taskId ? assertId(taskId, "taskId") : null,
    });
  }

  review(id) {
    return this.store.getReview(assertId(id, "reviewId")) ?? null;
  }

  reviews({ workId = null, targetArtifactId = null } = {}) {
    return this.store.listReviews({
      workId: workId ? assertId(workId, "workId") : null,
      targetArtifactId: targetArtifactId ? assertId(targetArtifactId, "artifactId") : null,
    });
  }

  reviewRequest(id) {
    return this.store.getReviewRequest(assertId(id, "reviewRequestId")) ?? null;
  }

  reviewRequestForTask(taskId) {
    return this.store.reviewRequestForTask(assertId(taskId, "taskId")) ?? null;
  }

  repairBinding(id) {
    return this.store.getRepairBinding(assertId(id, "repairBindingId")) ?? null;
  }

  repairBindings({ workId = null, sourceTaskId = null } = {}) {
    return this.store.listRepairBindings({
      workId: workId ? assertId(workId, "workId") : null,
      sourceTaskId: sourceTaskId ? assertId(sourceTaskId, "sourceTaskId") : null,
    });
  }

  company(id) {
    return this.store.getCompany(assertId(id, "companyId")) ?? null;
  }

  companies() {
    return this.store.listCompanies();
  }

  work(id) {
    return this.store.getWork(assertId(id, "workId")) ?? null;
  }

  works(companyId) {
    return this.store.listWorks(assertId(companyId, "companyId"));
  }

  task(id) {
    return this.store.getTask(assertId(id, "taskId")) ?? null;
  }

  tasks(workId) {
    return this.store.listTasks(assertId(workId, "workId"));
  }

  checkpoints(taskId) {
    return this.store.listCheckpoints(assertId(taskId, "taskId"));
  }

  artifacts({ taskId = null, workId = null } = {}) {
    return this.store.listArtifacts({
      taskId: taskId ? assertId(taskId, "taskId") : null,
      workId: workId ? assertId(workId, "workId") : null,
    });
  }

  artifact(id) {
    return this.store.getArtifact(assertId(id, "artifactId")) ?? null;
  }

  activity({ companyId = null, workId = null, taskId = null, limit = 100 } = {}) {
    return this.store.listActivity({
      companyId: companyId ? assertId(companyId, "companyId") : null,
      workId: workId ? assertId(workId, "workId") : null,
      taskId: taskId ? assertId(taskId, "taskId") : null,
      limit: Math.min(assertInteger(limit, "limit", { min: 1 }), 500),
    });
  }

  // The Continuation Trace, read explicitly and never mixed into a Work
  // projection: it explains how the Runtime got here, it does not say what is
  // true now (v0B4 §12).
  continuationTraces({ workId, limit = 100 } = {}) {
    const id = assertId(workId, "workId");
    this.#requireWork(id);
    return this.store.listContinuationTraces({
      workId: id,
      limit: Math.min(assertInteger(limit, "limit", { min: 1 }), 500),
    });
  }

  // Founder Attention for a whole company: at most one item per Work, ordered
  // by how urgently a human is actually needed. Nothing is stored and nothing
  // is marked: there is no read flag, no dismissal and no second lifecycle,
  // because "what needs me now" is a question about Runtime truth, and Runtime
  // truth already knows the answer (v0B3 §11).
  founderAttention({ companyId } = {}) {
    const company = assertId(companyId, "companyId");
    if (!this.store.getCompany(company))
      throw kernelError("COMPANY_NOT_FOUND", `company ${company} does not exist`);
    const items = [];
    for (const work of this.store.listWorks(company)) {
      const { item } = this.#workReads(work).founderAttention;
      if (item) items.push(item);
    }
    return sortAttentionItems(items);
  }

  // The Work projection: Work status is derived from Task truth, never stored.
  workProjection(id) {
    const work = this.#requireWork(id);
    const reads = this.#workReads(work);
    const { tasks, artifacts, reviews, reviewRequests, repairBindings, collaboration } =
      reads;
    const latest = latestArtifact(artifacts);
    const taskCounts = {};
    for (const task of tasks)
      taskCounts[task.state] = (taskCounts[task.state] ?? 0) + 1;
    const summary = (task) =>
      task && {
        id: task.id,
        title: task.title,
        intent: task.intent,
        state: task.state,
        generation: task.generation,
        updatedAt: task.updatedAt,
      };
    return {
      work,
      // v0B2: the Work's own status is derived from Tasks *and* their review
      // obligations. `taskStatus` keeps the v0A task-only reading available.
      status: collaboration.status,
      stage: collaboration.stage,
      taskStatus: deriveWorkStatus(tasks),
      // v0B3: what this Work's outcome is right now, and — when the Runtime
      // offers no autonomous continuation and a legal Founder action exists —
      // whether the Work is waiting on the Founder. Both are derived from
      // truth; neither is stored, and reading them mutates nothing.
      outcome: reads.outcome,
      decisionBasis: reads.decisionBasis,
      founderAttention: reads.founderAttention,
      collaboration: {
        outstanding: collaboration.outstanding,
        round: collaboration.round,
        openReviewTaskId: collaboration.openReviewTaskId,
        openRepairTaskId: collaboration.openRepairTaskId,
        pendingReviewTaskIds: collaboration.pendingReviewTaskIds,
        unownedRevisionReviewIds: collaboration.unownedRevisionReviewIds,
        unfinishedRepairTaskIds: collaboration.unfinishedRepairTaskIds,
      },
      taskCounts,
      tasks: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        state: task.state,
        generation: task.generation,
        updatedAt: task.updatedAt,
      })),
      attention: tasks
        .filter((task) => task.state === TASK_STATES.INTERRUPTED)
        .map((task) => ({
          taskId: task.id,
          title: task.title,
          generation: task.generation,
        })),
      // v0B2 reading of the supersession chain: "the newest Artifact that
      // nothing has replaced". It is never how an outcome is decided — a Work
      // with two current candidates is AMBIGUOUS whichever one is newest.
      latestArtifact: latest
        ? {
            id: latest.id,
            taskId: latest.taskId,
            generation: latest.generation,
            kind: latest.kind,
            title: latest.title,
            contentDigest: latest.contentDigest,
            workerRunId: latest.workerRunId,
            supersedesArtifactId: latest.supersedesArtifactId,
            createdAt: latest.createdAt,
          }
        : null,
      artifacts: artifacts.map((artifact) => ({
        id: artifact.id,
        taskId: artifact.taskId,
        generation: artifact.generation,
        kind: artifact.kind,
        title: artifact.title,
        contentDigest: artifact.contentDigest,
        workerRunId: artifact.workerRunId,
        supersedesArtifactId: artifact.supersedesArtifactId,
        createdAt: artifact.createdAt,
      })),
      reviews,
      reviewRequests,
      repairBindings,
      supersession: supersessionChain(artifacts),
      latestReview:
        reviews.length > 0 ? reviews[reviews.length - 1] : null,
      openReviewTask:
        summary(tasks.find((task) => task.id === collaboration.openReviewTaskId)) ?? null,
      openRepairTask:
        summary(tasks.find((task) => task.id === collaboration.openRepairTaskId)) ?? null,
    };
  }

  taskDetail(id) {
    const task = this.#requireTask(id);
    return {
      task,
      requirements: this.store.getTaskRequirements(task.id) ?? null,
      assignment: this.store.currentAssignment(task.id) ?? null,
      assignments: this.store.listAssignments(task.id),
      runs: this.store.listWorkerRuns({ taskId: task.id }),
      checkpoints: this.store.listCheckpoints(task.id),
      artifacts: this.store.listArtifacts({ taskId: task.id }),
      reviewRequest: this.store.reviewRequestForTask(task.id) ?? null,
      review: this.store.reviewForTask(task.id) ?? null,
      repairBinding: this.store.repairBindingForTask(task.id) ?? null,
      reviews: this.store
        .listReviewRequests({ sourceTaskId: task.id })
        .map((request) => this.store.reviewForTask(request.reviewTaskId))
        .filter(Boolean),
      activity: this.store.listActivity({ taskId: task.id }),
    };
  }

  status() {
    return {
      schemaVersion: SCHEMA_VERSION,
      storePath: this.store.path,
      openedAt: this.openedAt,
      recovery: this.recovery,
      counts: this.store.counts(),
      tasksByState: this.store.tasksByState(),
      needsAttention: this.store
        .listTasksByState(TASK_STATES.INTERRUPTED)
        .map((task) => ({ taskId: task.id, workId: task.workId, title: task.title })),
    };
  }

  // --- internals ------------------------------------------------------------

  // One instant of Work-scoped truth, read once and shared by every projection
  // derived from it, so status, outcome, attention and basis can never describe
  // three slightly different moments. All of it is derived here; none of it is
  // stored.
  #workReads(work) {
    const tasks = this.store.listTasks(work.id);
    const artifacts = this.store.listArtifacts({ workId: work.id });
    const reviews = this.store.listReviews({ workId: work.id });
    const reviewRequests = this.store.listReviewRequests({ workId: work.id });
    const repairBindings = this.store.listRepairBindings({ workId: work.id });
    const decision = this.store.founderDecisionForWork(work.id);
    const decisionBasis = this.store.workActivityHead(work.id);
    const requirementsByTask = new Map();
    const assignmentsByTask = new Map();
    for (const task of tasks) {
      const requirements = this.store.getTaskRequirements(task.id);
      if (requirements) requirementsByTask.set(task.id, requirements);
      const assignment = this.store.currentAssignment(task.id);
      if (assignment) assignmentsByTask.set(task.id, assignment);
    }
    // Which Employees are executing right now, and who produced each artifact
    // under review: Founder Attention needs both to decide what the Runtime can
    // still continue by itself (v0B4 §11).
    const activeEmployeeIds = this.store
      .listActiveWorkerRuns(work.companyId)
      .map((run) => run.employeeId);
    const reviewProducerByTask = new Map();
    for (const request of reviewRequests) {
      const target = artifacts.find((artifact) => artifact.id === request.targetArtifactId) ?? null;
      const run = target?.workerRunId ? this.store.getWorkerRun(target.workerRunId) : null;
      if (run) reviewProducerByTask.set(request.reviewTaskId, run.employeeId);
    }
    // How many attempts each Task has already consumed: the autonomous retry
    // budget is derived from these durable rows, never stored and never read
    // from a trace.
    const attemptsByTask = new Map();
    for (const run of this.store.listWorkerRuns({ workId: work.id }))
      attemptsByTask.set(run.taskId, (attemptsByTask.get(run.taskId) ?? 0) + 1);
    const collaboration = deriveCollaboration({
      tasks,
      reviewRequests,
      reviews,
      repairBindings,
      artifacts,
    });
    const outcome = deriveOutcome({ tasks, artifacts, decision });
    const founderAttention = deriveWorkAttention({
      work,
      status: collaboration.status,
      tasks,
      reviewRequests,
      repairBindings,
      outcome,
      decision,
      employees: this.store.listEmployees(work.companyId),
      positions: this.store.listPositions(work.companyId),
      requirementsByTask,
      assignmentsByTask,
      reviewProducerByTask,
      activeEmployeeIds,
      attemptsByTask,
      decisionBasis,
    });
    return {
      tasks,
      artifacts,
      reviews,
      reviewRequests,
      repairBindings,
      decision,
      decisionBasis,
      collaboration,
      outcome,
      founderAttention,
    };
  }

  #requireWork(id) {
    const workId = assertId(id, "workId");
    const work = this.store.getWork(workId);
    if (!work) throw kernelError("WORK_NOT_FOUND", `work ${workId} does not exist`);
    return work;
  }

  #requireTask(id) {
    const taskId = assertId(id, "taskId");
    const task = this.store.getTask(taskId);
    if (!task) throw kernelError("TASK_NOT_FOUND", `task ${taskId} does not exist`);
    return task;
  }

  #requirePosition(id) {
    const positionId = assertId(id, "positionId");
    const position = this.store.getPosition(positionId);
    if (!position)
      throw kernelError("POSITION_NOT_FOUND", `position ${positionId} does not exist`);
    return position;
  }

  #requireEmployee(id) {
    const employeeId = assertId(id, "employeeId");
    const employee = this.store.getEmployee(employeeId);
    if (!employee)
      throw kernelError("EMPLOYEE_NOT_FOUND", `employee ${employeeId} does not exist`);
    return employee;
  }

  // A Task has at most one active run (enforced by a partial unique index), so
  // "the" active run is a well-defined lookup rather than a search heuristic.
  #activeRun(taskId) {
    return (
      this.store.listWorkerRuns({ taskId, state: WORKER_RUN_STATES.RUNNING })[0] ?? null
    );
  }

  #endRun(run, state, reason) {
    this.store.updateWorkerRun(run.id, {
      state,
      endedAt: this.now(),
      endReason: reason,
    });
    // The single WorkerRun-end seam: ending a run is the one fact that can
    // change Company workforce availability, so it is detected here and
    // published only if this transaction commits.
    this.#notify({
      cause: WAKE_CAUSES.WORKER_RUN_ENDED,
      companyId: run.companyId,
      companyWide: true,
    });
    this.#event({
      companyId: run.companyId,
      workId: run.workId,
      taskId: run.taskId,
      generation: run.generation,
      kind: RUN_END_EVENT_KIND[state],
      detail: { workerRunId: run.id, employeeId: run.employeeId, reason },
    });
  }

  #requirementsRecord(taskId, requiredCapabilities, reviewCapabilities, existing = null) {
    const now = this.now();
    return {
      taskId,
      requiredCapabilities,
      reviewCapabilities,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  // Availability is derived: `enabled` plus the active runs of the moment.
  #withAvailability(employee, companyId = employee.companyId) {
    const activeRuns = this.store.listActiveWorkerRuns(companyId);
    const active = activeRuns.find((run) => run.employeeId === employee.id) ?? null;
    return {
      ...employee,
      availability: deriveAvailability({
        enabled: employee.enabled,
        activeRunCount: active ? 1 : 0,
      }),
      activeRunId: active?.id ?? null,
    };
  }

  #contextOfTask(task) {
    const work = this.store.getWork(task.workId);
    if (!work)
      throw kernelError("WORK_NOT_FOUND", `task ${task.id} references missing work ${task.workId}`);
    return { workId: work.id, companyId: work.companyId };
  }

  #assertExecutionWrite(task, generation) {
    assertInteger(generation, "generation", { min: 0 });
    const fence = executionWriteFence(task, generation);
    if (fence === "STALE_GENERATION")
      throw kernelError(
        "STALE_GENERATION",
        `execution generation ${generation} is not current for task ${task.id} (current ${task.generation})`,
      );
    if (fence === "TASK_NOT_RUNNING")
      throw kernelError(
        "TASK_NOT_RUNNING",
        `task ${task.id} is ${task.state}; only a RUNNING task accepts execution writes`,
      );
  }

  // A review Task is an output of the collaboration protocol, not work that is
  // itself reviewed: there is no Artifact to hand off and no second-order cycle
  // in this milestone.
  #assertNotReviewTask(task) {
    if (this.store.reviewRequestForTask(task.id))
      throw kernelError(
        "REVIEW_TASK_NOT_REVIEWABLE",
        `task ${task.id} is a review task; a review of a review is not a collaboration shape`,
      );
    return task;
  }

  // Completing a Task that requires review without its Review Task would let a
  // crash window turn "not delivered" into "done". The only legal exit is
  // requestReview, which completes the Task and creates the Review Task in one
  // transaction.
  #assertReviewNotRequired(task) {
    const requirements = this.store.getTaskRequirements(task.id);
    if ((requirements?.reviewCapabilities ?? []).length === 0) return;
    throw kernelError(
      "REVIEW_REQUIRED",
      `task ${task.id} requires review by [${requirements.reviewCapabilities.join(", ")}]; hand the output off with requestReview`,
    );
  }

  // One rule, checked in one place: a Repair Task's output must replace exactly
  // the Artifact its binding names, and an ordinary Task's output must replace
  // nothing at all.
  #assertSupersession(task, repairBinding, supersedesArtifactId) {
    const named = supersedesArtifactId ?? null;
    if (!repairBinding && named)
      throw kernelError(
        "SUPERSEDES_NOT_ALLOWED",
        `task ${task.id} has no repair binding; only a repair may replace a recorded artifact`,
      );
    if (repairBinding && !named)
      throw kernelError(
        "SUPERSEDES_REQUIRED",
        `task ${task.id} repairs artifact ${repairBinding.targetArtifactId}; its output must name that artifact as superseded`,
      );
    if (!named) return null;
    const id = assertId(named, "supersedesArtifactId");
    const target = this.store.getArtifact(id);
    if (!target)
      throw kernelError("SUPERSEDES_NOT_FOUND", `artifact ${id} does not exist`);
    const { companyId, workId } = this.#contextOfTask(task);
    if (target.companyId !== companyId || target.workId !== workId)
      throw kernelError(
        "SUPERSEDES_OUT_OF_SCOPE",
        `artifact ${id} belongs to another company or work`,
      );
    if (id !== repairBinding.targetArtifactId)
      throw kernelError(
        "SUPERSEDES_OUT_OF_SCOPE",
        `task ${task.id} is bound to replace ${repairBinding.targetArtifactId}, not ${id}`,
      );
    return id;
  }

  // The review delivery's lineage is derived from the WorkerRun for the same
  // reason: a host that tries to name the task, request, target or reviewer is
  // refused rather than silently ignored.
  #assertNoReviewDeliveryOverride(overrides) {
    const named = Object.keys(overrides ?? {});
    if (named.length === 0) return;
    throw kernelError(
      "INVALID_INPUT",
      `submitWorkerReviewResult does not accept ${named.join(", ")}; the task, request, target artifact and reviewer this judgment belongs to are derived from the WorkerRun inside the Runtime`,
    );
  }

  // Delivery is derived, never chosen: a host that tries to select the handoff
  // is refused rather than silently ignored.
  #assertNoDeliveryOverride(overrides) {
    const named = Object.keys(overrides ?? {});
    if (named.length === 0) return;
    throw kernelError(
      "INVALID_INPUT",
      `submitWorkerResult does not accept ${named.join(", ")}; whether a delivery completes the Task or hands it off for review is derived from the Task's requirements inside the Runtime`,
    );
  }

  // The durable receipt of one successful delivery: append-only, bounded, and
  // traceable from both the WorkerRun and the Artifact. No logs, no raw event
  // stream, no transcript, no model output, no secrets. The full Harness
  // evidence stays outside the Runtime; only its digest is recorded.
  #writeResultSubmission({
    task,
    run,
    artifact,
    resultDigest,
    evidenceDigest,
    verificationSummary,
    reviewRequired,
    reviewRequest,
  }) {
    const { companyId, workId } = this.#contextOfTask(task);
    const detail = {
      workerRunId: run.id,
      generation: run.generation,
      artifactId: artifact.id,
      resultDigest,
      evidenceDigest,
      verificationSummary,
      reviewRequired,
      reviewRequestId: reviewRequest?.id ?? null,
    };
    this.#event({
      companyId,
      workId,
      taskId: task.id,
      generation: run.generation,
      kind: EVENTS.WORKER_RESULT_SUBMITTED,
      detail,
    });
    return { detail };
  }

  // The durable receipt of one Reviewer delivery: append-only, bounded and
  // traceable from the WorkerRun, the Review and the Review Task. Only the
  // judgment's identity and the Harness evidence digest are recorded — never
  // the evidence itself, the provider's raw output or any prompt text.
  #writeReviewSubmission({
    task,
    run,
    review,
    resultDigest,
    evidenceDigest,
    verificationSummary,
  }) {
    const { companyId, workId } = this.#contextOfTask(task);
    const detail = {
      workerRunId: run.id,
      generation: run.generation,
      reviewId: review.id,
      resultDigest,
      evidenceDigest,
      verificationSummary,
    };
    this.#event({
      companyId,
      workId,
      taskId: task.id,
      generation: run.generation,
      kind: EVENTS.WORKER_REVIEW_RESULT_SUBMITTED,
      detail,
    });
    return { detail };
  }

  #reviewSubmissionView(task, run, review, receipt, idempotent) {
    const { detail } = receipt;
    return {
      review: this.store.getReview(detail.reviewId),
      task: this.task(task.id),
      workerRun: this.store.getWorkerRun(run.id),
      resultDigest: detail.resultDigest,
      evidenceDigest: detail.evidenceDigest,
      verificationSummary: detail.verificationSummary,
      idempotent,
    };
  }

  #submissionView(task, run, receipt, idempotent) {
    const { detail } = receipt;
    const reviewRequest = detail.reviewRequestId
      ? this.store.getReviewRequest(detail.reviewRequestId)
      : null;
    return {
      workerRun: this.store.getWorkerRun(run.id),
      task: this.task(task.id),
      artifact: this.store.getArtifact(detail.artifactId),
      reviewRequired: detail.reviewRequired,
      reviewTask: reviewRequest ? this.task(reviewRequest.reviewTaskId) : null,
      reviewRequest,
      resultDigest: detail.resultDigest,
      evidenceDigest: detail.evidenceDigest,
      verificationSummary: detail.verificationSummary,
      idempotent,
    };
  }

  // What a reviewer is granted: the exact Artifact to judge, its recorded
  // digest, and the Task that produced it. Nothing else — no database dump, no
  // event log, no other Work, no prompt text.
  #reviewSection(task, requirements) {
    const request = this.store.reviewRequestForTask(task.id);
    if (!request) return null;
    const target = this.store.getArtifact(request.targetArtifactId);
    const sourceTask = this.store.getTask(request.sourceTaskId);
    if (!target || !sourceTask)
      throw kernelError(
        "REVIEW_TARGET_MISMATCH",
        `review request ${request.id} references a missing artifact or task`,
      );
    return {
      reviewRequestId: request.id,
      sourceTask: {
        id: sourceTask.id,
        title: sourceTask.title,
        intent: sourceTask.intent,
        generation: sourceTask.generation,
      },
      targetArtifact: {
        id: target.id,
        kind: target.kind,
        title: target.title,
        content: target.content,
        contentDigest: target.contentDigest,
        generation: target.generation,
        createdAt: target.createdAt,
      },
      reviewedDigest: request.targetArtifactDigest,
      reviewTask: { id: task.id, title: task.title, intent: task.intent },
      requiredCapabilities: [...(requirements?.requiredCapabilities ?? [])],
    };
  }

  // What a repairer is granted: which output it is correcting, why, and what the
  // corrected output must replace.
  #repairSection(task) {
    const binding = this.store.repairBindingForTask(task.id);
    if (!binding) return null;
    const review = this.store.getReview(binding.reviewId);
    const target = this.store.getArtifact(binding.targetArtifactId);
    const sourceTask = this.store.getTask(binding.sourceTaskId);
    if (!review || !target || !sourceTask)
      throw kernelError(
        "REPAIR_BINDING_NOT_FOUND",
        `repair binding ${binding.id} references a missing review, artifact or task`,
      );
    return {
      repairBindingId: binding.id,
      reviewId: review.id,
      reviewVerdict: review.verdict,
      reviewSummary: review.summary,
      reviewFindings: [...review.findings],
      sourceTask: {
        id: sourceTask.id,
        title: sourceTask.title,
        intent: sourceTask.intent,
      },
      targetArtifact: {
        id: target.id,
        kind: target.kind,
        title: target.title,
        contentDigest: target.contentDigest,
        generation: target.generation,
      },
      supersedesArtifactId: binding.targetArtifactId,
    };
  }

  #event({ companyId, workId = null, taskId = null, generation = null, kind, detail }) {
    this.store.appendActivity(
      newActivityEvent({
        companyId,
        workId,
        taskId,
        generation,
        kind,
        detail,
        createdAt: this.now(),
      }),
    );
    // Every Work-scoped fact is appended here, so a committed event is exactly
    // "this Work changed": the Driver re-reads it after COMMIT.
    if (workId) this.#notify({ cause: WAKE_CAUSES.WORK_CHANGED, companyId, workId });
  }

  // The Employee who produced the Artifact a Review Task judges, or null when
  // the Task is not a review. Fail closed: a review whose producer cannot be
  // established has no provable independence, so the caller must refuse.
  #reviewProducerEmployeeId(task) {
    const request = this.store.reviewRequestForTask(task.id);
    if (!request) return null;
    const target = this.store.getArtifact(request.targetArtifactId);
    const run = target?.workerRunId ? this.store.getWorkerRun(target.workerRunId) : null;
    if (!run)
      throw kernelError(
        "REVIEWER_NOT_INDEPENDENT",
        `review task ${task.id} has no establishable producer; this Runtime never starts a review whose independence cannot be proven`,
      );
    return run.employeeId;
  }
}

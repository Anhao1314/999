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
  BOUNDS,
  newActivityEvent,
  newArtifact,
  newCheckpoint,
} from "../work/records.mjs";
import { kernelError } from "./errors.mjs";
import {
  assertCapabilityList,
  assertEnabled,
  assertId,
  assertInteger,
  assertKind,
  assertNoSecret,
  assertRecordId,
  assertText,
  serializeJsonValue,
} from "./guards.mjs";
import { KernelStore, SCHEMA_VERSION } from "./store.mjs";
import {
  AVAILABILITY,
  WORKER_RUN_STATES,
  buildWorkPacket,
  deriveAvailability,
  missingCapabilities,
  newAssignment,
  newEmployee,
  newPosition,
  newWorkerRun,
  satisfiesCapabilities,
  workPacketDigest,
} from "../workforce/index.mjs";

const INTERRUPTION_REASON = "PROCESS_INTERRUPTED";

// Ending a WorkerRun always produces the matching audit event, from wherever
// the run was ended (completion, cancellation, recovery).
const RUN_END_EVENT_KIND = Object.freeze({
  [WORKER_RUN_STATES.COMPLETED]: "WORKER_RUN_COMPLETED",
  [WORKER_RUN_STATES.INTERRUPTED]: "WORKER_RUN_INTERRUPTED",
  [WORKER_RUN_STATES.CANCELLED]: "WORKER_RUN_CANCELLED",
});

export class WorkKernel {
  constructor({ dir, now = () => new Date().toISOString() }) {
    this.store = new KernelStore(dir);
    this.now = now;
    this.openedAt = this.now();
    this.recovery = this.#recoverOpenAttempts();
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
    this.store.transaction(() => {
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
    });
    return employee;
  }

  setEmployeeEnabled({ employeeId, enabled } = {}) {
    const employee = this.#requireEmployee(employeeId);
    const next = assertEnabled(enabled, "enabled");
    if (employee.enabled === next) return this.employee(employee.id);
    this.store.transaction(() => {
      this.store.updateEmployeeEnabled(employee.id, next);
      this.#event({
        companyId: employee.companyId,
        kind: "EMPLOYEE_UPDATED",
        detail: { employeeId: employee.id, enabled: next },
      });
    });
    return this.employee(employee.id);
  }

  setTaskRequirements({ taskId, requiredCapabilities } = {}) {
    const task = this.#requireTask(taskId);
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
      existing,
    );
    this.store.transaction(() => {
      this.store.upsertTaskRequirements(requirements);
      const { companyId, workId } = this.#contextOfTask(task);
      this.#event({
        companyId,
        workId,
        taskId: task.id,
        kind: "TASK_REQUIREMENTS_SET",
        detail: {
          requiredCapabilities: requirements.requiredCapabilities,
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
    this.store.transaction(() => {
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
    this.store.transaction(() => {
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
    this.store.transaction(() => {
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
          );
    this.store.transaction(() => {
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

  startTask({ taskId } = {}) {
    const task = this.#requireTask(taskId);
    if (!startAllowedFrom(task.state))
      throw kernelError(
        "INVALID_TRANSITION",
        `a ${task.state} task cannot start an execution attempt`,
      );
    const generation = task.generation + 1;
    this.store.transaction(() => {
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
    this.store.transaction(() => {
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
  } = {}) {
    const task = this.#requireTask(taskId);
    this.#assertExecutionWrite(task, generation);
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
      createdAt: this.now(),
    });
    this.store.transaction(() => {
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
    const outputs = this.store
      .listArtifacts({ taskId: task.id })
      .filter((artifact) => artifact.generation === generation);
    if (outputs.length === 0)
      throw kernelError(
        "TASK_HAS_NO_ARTIFACT",
        `task ${task.id} has no artifact from generation ${generation}; a completion must name the output it completes`,
      );
    this.store.transaction(() => {
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
    this.store.transaction(() => {
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
    this.store.transaction(() => {
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
    this.store.transaction(() => {
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

  // Generic, data-driven seed application: positions and employees with stable
  // ids. Idempotent — an identical redefinition is skipped, a conflicting one
  // fails instead of silently overwriting. The data itself lives outside the
  // core (fixtures/seeds/system-workforce.mjs).
  bootstrapWorkforce({ companyId, positions = [], employees = [] } = {}) {
    const company = assertId(companyId, "companyId");
    if (!this.store.getCompany(company))
      throw kernelError("COMPANY_NOT_FOUND", `company ${company} does not exist`);
    const result = { positions: 0, employees: 0, skipped: 0 };
    this.store.transaction(() => {
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
    });
    return result;
  }

  #recoverOpenAttempts() {
    const interrupted = [];
    this.store.transaction(() => {
      for (const task of this.store.listTasksByState(TASK_STATES.RUNNING)) {
        const { companyId, workId } = this.#contextOfTask(task);
        const fencedGeneration = task.generation + 1;
        const activeRun = this.#activeRun(task.id);
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
          detail: {
            interruptedGeneration: task.generation,
            reason: INTERRUPTION_REASON,
            automaticRetry: false,
          },
        });
        if (activeRun)
          this.#endRun(activeRun, WORKER_RUN_STATES.INTERRUPTED, INTERRUPTION_REASON);
        interrupted.push({
          taskId: task.id,
          workId,
          companyId,
          interruptedGeneration: task.generation,
          workerRunId: activeRun?.id ?? null,
        });
      }
    });
    return { interrupted, count: interrupted.length, at: this.openedAt };
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

  workerRuns({ taskId = null, employeeId = null } = {}) {
    return this.store.listWorkerRuns({
      taskId: taskId ? assertId(taskId, "taskId") : null,
      employeeId: employeeId ? assertId(employeeId, "employeeId") : null,
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

  activity({ companyId = null, workId = null, taskId = null, limit = 100 } = {}) {
    return this.store.listActivity({
      companyId: companyId ? assertId(companyId, "companyId") : null,
      workId: workId ? assertId(workId, "workId") : null,
      taskId: taskId ? assertId(taskId, "taskId") : null,
      limit: Math.min(assertInteger(limit, "limit", { min: 1 }), 500),
    });
  }

  // The Work projection: Work status is derived from Task truth, never stored.
  workProjection(id) {
    const work = this.#requireWork(id);
    const tasks = this.store.listTasks(work.id);
    const taskCounts = {};
    for (const task of tasks)
      taskCounts[task.state] = (taskCounts[task.state] ?? 0) + 1;
    return {
      work,
      status: deriveWorkStatus(tasks),
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
    this.#event({
      companyId: run.companyId,
      workId: run.workId,
      taskId: run.taskId,
      generation: run.generation,
      kind: RUN_END_EVENT_KIND[state],
      detail: { workerRunId: run.id, employeeId: run.employeeId, reason },
    });
  }

  #requirementsRecord(taskId, requiredCapabilities, existing = null) {
    const now = this.now();
    return {
      taskId,
      requiredCapabilities,
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
  }
}

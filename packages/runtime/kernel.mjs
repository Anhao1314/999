// The Persistent Work Kernel: the command seam over the store.
//
// Every state change goes through a command here; callers never assign task
// state. Each command runs in one transaction, so state and its activity entry
// commit together or not at all. Contract:
// docs/contracts/persistent-work-kernel-v0.md §3–§10.
import { newCompany } from "../company/company.mjs";
import {
  TASK_STATES,
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
  assertId,
  assertInteger,
  assertKind,
  assertNoSecret,
  assertText,
  serializeJsonValue,
} from "./guards.mjs";
import { KernelStore, SCHEMA_VERSION } from "./store.mjs";

const INTERRUPTION_REASON = "PROCESS_INTERRUPTED";

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

  createTask({ workId, title, intent } = {}) {
    const work = this.#requireWork(workId);
    const task = newTask({
      workId: work.id,
      title: assertText(title, "title", BOUNDS.taskTitleMax),
      intent: assertText(intent, "intent", BOUNDS.taskIntentMax),
      createdAt: this.now(),
    });
    this.store.transaction(() => {
      this.store.insertTask(task);
      this.#event({
        companyId: work.companyId,
        workId: work.id,
        taskId: task.id,
        kind: "task.created",
        detail: { title: task.title },
      });
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
    kind,
    title,
    content,
    inputDigest = null,
  } = {}) {
    const task = this.#requireTask(taskId);
    this.#assertExecutionWrite(task, generation);
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
    });
    return artifact;
  }

  completeTask({ taskId, generation } = {}) {
    const task = this.#requireTask(taskId);
    this.#assertExecutionWrite(task, generation);
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
      this.store.updateTask(task.id, {
        state: TASK_STATES.CANCELLED,
        generation,
        updatedAt: this.now(),
      });
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

  #recoverOpenAttempts() {
    const interrupted = [];
    this.store.transaction(() => {
      for (const task of this.store.listTasksByState(TASK_STATES.RUNNING)) {
        const { companyId, workId } = this.#contextOfTask(task);
        const fencedGeneration = task.generation + 1;
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
        interrupted.push({
          taskId: task.id,
          workId,
          companyId,
          interruptedGeneration: task.generation,
        });
      }
    });
    return { interrupted, count: interrupted.length, at: this.openedAt };
  }

  // --- reads ----------------------------------------------------------------

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

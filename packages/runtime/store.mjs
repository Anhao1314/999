// SQLite persistence for the Persistent Work Kernel.
//
// This module is the storage boundary: it maps storage rows to plain domain
// records and back, and it is the only place that knows SQL. Domain callers
// never see a row shape (contract §11). Immutability and append-only rules are
// enforced by database triggers, not by convention.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { kernelError } from "./errors.mjs";

export const SCHEMA_VERSION = 3;
export const STORE_FILE_NAME = "kernel.sqlite";

// The v1 table set, kept verbatim: it is both the starting point of a fresh
// install and the shape a v1 store is migrated from. There is exactly one
// definition of the v2 shape, and the migration path runs on every install
// (see #initializeSchema) instead of only on old stores.
const V1_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta(version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS companies(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS works(
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL,
  intent TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks(
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id),
  title TEXT NOT NULL,
  intent TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('OPEN','RUNNING','INTERRUPTED','COMPLETED','CANCELLED')),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checkpoints(
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  generation INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  label TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts(
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  work_id TEXT NOT NULL REFERENCES works(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  generation INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  input_digest TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity(
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL REFERENCES companies(id),
  work_id TEXT,
  task_id TEXT,
  generation INTEGER,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

// v0B1 additions (schema v2): workforce identity, assignment and runs.
const V2_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS positions(
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS employees(
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  position_id TEXT NOT NULL REFERENCES positions(id),
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  provider_preference TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS task_requirements(
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  required_capabilities TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS assignments(
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  company_id TEXT NOT NULL REFERENCES companies(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  position_id TEXT NOT NULL REFERENCES positions(id),
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS worker_runs(
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  company_id TEXT NOT NULL REFERENCES companies(id),
  work_id TEXT NOT NULL REFERENCES works(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  position_id TEXT NOT NULL REFERENCES positions(id),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  state TEXT NOT NULL CHECK (state IN ('RUNNING','COMPLETED','INTERRUPTED','CANCELLED')),
  work_packet TEXT NOT NULL,
  work_packet_digest TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS worker_runs_one_active_per_task
  ON worker_runs(task_id) WHERE state='RUNNING';
CREATE UNIQUE INDEX IF NOT EXISTS worker_runs_one_per_generation
  ON worker_runs(task_id, generation);
`;

const TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS artifacts_no_update BEFORE UPDATE ON artifacts
  BEGIN SELECT RAISE(ABORT,'ARTIFACT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS artifacts_no_delete BEFORE DELETE ON artifacts
  BEGIN SELECT RAISE(ABORT,'ARTIFACT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS checkpoints_no_update BEFORE UPDATE ON checkpoints
  BEGIN SELECT RAISE(ABORT,'CHECKPOINT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS checkpoints_no_delete BEFORE DELETE ON checkpoints
  BEGIN SELECT RAISE(ABORT,'CHECKPOINT_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS activity_no_update BEFORE UPDATE ON activity
  BEGIN SELECT RAISE(ABORT,'ACTIVITY_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS activity_no_delete BEFORE DELETE ON activity
  BEGIN SELECT RAISE(ABORT,'ACTIVITY_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS tasks_generation_monotonic BEFORE UPDATE ON tasks
  WHEN NEW.generation < OLD.generation
  BEGIN SELECT RAISE(ABORT,'GENERATION_REGRESSION'); END;
CREATE TRIGGER IF NOT EXISTS worker_runs_binding_frozen BEFORE UPDATE ON worker_runs
  WHEN NEW.id <> OLD.id OR NEW.task_id <> OLD.task_id OR NEW.employee_id <> OLD.employee_id
    OR NEW.position_id <> OLD.position_id OR NEW.generation <> OLD.generation
    OR NEW.work_packet <> OLD.work_packet OR NEW.work_packet_digest <> OLD.work_packet_digest
    OR NEW.started_at <> OLD.started_at
  BEGIN SELECT RAISE(ABORT,'WORKER_RUN_BINDING_FROZEN'); END;
CREATE TRIGGER IF NOT EXISTS assignments_no_update BEFORE UPDATE ON assignments
  BEGIN SELECT RAISE(ABORT,'ASSIGNMENT_APPEND_ONLY'); END;
CREATE TRIGGER IF NOT EXISTS assignments_no_delete BEFORE DELETE ON assignments
  BEGIN SELECT RAISE(ABORT,'ASSIGNMENT_APPEND_ONLY'); END;
`;

// v0B2 additions (schema v3): review, repair lineage and artifact supersession.
const V3_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS reviews(
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  work_id TEXT NOT NULL REFERENCES works(id),
  review_task_id TEXT NOT NULL REFERENCES tasks(id),
  reviewer_worker_run_id TEXT NOT NULL REFERENCES worker_runs(id),
  target_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  target_artifact_digest TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('PASS','REQUEST_REVISION')),
  summary TEXT NOT NULL,
  findings TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reviews_by_work ON reviews(work_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS reviews_one_per_task ON reviews(review_task_id);
CREATE TABLE IF NOT EXISTS review_requests(
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  work_id TEXT NOT NULL REFERENCES works(id),
  review_task_id TEXT NOT NULL REFERENCES tasks(id),
  source_task_id TEXT NOT NULL REFERENCES tasks(id),
  target_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  target_artifact_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS review_requests_one_per_task
  ON review_requests(review_task_id);
CREATE INDEX IF NOT EXISTS review_requests_by_source
  ON review_requests(source_task_id, created_at);
CREATE TABLE IF NOT EXISTS repair_bindings(
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  work_id TEXT NOT NULL REFERENCES works(id),
  repair_task_id TEXT NOT NULL REFERENCES tasks(id),
  review_id TEXT NOT NULL REFERENCES reviews(id),
  source_task_id TEXT NOT NULL REFERENCES tasks(id),
  target_artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  target_artifact_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS repair_bindings_one_per_review
  ON repair_bindings(review_id);
CREATE UNIQUE INDEX IF NOT EXISTS repair_bindings_one_per_task
  ON repair_bindings(repair_task_id);
CREATE INDEX IF NOT EXISTS repair_bindings_by_source
  ON repair_bindings(source_task_id, created_at);
`;

const V3_TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS reviews_no_update BEFORE UPDATE ON reviews
  BEGIN SELECT RAISE(ABORT,'REVIEW_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS reviews_no_delete BEFORE DELETE ON reviews
  BEGIN SELECT RAISE(ABORT,'REVIEW_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS review_requests_no_update BEFORE UPDATE ON review_requests
  BEGIN SELECT RAISE(ABORT,'REVIEW_REQUEST_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS review_requests_no_delete BEFORE DELETE ON review_requests
  BEGIN SELECT RAISE(ABORT,'REVIEW_REQUEST_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS repair_bindings_no_update BEFORE UPDATE ON repair_bindings
  BEGIN SELECT RAISE(ABORT,'REPAIR_BINDING_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS repair_bindings_no_delete BEFORE DELETE ON repair_bindings
  BEGIN SELECT RAISE(ABORT,'REPAIR_BINDING_IMMUTABLE'); END;
`;

const rowToCompany = (row) =>
  row && { id: row.id, name: row.name, createdAt: row.created_at };

const rowToWork = (row) =>
  row && {
    id: row.id,
    companyId: row.company_id,
    title: row.title,
    intent: row.intent,
    createdAt: row.created_at,
  };

const rowToTask = (row) =>
  row && {
    id: row.id,
    workId: row.work_id,
    title: row.title,
    intent: row.intent,
    state: row.state,
    generation: row.generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

const rowToCheckpoint = (row) =>
  row && {
    id: row.id,
    taskId: row.task_id,
    generation: row.generation,
    sequence: row.sequence,
    label: row.label,
    state: JSON.parse(row.state),
    createdAt: row.created_at,
  };

const rowToArtifact = (row) =>
  row && {
    id: row.id,
    companyId: row.company_id,
    workId: row.work_id,
    taskId: row.task_id,
    generation: row.generation,
    workerRunId: row.worker_run_id ?? null,
    kind: row.kind,
    title: row.title,
    content: row.content,
    contentDigest: row.content_digest,
    inputDigest: row.input_digest ?? null,
    supersedesArtifactId: row.supersedes_artifact_id ?? null,
    createdAt: row.created_at,
  };

const rowToPosition = (row) =>
  row && {
    id: row.id,
    companyId: row.company_id,
    title: row.title,
    capabilities: Object.freeze(JSON.parse(row.capabilities)),
    createdAt: row.created_at,
  };

const rowToEmployee = (row) =>
  row && {
    id: row.id,
    companyId: row.company_id,
    positionId: row.position_id,
    displayName: row.display_name,
    enabled: row.enabled === 1,
    providerPreference: row.provider_preference ?? null,
    createdAt: row.created_at,
  };

const rowToRequirements = (row) =>
  row && {
    taskId: row.task_id,
    requiredCapabilities: Object.freeze(JSON.parse(row.required_capabilities)),
    reviewCapabilities: Object.freeze(JSON.parse(row.review_capabilities ?? "[]")),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };

const rowToReview = (row) =>
  row && {
    id: row.id,
    companyId: row.company_id,
    workId: row.work_id,
    reviewTaskId: row.review_task_id,
    reviewerWorkerRunId: row.reviewer_worker_run_id,
    targetArtifactId: row.target_artifact_id,
    targetArtifactDigest: row.target_artifact_digest,
    verdict: row.verdict,
    summary: row.summary,
    findings: Object.freeze(JSON.parse(row.findings)),
    createdAt: row.created_at,
  };

const rowToReviewRequest = (row) =>
  row && {
    id: row.id,
    companyId: row.company_id,
    workId: row.work_id,
    reviewTaskId: row.review_task_id,
    sourceTaskId: row.source_task_id,
    targetArtifactId: row.target_artifact_id,
    targetArtifactDigest: row.target_artifact_digest,
    createdAt: row.created_at,
  };

const rowToRepairBinding = (row) =>
  row && {
    id: row.id,
    companyId: row.company_id,
    workId: row.work_id,
    repairTaskId: row.repair_task_id,
    reviewId: row.review_id,
    sourceTaskId: row.source_task_id,
    targetArtifactId: row.target_artifact_id,
    targetArtifactDigest: row.target_artifact_digest,
    createdAt: row.created_at,
  };

const rowToAssignment = (row) =>
  row && {
    sequence: row.sequence,
    id: row.id,
    companyId: row.company_id,
    taskId: row.task_id,
    employeeId: row.employee_id,
    positionId: row.position_id,
    reason: row.reason ?? null,
    createdAt: row.created_at,
  };

const rowToWorkerRun = (row) =>
  row && {
    sequence: row.sequence,
    id: row.id,
    companyId: row.company_id,
    workId: row.work_id,
    taskId: row.task_id,
    employeeId: row.employee_id,
    positionId: row.position_id,
    generation: row.generation,
    state: row.state,
    workPacket: JSON.parse(row.work_packet),
    workPacketDigest: row.work_packet_digest,
    startedAt: row.started_at,
    endedAt: row.ended_at ?? null,
    endReason: row.end_reason ?? null,
  };

const rowToActivity = (row) =>
  row && {
    sequence: row.sequence,
    companyId: row.company_id,
    workId: row.work_id ?? null,
    taskId: row.task_id ?? null,
    generation: row.generation ?? null,
    kind: row.kind,
    detail: JSON.parse(row.detail),
    createdAt: row.created_at,
  };

export class KernelStore {
  constructor(dir) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, STORE_FILE_NAME);
    this.db = new DatabaseSync(this.path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
    );
    this.inTransaction = false;
    this.#initializeSchema();
  }

  #initializeSchema() {
    const meta = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'",
      )
      .get();
    if (!meta) {
      this.db.exec(V1_TABLES_SQL);
      this.db.prepare("INSERT INTO schema_meta(version) VALUES(?)").run(1);
    }
    const version = this.db.prepare("SELECT version FROM schema_meta").get()?.version;
    if (version === SCHEMA_VERSION) return;
    // Stepwise: an old store is walked forward one version at a time, so every
    // migration step is exercised on every upgrade path, not only on fresh
    // installs. Each step is its own transaction.
    if (version === 1) this.transaction(() => this.#migrateV1ToV2());
    if (this.db.prepare("SELECT version FROM schema_meta").get()?.version === 2)
      this.transaction(() => this.#migrateV2ToV3());
    if (this.db.prepare("SELECT version FROM schema_meta").get()?.version === SCHEMA_VERSION)
      return;
    throw kernelError(
      "INCOMPATIBLE_SCHEMA_VERSION",
      `store schema version ${version} is not supported by this runtime (expected ${SCHEMA_VERSION})`,
    );
  }

  // Explicit v1 → v2 migration. Adds the workforce tables and the nullable
  // artifact producer reference, then bumps the version. Nothing is deleted,
  // nothing is recreated, and the whole thing is one transaction, so a failure
  // leaves a readable v1 store rather than a half-upgraded one.
  #migrateV1ToV2() {
    this.db.exec(V2_TABLES_SQL + TRIGGERS_SQL);
    const artifactColumns = this.db
      .prepare("PRAGMA table_info(artifacts)")
      .all()
      .map((column) => column.name);
    if (!artifactColumns.includes("worker_run_id"))
      this.db.exec(
        "ALTER TABLE artifacts ADD COLUMN worker_run_id TEXT REFERENCES worker_runs(id)",
      );
    this.db.prepare("UPDATE schema_meta SET version=?").run(2);
  }

  // Explicit v2 → v3 migration: review, repair lineage and artifact
  // supersession. Nothing is deleted or recreated; a v0A or v0B1 fact keeps its
  // value and simply gains a null where the new column answers "was this
  // replaced?".
  #migrateV2ToV3() {
    this.db.exec(V3_TABLES_SQL + V3_TRIGGERS_SQL);
    const artifactColumns = this.db
      .prepare("PRAGMA table_info(artifacts)")
      .all()
      .map((column) => column.name);
    if (!artifactColumns.includes("supersedes_artifact_id"))
      this.db.exec(
        "ALTER TABLE artifacts ADD COLUMN supersedes_artifact_id TEXT REFERENCES artifacts(id)",
      );
    const requirementColumns = this.db
      .prepare("PRAGMA table_info(task_requirements)")
      .all()
      .map((column) => column.name);
    if (!requirementColumns.includes("review_capabilities"))
      this.db.exec(
        "ALTER TABLE task_requirements ADD COLUMN review_capabilities TEXT NOT NULL DEFAULT '[]'",
      );
    this.db.prepare("UPDATE schema_meta SET version=?").run(3);
  }

  get schemaVersion() {
    return SCHEMA_VERSION;
  }

  transaction(fn) {
    if (this.inTransaction) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  close() {
    this.db.close();
  }

  // --- companies ------------------------------------------------------------
  insertCompany(company) {
    this.db
      .prepare("INSERT INTO companies(id,name,created_at) VALUES(?,?,?)")
      .run(company.id, company.name, company.createdAt);
    return company;
  }

  getCompany(id) {
    return rowToCompany(
      this.db.prepare("SELECT * FROM companies WHERE id=?").get(id),
    );
  }

  listCompanies() {
    return this.db
      .prepare("SELECT * FROM companies ORDER BY created_at, id")
      .all()
      .map(rowToCompany);
  }

  // --- works ----------------------------------------------------------------
  insertWork(work) {
    this.db
      .prepare("INSERT INTO works(id,company_id,title,intent,created_at) VALUES(?,?,?,?,?)")
      .run(work.id, work.companyId, work.title, work.intent, work.createdAt);
    return work;
  }

  getWork(id) {
    return rowToWork(this.db.prepare("SELECT * FROM works WHERE id=?").get(id));
  }

  listWorks(companyId) {
    return this.db
      .prepare("SELECT * FROM works WHERE company_id=? ORDER BY created_at, id")
      .all(companyId)
      .map(rowToWork);
  }

  // --- tasks ----------------------------------------------------------------
  insertTask(task) {
    this.db
      .prepare(
        "INSERT INTO tasks(id,work_id,title,intent,state,generation,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        task.id,
        task.workId,
        task.title,
        task.intent,
        task.state,
        task.generation,
        task.createdAt,
        task.updatedAt,
      );
    return task;
  }

  getTask(id) {
    return rowToTask(this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id));
  }

  listTasks(workId) {
    return this.db
      .prepare("SELECT * FROM tasks WHERE work_id=? ORDER BY created_at, id")
      .all(workId)
      .map(rowToTask);
  }

  listTasksByState(state) {
    return this.db
      .prepare("SELECT * FROM tasks WHERE state=? ORDER BY created_at, id")
      .all(state)
      .map(rowToTask);
  }

  // The only mutable row in the kernel. The monotonic-generation trigger makes
  // a generation regression impossible even if a caller tries.
  updateTask(id, { state, generation, updatedAt }) {
    this.db
      .prepare("UPDATE tasks SET state=?,generation=?,updated_at=? WHERE id=?")
      .run(state, generation, updatedAt, id);
  }

  // --- checkpoints ----------------------------------------------------------
  insertCheckpoint(checkpoint) {
    this.db
      .prepare(
        "INSERT INTO checkpoints(id,task_id,generation,sequence,label,state,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        checkpoint.id,
        checkpoint.taskId,
        checkpoint.generation,
        checkpoint.sequence,
        checkpoint.label,
        JSON.stringify(checkpoint.state),
        checkpoint.createdAt,
      );
    return checkpoint;
  }

  listCheckpoints(taskId) {
    return this.db
      .prepare("SELECT * FROM checkpoints WHERE task_id=? ORDER BY sequence")
      .all(taskId)
      .map(rowToCheckpoint);
  }

  // --- artifacts ------------------------------------------------------------
  insertArtifact(artifact) {
    this.db
      .prepare(
        "INSERT INTO artifacts(id,company_id,work_id,task_id,generation,worker_run_id,kind,title,content,content_digest,input_digest,supersedes_artifact_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        artifact.id,
        artifact.companyId,
        artifact.workId,
        artifact.taskId,
        artifact.generation,
        artifact.workerRunId ?? null,
        artifact.kind,
        artifact.title,
        artifact.content,
        artifact.contentDigest,
        artifact.inputDigest,
        artifact.supersedesArtifactId ?? null,
        artifact.createdAt,
      );
    return artifact;
  }

  getArtifact(id) {
    return rowToArtifact(
      this.db.prepare("SELECT * FROM artifacts WHERE id=?").get(id),
    );
  }

  listArtifacts({ taskId = null, workId = null } = {}) {
    const clauses = [];
    const values = [];
    if (taskId) {
      clauses.push("task_id=?");
      values.push(taskId);
    }
    if (workId) {
      clauses.push("work_id=?");
      values.push(workId);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM artifacts${where} ORDER BY created_at, id`)
      .all(...values)
      .map(rowToArtifact);
  }

  // --- activity -------------------------------------------------------------
  appendActivity(event) {
    const result = this.db
      .prepare(
        "INSERT INTO activity(company_id,work_id,task_id,generation,kind,detail,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        event.companyId,
        event.workId,
        event.taskId,
        event.generation,
        event.kind,
        JSON.stringify(event.detail ?? {}),
        event.createdAt,
      );
    return Number(result.lastInsertRowid);
  }

  listActivity({ companyId = null, workId = null, taskId = null, limit = 100 } = {}) {
    const clauses = [];
    const values = [];
    for (const [column, value] of [
      ["company_id", companyId],
      ["work_id", workId],
      ["task_id", taskId],
    ]) {
      if (value) {
        clauses.push(`${column}=?`);
        values.push(value);
      }
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM activity${where} ORDER BY sequence LIMIT ?`)
      .all(...values, limit)
      .map(rowToActivity);
  }

  // --- status ---------------------------------------------------------------
  // --- positions ------------------------------------------------------------
  insertPosition(position) {
    this.db
      .prepare(
        "INSERT INTO positions(id,company_id,title,capabilities,created_at) VALUES(?,?,?,?,?)",
      )
      .run(
        position.id,
        position.companyId,
        position.title,
        JSON.stringify(position.capabilities),
        position.createdAt,
      );
    return position;
  }

  getPosition(id) {
    return rowToPosition(
      this.db.prepare("SELECT * FROM positions WHERE id=?").get(id),
    );
  }

  listPositions(companyId) {
    return this.db
      .prepare("SELECT * FROM positions WHERE company_id=? ORDER BY created_at, id")
      .all(companyId)
      .map(rowToPosition);
  }

  // --- employees ------------------------------------------------------------
  insertEmployee(employee) {
    this.db
      .prepare(
        "INSERT INTO employees(id,company_id,position_id,display_name,enabled,provider_preference,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        employee.id,
        employee.companyId,
        employee.positionId,
        employee.displayName,
        employee.enabled ? 1 : 0,
        employee.providerPreference,
        employee.createdAt,
      );
    return employee;
  }

  getEmployee(id) {
    return rowToEmployee(
      this.db.prepare("SELECT * FROM employees WHERE id=?").get(id),
    );
  }

  listEmployees(companyId) {
    return this.db
      .prepare("SELECT * FROM employees WHERE company_id=? ORDER BY created_at, id")
      .all(companyId)
      .map(rowToEmployee);
  }

  updateEmployeeEnabled(id, enabled) {
    this.db
      .prepare("UPDATE employees SET enabled=? WHERE id=?")
      .run(enabled ? 1 : 0, id);
  }

  // --- task requirements ----------------------------------------------------
  upsertTaskRequirements(requirements) {
    this.db
      .prepare(
        "INSERT INTO task_requirements(task_id,required_capabilities,review_capabilities,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET required_capabilities=excluded.required_capabilities, review_capabilities=excluded.review_capabilities, updated_at=excluded.updated_at",
      )
      .run(
        requirements.taskId,
        JSON.stringify(requirements.requiredCapabilities),
        JSON.stringify(requirements.reviewCapabilities ?? []),
        requirements.createdAt,
        requirements.updatedAt,
      );
    return requirements;
  }

  getTaskRequirements(taskId) {
    return rowToRequirements(
      this.db.prepare("SELECT * FROM task_requirements WHERE task_id=?").get(taskId),
    );
  }

  // --- assignments ----------------------------------------------------------
  insertAssignment(assignment) {
    this.db
      .prepare(
        "INSERT INTO assignments(id,company_id,task_id,employee_id,position_id,reason,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        assignment.id,
        assignment.companyId,
        assignment.taskId,
        assignment.employeeId,
        assignment.positionId,
        assignment.reason,
        assignment.createdAt,
      );
    return assignment;
  }

  listAssignments(taskId) {
    return this.db
      .prepare("SELECT * FROM assignments WHERE task_id=? ORDER BY sequence")
      .all(taskId)
      .map(rowToAssignment);
  }

  // The current assignment is the most recent row: history is append-only, so
  // "current" is a reading of the log, never a mutation of it.
  currentAssignment(taskId) {
    return rowToAssignment(
      this.db
        .prepare("SELECT * FROM assignments WHERE task_id=? ORDER BY sequence DESC LIMIT 1")
        .get(taskId),
    );
  }

  // --- worker runs ----------------------------------------------------------
  insertWorkerRun(run) {
    this.db
      .prepare(
        "INSERT INTO worker_runs(id,company_id,work_id,task_id,employee_id,position_id,generation,state,work_packet,work_packet_digest,started_at,ended_at,end_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        run.id,
        run.companyId,
        run.workId,
        run.taskId,
        run.employeeId,
        run.positionId,
        run.generation,
        run.state,
        JSON.stringify(run.workPacket),
        run.workPacketDigest,
        run.startedAt,
        run.endedAt,
        run.endReason,
      );
    return run;
  }

  getWorkerRun(id) {
    return rowToWorkerRun(
      this.db.prepare("SELECT * FROM worker_runs WHERE id=?").get(id),
    );
  }

  listWorkerRuns({ taskId = null, employeeId = null, state = null } = {}) {
    const clauses = [];
    const values = [];
    for (const [column, value] of [
      ["task_id", taskId],
      ["employee_id", employeeId],
      ["state", state],
    ]) {
      if (value) {
        clauses.push(`${column}=?`);
        values.push(value);
      }
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM worker_runs${where} ORDER BY sequence`)
      .all(...values)
      .map(rowToWorkerRun);
  }

  updateWorkerRun(id, { state, endedAt, endReason }) {
    this.db
      .prepare("UPDATE worker_runs SET state=?,ended_at=?,end_reason=? WHERE id=?")
      .run(state, endedAt, endReason, id);
  }

  listActiveWorkerRuns(companyId) {
    return this.db
      .prepare(
        "SELECT * FROM worker_runs WHERE company_id=? AND state='RUNNING' ORDER BY sequence",
      )
      .all(companyId)
      .map(rowToWorkerRun);
  }

  // --- reviews, review requests, repair bindings ----------------------------
  insertReview(review) {
    this.db
      .prepare(
        "INSERT INTO reviews(id,company_id,work_id,review_task_id,reviewer_worker_run_id,target_artifact_id,target_artifact_digest,verdict,summary,findings,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        review.id,
        review.companyId,
        review.workId,
        review.reviewTaskId,
        review.reviewerWorkerRunId,
        review.targetArtifactId,
        review.targetArtifactDigest,
        review.verdict,
        review.summary,
        JSON.stringify(review.findings),
        review.createdAt,
      );
    return review;
  }

  getReview(id) {
    return rowToReview(this.db.prepare("SELECT * FROM reviews WHERE id=?").get(id));
  }

  reviewForTask(reviewTaskId) {
    return rowToReview(
      this.db.prepare("SELECT * FROM reviews WHERE review_task_id=?").get(reviewTaskId),
    );
  }

  listReviews({ workId = null, targetArtifactId = null } = {}) {
    const clauses = [];
    const values = [];
    if (workId) {
      clauses.push("work_id=?");
      values.push(workId);
    }
    if (targetArtifactId) {
      clauses.push("target_artifact_id=?");
      values.push(targetArtifactId);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM reviews${where} ORDER BY created_at, id`)
      .all(...values)
      .map(rowToReview);
  }

  insertReviewRequest(request) {
    this.db
      .prepare(
        "INSERT INTO review_requests(id,company_id,work_id,review_task_id,source_task_id,target_artifact_id,target_artifact_digest,created_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        request.id,
        request.companyId,
        request.workId,
        request.reviewTaskId,
        request.sourceTaskId,
        request.targetArtifactId,
        request.targetArtifactDigest,
        request.createdAt,
      );
    return request;
  }

  getReviewRequest(id) {
    return rowToReviewRequest(
      this.db.prepare("SELECT * FROM review_requests WHERE id=?").get(id),
    );
  }

  reviewRequestForTask(reviewTaskId) {
    return rowToReviewRequest(
      this.db.prepare("SELECT * FROM review_requests WHERE review_task_id=?").get(reviewTaskId),
    );
  }

  listReviewRequests({ workId = null, sourceTaskId = null } = {}) {
    const clauses = [];
    const values = [];
    if (workId) {
      clauses.push("work_id=?");
      values.push(workId);
    }
    if (sourceTaskId) {
      clauses.push("source_task_id=?");
      values.push(sourceTaskId);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM review_requests${where} ORDER BY created_at, id`)
      .all(...values)
      .map(rowToReviewRequest);
  }

  insertRepairBinding(binding) {
    this.db
      .prepare(
        "INSERT INTO repair_bindings(id,company_id,work_id,repair_task_id,review_id,source_task_id,target_artifact_id,target_artifact_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        binding.id,
        binding.companyId,
        binding.workId,
        binding.repairTaskId,
        binding.reviewId,
        binding.sourceTaskId,
        binding.targetArtifactId,
        binding.targetArtifactDigest,
        binding.createdAt,
      );
    return binding;
  }

  getRepairBinding(id) {
    return rowToRepairBinding(
      this.db.prepare("SELECT * FROM repair_bindings WHERE id=?").get(id),
    );
  }

  repairBindingForTask(repairTaskId) {
    return rowToRepairBinding(
      this.db.prepare("SELECT * FROM repair_bindings WHERE repair_task_id=?").get(repairTaskId),
    );
  }

  repairBindingForReview(reviewId) {
    return rowToRepairBinding(
      this.db.prepare("SELECT * FROM repair_bindings WHERE review_id=?").get(reviewId),
    );
  }

  listRepairBindings({ workId = null, sourceTaskId = null } = {}) {
    const clauses = [];
    const values = [];
    if (workId) {
      clauses.push("work_id=?");
      values.push(workId);
    }
    if (sourceTaskId) {
      clauses.push("source_task_id=?");
      values.push(sourceTaskId);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM repair_bindings${where} ORDER BY created_at, id`)
      .all(...values)
      .map(rowToRepairBinding);
  }

  // --- status ---------------------------------------------------------------
  counts() {
    const count = (table) =>
      this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
    return {
      companies: count("companies"),
      works: count("works"),
      tasks: count("tasks"),
      checkpoints: count("checkpoints"),
      artifacts: count("artifacts"),
      positions: count("positions"),
      employees: count("employees"),
      assignments: count("assignments"),
      workerRuns: count("worker_runs"),
      reviews: count("reviews"),
      reviewRequests: count("review_requests"),
      repairBindings: count("repair_bindings"),
      activity: count("activity"),
    };
  }

  tasksByState() {
    const rows = this.db
      .prepare("SELECT state, count(*) AS n FROM tasks GROUP BY state ORDER BY state")
      .all();
    return Object.fromEntries(rows.map((row) => [row.state, row.n]));
  }
}

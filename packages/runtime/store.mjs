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

export const SCHEMA_VERSION = 1;
export const STORE_FILE_NAME = "kernel.sqlite";

const SCHEMA_DDL = `
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
    kind: row.kind,
    title: row.title,
    content: row.content,
    contentDigest: row.content_digest,
    inputDigest: row.input_digest ?? null,
    createdAt: row.created_at,
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
    this.#createOrVerifySchema();
  }

  #createOrVerifySchema() {
    const meta = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'",
      )
      .get();
    if (!meta) {
      this.db.exec(SCHEMA_DDL);
      this.db
        .prepare("INSERT INTO schema_meta(version) VALUES(?)")
        .run(SCHEMA_VERSION);
      return;
    }
    const version = this.db.prepare("SELECT version FROM schema_meta").get()?.version;
    if (version !== SCHEMA_VERSION)
      throw kernelError(
        "INCOMPATIBLE_SCHEMA_VERSION",
        `store schema version ${version} is not supported by this runtime (expected ${SCHEMA_VERSION})`,
      );
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
        "INSERT INTO artifacts(id,company_id,work_id,task_id,generation,kind,title,content,content_digest,input_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        artifact.id,
        artifact.companyId,
        artifact.workId,
        artifact.taskId,
        artifact.generation,
        artifact.kind,
        artifact.title,
        artifact.content,
        artifact.contentDigest,
        artifact.inputDigest,
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
  counts() {
    const count = (table) =>
      this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
    return {
      companies: count("companies"),
      works: count("works"),
      tasks: count("tasks"),
      checkpoints: count("checkpoints"),
      artifacts: count("artifacts"),
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

// Frozen snapshot of the schema the v0B1 milestone shipped (commit 027229f).
//
// Verbatim on purpose: the v2 → v3 migration test must open a *real* v2
// database — that is, the v1 table set, the v2 workforce tables, the v2
// triggers and the one column v1 → v2 adds — not a re-derivation of one. If a
// later migration changes, this file does not: it is history.
export const V2_SCHEMA_DDL = `
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

ALTER TABLE artifacts ADD COLUMN worker_run_id TEXT REFERENCES worker_runs(id);
`;

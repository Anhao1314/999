// Frozen snapshot of the schema the v0A milestone shipped (commit 5afd99d).
//
// It is kept verbatim on purpose: the v1 → v2 migration test must open a *real*
// v1 database, not a re-derivation of one. If the migration changes, this file
// does not — it is history.
export const V1_SCHEMA_DDL = `
CREATE TABLE schema_meta(version INTEGER NOT NULL);
CREATE TABLE companies(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE works(
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL,
  intent TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE tasks(
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id),
  title TEXT NOT NULL,
  intent TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('OPEN','RUNNING','INTERRUPTED','COMPLETED','CANCELLED')),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE checkpoints(
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  generation INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  label TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE artifacts(
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
CREATE TABLE activity(
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL REFERENCES companies(id),
  work_id TEXT,
  task_id TEXT,
  generation INTEGER,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TRIGGER artifacts_no_update BEFORE UPDATE ON artifacts
  BEGIN SELECT RAISE(ABORT,'ARTIFACT_IMMUTABLE'); END;
CREATE TRIGGER artifacts_no_delete BEFORE DELETE ON artifacts
  BEGIN SELECT RAISE(ABORT,'ARTIFACT_IMMUTABLE'); END;
CREATE TRIGGER checkpoints_no_update BEFORE UPDATE ON checkpoints
  BEGIN SELECT RAISE(ABORT,'CHECKPOINT_IMMUTABLE'); END;
CREATE TRIGGER checkpoints_no_delete BEFORE DELETE ON checkpoints
  BEGIN SELECT RAISE(ABORT,'CHECKPOINT_IMMUTABLE'); END;
CREATE TRIGGER activity_no_update BEFORE UPDATE ON activity
  BEGIN SELECT RAISE(ABORT,'ACTIVITY_APPEND_ONLY'); END;
CREATE TRIGGER activity_no_delete BEFORE DELETE ON activity
  BEGIN SELECT RAISE(ABORT,'ACTIVITY_APPEND_ONLY'); END;
CREATE TRIGGER tasks_generation_monotonic BEFORE UPDATE ON tasks
  WHEN NEW.generation < OLD.generation
  BEGIN SELECT RAISE(ABORT,'GENERATION_REGRESSION'); END;
`;

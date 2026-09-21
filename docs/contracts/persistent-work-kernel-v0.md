# Contract — Persistent Work Kernel v0A

Status: **frozen semantics for the v0A milestone.** The implementation and its
tests are the evidence that these semantics hold; this file is the specification
they are checked against. It answers the questions of the milestone charter §6,
in the order they were asked.

Milestone thesis: *a Company's Work, with its Tasks, Artifacts, Checkpoints and
Activity, survives process exit and restart — correctly, consistently, and
recoverably.*

Explicitly **not** in v0A: Employee / Position / WorkerRun, Review, Repair,
Inbox, Decision, Hiring, Company Genesis, Canvas / UI, any model provider or
semantic sensor. Those are later milestones; nothing here may presuppose them.

---

## 1. Company

**Company is the organization root object.** Every Work (and therefore every
Task, Artifact, Checkpoint and Activity entry) belongs to exactly one Company.

Minimal v0A shape: `id`, `name`, `createdAt`. Nothing else.

| Rule | Statement |
| --- | --- |
| Identity | Runtime-generated, opaque, never derived from a display name |
| Ownership | A Work cannot exist without an existing Company (`WORK_COMPANY_MISSING`) |
| Not included | Profile, settings, employees, mission, budget — Genesis / Hiring own those |

### 1.1 Duty is not Company (explicit legacy correction)

The old repository had a `Duty` object: a *standing obligation* with a source
subject and a current-task pointer, seeded once for the research fixture. It is
**not** migrated, and it is **not** mapped to Company:

```
Duty (standing obligation)  ≠  Company (organization root)
```

A standing obligation, if the product needs one later, is a **Work shape**
(standing / recurring Work definition), not the root of the organization.
Mapping Duty onto Company would have made "the company" mean "a research
obligation", which is exactly the research-domain leak this milestone forbids.

---

## 2. Work

**Work is the continuity object.** It is what the Founder and the company care
about; it outlives sessions, executions and (later) employees.

Minimal v0A shape: `id`, `companyId`, `title`, `intent`, `createdAt`.
`intent` is required: a Work must state *why it exists*.

### 2.1 Work has no second state machine

Work owns **no stored status field**. Its status is *derived* from its child
Tasks, by this fixed precedence (`packages/work/work.mjs → deriveWorkStatus`):

| Priority | Condition over the Work's Tasks | Derived status |
| --- | --- | --- |
| 1 | any Task `INTERRUPTED` | `NEEDS_ATTENTION` |
| 2 | any Task `RUNNING` | `ACTIVE` |
| 3 | ≥1 Task and all `COMPLETED` | `COMPLETED` |
| 4 | ≥1 Task and all `CANCELLED` | `CANCELLED` |
| 5 | otherwise (no Tasks, or Tasks still `OPEN`) | `OPEN` |

Why derived: two stored state machines need to be kept in sync by someone, and
the first sync bug silently lies about reality. Task state *is* the execution
truth; Work status is a projection of it. An interruption outranks everything,
because "this Work stopped against our will" is the fact that most needs a human.

---

## 3. Task

**Task is the execution unit inside a Work.** Minimal shape: `id`, `workId`,
`title`, `intent`, `state`, `generation`, `createdAt`, `updatedAt`.

### 3.1 Lifecycle — five states, no more

| State | Why it exists |
| --- | --- |
| `OPEN` | Created, no execution attempt has happened (or the Work is simply not started) |
| `RUNNING` | An execution attempt is active and holds the current generation |
| `INTERRUPTED` | An attempt was cut off (process died, or it was explicitly fenced). Nothing was completed; this is not a success and not a failure of the work itself |
| `COMPLETED` | The current attempt finished and its result is recorded as an Artifact |
| `CANCELLED` | A human/kernel decision ended the Task before completion; the attempt is invalidated |

Transition table (who: **only** the Runtime command layer; see §4):

| From | To | Command | Side effect |
| --- | --- | --- | --- |
| `OPEN` | `RUNNING` | `startTask` | new generation |
| `OPEN` | `CANCELLED` | `cancelTask` | generation fenced |
| `RUNNING` | `COMPLETED` | `completeTask(generation)` | requires an Artifact of the current generation |
| `RUNNING` | `CANCELLED` | `cancelTask` | generation fenced — late writes rejected |
| `RUNNING` | `INTERRUPTED` | runtime recovery on open | generation fenced; never automatic retry |
| `INTERRUPTED` | `RUNNING` | `startTask` | new generation (the only way to continue) |
| `INTERRUPTED` | `CANCELLED` | `cancelTask` | generation fenced |
| `INTERRUPTED` | `COMPLETED` | — | **forbidden**: an interrupted attempt produced no verified output |
| `COMPLETED` | anything | — | **terminal** |
| `CANCELLED` | anything | — | **terminal** |

Forbidden transitions fail with `INVALID_TRANSITION`; states are never assigned
directly by a caller (§4).

Why not more states: there is deliberately **no** `WAITING` / `BLOCKED` state.
In v0A nothing can make a Task wait — there is no delegation, no review, no
external dependency. The only genuine "not progressing" condition this kernel
knows is an interrupted attempt, and `INTERRUPTED` already says it. A blocked
state without a producer would be vocabulary nobody can act on.

### 3.2 Generation is a fencing token

`task.generation` is a monotone integer. It is not a counter of attempts to
display; it is the token that identifies *which execution is allowed to write*.

| Event | Token |
| --- | --- |
| Task created | `0` |
| `startTask` | previous + 1 (returned to the caller) |
| `cancelTask` | previous + 1 (invalidates any live attempt) |
| recovery of a `RUNNING` Task | previous + 1 (invalidates the dead attempt) |
| `completeTask` | unchanged — the completing attempt keeps the token it was granted |

Write fence for every execution-scoped write (`checkpointTask`, `recordArtifact`,
`completeTask`):

```
token ≠ task.generation      → STALE_GENERATION
state ≠ RUNNING              → TASK_NOT_RUNNING     (a never-started Task has token 0)
otherwise                    → accepted
```

The fence exists so that a slow, cancelled or dead execution can never overwrite
a newer reality — the invariant the old Runtime enforced in-process, here made a
persisted, testable property (charter §13).

---

## 4. Commands, not mutation

The kernel exposes exactly these commands. There is no supported path that sets
task state directly.

| Command | Input | Result |
| --- | --- | --- |
| `createCompany` | `name` | Company |
| `createWork` | `companyId`, `title`, `intent` | Work |
| `createTask` | `workId`, `title`, `intent` | Task (`OPEN`, token 0) |
| `startTask` | `taskId` | `{ task, generation }` — the token the caller must carry |
| `checkpointTask` | `taskId`, `generation`, `label`, `state` | Checkpoint |
| `recordArtifact` | `taskId`, `generation`, `kind`, `title`, `content`, `inputDigest?` | Artifact |
| `completeTask` | `taskId`, `generation` | Task (`COMPLETED`) |
| `cancelTask` | `taskId`, `note?` | Task (`CANCELLED`) |
| `recover` | — | automatic on open; also callable and idempotent |

Every command runs inside one store transaction: state change and activity entry
commit together or not at all.

---

## 5. Artifact

**Artifact is the formal output record of a Task.** Shape: `id`, `companyId`,
`workId`, `taskId`, `generation`, `kind`, `title`, `content`, `contentDigest`,
`inputDigest?`, `createdAt`.

| Rule | Statement |
| --- | --- |
| Provenance | Bound to Company + Work + Task + the generation that produced it |
| Integrity | `contentDigest` = SHA-256 of the content, written at record time |
| Immutability | Enforced by database triggers: `UPDATE`/`DELETE` on `artifacts` raise `ARTIFACT_IMMUTABLE` |
| Boundary | Content must be a textual payload within a fixed size bound (see §8) — the kernel is not a blob store |
| Not included | No producer employee id. v0A has no Employee, so it must not invent one; the generation reference is the honest producer handle |

Historic artifacts are never overwritten. Later repair/supersede lineage is a
future milestone and will be added as new records, not edits.

---

## 6. Checkpoint

**A Checkpoint is resumable progress, not an output and not a completion.**

| Rule | Statement |
| --- | --- |
| Ownership | Belongs to exactly one Task |
| Binding | Generation-bound: a stale token cannot write (`STALE_GENERATION`) |
| Order | Monotone `sequence` per Task, assigned by the Runtime |
| Durability | Readable after restart; append-only (`CHECKPOINT_IMMUTABLE`) |
| Not | Not an Artifact (no output claim) and not a completion (the Task stays `RUNNING`) |

The kernel stores the checkpoint *state* it is given. It never stores model
session dumps or conversation transcripts; that is a caller-side concern and is
out of scope.

---

## 7. Activity / Event

Append-only audit history: **who/what happened, in order, durably.**

Shape: `sequence` (monotone, primary key), `companyId`, `workId?`, `taskId?`,
`generation?`, `kind`, `detail` (JSON), `createdAt`.

Kinds in v0A:

```
company.created      work.created          task.created
task.execution_started
checkpoint.written   artifact.recorded     task.completed
task.interrupted     task.cancelled
```

Rules: `UPDATE`/`DELETE` on `activity` raise `ACTIVITY_APPEND_ONLY`; ordering is
the `sequence`, never a timestamp; every state change in §3.1 has a matching
event. This is **not** a full event-sourcing architecture: current state is
stored normally, and the event log is the audit trail beside it (charter §17).

---

## 8. Recorded truth guards

Two guards protect the persisted truth, both ported from verified old-Runtime
behaviour and both testable:

1. **Input bounds.** Titles, intents, labels and notes have explicit length
   bounds; checkpoint state and artifact content have size bounds
   (`packages/work/records.mjs → BOUNDS`). Oversized or non-textual input is
   rejected before it reaches storage.
2. **Credential-shaped content is refused.** Credential patterns are rejected on
   every write path into recorded truth, with `SECRET_IN_OUTPUT`. A Runtime that
   persists what it is told must at least refuse to persist a key.

---

## 9. Recovery

Recovery runs when a Runtime opens a store that another process left behind.

```
store has a Task in RUNNING
  → Runtime marks it INTERRUPTED (generation fenced, +1)
  → activity entry task.interrupted { interruptedGeneration, reason: PROCESS_INTERRUPTED,
                                      automaticRetry: false }
  → nothing is ever marked COMPLETED by recovery
  → Checkpoints and Artifacts written before the crash remain readable
  → to continue, a human/caller must explicitly startTask (new generation)
```

Rules: recovery never guesses that a dead attempt "probably finished"; it never
retries; it never deletes history; it is idempotent (a second open finds nothing
to fence). A Task whose attempt died is *honestly* not progressing until someone
decides what happens next — that is the point of the state.

---

## 10. Cancellation

`cancelTask` ends a Task before completion:

* allowed from `OPEN`, `RUNNING`, `INTERRUPTED`; forbidden from `COMPLETED` /
  `CANCELLED` (`INVALID_TRANSITION`),
* advances the generation, so any live attempt's late checkpoint, artifact or
  completion is rejected (`STALE_GENERATION` / `TASK_NOT_RUNNING`),
* records `task.cancelled` (with the optional human note) in the activity log,
* keeps everything already written (Checkpoints, Artifacts) readable — cancel
  stops work, it does not erase history.

---

## 11. Storage and schema versioning

**Choice: SQLite through Node's built-in `node:sqlite` (`DatabaseSync`).**

Reasons, checked against the actual environment rather than assumed:

* Node v24.19.0 ships it — **zero new third-party dependencies** (charter §33),
* it gives transactional updates (`BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`),
  single-file durability and real restart persistence,
* it supports triggers, which is how artifact/checkpoint immutability and
  append-only activity are enforced *at the storage layer* instead of by
  convention,
* no server process to operate, no network, no credentials.

`schema_meta.version = 1`. On open: a fresh directory initialises; the same
version opens; any other version fails loudly with
`INCOMPATIBLE_SCHEMA_VERSION` before any read or write (charter §20). There is
deliberately no migration framework yet — there is nothing to migrate from.

The store is a boundary, not an API: SQL rows are mapped to plain domain records
inside `packages/runtime/store.mjs`; no SQL shape leaks to commands, projections
or callers (charter §19).

---

## 12. Boundary summary

```
packages/company   Company contract (root object, identity, validation bounds)
packages/work      Work + Task lifecycle, generation fencing, record shapes, projection
packages/runtime   commands (kernel), SQLite store, error vocabulary, process app
```

Dependency direction: `runtime → work → company`. Domain modules never import
SQLite or HTTP; the store never imports domain rules; the HTTP app is a thin
transport over the commands.

Deferred, on purpose (charter §9, §23–§27): Employee, Position, WorkerRun,
Review, Repair, Inbox, Decision, Hiring, Genesis, Canvas, sensors, providers.
Standing obligations return as a Work shape if needed — never as Company (§1.1).

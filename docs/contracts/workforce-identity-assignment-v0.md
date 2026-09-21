# Contract — Workforce Identity & Assignment v0B1

Status: **frozen semantics for the v0B1 milestone.** This milestone answers one
question and nothing more:

> How does FlowCredit represent a company's Positions and Employees, formally
> assign a Task to an Employee, and record one execution as a persistent,
> recoverable, auditable WorkerRun?

Protocol covered: **ASSIGN · EXECUTE · HANDOFF · COMPLETE.**
Not covered (later milestones): REVIEW, REPAIR, ESCALATE, Founder Inbox,
Founder ACCEPT, Hiring, Genesis, Canvas, any model provider.

Builds on `docs/contracts/persistent-work-kernel-v0.md` (v0A): Company → Work →
Task → Artifact, Checkpoints, Activity, generation fencing, recovery,
cancellation. Nothing in v0A is redefined here; it is extended.

---

## 1. Which things are what

| Object | Kind | Lives in |
| --- | --- | --- |
| **Position** | persistent object | `positions` |
| **Employee** | persistent object | `employees` |
| **TaskRequirement** | persistent object (0 or 1 per Task) | `task_requirements` |
| **Assignment** | persistent *historical fact* (append-only) | `assignments` |
| **WorkerRun** | persistent object (execution record) | `worker_runs` |
| **WorkPacket** | derived at run start, then **stored verbatim** on the run | `worker_runs.work_packet` |
| **Availability** | **derived** projection, never stored | computed from `enabled` + active runs |
| **Handoff** | **protocol event**, not an object | `activity.kind = ARTIFACT_HANDED_OFF` |

Two rules follow from this table and are enforced in code and in storage:

1. **Availability is derived.** There is no `employee.status` column. A stored
   `BUSY/AVAILABLE` flag is a second source of truth that drifts the first time
   a process dies; `enabled` (an authority fact) plus active runs (an execution
   fact) always answer the question correctly, even after a crash.
2. **A Handoff is not an object yet.** v0B1 expresses it as an auditable event
   carrying `taskId + artifactId + workerRunId`. Creating a Handoff table before
   there is a second party to hand to would invent a lifecycle nobody can
   advance.

---

## 2. Position

*What kind of work the company needs.*

```
Position = { id, companyId, title, capabilities[], createdAt }
```

| Rule | Statement |
| --- | --- |
| Identity | `pos_…`, runtime-generated or explicitly supplied by a seed/bootstrap path |
| Capabilities | Stable capability identifiers (`research.execute`); stored sorted + de-duplicated so anything derived from them is deterministic |
| Outlives Employee | A Position is a contract; several Employees may fill it over time |
| Not included | JD text, salary, performance, department, manager hierarchy — Hiring owns those |

Positions belong to exactly one Company (`POSITION_COMPANY_MISSING` if unknown).

---

## 3. Employee

*A stable AI employee identity the company owns.*

```
Employee = { id, companyId, positionId, displayName, enabled, providerPreference?, createdAt }
```

Hard separations (each one is a test):

```
Employee ≠ Position       (positionId is a reference; positions outlive employees)
Employee ≠ Model          (no model id, no session id is ever an employee id)
Employee ≠ Provider       (providerPreference is an optional preference, never identity)
Employee ≠ WorkerRun      (a run is temporary work by a persistent identity)
```

`enabled` is the only stored lifecycle fact: a roster/authority decision that
survives restarts. `providerPreference` is optional and carries no execution
meaning in v0B1 (there is no provider yet).

### 3.1 Availability (derived)

| Condition | Derived availability |
| --- | --- |
| `enabled = false` | `DISABLED` |
| `enabled = true`, ≥1 `RUNNING` WorkerRun | `BUSY` |
| `enabled = true`, 0 `RUNNING` WorkerRuns | `AVAILABLE` |

Reads expose `availability` and `activeRunId`; neither is stored, and after a
crash-recovery both are correct without repair work.

---

## 4. TaskRequirement

*What capability a Task needs.* Tasks express **capability**, never a role name.

```
TaskRequirement = { taskId, requiredCapabilities[], createdAt, updatedAt }
```

* Absent requirements = the Task needs no particular capability.
* Capability ids are validated (`^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)*$`), stored
  sorted and de-duplicated.
* Requirements may be set at Task creation or later with
  `setTaskRequirements`, but only while the Task is `OPEN` or `INTERRUPTED`
  (a running attempt must not have its requirement changed underneath it —
  `TASK_REQUIREMENTS_LOCKED`).
* Capabilities are opaque strings to the core. There is **no** capability
  registry, no scoring, no dynamic matching, no routing.

---

## 5. Assignment

*A recorded fact: this Employee was given this Task, at this time, for this
reason.* Append-only; never edited, never deleted.

```
Assignment = { id, companyId, taskId, employeeId, positionId, reason, createdAt }
```

`assignTask` is deterministic. It validates, in order:

| Check | Failure |
| --- | --- |
| Task exists | `TASK_NOT_FOUND` |
| Task is assignable (`OPEN`; not terminal, not running) | `TASK_NOT_ASSIGNABLE` / `TASK_ALREADY_RUNNING` |
| Employee exists | `EMPLOYEE_NOT_FOUND` |
| Employee enabled | `EMPLOYEE_DISABLED` |
| Employee and Task are in the same Company | `CROSS_COMPANY_ASSIGNMENT` |
| Our requirements ⊆ the Position's capabilities | `TASK_REQUIREMENTS_UNSATISFIED` (lists the missing capabilities) |
| No conflicting active assignment or run | `TASK_ALREADY_RUNNING` |

**Current assignment = the most recent assignment row** (ordered by insertion
sequence, never by timestamp). Re-assignment before execution is allowed and
appends a new row; the previous row remains as history. While a WorkerRun is
active the Task cannot be re-assigned — that is the v0B1 contract (no
mid-execution handover yet).

Explicitly **not** in v0B1: an LLM choosing the employee, ranking, cost
optimisation, Jev routing, dynamic swarm. The caller names the employee.

---

## 6. WorkerRun

*One actual execution of a Task by an Employee.*

```
WorkerRun = { id, companyId, workId, taskId, employeeId, positionId,
              generation, state, workPacket, workPacketDigest,
              startedAt, endedAt, endReason }
```

States (deliberately only four — a WorkerRun is an execution record, not a
second Task lifecycle):

```
RUNNING → COMPLETED | INTERRUPTED | CANCELLED      (all three are terminal)
```

| Rule | Statement |
| --- | --- |
| Binding is frozen | `id, taskId, employeeId, positionId, generation, workPacket, startedAt` can never change (database trigger `WORKER_RUN_BINDING_FROZEN`) |
| At most one active run per Task | partial unique index; enforced by storage |
| At most one run per (Task, generation) | unique index; a generation is granted to one execution |
| Persistent | Survives restart; only state/ended_at/end_reason may change |

### 6.1 WorkerRun ≠ Generation

This is the milestone's highest-priority invariant, and it is a *separation*, not
an identity:

| Question | Answered by |
| --- | --- |
| "Is this execution still allowed to write Runtime state?" | **generation** — the fencing token from v0A |
| "Which employee actually did this work?" | **WorkerRun** — a durable execution record |

```
workerRun.id  ≠  generation        (a uuid-shaped string vs. a monotone integer)
generation    →  0 or 1 current WorkerRun
WorkerRun     →  exactly 1 generation, frozen at creation
```

History is never rewritten: when a run is interrupted or cancelled, the
generation advances and the old run stays readable forever. A new attempt gets
a new run id *and* a new generation. Reusing a run id across attempts, or
mistaking the generation for the run identity, is the failure mode this section
exists to prevent.

---

## 7. WorkPacket

*The minimum working context the Runtime grants an Employee when it wakes it up.*

```
WorkPacket = {
  packetVersion: 1,
  company: { id, name },
  work:    { id, title, intent },
  task:    { id, title, intent, state, generation },
  requirements: { requiredCapabilities[] },
  assignment: { id, employeeId, positionId, reason, assignedAt },
  employee: { id, displayName },
  position: { id, title, capabilities[] },
  context: {
    latestCheckpoint: null | { id, label, sequence, generation, state },
    priorArtifacts: [{ id, kind, title, contentDigest, generation, createdAt }],
    priorArtifactCount
  }
}
```

Rules:

* **Deterministic**: built only from persisted facts, keys in a fixed order, so
  the same state yields the same bytes and the same digest.
* **Bounded**: prior artifacts are summarised (ids/digests, *no* content);
  at most the 20 most recent are listed, with `priorArtifactCount` telling the
  truth about the rest. There is no database dump, no company history, no event
  log.
* **Not a prompt.** The packet is a Runtime contract. No system prompt, no
  message list, no chain of thought, no provider request is stored anywhere in
  the kernel. A future provider adapter may *derive* a prompt from a packet;
  the core never holds one.
* **Stored verbatim on the run** together with `workPacketDigest` (SHA-256 of the
  canonical JSON), so an audit can prove what was granted, not just what is
  reconstructible later.
* Fields that do not exist yet (FounderProfile, CompanyProfile, Knowledge,
  permission grants) are **absent** rather than faked.

---

## 8. Execution commands and transactions

```
startWorkerRun({ taskId })
  → validates assignment, enabled employee, requirements still satisfied
  → starts the Task (new generation)
  → creates the WorkerRun bound to that generation
  → builds and stores the WorkPacket
  → appends activity (task.execution_started + WORKER_RUN_STARTED)
  → returns { task, generation, workerRun, workPacket }
```

All of it in **one store transaction**, so these split-brain states are
impossible by construction:

```
Task RUNNING  without a WorkerRun      ✗
WorkerRun RUNNING while Task is OPEN   ✗
```

Completion:

* `completeWorkerRun({ taskId, generation })` — the active run must exist and
  match the generation; the Task must have an Artifact from that generation;
  then run → `COMPLETED` and Task → `COMPLETED` in one transaction.
* `completeTask({ taskId, generation })` (the v0A path) refuses while an active
  run exists (`TASK_HAS_ACTIVE_RUN`) — there is exactly one way to finish a Task
  that has a WorkerRun.

### 8.1 Worker COMPLETE ≠ Work Accepted

`WORKER_RUN_COMPLETED` and a `COMPLETED` Task mean "the employee finished its
task responsibility and an output is recorded". There is no Accepted concept in
v0B1 at all, and Work status remains a projection of Task truth. Review,
Repair and Founder decisions arrive in v0B2/v0B3 and will attach *after* this
point without changing it.

---

## 9. Artifact producer provenance

`artifacts` gains one nullable column: `worker_run_id`.

```
Artifact → WorkerRun → Employee        (identity is looked up, not duplicated)
```

| Producer | `worker_run_id` |
| --- | --- |
| Artifact recorded by an Employee's run | required — must name the active run |
| Artifact recorded through the v0A path (no run) | `NULL` |
| Artifact written before schema v2 (v0A data) | `NULL`, and still valid forever |

No `employee_id` is stored on the artifact: employee and position are reachable
through the run. There is no "unknown employee", no "system employee" and no
"migration employee" placeholder — absence is represented by absence.

---

## 10. Handoff, cancellation, recovery

* **Handoff** — recording an artifact during a WorkerRun appends
  `ARTIFACT_HANDED_OFF { taskId, artifactId, workerRunId }`. The employee never
  names the next actor; coordination stays with the Runtime.
* **Cancellation** — `cancelTask` ends the Task *and* the active WorkerRun in one
  transaction (`WORKER_RUN_CANCELLED`), advances the generation so late
  checkpoint/artifact/completion writes are rejected, and keeps all history.
  Availability returns to `AVAILABLE` because the derived definition no longer
  sees an active run.
* **Recovery** — in a single transaction: `Task RUNNING → INTERRUPTED` **and**
  `WorkerRun RUNNING → INTERRUPTED`, with the same generation fence and the same
  `automaticRetry: false` honesty. A Task can therefore never be interrupted
  while its employee stays `BUSY` forever.

---

## 11. Activity vocabulary (v0B1 additions)

```
POSITION_CREATED      EMPLOYEE_CREATED      EMPLOYEE_UPDATED
TASK_REQUIREMENTS_SET TASK_ASSIGNED
WORKER_RUN_STARTED    WORKER_RUN_COMPLETED  WORKER_RUN_INTERRUPTED
WORKER_RUN_CANCELLED  ARTIFACT_HANDED_OFF
```

Generic only. Role-named events (`RESEARCHER_STARTED`, `REVIEWER_STARTED`) do
not exist and are refused by the core-language guard. v0A's lowercase event
kinds remain unchanged — history is append-only and is not renamed.

---

## 12. Storage and the v1 → v2 migration

Schema version 2 adds `positions`, `employees`, `task_requirements`,
`assignments`, `worker_runs`, the partial/unique run indexes, the binding-frozen
trigger, and `artifacts.worker_run_id`.

Opening a store:

| Found | Action |
| --- | --- |
| no `schema_meta` (fresh) | create the v2 schema |
| version 1 | **explicit v1 → v2 migration in one transaction**, then continue |
| version 2 | open normally |
| anything else | fail loudly with `INCOMPATIBLE_SCHEMA_VERSION` |

The migration never deletes or recreates anything: it adds tables, adds the
nullable column, and updates the version. Old rows are preserved value-for-value
and remain readable through the new runtime — asserted by a test that builds a
real v1 database, migrates it, and compares every pre-existing row.

---

## 13. Where the system employees live

The two shipped system employees (a research analyst and an independent
reviewer) are **seed data, not core logic**:

* core packages (`packages/**`, `apps/runtime/**`) contain no employee name and
  no capability id — the guard in `scripts/check.mjs` fails the build if one
  appears there;
* the seed lives in `fixtures/seeds/system-workforce.mjs` and is applied through
  the generic `bootstrapWorkforce` command (idempotent by id; a conflicting
  redefinition fails rather than silently overwriting).

This is also why the entire kernel test suite uses generic employees
(`Analyst A`, `Analyst B`, `capability.x`) and passes without the seed.

Seeding is **not** Hiring: no JD, no hiring conversation, no trial task, no
Founder confirmation, no custom-employee creation path. That is MVP 3.

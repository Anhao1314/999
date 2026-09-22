# Contract — Workforce Experience v0 (Runtime-backed Read Projections)

Status: **frozen semantics for the Workforce Experience v0A slice.** It freezes
one idea and nothing more:

> The frozen Founder Workspace / Employee Lobby renders Runtime truth through a
> derived, bounded, read-only product model — never through a second lifecycle,
> a cache or a copy of Company truth.

Protocol additions: **none.** Experience adds no command, no state and no
authority. Already present: ASSIGN · EXECUTE · HANDOFF · REVIEW · REPAIR ·
ATTEND · ACCEPT. Not covered (later milestones): Founder Workspace production
UI, Lobby UI integration, Hiring, Genesis, Canvas persistence, Laya, Jev,
General A2A, dynamic allocation, schedulers, Knowledge admission.

Builds on `docs/contracts/work-continuity-v0.md` (v0B4),
`docs/contracts/founder-attention-acceptance-v0.md` (v0B3) and everything
before it. Nothing in those is redefined; this document only says how their
truth is projected for a reader.

---

## 1. What an Experience projection is

| Object | Kind | Lives in |
| --- | --- | --- |
| **Experience projection** | **derived read model**, recomputed per read | `packages/experience/` |
| **Founder Workspace content** | projection: company + attention + primary Work + workforce + deliveries + pulse | computed |
| **UI state** | presentation: selection, scroll, seat, table, x/y, `?demo=1` | the UI, never Runtime |
| **Founder attention** | already-derived Runtime projection (v0B3) | computed |
| **Inbox / read flag / dismissal** | — | **does not exist** |

Four rules decide every question below:

1. **Experience is not Runtime.** It reads Runtime facts through public Kernel
   seams and returns bounded plain objects. It writes nothing, stores nothing,
   and cannot be a second source of truth.
2. **UI state is not Company truth.** The Canvas may arrange, highlight and
   animate anything; a drag changes pixels, never reality. When the Lobby and
   Runtime disagree, Runtime is right and the UI is stale.
3. **Availability and role are derived.** They are functions of `enabled` and
   active `WorkerRun` facts at read time — never stored, never remembered, never
   inferred from display strings.
4. **Reading never mutates.** Every projection is a pure read; a GET that
   created an Activity event would be a bug, not a feature.

## 2. Frozen vocabulary

Two derivations get their own words here, and these words never drift:

| Concept | Values | Derived from |
| --- | --- | --- |
| `availability` | `AVAILABLE` · `WORKING` · `DISABLED` | `employee.enabled` + an active WorkerRun |
| `currentRole` | `EXECUTION` · `REVIEW` · `REPAIR` | the Task's structural role in the Work |

`ONLINE`, `OFFLINE`, `IDLE` and `DISCONNECTED` are deliberately absent: an
Employee with no active attempt is `AVAILABLE`, not offline, and transport or
backend state is execution detail rather than organizational identity. The
Runtime's internal employee availability enum keeps its own value `BUSY`;
the Experience projection freezes `WORKING` and derives it independently in
`packages/experience/records.mjs` rather than copying a presentation enum.

`currentRole` is never stored: a Task is `REVIEW` because a ReviewRequest names
it, `REPAIR` because a RepairBinding names it, and `EXECUTION` otherwise. A
role that cannot be established structurally is reported as `null` — the
projection fails closed instead of guessing from a Task title or a Position
name.

One Employee is one current focus. The Runtime's command layer does **not**
forbid a second RUNNING attempt for an Employee who already has one: the
partial unique index is per Task (`worker_runs_one_active_per_task`), there is
no Employee-level constraint, and only the v0B4 dispatch policy avoids the
situation in production. Experience therefore never chooses between active
runs: `availability` stays `WORKING`, `currentWork` and `currentRole` become
`null`, and the card carries `condition = MULTIPLE_ACTIVE_RUNS`. It does not
name “the last one”, and it does not grow a `currentWorks[]` list — the frozen
UI baseline assumes one focus per Employee.

## 3. Bounds

Every list the Experience layer returns is capped by `EXPERIENCE_BOUNDS`, so a
large company degrades into "the most recent N" instead of an unbounded
response: employees 500 · capabilities 32 · on-duty 8 · attention items 20 ·
deliveries 10 · activity 20 · lineage steps 40 · runs scanned per employee 20 ·
title 200 · summary 400 characters. Long titles are truncated with `…`, never
rewritten. Bounds are part of this contract; changing one is a contract change,
not a tweak.

## 4. Runtime read seam

Projections may only use public Kernel reads: companies, positions, employees,
runs, task details, artifacts, reviews, repair bindings, work projections,
Founder Attention and Activity. They must never touch `kernel.store.db`, a raw
row, a SQL statement or a storage table. Two read shapes exist on purpose:

- `kernel.activity(...)` reads the append-only stream from the oldest end
  (how did this begin);
- `kernel.recentActivity(...)` reads it from the newest end (what just
  happened), bounded and in append order.

The Experience layer added no other seam. That is the whole Runtime surface it
depends on.

## 5. Workforce Lobby projection

`projectWorkforceLobby({ kernel, companyId })` returns:

```
{ company: { id, name },
  summary: { employees, working, available, disabled },
  employees: [ { employeeId, displayName,
                 position: { id, title } | null,
                 capabilities: [ ... ],
                 availability,
                 condition: null | "MULTIPLE_ACTIVE_RUNS",
                 currentWork: { workId, title, taskId, role, workerRunId,
                                generation, attempt, maxAutonomousAttempts } | null,
                 execution: { backendType, backendVersion } | null } ] }
```

Employee identity is organizational only: Employee, Position, capabilities.
`backendType`, `model`, `provider`, `externalSessionRef`, PID and Codex threads
are execution details and never identity. `summary` counts derive from the same
cards every other view sees, so the widget and the Lobby cannot disagree. The
Lobby is not a scheduler: it shows who is working and cannot start, assign or
interrupt anything.

## 6. Employee Detail projection

`projectEmployeeDetail({ kernel, employeeId })` returns bounded identity,
position, capabilities, availability, `currentRole`, the current attempt
(Work, Task, role, WorkerRun, generation, attempt / `maxAutonomousAttempts`),
execution (`backendType`, `backendVersion`), recent Artifact deliveries and a
bounded window of domain-level Activity for this Employee's own Tasks.

It must not include raw logs, JSONL, chain-of-thought, full prompts, session
references or raw rows. A Worker's execution binding may add `backendType` and
`backendVersion`; `workspaceRoot`, `scratchRoot`, `externalExecutionRef`,
`externalSessionRef`, PIDs and digests stay in debug/developer views.

## 7. Work Lineage projection

`projectWorkLineage({ kernel, workId })` is the derived visualization behind
the central Work card: the Work, its Tasks in creation order (execution,
review, repair), the assigned Employees, produced Artifacts with append-order
version labels and supersession links, Review verdicts, Repair bindings and the
Founder boundary.

It is a rendering of Runtime facts, not an editable workflow graph: nodes exist
because facts exist, edges are supersession / review / repair truth, and
nothing here can be dragged into changing the Work. A projection that mixes
records from two Works fails closed with `EXPERIENCE_LINEAGE_MISMATCH` (HTTP
409) instead of rendering a story that never happened.

## 8. Founder Workspace projection

`projectFounderWorkspace({ kernel, companyId })` returns the frozen home screen
as content: `company`, `runtime`, `attention { count, items }`, `primaryWork
{ selection, lineage } | null`, `workforce` (summary + on-duty), bounded
`recentDeliveries` and `pulse`.

`runtime.available = true` means exactly this: the kernel opened, the store was
readable and the projection derived. It is not infrastructure monitoring, and
it deliberately does not collapse Runtime health, Worker-backend health and
Employee availability into one light.

Primary-Work selection is a documented deterministic policy, not a ranking
algorithm:

1. the Work Founder Attention names first (attention is already urgency-ordered);
2. otherwise the active (not accepted, not cancelled) Work whose newest Task
   `updatedAt` is most recent, ties broken by lower `workId`;
3. otherwise the most recently created Work, ties broken the same way;
4. otherwise no primary Work — a timestamp is never invented.

`pulse` contains counts of facts that exist — works, active, ready for decision,
accepted, open reviews, open repairs, attention, employees working / available /
disabled. No productivity score, efficiency ratio, rating or trend is derived,
because Runtime truth does not contain one.

## 9. HTTP read surface

The Experience projections are exposed through the existing Runtime process as
GET-only reads:

```
GET /experience/companies/:companyId/workspace
GET /experience/companies/:companyId/workforce
GET /experience/employees/:employeeId
GET /experience/works/:workId/lineage
```

Discipline: no POST, no mutation, bounded JSON, an explicit 404 for an unknown
company / employee / work (never a raw 500), and no raw internal exception,
stack trace, storage path or secret in the body. The projections did not grow a
generic query surface, a GraphQL endpoint or a repository browser.

## 10. Founder Attention is not an Inbox

The UI bubble "需要你处理 N" is a summary of current Runtime truth, nothing
else. Experience reads the existing v0B3 Founder Attention projection and
creates no notifications table, no read/unread flag, no dismissed/archived
state and no second Todo lifecycle. When the underlying condition disappears —
the task is resumed, the decision is made — the item disappears by itself on
the next read, without anything being "marked done".

## 11. Acceptance is the Founder's, and only the Founder's

Reviewer PASS never becomes ACCEPTED through Experience; the projection shows
`reviewState: PASS` and `acceptedState: NOT_ACCEPTED` until a Founder Decision
exists. When the decision exists, the delivery flips to `ACCEPTED` and the
lineage exposes only durable decision facts (`decisionId`, `disposition`,
`artifactId`, `artifactDigest`, `decidedAt`, `basis`) — never invocation
metadata such as whether the committing call was a retry. Experience cannot
accept, and Founder ACCEPT here is still not Knowledge admission.

## 12. Derivation, restart and freshness

Every projection is recomputed from the store on every read. There is no cache,
no memoized workforce, no in-memory Lobby state: after a restart, the same
Runtime truth projects identically, and changed truth (a recovered attempt, a
completed review) is visible on the next read without any invalidation
protocol. Ordering facts are the Runtime's own timestamps and append order; the
UI must not synthesize relative times ("2 hours ago") or freshness it cannot
derive.

## 13. What Experience never does

- It does not schedule: no `assignTask`, `startWorkerRun`, `requestReview`,
  `submitReview`, `createRepairTask`, `interruptWorkerRun` or `acceptWork` is
  reachable through Experience. The Employee Lobby is not a manual coordinator
  — Founder 组建团队，FlowCredit 调度团队.
- It does not own presentation: no Team/Seat/Room table, no table or seat
  authority, no pixel layout. Those are UI state.
- It does not persist tables or queues of its own.
- It does not know the demo: `?demo=1` fixtures live in the UI; Experience
  returns live Runtime projections only, and the two must stay visibly
  distinct.

## 14. Integration target (future, not this slice)

The Pixel Lobby work (PR #1) reads Runtime through direct SQL today. Its
replacement target is exactly this projection surface: roster and current work
from the Workforce Lobby projection, the Inspector from Employee Detail,
activity from bounded recent Activity, task/artifact views through Work
Lineage. Its `assign` / `start` / `enable` manual controls stay out of the
Experience layer by design; enabling or disabling an Employee remains an
existing company control, not part of this read-only slice.

## 15. Real-time boundary (documented, not implemented)

v0A ships no WebSocket and no SSE. The future pattern, when the UI needs
liveness, is:

```
Runtime truth → invalidation / event → frontend refetches the Experience projection
```

and never:

```
event → frontend mutates Company truth locally
```

Polling the GET endpoints is acceptable for Lobby v0: the projections are
bounded, derived and write nothing, so a refetch is a cheap, honest read.

---

## Frozen minimal test surface

`tests/unit/experience-workforce.test.mjs`,
`tests/unit/experience-workspace.test.mjs` and
`tests/integration/experience-http.test.mjs` freeze this contract: empty
company, all-available and disabled Employees, execution / review / repair
roles, bounded shapes, cross-Work re-dispatch, exhausted-budget attention,
review PASS waiting at the Founder boundary, explicit ACCEPT, HTTP
404 / no-mutation discipline, and restart equivalence.

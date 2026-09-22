# Contract — Work Continuity v0B4

**Status: frozen.** This is the milestone that closes the AI Workforce MVP's
coordination gap: the Runtime, not the Founder, performs the ordinary
coordination that the frozen product principle assigns to FlowCredit
(*Founder 组建团队，FlowCredit 调度团队*).

It adds **no new Work status, no new collaboration status, no scheduler, no
event bus, no persisted queue, no WAIT, no timers and no model calls.** Every
fact it acts on already exists; what is new is that the Runtime is allowed to
act on it, deterministically, one step at a time.

Depends on: [Persistent Work Kernel v0A](persistent-work-kernel-v0.md) ·
[Workforce Identity & Assignment v0B1](workforce-identity-assignment-v0.md) ·
[Review / Repair Collaboration v0B2](review-repair-collaboration-v0.md) ·
[Founder Attention & Acceptance v0B3](founder-attention-acceptance-v0.md).

## 1. Which things are what

| Thing | What it is |
| --- | --- |
| Continuation Policy | A pure function of Runtime truth: *what boundary is this Work at, and what one action may follow?* |
| Continuation Driver | A stateless actuator: read → choose one action → run one command → re-read. It holds no truth. |
| ProgressBoundary | The named situation the Work is currently in (§6). Derived, never stored. |
| NextActionProposal | A **proposal**, validated by the Runtime, never an instruction: it names work, never authority. |
| Continuation Trace | Append-only **observability**. Never an input to any decision. |
| Availability Wake | A re-evaluation signal after a cross-Work derived fact changed. Never a Work mutation. |

The Driver is not a scheduler: it has no clock, no queue, no ordering policy and
no notion of "later". It runs when the Runtime tells it something changed, and
it stops the moment no single legal action is deterministically available.

## 2. Eligibility is not dispatchability

```
eligibleEmployees =
    employee.enabled
  + employee.companyId === the Work's company
  + Position.capabilities ⊇ TaskRequirements.requiredCapabilities
  + any existing hard role constraint

dispatchableEmployees = eligibleEmployees − { employee | has an active WorkerRun }
```

- Eligibility keeps its v0B3 meaning exactly (`classifyEmployeeCandidates` is
  unchanged). It is an **organizational capability fact**.
- Dispatchability is a **separate derivation**: currently available for
  automatic dispatch. Availability stays derived from WorkerRuns, never stored.
- `CAPABILITY_GAP` ⟺ `eligibleEmployees.length === 0`.
- `eligible > 0 ∧ dispatchable === 0` is **resource contention**, never a
  capability gap. It stops on `NO_DISPATCHABLE_EMPLOYEE` (a diagnostic).
- A BUSY Employee does not mean the Company lacks that capability.

## 3. The dispatch rule

```
current Assignment exists?
  ├─ is the assigned Employee still eligible?
  │    ├─ NO  → the Assignment is not currently usable
  │    │        → treat the Task as unassigned → normal dispatch rules
  │    └─ YES → is that Employee currently dispatchable?
  │             ├─ YES → startWorkerRun
  │             └─ NO  → NO_DISPATCHABLE_EMPLOYEE
  └─ none    → eligible set → dispatchable set
               ├─ exactly one   → assignTask
               ├─ none          → NO_DISPATCHABLE_EMPLOYEE, or CAPABILITY_GAP when eligible is empty
               └─ more than one → DISPATCH_AMBIGUOUS (reported, never resolved)
```

- An existing Assignment is a **recorded preference, not an entitlement to
  start**.
- The Runtime never picks between two equally dispatchable Employees.
- **The generic Kernel is unchanged here.** `assignTask` / `startWorkerRun`
  still do not globally forbid an Employee holding several runs; the rule above
  is Continuation Policy, enforced by the Driver. The Kernel only refuses what
  is structurally illegal.

## 4. Reviewer independence — an enforced guarantee

> The reviewer Employee must not be the producer Employee of the exact Artifact
> being reviewed.

- Producer Employee = `artifact.workerRunId → workerRun.employeeId` of the
  Artifact named by the ReviewRequest.
- Enforced at **both** seams, for Review Tasks:
  1. `assignTask` — a Review Task cannot be assigned to its producer;
  2. `startWorkerRun` — revalidated against current truth before work starts.
- Failure is a deterministic refusal (`REVIEWER_NOT_INDEPENDENT`); nothing is
  written.
- **Fail closed**: if the producer cannot be established, the Runtime refuses.
- A stale, migrated or hand-created self-review Assignment stays a readable
  append-only fact but can never become an executable Review run.
- No self-review exception and no override exists in v0. Independence is not a
  capability and is not expressible in `reviewCapabilities`.
- **Recorded**: in v0B2 this was a convention (demos simply passed
  `reason: "independent review"`); v0B4 makes it a Runtime guarantee.

## 5. Atomic proposal materialization

```
materializeNextAction({ workId, expectedBasis, proposal })
  -> { work, basis, task, requirements }
```

One transaction, in this order:

1. validate `proposal` against the frozen schema (§13) and hard policy;
2. `BEGIN IMMEDIATE`;
3. revalidate: `Work is not accepted` ∧ `Work has zero Tasks` ∧
   `expectedBasis === currentBasis`;
4. create **exactly one** Task (`OPEN`, generation 0);
5. create its TaskRequirements;
6. append the required Work Activity (`task.created` + `TASK_REQUIREMENTS_SET`);
7. `COMMIT`.

It must NOT: select or assign an Employee, start a WorkerRun, call a proposer,
call a sensor, submit a Review, create a Repair, or accept Work.

- The generic `createTask` remains valid and unchanged.
- The **Continuation Driver never writes store rows**. It calls Runtime
  commands, and nothing else.
- A retry after a lost response observes that the Work now has a Task and
  **refuses as a no-op** (`WORK_ALREADY_ACTIVATED`, carrying the current task id
  and basis). No duplicate Task, no second mutable revision counter.

## 6. The drain loop

> Each Driver iteration may commit **at most one** business mutation.

```
read Runtime truth -> basis
derive ProgressBoundary
if no single legal action      -> stop (trace may be appended)
execute exactly ONE command
re-read truth -> NEW basis
repeat, bounded by MAX_CONTINUATION_STEPS = 16
```

- Against one snapshot these are forbidden: `assignTask → startWorkerRun`;
  `createRepairTask → startWorkerRun`.
- Every iteration re-reads truth and re-derives the boundary. A stale basis
  discards the pending decision and recomputes; an old plan is never forced.
- A refusal / no-op / stale / diagnostic step is not a business mutation. It
  may be traced, and the loop **stops** rather than retrying it forever.
- `MAX_CONTINUATION_STEPS = 16` is the loop-safety fuse.

### ProgressBoundary

| Boundary | Meaning | The one legal action |
| --- | --- | --- |
| `ACCEPTED` | a Founder Decision exists | none — stop |
| `CANCELLED` | every Task is cancelled | none — stop |
| `RUNNING` | an attempt is executing right now | none — stop |
| `INTERRUPTED` | an interrupted Task with a deterministic continuation | resume / reassign |
| `REVISION_UNOWNED` | a `REQUEST_REVISION` Review with no Repair | `createRepairTask` |
| `UNASSIGNED_TASK` | an open Task with no usable Assignment | `assignTask` |
| `READY_TO_START` | an open Task with a usable, dispatchable Assignment | `startWorkerRun` |
| `NOT_ACTIVATED` | non-terminal Work with zero Tasks | `materializeNextAction` |
| `READY_FOR_DECISION` | outcome ready, waiting on the Founder | none — stop |
| `BLOCKED` | an obligation nothing can satisfy | none — stop (+ diagnostic) |

Precedence when several apply: `ACCEPTED` > `CANCELLED` > `RUNNING` >
`INTERRUPTED` > `REVISION_UNOWNED` > `UNASSIGNED_TASK`/`READY_TO_START` >
`NOT_ACTIVATED` > `READY_FOR_DECISION` > `BLOCKED`.

## 7. REPLAN in v0

Executable `REPLAN` exists **only for Initial Work Activation**: a non-terminal
Work with zero Tasks.

```
WORK_CREATED → zero Tasks → REPLAN → NextActionProposer
→ validated NextActionProposal → materializeNextAction → initial EXECUTION Task
```

- After the initial Execution Task exists, v0B4 **never** creates another
  ordinary Execution Task through open-ended replanning. Later progress uses
  only: Task dispatch, Review, `REQUEST_REVISION`, Repair, re-review and the
  Founder decision.
- If no legal path exists outside those protocols: diagnostic / stop. The
  Runtime never invents a Task.
- The boundary is enforced in the Runtime (materialization refuses a
  non-activatable Work), not merely promised by the proposer.
- `taskKind = VERIFICATION` stays reserved in the vocabulary and is never
  materialized in v0; the v0 adapter emits only `EXECUTION`.
- Recorded as future scope: multi-Task decomposition, Task DAG, continuous
  REPLAN, Dynamic Swarm.

## 8. Trigger seams and the availability wake

Three seams, and nothing else:

1. **Post-commit** — after a command's transaction commits, the Runtime tells
   the Driver what changed. The Kernel detects this at the single point where
   Work-scoped Activity is appended and at its transaction boundary; the
   Driver is notified **only after COMMIT**.
2. **Startup** — after `recover()`, the host drives every non-terminal Work
   once.
3. **Explicit** — `driveWork(workId)`.

Invariant:

> No continuation wake may observe an uncommitted WorkerRun terminal state.

If the transaction rolls back, no wake happens as a consequence of it.

`wakeContinuations(companyId)` is **internal** to the Driver. Its only purpose:

> re-drive non-terminal Works whose continuation may have changed because
> Company workforce facts changed.

- Causes in v0: `WORKER_RUN_ENDED` · `EMPLOYEE_ENABLED_CHANGED` (both
  directions) · `EMPLOYEE_CREATED` · ordinary Work Activity.
- v0 conservatively scans every non-terminal Work of the Company. No
  optimization is required.
- Coalescing is an in-process `Set<workId>`. Nothing is persisted: a restart
  loses pending wakes, and that is correct — the next trigger or the startup
  drive re-derives everything from truth.
- This is NOT a scheduler, a durable queue, an event bus, ranking, load
  balancing or priority scheduling. It carries no truth; the consumer re-reads.
- There is no clock and no timer. `NO_DISPATCHABLE_EMPLOYEE` is not retried on a
  schedule; the Work becomes eligible for another drive when workforce
  availability actually changes.

## 9. Basis interaction

- A cross-Work availability change **never** appends Activity to another Work
  and never advances its `decisionBasis`.
- Flow: `Company workforce facts changed → wake Work A → Work A re-reads
  Company + Work truth → drive if now possible`.
- Cross-Work wake is a scheduling signal, **not a Work mutation**. A wake that
  finds nothing to do leaves the Work bit-for-bit unchanged.
- v0B3 stale-decision semantics are preserved exactly: `expectedBasis` guards
  cannot be invalidated by a wake.

## 10. `WORK_ALREADY_ACTIVATED` is benign convergence

It MUST NOT count as a failed planning attempt, a refused proposal, unsafe
autonomy or `PLANNING_EXHAUSTED` input. It means: *another attempt already
materialized the initial Task.*

```
WORK_ALREADY_ACTIVATED → re-read Runtime truth → continue from the existing Task
```

Trace may record `action_result = NO_OP`, `reason = ALREADY_CONVERGED`. No new
Task, no consumed retry.

## 11. Founder Attention after the Driver

- Attention is derived **exclusively from current Runtime truth**. It may not
  read traces, and it may not depend on "the Driver previously stopped".
- `EXECUTION_INTERRUPTED` becomes an item only when **no deterministic
  continuation exists** and a legal Founder command resolves or advances it.
  - resumable now (usable Assignment + dispatchable assignee) → **no item**
  - exactly one dispatchable replacement → **no item** (the Driver reassigns)
  - eligible but all busy → **no item**; diagnostic `NO_DISPATCHABLE_EMPLOYEE`
  - more than one dispatchable replacement → **item** (`ASSIGN_EMPLOYEE`): the
    Runtime refuses to choose
  - only a disabled capable Employee → **item** (`ENABLE_EMPLOYEE`)
  - no capable Employee at all → `CAPABILITY_GAP`; for an execution Task
    `ABANDON_TASK` remains the honest exit
- `REPAIR_UNASSIGNABLE` and `DECISION_REQUIRED` keep their v0B3 semantics.
- The `EXECUTION_INTERRUPTED` summary text changes, because the Runtime now does
  restart attempts: "Execution was interrupted, and this Runtime never restarts
  an attempt by itself" is no longer true.

## 12. Trace semantics

- `continuation_traces` is append-only (`no_update` / `no_delete` triggers,
  mirroring `founder_decisions`).
- **A trace write failure never rolls back or invalidates an already-committed
  business mutation.** Business truth wins. Ordering: business COMMIT → attempt
  trace append → on failure, log and continue; never repeat the business action
  because the trace is missing.
- Diagnostic / stale / no-op steps may append a trace with no business mutation.
- Neither the Continuation Policy nor Founder Attention may read trace rows to
  decide Runtime reality. Traces may explain history to developers.
- The trace is read through an explicit trace query, never mixed into the Work
  projection: a Work projection must contain no field whose value depends on
  history rather than on current truth.

## 13. NextActionProposal schema (frozen, strict)

```
{ taskKind: "EXECUTION",
  title,
  intent,
  requiredCapabilities: [ ... ],   // non-empty
  reviewCapabilities:   [ ... ] }  // non-empty (artefact-producing work is reviewed)
```

Unknown fields are **rejected**, never ignored — including `employeeId`,
`permission`, `verdict`, `accepted`, `runtimeState`, `toolGrants`, `basis`, or
any other field that would let a proposer smuggle Runtime authority through the
proposal. Validation is total and fails closed before the transaction opens.

## 14. DecisionState

Each traced step carries a bounded, JSON-safe `DecisionState` (work, task states,
boundary, candidate sets, basis) and its digest. It is a **reading**, not an
input: no decision may depend on a stored DecisionState. It exists so a future
sensor adapter can be added without redesigning the Runtime, and so a step can
be replayed by a developer.

## 15. Semantic Sensor — reserved, not integrated

The Runtime integrates **no sensor** in v0B4. There is no sensor adapter, no
timeout policy, no confidence mapping and no `FLOWCREDIT_SENSOR` switch: a knob
that changes nothing is a lie. The trace carries nullable sensor columns so the
shape is reserved, and every v0B4 row leaves them `NULL`.

## 16. Errors

New codes: `INVALID_PROPOSAL` (400) · `REVIEWER_NOT_INDEPENDENT` (409) ·
`WORK_ALREADY_ACTIVATED` (409) · `STALE_CONTINUATION_BASIS` (409).

Diagnostics (recorded in traces, never thrown): `NO_DISPATCHABLE_EMPLOYEE` ·
`CAPABILITY_GAP` · `DISPATCH_AMBIGUOUS` · `PLANNING_EXHAUSTED` ·
`CONTINUATION_LIMIT_REACHED` · `COLLABORATION_BLOCKED`.

## 17. Storage: schema v4 → v5

One additive table, no backfill, no status column, no queue:

```sql
continuation_traces(
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  company_id, work_id,
  step INTEGER,
  trigger_type TEXT,              -- COMMAND | STARTUP | EXPLICIT | WAKE
  basis_before INTEGER, basis_after INTEGER,
  decision_state_digest TEXT, decision_state TEXT,
  policy_version TEXT, reason_codes TEXT,
  diagnostic_code TEXT,
  action_command TEXT, action_target_id TEXT,
  action_result TEXT,             -- EXECUTED | NO_OP | REFUSED | STALE | SKIPPED | DIAGNOSTIC
  action_error_code TEXT,
  sensor_name TEXT, sensor_version TEXT, signals_json TEXT,   -- reserved, NULL in v0B4
  created_at TEXT NOT NULL
)
```

## 18. Authority boundary

| The Runtime may | The Runtime may never |
| --- | --- |
| assign an existing Employee to an existing Task | create, hire or enable an Employee |
| start an existing Task's run | accept Work, or write a Review verdict |
| materialize one proposed initial Task | invent work outside a validated proposal |
| repair a revision the Reviewer requested | decide an ambiguous dispatch |
| re-read its own truth and continue | read a trace to decide anything |

Reviewer PASS ≠ Founder ACCEPT. Founder ACCEPT ≠ Knowledge Admission. The
Driver can reach `READY_FOR_DECISION`; only the Founder can cross it.

## 19. Acceptance criteria

- All 139 pre-v0B4 tests stay green; every new invariant has a test.
- Scenario 1 (real Work, Driver on, no sensor): `Founder Extra Touch Count = 0`
  and `Manual Coordination Count = 0` between `CREATE_WORK` and
  `DECISION_REQUIRED`.
- Scenario 2 (genuine `REQUEST_REVISION` → Repair → re-review → PASS): 0/0.
- `kill -9` mid-drive → restart → converges; no duplicate Assignment, no
  duplicate WorkerRun, no duplicate Task.
- Deterministically resumable interruptions produce **no** Founder Attention.
- `node scripts/check.mjs`, `node --test` and every demo pass.

**Wording.** This milestone's success is named
**`Deterministic Workforce Coordination Closure = PASS`**. It is **not** "full
AI Workforce product autonomy", which additionally requires real execution
adapters / System 2 integration. A deterministic or test proposer validates the
Runtime architecture; it must never be described as production System 2
autonomy.

## 20. Known limitations (recorded, not solved)

1. No dynamic allocation: two equally dispatchable Employees stop the drive
   (`DISPATCH_AMBIGUOUS`) instead of being ranked.
2. No `WAIT`: a Work whose only capable Employee is busy waits for a real
   availability change, not for a clock.
3. No autonomous cancel, no escalation command, no Hiring.
4. REPLAN is initial-activation only; multi-step decomposition is future scope.
5. `COLLABORATION_BLOCKED` and `OUTCOME_AMBIGUOUS` keep their v0B3 limitations.
6. The wake scans every non-terminal Work of the Company. Deliberately
   unoptimized in v0.

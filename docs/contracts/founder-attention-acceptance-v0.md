# Contract — Founder Attention & Acceptance v0B3

Status: **frozen semantics for the v0B3 milestone.** This milestone answers one
question and nothing more:

> A Work has stopped being able to continue correctly on its own. Which of those
> conditions genuinely need the Founder, what does the Founder actually see, and
> what does it mean when they ACCEPT the outcome?

Protocol additions: **ATTEND · ACCEPT.**
Already present: ASSIGN · EXECUTE · HANDOFF · COMPLETE · REVIEW · REPAIR.
Not covered (later milestones): Hiring, Genesis, Canvas, Jev, dynamic
allocation, schedulers, capability ranking, DAG planning, model providers,
Knowledge admission, any UI.

Builds on `docs/contracts/persistent-work-kernel-v0.md` (v0A),
`docs/contracts/workforce-identity-assignment-v0.md` (v0B1) and
`docs/contracts/review-repair-collaboration-v0.md` (v0B2). Nothing in those is
redefined; this document extends them.

---

## 1. Which things are what

| Object | Kind | Lives in |
| --- | --- | --- |
| **FounderDecision** | persistent **immutable authority act** | `founder_decisions` |
| **DecisionBasis** | the Work's Activity head at decision time | derived (`max(activity.sequence)` for the Work) |
| **Work outcome** | **derived** projection of Artifacts + Tasks + the Decision | computed |
| **Attention item** | **derived** projection: a condition plus a legal action | computed |
| **Attention diagnostics** | observed conditions with no legal action | computed |
| **Read / unread / dismissed** | — | **does not exist** |

Four rules decide every question below:

1. **Reviewer PASS is not an acceptance.** A `PASS` moves a Work to
   `READY_FOR_DECISION`; only the Founder moves it past that.
2. **Acceptance is an act about an exact Artifact at an exact basis.** Never
   about "the latest", never about a Work in general.
3. **Attention is a projection, not a queue.** Reading it stores nothing, and
   there is no second lifecycle to keep in sync with Runtime truth.
4. **A legal command is not automatically a valid action.** Attention only
   advertises an action proven to resolve or advance the condition.

## 2. Naming normalization

One act, two names, never interchangeable:

| Fact | Value | Where |
| --- | --- | --- |
| the durable authority act | `ACCEPT` | `founder_decisions.disposition` |
| the derived Work condition | `ACCEPTED` | `workProjection.outcome.state` |
| accepted decision details | `disposition: "ACCEPT"` | `workProjection.outcome.accepted` |

There is deliberately **no `ACCEPTED` collaboration status or stage**: the
collaboration vocabulary (`OPEN` / `ACTIVE` / `NEEDS_ATTENTION` /
`READY_FOR_DECISION` / `BLOCKED` / `CANCELLED`) describes what the Work's Tasks
are doing, and an accepted Work's Tasks are doing exactly what they were doing
before. After acceptance:

```
collaboration status = READY_FOR_DECISION
outcome.state        = ACCEPTED
```

## 3. The Founder Decision — the one new durable fact

```
founder_decisions(
  id, company_id, work_id, disposition,
  artifact_id, artifact_digest, basis_sequence, created_at
)
```

- append-only, immutable (no UPDATE, no DELETE), **at most one decision per Work**
  (unique index on `work_id`)
- `disposition` vocabulary currently contains exactly one value: `ACCEPT`
- `artifact_id` is a foreign key, `artifact_digest` is the digest the Founder saw
- `basis_sequence` is the DecisionBasis the Founder decided against
- no new stored Work status, no new Task state, no Inbox table, no actor table,
  no Knowledge write, no Review mutation

`idempotent` is **not** a decision fact. It describes whether the *current
`acceptWork` invocation* was a retry of an already-committed identical decision.
It therefore appears in the command response and nowhere else — never in the
Work projection, never in storage.

## 4. DecisionBasis

```
basis = MAX(activity.sequence WHERE work_id = W)
```

No `work.revision`, no second mutable version counter.

**Frozen invariant:** *every mutation that can change the acceptance-relevant
reality of Work W appends Work-scoped Activity in the same transaction.* The
implementation is protected by regression tests
(`tests/unit/founder-attention.test.mjs`, "every mutation of a Work's accepted
reality advances its basis").

Acceptance-relevant Work reality is the Work-scoped content of `works`, `tasks`,
`artifacts`, `task_requirements`, `assignments`, `worker_runs`, `reviews`,
`review_requests` and `repair_bindings`.

**Company-level workforce changes are intentionally outside the Work basis**:
`createPosition`, `createEmployee`, `setEmployeeEnabled` and `bootstrapWorkforce`
append company-scoped Activity only. Enabling an Employee changes who *could* do
the work, not what the Work *is*, and must not make a Founder's inspected basis
stale.

## 5. Outcome candidate semantics

A **current outcome candidate** is an Artifact that is:

- produced by a `COMPLETED` Task, and
- not superseded by another Artifact in the same Work.

Derived Work outcome states:

| state | condition | acceptance |
| --- | --- | --- |
| `NO_CANDIDATE` | 0 candidates | not possible |
| `READY` | exactly 1 candidate | eligible |
| `AMBIGUOUS` | 2 or more candidates | not possible |
| `ACCEPTED` | a Founder Decision exists | already decided |

Candidates are **never** chosen by recency. `AMBIGUOUS` never falls back to
`latestArtifact`, never asks the Founder to pick one arbitrarily, and has no
composite/manifest/partial-acceptance escape hatch. `workProjection.latestArtifact`
still exists as the v0B2 reading of the supersession chain, and is never how an
outcome is decided.

## 6. Work projection

The v0B2 read model is extended, not replaced:

```
outcome = { state, candidateArtifacts, accepted }
decisionBasis = <the Work's current Activity head>
founderAttention = { item, conditions, diagnostics }
```

`accepted` is derived only from durable facts and may contain exactly:

```
decisionId · disposition ("ACCEPT") · artifactId · artifactDigest · decidedAt · basis
```

It may not contain `idempotent`, retry information, request/session metadata or
UI state.

## 7. `acceptWork`

```
acceptWork({ workId, artifactId, artifactDigest, basis })
  → { decision, work, idempotent: true | false }
```

Frozen validation order:

1. validate input
2. existing identical decision → return it with `idempotent: true`
3. conflicting existing decision → `WORK_ALREADY_DECIDED`
4. Work exists
5. Artifact belongs to the exact Work and company → `DECISION_TARGET_MISMATCH`
6. digest matches the recorded Artifact exactly → `DECISION_TARGET_MISMATCH`
7. Artifact is the current outcome candidate → `ARTIFACT_NOT_CURRENT`
8. exactly one candidate exists → `OUTCOME_AMBIGUOUS`
9. the Work currently derives `READY_FOR_DECISION` → `WORK_NOT_READY_FOR_DECISION`
10. basis equals the current Work Activity head → see §8

Checks 2–10 re-read stored truth **inside `BEGIN IMMEDIATE`**, so a decision can
never commit against a Work state that has already moved on.

The successful transaction is exactly:

```
insert founder_decision
+ append WORK_ACCEPTED Activity
+ COMMIT
```

No other business mutation.

## 8. Stale decisions

The Founder must never accept reality they did not inspect.

```
basis < current head  →  STALE_DECISION_BASIS
basis > current head  →  INVALID_DECISION_BASIS
```

No decision row, no partial state. A retry after a successful commit, quoting the
same basis, succeeds through check 2 — the idempotency branch runs **before**
staleness, so a legitimate replay is never misreported as a stale decision, and a
genuinely different decision is refused before either.

## 9. Post-acceptance guard

```
createTask(acceptedWork)  →  WORK_ACCEPTED_LOCKED
```

This is the minimum guard, and the only one. A Work that merely derives
`READY_FOR_DECISION` is **not** locked: before acceptance, reality may still
change, and if it changes the DecisionBasis makes the Founder's previous
inspection stale. Further work on an accepted outcome belongs to a new Work.

## 10. Founder Attention — the decision rule

Attention is a pure derived projection. No storage, no Inbox row, no
`read`/`unread`/`done`/`dismissed`/`archived`/`resolved` flag. Reading it mutates
nothing. At most **one item per Work**.

The normative question is not "is something unfinished?" but:

> Can this Work continue correctly without Founder intervention
> under the Runtime that exists today?

```
real autonomous continuation exists
  → no Founder Attention

otherwise, an existing legal Founder action actually resolves
or meaningfully advances the condition
  → Founder Attention, carrying that action

otherwise
  → diagnostic only: visible in the Work projection, no Inbox item
```

## 11. Emitted kinds

| Kind | Condition | Advertised actions |
| --- | --- | --- |
| `EXECUTION_INTERRUPTED` | a Task is `INTERRUPTED` and no automatic resume policy exists | `RESUME_EXECUTION` (assigned and valid) · `ASSIGN_EMPLOYEE` (a capable Employee exists) · `ENABLE_EMPLOYEE` (only a disabled capable one) · `ABANDON_TASK` (execution Tasks only) |
| `REPAIR_UNASSIGNABLE` | an open Repair Task has no valid assignment | `ASSIGN_EMPLOYEE` · `ENABLE_EMPLOYEE` |
| `DECISION_REQUIRED` | the Work derives `READY_FOR_DECISION`, has exactly one candidate and no decision | `ACCEPT` (carrying artifact id, digest and basis) |

Precedence, then `workId`: `EXECUTION_INTERRUPTED` > `REPAIR_UNASSIGNABLE` >
`DECISION_REQUIRED`.

`ATTENTION_ACTIONS` is a closed vocabulary of *mechanisms*
(`ACCEPT`, `RESUME_EXECUTION`, `ASSIGN_EMPLOYEE`, `ENABLE_EMPLOYEE`,
`ABANDON_TASK`); every advertised action also carries an effect of `RESOLVES` or
`ADVANCES`. Nothing else is advertised.

## 12. Diagnostics

These are recorded in the Work projection and never emit an actionable item:

| Diagnostic | Why it is not an item |
| --- | --- |
| `COLLABORATION_BLOCKED` | a cancelled Review or Repair left an obligation nothing can ever satisfy; v0B3 defines no reopen/override/abandon protocol, so it invents no action |
| `CAPABILITY_GAP` | hiring is the v0B3 successor's answer, and v0B3 has no Hiring; it is emitted only when no usable existing action remains |
| `OUTCOME_AMBIGUOUS` | v0B3 has no disambiguation protocol, and guessing is forbidden |
| `NO_CANDIDATE` | defensive: a Work that is ready with nothing to accept has no legal exit |

### Action audit

Actions are advertised only where Runtime behaviour was verified:

- `ABANDON_TASK` **is** offered for an interrupted execution Task, where
  cancelling provably clears the interruption.
- `ABANDON_TASK` is **not** offered for an unassignable Repair: cancelling it
  produces permanent `BLOCKED` collaboration, which is not a resolution.
- `ABANDON_TASK` is **not** offered for an interrupted Review or Repair Task: it
  would leave an obligation nothing can ever satisfy.

## 13. Autonomous continuation

`CONTINUING` · `AUTO_CONTINUABLE` · `FOUNDER_ACTION_REQUIRED` · `CAPABILITY_GAP`

An eligible Employee is a **capability fact, not a schedule**. There is no
dispatcher in v0B3; an unassigned Task with three eligible Employees is still an
unassigned Task, and the Runtime does not imply otherwise anywhere.

Two continuations are Runtime-owned and therefore never Founder attention:

- `REQUEST_REVISION` with deterministic Repair creation available
  (`createRepairTask`), which is why a `BLOCKED` Work at that instant is not an
  item.
- nothing else. Interrupted execution stays Founder attention, because the
  Runtime never restarts an attempt by itself.

## 14. Crash, retry, concurrency

- crash before the transaction → no state
- crash during the transaction → rollback, no decision, no event
- crash after commit, before the response → the retry is idempotent
- the same ACCEPT → the existing decision; a conflicting ACCEPT → an error
- concurrent ACCEPT → the transaction serialises them; one wins, the other
  replays or is refused
- a hard restart preserves the outcome; there is **no decision-recovery
  lifecycle**, and `#recoverOpenAttempts` never adjudicates or modifies a
  Founder Decision

## 15. Activity vocabulary

Exactly one new kind: `WORK_ACCEPTED`. Its Work-scoped sequence is also what makes
the DecisionBasis correct, so it is appended in the same transaction as the
decision. Activity does not become a second state machine.

## 16. Errors

```
WORK_ALREADY_DECIDED · WORK_NOT_READY_FOR_DECISION · DECISION_TARGET_MISMATCH
ARTIFACT_NOT_CURRENT · OUTCOME_AMBIGUOUS · STALE_DECISION_BASIS
INVALID_DECISION_BASIS · WORK_ACCEPTED_LOCKED · FOUNDER_DECISION_NOT_FOUND
```

They use the existing runtime error conventions and HTTP statuses.

## 17. Storage: schema v3 → v4

New table: `founder_decisions`. New index: `activity(work_id, sequence)` (the
DecisionBasis read). New triggers: `founder_decisions_no_update`,
`founder_decisions_no_delete`.

`SCHEMA_VERSION = 4`. The migration is **purely additive** and runs stepwise
(`v1 → v2 → v3 → v4`, each step in its own transaction). There is **no historical
backfill**: a store that predates v0B3 has no decisions, and absence is how "no
decision yet" is represented. An unknown future version still fails loudly with
`INCOMPATIBLE_SCHEMA_VERSION`.

## 18. Authority boundary

The Founder Decision is the only human authority the Runtime stores, and it is
reachable only through `WorkKernel.acceptWork`. The read surface for Founder
Attention is `WorkKernel.founderAttention({ companyId })` and
`GET /companies/:id/attention`, both returning the actionable items ordered by
precedence — the per-Work view in §6 additionally carries `conditions` and
`diagnostics`. The command surface is `POST /commands` (`acceptWork`).

This milestone does **not** implement: Hiring, Genesis, Canvas, providers, model
calls, dispatchers, schedulers, capability ranking, DAG planning, dynamic
allocation, parallel swarms, Knowledge admission, or any UI. ACCEPT is not an
escalation and not a review; it is the Founder closing one Work, and nothing
follows from it automatically.

## 19. Known limitations

Recorded honestly, not fixed here:

1. **Permanent `COLLABORATION_BLOCKED` has no exit.** Cancelling a Review or
   Repair leaves an obligation nothing in this Runtime can satisfy, and v0B3
   defines no reopen/override/abandon protocol.
2. **`OUTCOME_AMBIGUOUS` has no disambiguation.** Two current candidates are
   reported faithfully and refused; the Runtime never chooses.
3. **A pure capability gap needs Hiring.** A Repair whose only capable Employee
   is disabled always has the honest action `ENABLE_EMPLOYEE`; a genuinely
   capability-less Work can only be diagnosed until MVP 3.
4. **There is no dispatcher.** See the closure gate below.
5. **There is no `escalate()` command.** The product protocol vocabulary lists
   ESCALATE between REPAIR and the Founder Inbox, but v0B3 adds no such command:
   attention is *derived* from Runtime truth, so nothing has to be escalated into
   existence, and an escalation record would be a second lifecycle with nothing
   to store that the projection does not already say.

## 20. AI Workforce MVP closure gate

After v0B3, and before the AI Workforce MVP may be called PASS, a separate
end-to-end product test asks:

> Can Founder create Work and then stop manually coordinating until FlowCredit
> legitimately needs Founder attention again?

Specifically, whether the Founder must still personally perform ordinary Task
assignment, ordinary Task start, Review assignment and Repair coordination —
work the frozen product principle assigns to FlowCredit
(*Founder 组建团队，FlowCredit 调度团队*).

This gate is **recorded, not solved**, here. It authorizes no scheduler, no
capability ranking, no DAG planner, no dynamic swarm and no new routing logic in
v0B3.

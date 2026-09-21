# Contract — Review & Repair Collaboration v0B2

Status: **frozen semantics for the v0B2 milestone.** This milestone answers one
question and nothing more:

> After an Employee completes a Task and hands off an Artifact, how does another
> Employee review it formally, and how does the Runtime — when review finds a
> problem — create a Repair Task with complete lineage, whose Artifact supersedes
> the old one, so the result can be reviewed again and finally pass?

Protocol additions: **REVIEW · REPAIR.**
Already present: ASSIGN · EXECUTE · HANDOFF · COMPLETE.
Not covered (later milestones): ESCALATE to Founder, Founder Inbox, Founder
ACCEPT, Hiring, Genesis, Canvas, Jev, dynamic allocation, any model provider.

Builds on `docs/contracts/persistent-work-kernel-v0.md` (v0A) and
`docs/contracts/workforce-identity-assignment-v0.md` (v0B1). Nothing in those is
redefined; this document extends them.

---

## 1. Which things are what

| Object | Kind | Lives in |
| --- | --- | --- |
| **ReviewRequirement** | persistent obligation on a Task (part of its requirements) | `task_requirements.review_capabilities` |
| **ReviewRequest** | persistent *historical fact*: this Artifact owes a review, and this Task will produce it | `review_requests` |
| **Review** | persistent **immutable judgment record** | `reviews` |
| **RepairBinding** | persistent **immutable lineage record** | `repair_bindings` |
| **Supersession** | persistent pointer on the replacing Artifact | `artifacts.supersedes_artifact_id` |
| **Review cycle number** | **derived** (count of prior repairs in the chain), never stored | computed |
| **Work collaboration stage** | **derived** projection, never stored | computed |

Two rules decide every question below:

1. **Review is a judgment about an exact Artifact** — never about "the latest".
2. **Repair is a new Task** — the original Task, Artifact and Review are never
   reopened, edited or overwritten.

---

## 2. Review requirement

A Task may declare that its output must be reviewed before the Work can be
considered ready for a Founder decision:

```
task_requirements = { requiredCapabilities: [...], reviewCapabilities: [...] }
```

- `reviewCapabilities` is a capability list for the **reviewer's** position, in
  the same vocabulary as `requiredCapabilities` (v0B1 §4). Empty means "this
  Task's output does not need review".
- It is set through the existing `setTaskRequirements` command — there is no
  second entry point. The v0B1 lock (`TASK_REQUIREMENTS_LOCKED` while `RUNNING`)
  and freeze (terminal tasks) apply to both lists.
- The core never names a reviewer. It checks capabilities, never
  `employee.id === "…"`, and never a shipped roster name (the vocabulary guard
  in `scripts/check.mjs` enforces this).

A **review Task** may not itself declare a review requirement
(`REVIEW_TASK_NOT_REVIEWABLE`): a review of a review is not a collaboration
shape this milestone has semantics for.

## 3. Review Request — the obligation, and why it cannot vanish

`requestReview({ taskId })` is the **only** way a Task's output enters review,
and it is a single transaction that does four things at once:

1. verifies the execution attempt (task `RUNNING`, active WorkerRun, current
   generation, and an Artifact produced by that run in that generation),
2. **hands the Artifact off for review** (emits `REVIEW_REQUESTED` with the
   exact artifact id and digest),
3. **completes the WorkerRun and the source Task** (`WORKER_RUN_COMPLETED`,
   `task.completed`),
4. **creates the Review Task** with `requiredCapabilities = reviewCapabilities`
   of the source Task, plus the immutable `review_requests` row that binds it to
   the exact `targetArtifactId` + `targetArtifactDigest`.

Handing off requires a **WorkerRun** (`NO_ACTIVE_RUN` otherwise), so a Task that
requires review is always executed by an Employee: the no-run v0A completion
path cannot enter review, and is refused with `REVIEW_REQUIRED` before it can
try. In this milestone every reviewed Artifact therefore has a recorded
producer, which is exactly what the repair assignment policy reads.

### Why this shape

The failure mode this design must make impossible is:

```
source Task COMPLETED  →  crash  →  Review Task never created  →  Work looks "done"
```

Two properties remove it, and both are tested:

- **A Task that requires review cannot be completed without its Review Task.**
  `completeWorkerRun` refuses with `REVIEW_REQUIRED` and names `requestReview`
  as the legal exit; `requestReview` writes the completion and the Review Task
  in one transaction, so there is no instant in which one exists without the
  other.
- **The obligation is persisted, not inferred.** `review_requests` is written in
  the same transaction. Even a store inspected by another process shows the
  obligation, and the Work projection derives `AWAITING_REVIEW` from it rather
  than from the absence of a Task.

No second Work state is stored: the obligation is a row about a Task, and the
Work projection stays derived (§13).

A Review Task is a **normal Task** (§5). There is no `REVIEW_PENDING` /
`REVIEW_RUNNING` state: the source Task completes, and the Review Task walks the
existing v0A lifecycle `OPEN → RUNNING → COMPLETED | INTERRUPTED | CANCELLED`.

## 4. Review — the immutable judgment record

```
Review {
  id, companyId, workId,
  reviewTaskId, reviewerWorkerRunId,
  targetArtifactId, targetArtifactDigest,
  verdict: PASS | REQUEST_REVISION,
  summary,                      // bounded, required
  findings: [ string ],         // bounded, required non-empty for REQUEST_REVISION
  createdAt
}
```

- Written **only** by `submitReview`, and only for the Artifact the Review Task
  was bound to. There is no way to review "whatever is latest".
- **Immutable in storage**: database triggers refuse `UPDATE` and `DELETE`
  (`REVIEW_IMMUTABLE`).
- The verdict vocabulary is exactly those two words. No score, no confidence, no
  severity, no probability: this milestone has no consumer that could act on
  them, and a number nobody reads is a number that will be believed anyway.
- A wrong Review is corrected by a **new cycle**, never by editing history.

## 5. Review execution uses the ordinary workforce

A Review is executed like any other work:

```
Review Task → Assignment → Employee → WorkerRun → WorkPacket → submitReview
```

A Reviewer is not a special process, and Review is not a second runtime. The
Review Task is created (unassigned), assigned with `assignTask`, started with
`startWorkerRun`, and completed with `submitReview` — the same commands every
other Task uses, with the same generation fencing, one active run per Task and
bounded WorkPacket rules from v0B0/v0B1.

The **review Work Packet** (`packetVersion 2`) contains, in addition to the
v0B1 packet:

```
review: {
  reviewRequestId,
  sourceTask: { id, title, intent, generation },
  targetArtifact: { id, kind, title, content, contentDigest, generation, createdAt },
  reviewTask: { id, title, intent },
  requiredCapabilities
}
```

It contains **no** database dump, **no** event log, **no** other Work, and no
prompt text. The reviewer knows exactly which Artifact it is judging.

## 6. Submitting a review

`submitReview({ reviewTaskId, generation, verdict, summary, findings })` refuses
unless all of these hold — each is a separate test:

- the Task exists, is a Review Task, is `RUNNING`, and the generation is current,
- the Task has an active WorkerRun whose `generation` matches,
- the assignment's Employee is the Employee of that run,
- the Task's `review_requests` row exists (the Task was created *by* a request),
- the target Artifact still exists with the **same digest** as at request time
  (`REVIEW_TARGET_MISMATCH` otherwise),
- company and work agree across request, Artifact and Task.

Then, in **one transaction**: insert the immutable Review, complete the
WorkerRun, complete the Review Task, write `REVIEW_SUBMITTED` and
`REVIEW_PASSED` / `REVISION_REQUESTED`. A failure cannot leave a Review without
its completion, or a completed Review Task without its Review.

## 7. Verdict semantics

### PASS

PASS means exactly one thing:

> this reviewer judges that **this Artifact, at this digest**, satisfies the
> review contract it was asked to apply.

PASS does **not** mean Founder ACCEPT, knowledge admission, or any external
action. Nothing else is written: no acceptance record, no memory write, no
notification. If every review obligation on a Work is satisfied and no Task is
open, the Work projection derives `READY_FOR_DECISION` — a *derived* fact that
exists purely so v0B3 can build Founder attention on it. There is no
`ACCEPTED` anywhere in this milestone.

### REQUEST_REVISION

REQUEST_REVISION means: this Artifact cannot stand as the passing result of this
review cycle. The Review keeps `summary` and a non-empty `findings` list —
`FINDINGS_REQUIRED` if it is empty, because "please fix it" without a reason is
not a review.

Afterwards the Runtime allows exactly one thing: `createRepairTask({ reviewId })`.
It never modifies the source Task, never reopens it, never overwrites the
Artifact.

## 8. Repair

### RepairBinding (immutable lineage)

```
RepairBinding { repairTaskId (unique), reviewId (unique), sourceTaskId,
                targetArtifactId, targetArtifactDigest, createdAt }
```

`createRepairTask({ reviewId })` refuses unless the Review exists and its verdict
is `REQUEST_REVISION` (`REVISION_NOT_REQUESTED`). It is **idempotent**: one
Repair Task per Review, and a second call returns the existing one.

### Repair Task

A Repair is an **ordinary Task** with the v0A lifecycle. No `REPAIR_PENDING`, no
`REPAIR_RUNNING` — the second state machine this milestone explicitly refuses.

Its requirements are copied from the source Task at creation
(`requiredCapabilities` **and** `reviewCapabilities`): the repair must satisfy
the same capability requirement as the original work, and — because the repair
exists to answer a review — its output must be reviewed again. That is the
default the contract freezes; a caller may still change requirements afterwards
with `setTaskRequirements` while the Repair Task is not `RUNNING`.

### Repair assignment (deterministic, no allocation)

v0B2 performs no dynamic allocation. `createRepairTask` applies one deterministic
policy: assign the Repair Task to the Employee who produced the Artifact under
review (`assignmentReason: "original_producer"`) **if and only if** that Employee
exists, is enabled, belongs to the same company, and its position still
satisfies the Repair Task's required capabilities.

Otherwise the Repair Task stays **unassigned**. It does not pick another
employee, and it does not ask the Founder: escalation is v0B3.

(An Artifact with no producing run cannot nominate anybody. That branch is
defensive and currently unreachable, because review handoff requires a run; it
exists so a later path cannot quietly assign the wrong Employee.)

### Repair Work Packet

The repair Work Packet adds:

```
repair: {
  repairBindingId, reviewId, reviewVerdict, reviewSummary, reviewFindings,
  sourceTask: { id, title, intent },
  targetArtifact: { id, kind, title, contentDigest, generation },
  supersedesArtifactId
}
```

The Employee therefore knows *which* output it is correcting, *why*, and *what
the corrected output must replace*. "Please revise per the feedback" is not a
binding.

## 9. Artifact supersession

`artifacts.supersedes_artifact_id` (nullable) is the only mechanism by which one
Artifact replaces another. Artifacts remain immutable: supersession is a pointer
on the **new** row, never a write to the old one.

| Producing Task | `supersedes_artifact_id` |
| --- | --- |
| ordinary Task, no repair binding | must be `NULL` (`SUPERSEDES_NOT_ALLOWED` if set) |
| Task with a RepairBinding | **required** — must equal the binding's `targetArtifactId` (`SUPERSEDES_REQUIRED`) |

Refusals: a missing Artifact (`SUPERSEDES_NOT_FOUND`), an Artifact in another
company or Work, or an Artifact other than the one the binding names
(`SUPERSEDES_OUT_OF_SCOPE`). Self-supersession needs no guard: the replacing
Artifact does not exist yet when supersession is validated. Recording a
superseding Artifact writes `ARTIFACT_SUPERSEDED`.

"The latest Artifact" is a **projection** over the supersession chain. The old
Artifact keeps its content, digest, producer run and creation time forever.

## 10. Multiple cycles

The chain is unbounded by design — no `repairCount = 1`, no arbitrary loop
limit, no budget (that is a later milestone):

```
Artifact v1 → Review #1 REQUEST_REVISION → Repair #1 → Artifact v2 (supersedes v1)
            → Review #2 REQUEST_REVISION → Repair #2 → Artifact v3 (supersedes v2)
            → Review #3 PASS → READY_FOR_DECISION
```

Each Review Task is bound to one exact Artifact + digest, so each cycle reviews
the newest result rather than a drifting pointer. The **cycle number** is
derived by counting prior repairs in the chain; no counter is persisted, so no
counter can drift.

## 11. Cancellation and recovery

- **Cancel a Review Task** (`cancelTask`): the active reviewer WorkerRun becomes
  `CANCELLED` and **no Review is written**. The ReviewRequest stays — the
  obligation is real — and the Work projection reports that no legal PASS
  exists.
- **Cancel a Repair Task**: the binding, the Review and its findings, and the
  target Artifact all survive untouched.
- **Crash during review execution** (SIGKILL): on restart the Review Task is
  `INTERRUPTED`, its WorkerRun is `INTERRUPTED`, the generation is fenced and no
  Review exists. The review must be started again explicitly.
- **Crash during repair**: the Repair Task and its WorkerRun are `INTERRUPTED`,
  and the RepairBinding, the Review findings and the target Artifact survive. A
  restarted repair produces a **new generation and a new WorkerRun**, and its
  Artifact must supersede the **same** target Artifact.

## 12. Work collaboration projection

`workProjection(id)` gains a derived collaboration view over Task + Review
truth. **Nothing here is stored.**

| `status` | Meaning |
| --- | --- |
| `NEEDS_ATTENTION` | at least one Task is `INTERRUPTED` (a crash happened; a human must restart it) |
| `ACTIVE` | at least one Task is `RUNNING` — something is being worked on right now |
| `OPEN` | nothing is running, but queued Tasks exist (a Task to start, a review to start, a repair to pick up) |
| `READY_FOR_DECISION` | no Task is open or interrupted, and every review obligation is satisfied by a PASS |
| `BLOCKED` | nothing is in flight and an obligation is unmet for good (e.g. the Review Task was cancelled) |
| `CANCELLED` | every Task is `CANCELLED` and no review obligation exists |

`COMPLETED` is **retired** from the Work vocabulary: it claimed the Work was
finished, which under this contract is a Founder decision. The honest end state
is `READY_FOR_DECISION` — the ball is with the Founder, and nothing has been
accepted.

`stage` names the collaboration moment, first match wins:

```
NOT_STARTED     → no Tasks at all
NEEDS_ATTENTION → INTERRUPTED
REPAIRING       → an open Task with a RepairBinding
REVISION_REQUESTED → a REQUEST_REVISION Review whose Repair Task does not exist yet
REVIEWING       → a Review Task with a running attempt (a reviewer is working now)
AWAITING_REVIEW → a ReviewRequest with no Review recorded and no reviewer running
EXECUTING       → an open Task
READY_FOR_DECISION → every Task terminal, every obligation satisfied by PASS
CANCELLED       → every Task is CANCELLED
BLOCKED         → otherwise (nothing running, obligation unmet)
```

The projection also returns `latestArtifact`, `latestReview`, `openReviewTask`,
`openRepairTask`, and the `review`/`repair` history (reviews with their
findings, repair bindings, supersession links), so a Founder surface can read
one story in one place. These are projection language, **not** Task states and
**not** stored columns.

## 13. Activity vocabulary

v0B2 additions, all generic:

```
REVIEW_REQUESTED     artifact handed off; review task created
REVIEW_SUBMITTED     immutable review written
REVIEW_PASSED        verdict PASS
REVISION_REQUESTED   verdict REQUEST_REVISION
REPAIR_TASK_CREATED  repair task + binding created (with assignment outcome)
ARTIFACT_SUPERSEDED  a new artifact replaced an older one
```

Existing kinds (`TASK_ASSIGNED`, `WORKER_RUN_STARTED`, `ARTIFACT_HANDED_OFF`,
`WORKER_RUN_COMPLETED`, …, and the v0A lowercase kinds) are unchanged.

**Naming audit (technical debt, not fixed here):** the activity vocabulary mixes
`UPPER_SNAKE` kinds (v0B1/v0B2 domain events) with `lower.dot.case` kinds (v0A
lifecycle events). Both are readable and both stay. Rewriting history to unify
them would be a data migration with no behavioural gain; the mixed vocabulary is
recorded here as debt, and new kinds follow `UPPER_SNAKE`.

## 14. Storage: schema v2 → v3

New tables: `reviews`, `review_requests`, `repair_bindings`.
New column: `artifacts.supersedes_artifact_id`, `task_requirements.review_capabilities`.
New triggers: `reviews_no_update`, `reviews_no_delete`,
`review_requests_no_update/delete`, `repair_bindings_no_update/delete`.

`SCHEMA_VERSION = 3`. The migration runs **stepwise** (`v1 → v2 → v3`,
`v2 → v3`, fresh `v1 → v2 → v3`), each step in its own transaction, and never
deletes, reseeds or recreates anything. Old facts — including v0A Artifacts —
keep their values; a pre-v0B2 Artifact has `supersedes_artifact_id = NULL`. An
unknown future version still fails loudly with `INCOMPATIBLE_SCHEMA_VERSION`.

## 15. Authority boundary

This milestone has no Founder authority anywhere: no Inbox, no ACCEPT, no
escalation, no knowledge admission, no Hiring, no providers, no model calls.
Reviewer PASS ≠ Founder ACCEPT. Work that is `READY_FOR_DECISION` is waiting,
and saying so is the whole point of the projection.

# Contract — Worker Harness v0 (Slice 1.1: Production Harness Foundation)

**Status: Slice 1.1 implemented. The real `CodexExecAdapter` is deliberately NOT
part of this slice.** This contract freezes the execution layer around the
already-frozen Runtime seams: a `WorkerAdapter` interface, the WorkerRun input
envelope, the role-specific `ResultContract`, the WorkerResult /
WorkerReviewResult / HarnessEvidence split, the normalized WorkerEvent
vocabulary, the durable `WorkerExecutionBinding`, run-scoped workspace
isolation, the `WorkerBackendResolver`, the production `WorkerHost` with both
delivery seams (artifact delivery and Reviewer judgment), its command allowlist,
and the bounded autonomous retry budget — implemented against a deterministic
test backend so the Harness architecture is proven independently of Codex CLI
behavior.

Depends on: [Persistent Work Kernel v0A](persistent-work-kernel-v0.md) ·
[Workforce Identity & Assignment v0B1](workforce-identity-assignment-v0.md) ·
[Review / Repair Collaboration v0B2](review-repair-collaboration-v0.md) ·
[Founder Attention & Acceptance v0B3](founder-attention-acceptance-v0.md) ·
[Work Continuity v0B4](work-continuity-v0.md) ·
[Worker Execution Seam v0 (H0.1 + H0.2)](worker-execution-seam-v0.md).

Founder = Authority. Work = Continuity. Runtime = Control. AI Employee = Think +
Act. **The WorkerHost executes; it never coordinates and never decides.**

## 1. The one boundary this contract protects

v0B4 owns coordination: assignment, `startWorkerRun`, review dispatch, repair
dispatch. The WorkerHost owns exactly one thing:

> execution of a WorkerRun that the Runtime has already started.

The Host must never assign an Employee, start a WorkerRun, cancel a Task, create
a Review or Repair, or record a Founder Decision. It holds no Work/Task/Review/
Founder state; it re-reads WorkerRun truth before acting and reports what
happened.

Deliberately out of scope for v0: no resume, no fork, no steer, no session
management, no fallback, no backend ranking, no `CodexExecAdapter`, no Laya /
SemanticSensor, no container isolation, no persistent Worker queue, no event
bus, no polling loop, no Task `BLOCKED` state, no WorkerRun `FAILED` state.

## 2. WorkerAdapter v0

```
manifest()                    -> { adapterType, adapterVersion, containment }
start(input, context)         -> handle
events(handle)                -> async iterable of WorkerEvent
wait(handle, { timeoutMs })   -> WorkerAdapterResult
cancel(handle, reason)        -> void            (idempotent)
```

```
WorkerAdapterResult {
  terminalStatus: SUCCEEDED | FAILED | CANCELLED,
  failureReason?,          // FAILED only: the one failure the adapter certifies
  reason?,                 // CANCELLED only
  rawResultDigest?,        // the adapter's digest of its raw payload, if any
  resultCandidate?,        // the adapter's provider-specific extraction
  adapterMeta?             // a small, bounded, non-authoritative note
}
```

- `terminalStatus` is `SUCCEEDED | FAILED | CANCELLED`; a `FAILED` result must
  name a bounded `failureReason` (`PROCESS_EXIT` is the mapped one). Anything
  else the Host receives is treated as an adapter protocol problem (§17).
- `resultCandidate` is an **extraction**, not a decision: the adapter owns
  provider-specific parsing, and the Host validates the candidate against the
  role-specific contract before anything reaches the Runtime (§16, §17).
- `cancel` must be idempotent: a second cancel is a no-op, and cancelling an
  already-finished execution is legal.
- `manifest().containment` is the adapter's honest self-description of what the
  backend **actually enforces** (`sandboxMode`, `knownLimitations`). It is never
  a wish.
- An adapter has **zero Runtime authority**: it cannot assign, start, complete,
  review, repair, accept or write knowledge. It reports; the Runtime decides.
- The Host enforces the wall-clock budget itself; `timeoutMs` is a hint to the
  adapter, never a guarantee the Host relies on.

`context` provides `{ binding, workspaceRoot, scratchRoot,
effectiveExecutionPolicy }`. The adapter may write inside `workspaceRoot` and
`scratchRoot` only.

## 3. WorkerRunInput

```
WorkerRunInput = durable WorkPacket + execution envelope
```

```
{
  schemaVersion,
  workerRunId, generation,
  workPacketDigest, workPacket,        // the durable grant, verbatim
  executionBinding,                    // WorkerExecutionBinding
  executionPolicy: { requested, effective },
  resultContract                     // ARTIFACT_DELIVERY | REVIEW_JUDGMENT (§16)
}
```

The packet is the one the WorkerRun stored; the envelope adds only execution
facts the packet does not own. No WorkPacket field is duplicated: the Host must
not re-derive Company, Work, Task, Requirements, Assignment, Employee, Position,
Review or Repair context.

## 4. Requested policy vs effective containment

```
executionPolicy.requested = what the product asks for
executionPolicy.effective = what this attempt actually gets
```

**Requested restriction is not proven containment.** The contract requires the
two to be separate facts, and the effective side must state known limitations
honestly. For the deterministic test backend: `sandboxMode: "none"` with explicit
limitations. No code may present `requested.network = false` as evidence that
the network was actually blocked.

## 5. WorkerResult and HarnessEvidence stay separate

```
WorkerResult     = what the Worker reports about its own attempt
HarnessEvidence  = what the Host observed about the execution
```

- `WorkerResult`: `outcome`, `summary`, `completionClaim?`,
  `reportedVerification?`, `blockers`, `proposedArtifacts`, `suggestedNextActions`.
  Strict parsing: an unknown field, an unknown outcome or an unbounded value is
  **not** a WorkerResult.
- `HarnessEvidence`: `processOutcome`, observed event count/kinds,
  `resultParse`, `verification` (status + summary), containment observations,
  `observedAt`, `evidenceDigest`. It is produced by the Host and stays Host-side.

They are never merged into one verification array. **Neither equals approval.**
A parsed SUCCEEDED result is a delivery, not an acceptance; a Host observation is
not a verdict.

## 6. WorkerEvent

Frozen vocabulary — the only event names the domain knows:

```
RUN_STARTED · TOOL_FINISHED · RESULT_READY · RUN_FAILED · PROGRESS (optional)
```

Adapter-specific event names (tool calls, message deltas, provider traces) stay
inside the adapter. No chain-of-thought is persisted; no raw event stream is
persisted. **WorkerEvent remains observability only**: nothing is decided from an
event, and a broken event stream does not change what a validated result means.

## 7. WorkerExecutionBinding — the one new durable execution object

```
WorkerExecutionBinding {
  id,
  companyId, workId, taskId, workerRunId, generation,
  backendType, backendVersion, executionProfileDigest,
  workspaceRoot, scratchRoot,
  baseRevision?, branch?,
  externalExecutionRef?, externalSessionRef?,
  createdAt
}
```

- Cardinality is **1 WorkerRun : 1 WorkerExecutionBinding**, enforced by a UNIQUE
  constraint and by an immutability trigger.
- It does **not** duplicate WorkerRun state, `endedAt` or `endReason`: those stay
  WorkerRun truth.
- Lineage (`companyId`/`workId`/`taskId`) is **derived by the Runtime** from the
  WorkerRun, never accepted from the Host.
- The binding command validates: the WorkerRun exists, the generation matches
  exactly, the attempt is still `RUNNING` for a first write, and no binding
  exists yet.
- Retry semantics: an exact retry returns the committed binding
  (`idempotent: true`); a different backend, version, profile or workspace for
  the same attempt is `EXECUTION_BINDING_CONFLICT`. An attempt is never rebound.
- The persisted `executionProfileDigest` covers backend type/version and the
  effective containment facts under which the attempt ran.

No persistent `EmployeeWorkerBinding` exists, and this contract does not add one.

## 8. WorkspaceLease semantics — fields, not a table

The lease is not a second object; it is WorkerRun truth read a certain way:

> One mutable execution workspace belongs to exactly one WorkerRun + generation.

```
<runtimeRoot>/workspaces/<workId>/runs/<workerRunId>-g<generation>/
  workspace/    the mutable run workspace the adapter may write
  scratch/      host-provided scratch, never part of the deliverable
```

```
RUNNING     → ACTIVE
COMPLETED   → RELEASED
CANCELLED   → RELEASED
INTERRUPTED → INVALIDATED
```

Lease state is **derived, never stored**. A new WorkerRun/generation always gets
a new `workspaceRoot` and a new `scratchRoot`; an old mutable run directory is
never reused.

## 9. Orphan safety

Correctness must not depend on successfully killing an orphan process. If the
Runtime or Host crashes while a Worker survives:

```
old WorkerRun  → startup recovery → INTERRUPTED
old workspace  → invalidated by run truth
new WorkerRun  → new workspace
```

The old orphan may keep writing its old workspace; the new generation never
reads or reuses it. **Generation fencing plus workspace isolation are the
correctness mechanisms; PID cleanup is best-effort only.**

## 10. WorkerBackendResolver

```
resolve({ workerRun, task, employee, position, company }) -> { backendType, backendVersion, baseRevision?, externalSessionRef? } | null
```

v0 ships a static resolver that deterministically maps every eligible Employee
to `backendType = "test-worker"`. No persistent WorkerBackend registry, no
ranking, no fallback, no capability matching. The resolver is a replaceable
seam: a different object with the same one method changes no Runtime code.
Returning `null` defers the attempt (the Host writes nothing).

## 11. WorkerHost orchestration

```
WorkerRun becomes RUNNING
→ resolve backend
→ allocate run-scoped workspace
→ persist WorkerExecutionBinding
→ adapter.start
→ consume normalized events
→ wait with the Host's own timeout
→ collect HarnessEvidence
→ validate the candidate against the packet's resultContract
→ submitWorkerResult        (ARTIFACT_DELIVERY)
  or submitWorkerReviewResult (REVIEW_JUDGMENT)
```

Failure mapping:

```
timeout             → adapter.cancel → interruptWorkerRun(WORKER_TIMEOUT)
process exit        → interruptWorkerRun(WORKER_PROCESS_EXIT)
invalid adapter result → interruptWorkerRun(WORKER_PROTOCOL_ERROR)
invalid candidate      → interruptWorkerRun(WORKER_PROTOCOL_ERROR)
host crash             → existing startup recovery (the attempt stays RUNNING)
```

A validated `FAILED` WorkerResult (the attempt ended without a deliverable
output) maps to `WORKER_PROCESS_EXIT` in v0 — the interruption vocabulary has no
dedicated worker-reported-failure reason yet (see §16). The Host never retries a
delivery by itself: a delivered attempt is terminal, and a refused delivery is a
reported fact, not a second attempt.

The Host does not own Work/Task/Review/Founder state and never invokes the
Continuation Driver inside its own execution path.

## 12. WorkerHost command allowlist

The Host may mutate the Runtime through exactly:

```
bindWorkerExecution        (persist the immutable execution binding)
submitWorkerResult         (terminal successful artifact delivery)
submitWorkerReviewResult   (terminal successful Reviewer judgment)
interruptWorkerRun         (execution failure report)
```

It must NOT call `recordArtifact`, `completeWorkerRun`, `requestReview`,
`submitReview`, `createRepairTask`, `acceptWork`, `createTask`, `assignTask`,
`cancelTask`, `startWorkerRun`, `setTaskRequirements`, `checkpointTask`,
`completeTask`, or any other command. The Reviewer seam is the fourth allowed
command precisely because `submitReview` stays forbidden: the Host reports a
judgment, and the Runtime writes the Review. It must not rebuild coordination logic.
This is enforced by test: the Host is exercised through a restricted facade in
which every forbidden command throws.

## 13. Observation seam

The Host learns that a WorkerRun entered `RUNNING` through a post-commit
observer on the Kernel — the same shape as the v0B4 continuation seam:

- published **only after COMMIT**; a rolled-back command publishes nothing;
- duplicate notification is safe (the Host re-reads truth; an attempt already
  being executed is not executed twice);
- a missed notification is healed by **reconciliation** against committed
  WorkerRun truth (e.g. `workerRuns({ state: "RUNNING" })` at startup);
- there is no polling loop, no event bus and no persisted Worker queue;
- recovery still interrupts stale RUNNING attempts — the Host adds no competing
  resume mechanism.

An observer failure is an observability failure, never a reason to fail the
committed command.

## 14. Delivery is not approval

All invariants remain true:

```
WorkerResult SUCCEEDED != Task accepted
Agent COMPLETE       != Accepted
Reviewer PASS        != Founder ACCEPT
Founder ACCEPT       != Knowledge Admission
```

A review-required Task still receives its Review through the Runtime-derived
handoff inside `submitWorkerResult` (H0.2 §2.1); the Host cannot bypass or fake
it. After a delivery, a Work at the decision boundary waits for the Founder —
the Host has no path to `acceptWork`.

## 15. The Reviewer delivery seam — `submitWorkerReviewResult`

A Review Task's attempt is delivered through a Reviewer seam of its own. The
command is conceptually:

```
submitWorkerReviewResult({
  workerRunId, generation,
  resultDigest, evidenceDigest,
  verdict,          // PASS | REQUEST_REVISION — the existing frozen vocabulary
  findings,
  summary,
  verificationSummary?
})
```

```
WorkerReviewResult {
  schemaVersion, workerRunId, generation,
  verdict: PASS | REQUEST_REVISION,
  findings[],
  summary?
}
```

- It is a **Worker judgment**: not Founder approval, not an acceptance, and not
  a Review. The Runtime writes the Review through its one Review primitive
  (`submitReview`); this seam adds no second Review implementation, no score and
  no severity.
- `summary` is optional on the wire, but a judgment delivered to this Runtime
  must carry a bounded one, because the frozen Review primitive requires it and
  the Harness never invents Review text. A candidate without one is a protocol
  error (§17).
- The Host may **not** submit `reviewTaskId`, `sourceTaskId`, `targetArtifactId`,
  `targetArtifactDigest`, `reviewerEmployeeId`, `reviewRequestId`, a repair
  decision or a Founder decision; those extra fields are refused, never ignored.

**Lineage is derived inside the Runtime**, from the WorkerRun alone:

```
WorkerRun → its Task → ReviewRequest → exact target Artifact + digest
```

Validation, in order: the WorkerRun exists · the generation is exact · the
attempt is current and `RUNNING` · the Task is a Review Task · an exact
ReviewRequest exists · the current Assignment names the run's Employee · the
reviewer is not the Artifact's producer (fails closed when the producer cannot
be established) · the target Artifact still matches the recorded digest · the
verdict is `PASS | REQUEST_REVISION` · findings obey the existing Review bounds
(and a `REQUEST_REVISION` must carry at least one).

**Atomicity.** One transaction writes: the immutable Review, the Reviewer
WorkerRun's end (`REVIEW_COMPLETED`), the Review Task's completion, the existing
Review Activity (`REVIEW_SUBMITTED` plus `REVIEW_PASSED` / `REVISION_REQUESTED`,
`task.completed`) and the bounded submission receipt. Any failure rolls all of
it back. `REQUEST_REVISION` does **not** create a Repair inside this transaction:
the existing v0B4 continuation policy owns repair creation, exactly as before.

**Idempotency.** Submission identity is `workerRunId + generation +
resultDigest`, carried by an append-only Activity receipt
(`WORKER_REVIEW_RESULT_SUBMITTED`). An identical replay — including one after a
lost response or a restart — converges on the committed Review
(`idempotent: true`, no duplicate Review, Activity, Task transition or receipt).
The same attempt with a different `resultDigest` is
`WORKER_REVIEW_RESULT_CONFLICT` (409): a recorded judgment is never rewritten.

**Bounded metadata only.** The receipt carries exactly `workerRunId`,
`generation`, `reviewId`, `resultDigest`, `evidenceDigest` and the optional
`verificationSummary`. No logs, no raw Worker events, no chain-of-thought, no
prompt text and no unbounded result text are persisted anywhere.

## 16. ResultContract is role-specific

```
resultContract.kind = ARTIFACT_DELIVERY | REVIEW_JUDGMENT
```

- ordinary execution and Repair Tasks → `ARTIFACT_DELIVERY` (exactly one
  proposed output);
- Review Tasks → `REVIEW_JUDGMENT` (verdict + findings against the Artifact the
  WorkPacket names).

The contract is decided by the Runtime and carried by the durable WorkPacket
(`workPacket.review`), which the Host reads: neither the Host, the adapter nor
the Worker names its own contract kind. An adapter never decides what its own
result means.

## 17. Adapter parsing boundary

> Provider-specific result extraction belongs to WorkerAdapter.
> Provider-neutral schema validation belongs to WorkerHost.

The adapter may extract a candidate from whatever its provider produces (for a
future `CodexExecAdapter`: raw final message → strict JSON → allowed fenced JSON
→ candidate object). The Host then validates the candidate against the expected
`resultContract` and the declared schema, and derives the submission from it.

An invalid candidate — unparseable, wrong shape, wrong contract, unknown field,
unbounded value, wrong run/generation, or a judgment without a summary — is
`interruptWorkerRun(WORKER_PROTOCOL_ERROR)`. **No malformed result ever becomes
Runtime truth**, and the Host never repairs, guesses or fabricates one.

## 18. Bounded autonomous retries

```
MAX_AUTONOMOUS_ATTEMPTS_PER_TASK = 3      // 1 initial attempt + at most 2 retries
```

- The count is **derived from durable WorkerRun history** for the Task — there is
  no `task.retryCount`, no retry state, no Task state and no reason-specific
  budget. Every attempt this Task ever made is a row that survives a restart, so
  the budget survives one too.
- Every WorkerRun belonging to the Task counts, regardless of interruption
  reason. A COMPLETED Task is terminal, so the budget no longer matters.
- Fewer than 3 attempts and the Task `INTERRUPTED`: the ordinary deterministic
  continuation may re-dispatch (resume the usable Assignment, or hand the Task
  to the one Employee who can take it).
- 3 attempts and the Task still `INTERRUPTED`: the automatic Continuation Driver
  **stops** with reason `AUTO_RETRY_EXHAUSTED`. This is deterministic hard policy
  — no model, no sensor, no trace reading, and no fourth automatic attempt.
- An explicit Founder attempt (the ordinary commands) is still legal after
  exhaustion and does **not** reset the history: if it also dies, the Driver
  observes the same durable count and stops again.

## 19. Founder Attention after an exhausted budget

Exhaustion adds no Task state: the Task remains `INTERRUPTED`, and the condition
is derived from current Runtime truth.

- The Driver stops; the Work projection carries the `AUTO_RETRY_EXHAUSTED`
  diagnostic, and the Founder Attention item — when one is emitted — lists it
  among its `conditions`.
- `EXECUTION_INTERRUPTED` is emitted with whichever existing actions current
  truth supports: `RESUME_EXECUTION` (the Assignment is valid and dispatchable —
  the item then carries `RESOLVES`), `ASSIGN_EMPLOYEE` (after exhaustion this
  only `ADVANCES`: assigning no longer starts the Task by itself),
  `ENABLE_EMPLOYEE`, and `ABANDON_TASK` for execution Tasks only.
- No legal Founder action left (for example, only a busy or absent Employee)?
  Diagnostic only, exactly as the existing attention policy requires.
- Exhaustion is never read from a Continuation Trace: it is derived from
  WorkerRun history, the same rows the Driver counts.

## 20. Deliberately not implemented / known limitations

Recorded as facts, not promises:

1. **No independent verification.** HarnessEvidence reports the Worker's own
   verification statement (`status: "REPORTED"`); the Host performs no
   independent verification in this slice.
2. **No workspace provisioning.** The Host allocates run-scoped directories;
   checking out a base revision into them is a backend concern that arrives with
   the real adapter. `baseRevision` is recorded when a resolver provides one, and
   is `null` in this slice.
3. **Worker-reported FAILED maps to `WORKER_PROCESS_EXIT`**; a dedicated
   interruption reason may be warranted later.
4. **No CodexExecAdapter, no Laya, no external test verification, no production
   git workspace checkout, no WorkerBackend registry, no EmployeeWorkerBinding,
   no WAIT/timers, no heartbeat/lease expiry, no distributed WorkerHost, no
   app-server and no resume.** The Harness is proven against the deterministic
   test backend only.
5. **The full production Harness is not frozen yet** (adapters, host process
   topology, isolation). Only the facts exercised by Slices 1 and 1.1 are frozen
   here.

## 21. Schema v5 → v6

`worker_execution_bindings` is the only schema addition. The migration is
additive, transactional and has no backfill: old WorkerRuns have no binding, old
stores remain valid, and no historical execution provenance is invented for
attempts that never had one.

Slice 1.1 adds no schema at all: the Reviewer receipt is a row in the existing
append-only Activity stream (`WORKER_REVIEW_RESULT_SUBMITTED`), and the retry
budget is derived from the existing `worker_runs` history.

## 22. The deterministic test backend

`test-worker` is not intelligence and not a model. It is a deterministic
asynchronous executor that proves the seams: it emits only the frozen
WorkerEvent vocabulary, writes and reads back a real run-scoped workspace file,
and returns a valid candidate for the contract it was granted.

Behaviors: `complete` · `hang` · `exit` · `invalid-result` · `no-result` ·
`no-artifact` · `request-revision` (a Review Task returns a `PASS` judgment, or a
`REQUEST_REVISION` judgment, instead of an artifact).

## 23. Verification and demos

`node scripts/check.mjs`, `node --test`,
`node scripts/demo-work-continuity-v0b4.mjs` and
`node scripts/demo-worker-harness-v0.mjs` must all pass. The demo runs four
scenarios on the real Runtime seams: executed → reviewed (PASS) → Founder ACCEPT
with `Founder Extra Touch = 0`, `Manual Coordination = 0`, `Reviews = 1` and
`Founder Decisions before ACCEPT = 0`; a `REQUEST_REVISION` → Repair → PASS
cycle; a timed-out attempt re-dispatched into a fresh workspace; and a Work whose
attempts always die, where the Runtime stops after its budget and asks the
Founder.

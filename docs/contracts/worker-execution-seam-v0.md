# Contract note — Worker Execution Seam v0 (H0.1 + H0.2)

**Status: the Runtime seams are implemented; the Worker Harness architecture is NOT.**
This note covers exactly three things:

1. the frozen semantics of the `interruptWorkerRun` Runtime command (H0.1) —
   how an attempt that cannot continue is reported;
2. the frozen semantics of the `submitWorkerResult` Runtime command (H0.2) —
   how a successful attempt is delivered, exactly once, atomically;
3. the H0 experiment findings that constrain any future WorkerAdapter — recorded
   here as contract, deliberately not implemented.

Depends on: [Persistent Work Kernel v0A](persistent-work-kernel-v0.md) ·
[Workforce Identity & Assignment v0B1](workforce-identity-assignment-v0.md) ·
[Work Continuity v0B4](work-continuity-v0.md).

## 1. `interruptWorkerRun` — the Worker host's execution report

```
interruptWorkerRun({ workerRunId, generation, reason })
```

The Worker host reports that the **current execution attempt can no longer
continue**. It is an execution fact, not a judgment: it cannot accept Work,
cancel anything, create a Review or Repair, write a Founder Decision or change
permissions. It records one fact and stops.

### Frozen reason vocabulary (v0)

```
WORKER_TIMEOUT · WORKER_PROCESS_EXIT · WORKER_PROTOCOL_ERROR
```

Any other reason is `INVALID_INPUT`. The vocabulary describes execution
failure; it is never Founder cancellation, Task abandonment, Worker success or
a Review verdict. Startup recovery keeps its own reason
(`PROCESS_INTERRUPTED`), because a crash is a different fact from a reported
timeout.

### Successful interruption — required preconditions

- the WorkerRun exists (`WORKER_RUN_NOT_FOUND`);
- it is currently `RUNNING` (`INVALID_TRANSITION`);
- the supplied `generation` matches the run (`STALE_GENERATION`);
- the run is still the active attempt of its Task (`INVALID_TRANSITION`);
- the Task is `RUNNING` (`INVALID_TRANSITION`);
- the Task generation still matches the attempt (`STALE_GENERATION`).

Then, atomically, through the **same private primitive startup recovery uses**:

```
WorkerRun RUNNING → INTERRUPTED   (endReason = the supplied reason)
Task      RUNNING → INTERRUPTED   (generation + 1 — the existing fence)
Activity  → task.interrupted + WORKER_RUN_INTERRUPTED, recovery-identical shape
```

There is exactly **one interruption semantics**: recovery and the command
produce the same states, the same generation fence and the same Activity facts.
Only `reason` differs, by cause.

### Retry safety

Re-interrupting the **same attempt** (same run, same generation) that is already
`INTERRUPTED` is benign: it returns `interrupted: false, alreadyInterrupted: true`
and writes nothing — no duplicate Activity, no second fence. A wrong generation
is still refused.

### Terminal safety

A `COMPLETED` or `CANCELLED` run is never overwritten (`INVALID_TRANSITION`).
Late writes from the interrupted generation are rejected by the existing
generation fence: Artifact, Checkpoint and completion all fail with
`STALE_GENERATION`.

### Continuation interaction

`interruptWorkerRun` commits interruption truth and then the ordinary v0B4
post-commit seam wakes the Work. What follows is the existing
interrupted-execution policy, not this command: if the Assignment is still
deterministically usable, the Driver may start a new attempt (new generation);
otherwise the Work stops on its existing boundary/diagnostic. The Kernel never
restarts anything inside the interruption transaction, and no WorkerAdapter or
process management lives in the Runtime.

## 2. `submitWorkerResult` — the terminal successful delivery seam (H0.2)

```
submitWorkerResult({
  workerRunId, generation,
  resultDigest, evidenceDigest,
  artifact: { kind, title, content, supersedesArtifactId? },
  verificationSummary?,
})
```

This is the **production Worker host's delivery seam**, and the only one it may
use. It is terminal: intermediate durable progress still travels through
`checkpointTask`, and there is deliberately no "partial delivery" mode.

### 2.1 Runtime-derived handoff

The caller never chooses what happens next. The Runtime reads
`TaskRequirements` and decides inside the transaction:

```
reviewCapabilities.length > 0
  → record Artifact + end WorkerRun COMPLETED + complete source Task
    + create Review Task + write its requirements
    + create ReviewRequest bound to the exact Artifact and digest

reviewCapabilities.length == 0
  → record Artifact + end WorkerRun COMPLETED + complete source Task
```

`handoff`, `reviewRequired`, `completeTask`, `reviewVerdict`, `founderDecision`
and `employeeId` are refused with `INVALID_INPUT`: a host cannot bypass a
required Review by asking for a different delivery. The existing low-level
commands (`recordArtifact`, `completeWorkerRun`, `requestReview`) remain as
historical primitives; new code composes the delivery through this seam.

### 2.2 One transaction

Every fact above commits together or not at all (`BEGIN IMMEDIATE → COMMIT`, any
failure rolls the whole delivery back). There is no committed state in which an
Artifact exists while its WorkerRun is still `RUNNING` — the window the H0 audit
found is unreachable through this command. Continuation is still decided after
COMMIT: the Driver is never invoked inside the delivery transaction.

### 2.3 Idempotency and the durable receipt

Result identity is `workerRunId + generation + resultDigest`.

- **First delivery** writes the whole transaction and appends one
  `WORKER_RESULT_SUBMITTED` Activity fact.
- **Identical replay** (the response was lost, the host restarted) returns the
  committed delivery with `idempotent: true` and writes nothing: no second
  Artifact, no second ReviewRequest, no second Task transition, no duplicate
  Activity.
- **Same attempt, different `resultDigest`** is refused with
  `WORKER_RESULT_CONFLICT`. A different result is a new attempt, never a rewrite
  of a delivered one.

The receipt is the Activity row itself (append-only, immutable, already part of
the store), carrying exactly:

```
workerRunId · generation · artifactId · resultDigest · evidenceDigest
verificationSummary?   (bounded, ≤ 2000 characters)
reviewRequired · reviewRequestId?
```

It is traceable from the WorkerRun and from the Artifact, and it is durable
across restarts. Full Harness evidence — logs, diffs, stdout, transcripts — is
**never** persisted: only its digest is. A malformed or unsuccessful attempt
never reaches this command; it goes through `interruptWorkerRun` instead.

### 2.4 The candidate generation rule

Historical evidence is not current outcome reality.

> An Artifact can be a current outcome candidate only if its producing Task is
> `COMPLETED`, the Artifact's generation **is** that Task's current generation,
> and nothing in the Work has superseded it.

Artifacts left behind by abandoned or interrupted generations stay readable and
immutable forever; they simply cannot become candidates later. Without this
rule, a crash between recording and delivery left an orphan Artifact that turned
into a **false** `OUTCOME_AMBIGUOUS`: `READY_FOR_DECISION` with more than one
candidate, no Inbox item and no legal exit — the Founder could not even accept.

## 3. H0 findings — recorded contract, not implemented

### 3.1 Execution containment (H0 fact)

The H0 experiment showed that the current Codex CLI sandbox mode
`workspace-write` **allowed the child Worker to write to the system `/tmp`**
(observed: a scratch file created outside the assigned workspace), while writes
to the fixture base checkout and to this repository were not observed.

Therefore:

> FlowCredit must not claim OS-level workspace-only write containment from the
> CLI sandbox alone.

Any future WorkerAdapter must carry, and make explicit:

```
workspaceRoot   — the only directory whose contents are the Work's product
scratchRoot     — a per-WorkerRun disposable scratch area
sandboxMode     — the adapter's actual isolation claim, not an assumption
```

Recommended Worker-host behavior (not implemented in H0/H0.1): set `TMPDIR`,
`TMP` and `TEMP` to the per-WorkerRun scratch directory, and treat
`workspaceRoot` + `scratchRoot` as the adapter's declared write surface rather
than assuming the CLI sandbox enforces it. Broader container/VM isolation is
explicitly out of scope; it would be a separate milestone.

### 3.2 Structured result (H0 fact)

`--output-schema` was **not sufficient** to guarantee a raw JSON final message
(H0 observed prose with an embedded JSON fence). Therefore:

- WorkerResult parsing must be **schema-validated**;
- **harness-observed evidence outranks Worker-reported verification** — the
  Worker's claim is a claim, never Runtime truth;
- an invalid final structured output is an execution failure relayed through
  `interruptWorkerRun(WORKER_PROTOCOL_ERROR)`, never corruption of Runtime
  truth.

No production parser is implemented here.

### 3.3 Attempt liveness (H0.1 fact)

Killing the Runtime process with `kill -9` (H0.1-H2) while a WorkerRun was
`RUNNING` proved two separate things:

- **Recovery covers it.** On restart against the same store, the open attempt
  was closed in one transaction — run `INTERRUPTED`, `PROCESS_INTERRUPTED`,
  task generation fenced, employee freed, Assignment preserved. No command was
  needed; the host never reported anything.
- **The Kernel does not own the Worker process.** The worker child stayed alive
  after the Runtime died, and nothing in the Kernel can stop it. The Runtime's
  record and the real process can therefore disagree: the record says
  `INTERRUPTED` while the process is still running and could still touch the
  workspace.

Therefore:

> A Worker host owns the Worker process. Killing, reaping and fencing it —
> including the case where the host itself died — is the host's problem, not
> the Kernel's. The Kernel only records execution facts it is given, plus the
> one fact it can establish by itself: *this process restarted, so any attempt
> it was hosting did not survive*.

The same restart also closes an attempt that the Continuation Driver started
but that no external host ever attached to (H0.1-H3). The Runtime cannot tell
"no host has attached yet" apart from "the host died before attaching": both
are `RUNNING` truth with no owner, and today only host death
(`PROCESS_INTERRUPTED`) can close them. Any future Worker host must therefore
declare its own attachment/liveness story; the Kernel deliberately has no
lease, heartbeat or scheduler.

## 4. Deliberately not implemented

WorkerAdapter package · WorkerBackend table · EmployeeWorkerBinding ·
CodexExecAdapter package · Laya · SemanticSensor · GitHub integration ·
WorkerResult persistence redesign · Codex resume · App Server · container
runtime · automatic Worker process management.

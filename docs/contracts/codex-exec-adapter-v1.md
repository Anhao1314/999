# Contract — CodexExecAdapter v1 (the first real production Worker backend)

**Status: implemented and H1/H1.1-verified (2026-09-22) against the local
`codex-cli 0.154.0-alpha.6.2`.**
**Open evidence gap:** the real-Codex review → REQUEST_REVISION → repair →
re-review chain has not yet been observed (§14); the Runtime protocol itself is
covered by deterministic tests. This contract covers the adapter itself: how a
committed WorkerRun becomes one real local `codex exec` child process, how that
process is contained, prompted, parsed and observed, and what it may never do.

Depends on: [Worker Harness v0](worker-harness-v0.md) ·
[Worker Execution Seam v0](worker-execution-seam-v0.md) ·
[Work Continuity v0B4](work-continuity-v0.md).

Founder = Authority. Work = Continuity. Runtime = Control. AI Employee = Think +
Act. **Codex is none of those. Codex is an intelligence resource the Harness
rents for one attempt.**

## 1. Worker Harness v0 vs CodexExecAdapter

```text
Worker Harness v0   provider-neutral, frozen: WorkerAdapter contract, WorkerHost,
                    ResultContract, HarnessEvidence, execution bindings,
                    run-scoped workspaces, bounded retries.

CodexExecAdapter    one implementation of that WorkerAdapter. It adds exactly
                    three backend concerns:
                      - Git workspace provisioning from a base repository,
                      - real `codex exec` process construction (argv, env, stdin),
                      - independent post-run evidence (git, protected paths,
                        verification) plus Codex-specific result parsing.
```

The Host does not know Codex exists. Nothing in this adapter may be required for
Runtime truth: an attempt's binding, its workspace, its evidence digest and its
interruption all remain Runtime facts that survive without the Codex thread, the
session id or the process.

## 2. Verified CLI facts (audited, not assumed)

- Binary: the user's installed Codex CLI (resolved from `PATH`); the audit
  recorded `codex-cli 0.154.0-alpha.6.2`.
- The adapter uses: `codex exec`, `--json` (JSONL on stdout), `--ephemeral`
  (no session reuse), `--color never`, `--cd <workspace>`,
  `--sandbox workspace-write`, `--output-schema <file>`,
  `--output-last-message <file>`, and `-` (prompt on stdin).
- The CLI has no native timeout; the Harness Host owns the timeout and cancels
  the child (`WORKER_TIMEOUT`).
- The CLI is used with the operator's own configuration and credentials; this
  adapter neither reads nor changes them. Model choice and provider are the
  operator's, never Employee identity.
- Observed JSONL includes `thread.started`, `turn.started`, `item.started` /
  `item.completed` (`command_execution`, `agent_message`, `reasoning`, `error`),
  `turn.completed`. stderr carries CLI warnings and stays out of the domain.
- There is no session resume in v1: one WorkerRun = one fresh process.

## 3. One WorkerRun, one process

`start(input, context)` provisions the run workspace, writes the prompt and
schema into the run scratch directory, spawns exactly one child with
`cwd = workspaceRoot`, and returns a handle. `wait()` resolves with the terminal
`WorkerAdapterResult`; `events()` streams the frozen WorkerEvent vocabulary;
`cancel(handle, reason)` is idempotent, escalates SIGTERM → SIGKILL and never
writes Runtime truth. A cancelled attempt reports nothing: the Runtime decides
what an unreported attempt means.

Production argv shape (secrets redacted; prompt via stdin, so no shell
interpolation and no argv size limits):

```text
codex exec --json --ephemeral --color never --cd <workspace>
  --sandbox workspace-write --output-schema <scratch>/result-schema.json
  --output-last-message <scratch>/last-message.txt -
```

## 4. Workspace provisioning

The frozen Harness allocates `<runtimeRoot>/workspaces/<workId>/runs/<workerRunId>-g<generation>/`
with a `workspace/` and a `scratch/` directory per attempt. This adapter fills it:

- `git worktree add --detach <workspaceRoot> <baseSha>` from the configured
  base repository — the base revision is resolved to an exact commit first and
  the workspace HEAD is verified against it;
- the canonical checkout is never the execution directory and is never
  modified (no `cd`, no checkout, no reset, no clean);
- the worktree is detached: no branch is created, no commit exists, and the
  diff against `baseRevision` is the deliverable;
- an existing non-empty workspace is refused, never reused. A retry always gets
  a new directory, so correctness comes from generation fencing plus isolation,
  not from killing orphans.

## 5. Scratch containment and known limitations

Before spawning, `TMPDIR`, `TMP` and `TEMP` are pointed at the run scratch
directory and the child runs with `cwd = workspaceRoot`. The manifest states the
honest facts, including:

- the Codex CLI sandbox (`workspace-write`) is **not proven OS-level
  containment** — H0 observed writes outside the assigned workspace;
- no network policy is enforced by this adapter; the child inherits the host
  environment;
- `TMPDIR`/`TMP`/`TEMP` redirection is intent, not proof;
- the CLI additionally refuses commands that reach outside the workspace
  (H1 saw a reviewer's `cp -R`/`rm -rf` attempt into another `/tmp` path
  rejected). The compiled prompts therefore keep the worker and the reviewer
  inside their own workspace, and a refused command can end an attempt — which
  then counts against the bounded autonomous retry budget.

Containment claims are bounded to what was actually observed. Correctness still
comes from generation fencing and run-scoped workspace isolation.

## 6. Prompt compilation

The prompt is an execution artifact composed from the durable WorkPacket and the
run envelope only: no company history, no other Work's facts, no chain-of-thought
request. For an execution or Repair attempt it states the role (Employee and
Position), the objective, the task intent, the success criteria, the assigned
workspace and scratch directory, the independent verification command, the
protected paths, the prohibited effects (no commit, no push, no publish, no
deploy, no edits outside the workspace, no company decisions) and the exact JSON
result shape. Repair attempts additionally carry the reviewer summary and the
findings that must be addressed.

A Review attempt is told which artifact it judges (kind, title, id, generation,
recorded digest, the reviewed-digest binding and the diff itself, with a copy at
`<scratch>/artifact.patch`), that it must judge the artifact as delivered, and
that lineage is derived by the Runtime — never reported by the model.

## 7. Result contracts and parsing

`ARTIFACT_DELIVERY` — the final message must be one JSON object with `outcome`
(`SUCCEEDED` / `FAILED`), `summary`, and optional `completionClaim`,
`reportedVerification`, `blockers`. The adapter composes the WorkerResult
candidate; on `SUCCEEDED` it attaches exactly one proposed artifact whose content
is the workspace diff against the base revision, titled from the task.

`REVIEW_JUDGMENT` — the final message must be one JSON object with `verdict`,
`findings`, `summary`. The adapter composes a WorkerReviewResult candidate
carrying this attempt's `workerRunId` and `generation` (Runtime facts, not model
output).

Parsing policy:

1. strict JSON of the final message; then
2. exactly one top-level JSON object inside bounded prose — fenced or bare;
3. anything else — no candidate, two competing objects, a candidate that is not
   an object, an oversized message — is `NO_CANDIDATE`.

The scan is fence-agnostic on purpose: H1 runs showed the real CLI ending a
review with `prose + one fenced object` and also with `prose + one bare
object`, and `--output-schema` does not reliably suppress the preamble. The
ambiguity rule stays strict: two parseable top-level objects are refused
rather than guessed, and unparseable brace spans in prose are not candidates.

Candidate objects that carry fields outside the contract (for example a model
trying to name `workerRunId` or `targetArtifactId`) are refused rather than
sanitized. There is no second LLM call to repair malformed output. The raw final
message digest is preserved for evidence; the provider-neutral schema validation
still happens in the Host, and a candidate the Host rejects becomes
`WORKER_PROTOCOL_ERROR`.

## 8. Independent evidence

After the child exits, the adapter observes the attempt itself:

- process: pid, exit code, signal, duration, cancellation;
- git: HEAD, `git status --porcelain`, changed files, full diff against
  `baseRevision`, diff bytes and digest — with a built-in assertion that the
  worker did not move HEAD;
- protected paths: `git status --porcelain -- <path>` for each configured path;
- verification: the configured command is run independently in the workspace
  (after the child has stopped) and its exit code, tail and pass/fail are
  recorded.

A worker's self-report never becomes evidence: `reportedVerification` is stored
separately from the Harness-observed verification, and the observation records
both. Bounded evidence may be written to `FLOWCREDIT_CODEX_EVIDENCE_DIR`
(process/git/verification summary, no reasoning payloads, no unbounded stdout,
no credentials). Full chain-of-thought is never mapped, persisted or reported.

## 9. Failure mapping

| Condition | Adapter result | Host mapping |
| --- | --- | --- |
| non-zero exit / spawn failure | `FAILED` + `PROCESS_EXIT` | `interruptWorkerRun(WORKER_PROCESS_EXIT)` |
| HEAD moved | `FAILED` + `HARNESS_GIT_VIOLATION` | `WORKER_OUTPUT_REJECTED` |
| protected path modified | `FAILED` + `HARNESS_PROTECTED_PATH_MODIFIED` | `WORKER_OUTPUT_REJECTED` |
| independent verification failed | `FAILED` + `HARNESS_VERIFICATION_FAILED` | `WORKER_OUTPUT_REJECTED` |
| no workspace change | `FAILED` + `HARNESS_NO_CHANGE` | `WORKER_OUTPUT_REJECTED` |
| diff exceeds the artifact bound | `FAILED` + `HARNESS_ARTIFACT_TOO_LARGE` | `WORKER_OUTPUT_REJECTED` |
| malformed / ambiguous / oversized final message, candidate outside the contract, candidate refused by the Host | no candidate, or `SUCCEEDED` without one | `WORKER_PROTOCOL_ERROR` |
| timeout | (Host) cancel | `interruptWorkerRun(WORKER_TIMEOUT)` |
| startup crash | (Host recovery) | `interruptWorkerRun(PROCESS_INTERRUPTED)` |

`WORKER_PROTOCOL_ERROR` and `WORKER_OUTPUT_REJECTED` are deliberately different
facts, and the vocabulary stays bounded at these two:

- `WORKER_PROTOCOL_ERROR` — **no usable result protocol existed.** The final
  message was unparseable, ambiguous, oversized, or carried fields outside the
  contract; the Host refused the candidate before any postcondition was read.
- `WORKER_OUTPUT_REJECTED` — **a protocol-valid candidate existed, and
  independent Harness evidence or execution policy rejected the delivery.**

The order is protocol first, postconditions second: a candidate must compose at
all before postconditions are consulted, so a malformed result inside a failing
workspace still reports `WORKER_PROTOCOL_ERROR`. `result.method` records what the
parser actually found (`STRICT_JSON` / `EXTRACTED_JSON` stay visible even when
delivery is rejected) and the bounded `candidateReason` records why nothing
crossed the seam.

The specific rejection stays evidence-side: Runtime sees exactly one new reason,
while the Harness keeps `HARNESS_GIT_VIOLATION`, `HARNESS_PROTECTED_PATH_MODIFIED`,
`HARNESS_VERIFICATION_FAILED`, `HARNESS_NO_CHANGE` or `HARNESS_ARTIFACT_TOO_LARGE`
in the run metadata (`failureReason`). `WORKER_OUTPUT_REJECTED` is not a new Task
state, not a WorkerRun `FAILED`, and not a new retry budget: it consumes one
attempt under the existing interrupted-attempt semantics
(`MAX_AUTONOMOUS_ATTEMPTS_PER_TASK = 3`), records no Artifact and no Review, and
`PROCESS_INTERRUPTED` startup recovery is untouched.

## 10. Event mapping

Only the frozen vocabulary crosses the seam: `RUN_STARTED` (thread start),
`TOOL_FINISHED` (completed tool items), `RESULT_READY` / `RUN_FAILED` (terminal),
and nothing else. Reasoning items are dropped and only counted; unknown event
types and malformed lines are counted, never interpreted. Raw Codex event names
never enter Runtime domain types.

## 11. Configuration

- `FLOWCREDIT_WORKER_BACKEND=codex-exec` selects this backend in
  `apps/runtime/server.mjs` (the other values remain `off` and `test-worker`;
  there is no registry).
- `FLOWCREDIT_CODEX_REPO` (required) — the base repository to provision run
  worktrees from.
- `FLOWCREDIT_CODEX_BASE_REVISION` (default `HEAD`) — the exact revision each
  attempt starts from.
- `FLOWCREDIT_CODEX_VERIFICATION` (default `node --test`) — whitespace-separated
  argv of the independent verification command.
- `FLOWCREDIT_CODEX_PROTECTED_PATHS` — comma-separated repository-relative
  paths compared byte-for-byte via git after every execution attempt.
- `FLOWCREDIT_CODEX_EVIDENCE_DIR` — optional bounded evidence output.
- `FLOWCREDIT_WORKER_TIMEOUT_MS` — Host timeout; the codex-exec backend defaults
  to 600000 ms when unset (the deterministic test backend keeps 30000 ms).

This is execution configuration, never Company truth: no new domain object
stores a filesystem path.

## 12. Authority boundary (what this adapter may never do)

The CodexExecAdapter has no Runtime authority. It cannot assign a Task, start or
complete a WorkerRun, record an Artifact, request or submit a Review, create a
Repair, accept Work, or make a Founder decision. It never commits or pushes. It
cannot be required for recovery, identity, retry or resume. `externalSessionRef`
is opaque execution provenance: storing it is allowed, depending on it is not.

## 13. Deliberately not in v1

No resume, fork, steer, session reuse, fallback or ranking; no backend registry;
no persistent EmployeeWorkerBinding; no GitHub integration, no draft PRs, no
merge; no general Agent-to-Agent protocol; no Laya / SemanticSensor; no
scheduler, DAG planner or Dynamic Swarm; no container isolation.

## 14. H1 / H1.1 evidence (2026-09-22)

H1 — the adapter itself, real `codex exec`:

- A real `codex exec` implemented the H1 fixture's documented behavior in ~30 s,
  with the adapter's independent `node --test` verification passing and the
  fixture's `test/` directory byte-identical to base.
- A real end-to-end Work: execution → Review Task → real Codex reviewer `PASS`
  → `READY_FOR_DECISION` → explicit Founder `ACCEPT`, with zero manual
  coordination commands after the Work was stated.
- A real timeout: the first attempt was interrupted by `WORKER_TIMEOUT`, its
  workspace poisoned; the Runtime re-dispatched into a new generation with a new
  workspace, delivered for real, and never touched the abandoned directory.
- A protocol-boundary scenario: a controlled child produced complete work that
  passed independent verification but answered with an invalid result shape;
  three attempts ended in `WORKER_PROTOCOL_ERROR`, no Artifact and no Review
  were recorded, and the Work reached Founder Attention instead.

H1.1 — reason closure and the real review chain:

- The reason vocabulary is closed and bounded: `WORKER_OUTPUT_REJECTED` for a
  protocol-valid delivery that independent evidence rejected, `WORKER_PROTOCOL_ERROR`
  strictly for the absence of a usable result protocol (§9). Five integration
  tests drive a controlled child through verification failure, protected-path
  mutation, moved HEAD and no-change, and every one of them lands on
  `WORKER_OUTPUT_REJECTED` with zero Artifacts, zero Reviews and zero Founder
  Decisions; a malformed result inside a failing workspace still lands on
  `WORKER_PROTOCOL_ERROR`; three rejected attempts exhaust the unchanged
  `MAX_AUTONOMOUS_ATTEMPTS_PER_TASK = 3` into `AUTO_RETRY_EXHAUSTED` across three
  distinct generations, and startup recovery still reports `PROCESS_INTERRUPTED`
  without rewriting history.
- Three distinct real task scenarios (input normalization; ISO-8601 durations;
  interval algebra) were each driven all the way through Work → Task →
  Assignment → WorkerRun → real Codex → Artifact → independent real Codex
  Reviewer, with the Runtime owning every handoff and no manual Repair creation.
  All three reviewers honestly returned `PASS`; no Reviewer was instructed to ask
  for a revision, and an independent check of the third Artifact reproduced all
  19 documented rules, so the PASS verdicts were accurate rather than lenient.
- The Founder boundary was then confirmed on all three of those chains by
  re-attaching to the finished stores with coordination off (no actuation, no
  model call): each Work sat at `READY_FOR_DECISION` with
  `DECISION_REQUIRED`, `outcome.accepted = null` and **0** Founder Decisions;
  an explicit `acceptWork` bound to the exact reviewed Artifact and digest was
  the only thing that produced `ACCEPTED`, and repeating it returned
  `idempotent: true` for the same decision id. `Reviewer PASS != Founder ACCEPT`
  is therefore evidenced on real chains, not only in tests.
- **Therefore `REAL_REPAIR_EVIDENCE_NOT_OBSERVED`:** a real-Codex
  review → `REQUEST_REVISION` → repair → re-review chain has not been observed.
  The Runtime Review/Repair protocol is covered by deterministic tests, and a
  stub-backed dry run did drive the full four-attempt chain
  (execution → review → repair → re-review) through the production adapter and
  host, but no real model has yet produced a `REQUEST_REVISION`. This is an open
  evidence gap, not a known defect.
  Reproduce with `node scripts/h1-1-codex-repair.mjs <1|2|3>` and
  `node scripts/h1-1-codex-repair.mjs boundary <1|2|3>`.
- Still unobserved after H1.1: a real multi-cycle repair loop, and a real
  `WORKER_OUTPUT_REJECTED` from a real model (all rejected-delivery evidence is
  from the controlled child).

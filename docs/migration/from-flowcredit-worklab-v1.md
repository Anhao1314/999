# Migration manifest — from FlowCredit-worklab (v1)

Status: **three extractions done — Persistent Work Kernel v0A, Workforce
Identity & Assignment v0B1, Review & Repair Collaboration v0B2.** The table below
tracks every legacy capability and its status; the §"Extraction …" sections
record what was actually taken, from where, and why its shape changed. No legacy
file was copied: every capability was written in this repository's own domain
language.

Rule: **capability by capability, contract by contract, test by test.** Bulk copy
(`cp -R`, whole `apps/` / `packages/` / `docs/` trees) is forbidden (see `AGENTS.md`).

## Source repositories (read-only)

| Alias | Worktree | Branch | Commit at audit time | Role |
| --- | --- | --- | --- | --- |
| **A** | `/Users/yimingyang/Documents/Codex/2026-09-18/deepseek-key-dsh-profile/work/flowcredit-harness-migration` | `feat/persistent-repair-loop` | `27b11e7` | verified Founder-facing Runtime source |
| **B** | `/Users/yimingyang/Documents/Codex/2026-09-18/deepseek-key-dsh-profile/work/flowcredit-m2-decision-foundation` | `feat/m2-shadow-decision-foundation` | `3d04cf8` | Decision / Jev research source |
| **C** | `/Users/yimingyang/FlowCredit-Platform` | `chore/flowcredit-engineering-skill` | `9a98ea1` | satellite worktree (Pages demo + engineering skill) |

Remotes seen on A: `origin → https://github.com/Anhao1314/d.git`,
`worklab → https://github.com/Anhao1314/FlowCredit-worklab.git`.

None of the three may be modified, reset, cleaned, stashed or overwritten while
being used as a migration source.

## Capability manifest

| Capability | Source | Status | Target in this repo | Migration policy |
| --- | --- | --- | --- | --- |
| **Persistent Work substrate** (Duty/Task/Run/Checkpoint/Artifact/Budget) | A — `packages/control-plane/{runtime,store}.mjs`, `apps/runtime/server.mjs`; commit `0c8b023` + H0–H3 baseline | **extracted in v0A** — kernel only (Company/Work/Task/Artifact/Checkpoint/Activity). Budget, delegations and runs are *not* extracted | `packages/company` + `packages/work` + `packages/runtime` + `apps/runtime` (split by layer, not by file) | Extract the object semantics first (states, invariants, transitions), then re-implement against the new object model. `Duty` was deliberately **not** mapped to Company (see §Extraction v0A, item 1). |
| **Repair loop** (REQUEST_REVISION → Repair Task → START_REPAIR → lineage) | A — commits `163ba6a`, `afc2658`, `80abacb`; tests `tests/integration/repair-loop.test.mjs` (13 tests), `tests/unit/review-scope.test.mjs`, `tests/support/revision-stub.mjs` | **extracted in v0B2** — immutable Review, Repair Task + RepairBinding lineage, Artifact supersession. A's human `START_REPAIR` gate and research state names did *not* migrate (see §Extraction v0B2) | `packages/workforce` (`reviews` / `review-requests` / `repair-bindings`), `packages/work/collaboration.mjs` (projection), `packages/runtime` (commands, storage) | **A is canonical.** B implemented the same milestone independently (`4a8bc0e`, +1239 test lines); do not merge both. Port A's semantics, then reconcile any B-only invariant as an explicit review item. |
| **Founder Inbox** (pure projection of runtime conditions) | A — commit `27b11e7`; `apps/web/view-model.js` (`projectFounderInbox`), `tests/unit/inbox.test.mjs` | committed, validated | `packages/projections` + later Canvas Inbox module | Port the *classifier rules* (action-driven, not state-name-driven; id determinism; reading is not an exit) as a contract + tests. Keep the UI mapping out of the first extraction. |
| **Agent Identity** (stable system profiles) | A — commit `c2e1199`; `packages/agent-work/profiles.mjs`, `tests/unit/agent-identity.test.mjs` | **extracted in v0B1** | `packages/workforce` | Seed of MVP 2/3, done: the two system profiles became generic **Position + Employee** rows, and identity still comes from recorded runs, never from a role guess. A's `mission` / `outputContract` / `reviewPolicy` fields moved into this repository's *contract* vocabulary (`review_capabilities`), not into a profile object. |
| **Founder Decision Closure** | A — **uncommitted** (`packages/control-plane/store.mjs` `resolve(disposition)`, `apps/runtime/server.mjs` disposition branch), test `tests/integration/decision-closure.test.mjs` | uncommitted work in progress | `packages/decision` (human decision record) | **Must be committed in A before extraction** (it exists only as working-tree state today). Policy: a decision is explicit or fails closed — nothing defaults to ACCEPT. |
| **Company Canvas Interaction Foundation** | A — **uncommitted** `apps/web/company-canvas/*` + `docs/company-canvas-ui-port-contract-v0.md`; tests `tests/unit/company-canvas-{contracts,interaction,projection}.test.mjs` | uncommitted, browser-verified | `apps/web` (future shell) + `docs/architecture` contract | Migrate the **contract** (slots, hooks, interaction arbitration, layout schema, projection boundary) and its tests — not the reference skin. Blocks MVP 1's "personalized Company Canvas" only after Genesis exists. |
| **Decision Plane / Jev / reconciliation evidence** | B — commits `296661f`, `85625c6`, `19aaec8` + uncommitted `packages/decision-plane/*`, `packages/control-plane/jev-*.mjs`, `experiments/reconciliation/**` | research, shadow-only | `experiments/jev/` (never `packages/`) | **NOT a production migration.** The new Runtime must run with zero sensor dependencies. Future policy: `SemanticSensor → structured probability signal`, resolved from evidence, not from a hard `@typesafe-ai/sdk` import inside product packages. |
| **Swarm Office** (pixel office visualization) | A/B/C — `apps/web/swarm-space/**` | demo, no runtime dependency | none (stays in the old repo) | **Do not migrate to product core.** If a demo is ever wanted, it returns as an explicitly labelled demo entry, never as product navigation. |
| **Northstar synthetic研究库** | A/B — `fixtures/northstar/{seed.mjs,identity.mjs}` | synthetic fixture | future `fixtures/` (test material only) | Fixture/research material only. Never a product data source; product surfaces must keep the SYNTHETIC label if it is ever used. |
| **Pages demos / demo transport** | A/C — `apps/pages/demo-runtime.js`, `scripts/build-pages.mjs`, `.github/workflows/pages.yml` | build artifact for a public demo | none | **Do not migrate to product core.** The public demo stays a rendering of the old repo; the new product must not inherit a preset-simulation transport. |

## Extraction v0A — Persistent Work Kernel

Source: worktree **A**, branch `feat/persistent-repair-loop`, HEAD `27b11e7`
(working tree left untouched; §4 of the milestone charter).

Behaviour source, invariant by invariant:

| # | Invariant migrated | Old behaviour (source) | New behaviour (this repo) | Why the shape changed |
| --- | --- | --- | --- | --- |
| 1 | Organization root object | A single seeded `duty` row plus `dutyUpdate()` pointers (`packages/control-plane/store.mjs`); seeded from `fixtures/northstar/seed.mjs` | `Company` = `{id, name, createdAt}` (`packages/company/company.mjs`), owning Work | **Duty is not Company.** Duty was a *standing obligation*; Company is the *organization root*. Mapping one onto the other would make "company" mean "a research obligation" — the exact domain leak the charter forbids (charter §7). A standing obligation, if it returns, is a Work shape. |
| 2 | Task lifecycle | Research-shaped states `RESEARCH_PENDING` / `REVIEW_PENDING` / `MEMO_READY` / `NEEDS_ATTENTION` / `RECOVERY_BLOCKED` / `ABANDONED` | Five generic states `OPEN` / `RUNNING` / `INTERRUPTED` / `COMPLETED` / `CANCELLED` (`packages/work/work.mjs`) | The old states encoded review and memo steps that v0A does not have. States without a producer are vocabulary nobody can act on; the kernel keeps only states it can actually reach. |
| 3 | Checkpoint | `tasks.checkpoint` JSON blob overwritten by `store.state(id, state, checkpoint)` | Append-only `checkpoints` records, bound to `taskId + generation`, monotone `sequence` | Progress must be readable after a restart **and** must not overwrite history. |
| 4 | Generation isolation | In-process counter `runtime.generation`, guarded by `if (generation !== this.generation) throw Error("CANCELED")` after receipt and before commit (`packages/control-plane/runtime.mjs`); evidence: `tests/integration/platform.test.mjs` — "stand down isolates a late model response and preserves the stopped reason" (late response ignored, 0 artifacts) | Persisted fencing token per Task; every execution write (checkpoint/artifact/completion) must present it, else `STALE_GENERATION` / `TASK_NOT_RUNNING`. Tests: `tests/unit/generation.test.mjs`, `tests/integration/restart.test.mjs` | The old guard lived in one process and died with it. Persisting the token makes the same invariant hold across restarts and across a store reopened by a different process. |
| 5 | Recovery | `Store.recover()`: `*_RUNNING` → `NEEDS_ATTENTION` with `reason: "INTERRUPTED_ATTEMPT_COST_UNKNOWN"`, `nextAction: "人工检查执行尝试，不自动重试"`, runs → `INTERRUPTED`, duty → `PAUSED`; evidence: `tests/recovery/http.test.mjs` (real process, port + runtime dir, restart) | On open: `RUNNING` → `INTERRUPTED`, token fenced, `task.interrupted {reason: PROCESS_INTERRUPTED, automaticRetry: false}`; never marks anything `COMPLETED`, idempotent. Tests: `tests/unit/cancellation-recovery.test.mjs`, `tests/integration/restart.test.mjs` (SIGKILL, not a graceful stop) | Same honesty rule ("an interrupted attempt is not a result"), expressed without runs/budget/duty — those objects do not exist in v0A. The integration test now kills the process hard, so recovery cannot rely on a clean shutdown path. |
| 6 | Cancellation | `abandon()` allowed only from `NEEDS_ATTENTION` / `RECOVERY_BLOCKED`, else `TASK_NOT_ABANDONABLE`; note bounded and scanned (`INVALID_HUMAN_NOTE`, `SECRET_IN_OUTPUT`); refuses while a child task is active | `cancelTask()` from `OPEN` / `RUNNING` / `INTERRUPTED`, else `INVALID_TRANSITION`; fences the generation; optional note validated and scanned | v0A has no parent/child repair tasks, so the child-task guard has no referent yet. Everything else (bounded note, secret refusal, history kept) is ported. |
| 7 | Artifact provenance | `artifacts(id, task, producer, type, created, content, digest)` with `ARTIFACT_INTEGRITY` / `ARTIFACT_TYPE` / `PRODUCER_BINDING` checks | `artifacts` bound to `companyId + workId + taskId + generation`, `contentDigest`, database triggers raising `ARTIFACT_IMMUTABLE` on update/delete | `producer` referred to an employee; v0A has no Employee and must not invent one (charter §15), so the generation is the honest producer handle. Immutability moved from convention into storage. |
| 8 | Recorded-truth guards | `SECRET_IN_OUTPUT` checks on human notes and recorded output | Same refusal on every write path, plus explicit size bounds on titles, intents, labels, checkpoint state and artifact content | Ported unchanged in intent; the bounds are new because a bounded store is a precondition for honest persistence. |
| 9 | Storage engine and transactions | `node:sqlite` `DatabaseSync`, WAL, `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK`, ad-hoc `ALTER TABLE` upgrades, `immutable_context` trigger | Same engine and transaction discipline; frozen `schema_meta.version = 1`; any other version fails loudly with `INCOMPATIBLE_SCHEMA_VERSION` (`packages/runtime/store.mjs`) | There is nothing to migrate from, so an ad-hoc upgrade path would be untested code. A versioned store that refuses the unknown is honest; a silent one is not (charter §20). |
| 10 | Vocabulary | Core states and objects named for the old domain (research, memo, duty, snapshot, claim, R-01) | Core language: Company / Work / Task / Artifact / Checkpoint / Activity / Generation / Recovery | Research becomes a Work type later; it must not be the kernel's mother tongue (charter §8). Enforced by `scripts/check.mjs` (core-language guard), which fails the build if legacy vocabulary reappears in `packages/` or `apps/runtime/`. |

Not extracted in v0A (runs and employees were still open then — see
"Extraction v0B1" below): budget and delegations, runs and employees, review,
repair, inbox, decisions, hiring, canvas, sensors. Kernel tests: `node --test`
(see the milestone report for the full matrix).

## Extraction v0B1 — Workforce Identity & Assignment

Source: worktree **A**, branch `feat/persistent-repair-loop`, HEAD `27b11e7`
(read-only; the working tree was not touched). Sources read: `packages/agent-work/profiles.mjs`,
`tests/unit/agent-identity.test.mjs`, `packages/control-plane/runtime.mjs`
(run → profile binding at invoke), `packages/control-plane/store.mjs`
(one-time `ALTER TABLE runs ADD COLUMN profile` + deterministic backfill).

A's own model was `AgentProfile --(profileId)--> WorkerAssignment --> Runtime Role --> Provider --> Run`,
with the stated rule that *"provider is deliberately not part of identity"*.
v0B1 keeps that rule and replaces the two-profile registry with a generic
Position + Employee registry.

| # | Invariant migrated | Old behaviour (source) | New behaviour (this repo) | Why the shape changed |
| --- | --- | --- | --- | --- |
| 1 | Stable employee identity | `SYSTEM_PROFILES` in `packages/agent-work/profiles.mjs`: two frozen literals (`system:research-analyst`, `system:independent-reviewer`) carrying name, role, mission, capabilities, outputContract, reviewPolicy; `findProfileForRole()` mapped a role string back to a profile | `positions` + `employees` rows (`packages/workforce/{positions,employees}.mjs`); a Position carries `title` + `capabilities`, an Employee carries `displayName` + `enabled`. Identity is a stored row, never a lookup by role name | A hardcoded registry cannot express "the company hired someone new". Identity has to be data the company owns, not a constant in the core (charter §7, §26) |
| 2 | Identity ≠ provider | Stated in the module comment and proved by `agent-identity.test.mjs` — "worker assignment keeps identity stable while the provider changes" (`provider: "native-harness"` vs `"claude-code"`, same `profileId`) | Structural: Employee has **no** model or provider field; `providerPreference` is a nullable *preference*, and nothing in `packages/workforce` names a provider. The run records who worked, not what executed it | A tested convention beats an untested one, but an absent field beats both: if provider cannot be stored on the employee, identity cannot drift with it |
| 3 | A run binds the identity that produced it | `runtime.mjs` bound run → profile at invoke; historical rows without a profile were fixed by a one-time `ALTER TABLE` + deterministic backfill (`role` → profile, unknown roles left `NULL`) | `worker_runs.employee_id` is `NOT NULL` from creation, with trigger `worker_runs_binding_frozen` refusing any later change; one `RUNNING` run per task and one run per `(task, generation)` | No backfill path exists in v0B1 because nothing precedes it. Making the binding a storage invariant means the old "backfill once, deterministically" step is never needed again |
| 4 | Historical attribution, honest absence | `agent-identity.test.mjs`: role-only legacy runs are backfilled once; unknown roles stay `NULL` rather than guessed | `artifacts.worker_run_id` is nullable: an artifact produced by a run must name that run, while v0A artifacts keep `NULL` forever *and stay valid*. No placeholder employee, no "system employee" | Absence is represented by absence. `tests/unit/schema-migration.test.mjs` asserts a migrated v0A artifact keeps its bytes, its digest and a `null` producer |
| 5 | Assignment is a recorded fact | `workerAssignment({work, role, provider})` derived a descriptor (`profileId`, `runtimeRole`, `provider`, `requiredCapabilities`, `assignmentReason: "template_default"`) from the role at call time | Append-only `assignments` rows; the current assignment is the latest row; `assignments_no_update/delete` triggers make history immutable; a task carries `requiredCapabilities` and starting a run refuses when the position no longer satisfies them (`TASK_REQUIREMENTS_UNSATISFIED`) | Assignment answers "who owns this", so it must survive re-assignment and be auditable. Provider left the assignment entirely: that is an execution fact, not an ownership fact |
| 6 | Vocabulary | Core spoke the shipped roster: `Researcher` / `Reviewer` roles, capability literals `research` / `review`, `system:*` ids | Core speaks Position / Employee / capability ids. The shipped roster is **seed data**: `fixtures/seeds/system-workforce.mjs` (`pos_system_*`, `emp_system_*`, `research.execute`, `review.independent`), never core logic. `scripts/check.mjs` fails the build if those names appear anywhere in `packages/` or `apps/runtime/` | Same rule as v0A row 10, one level deeper: it is not enough for the kernel to avoid research *vocabulary* — it must not contain the *employees* either (charter §32) |

Not migrated from A in v0B1: the role-specific web/UI presentation of the two
profiles, the provider registry and provider dispatch, and `mission` /
`outputContract` / `reviewPolicy` — a Position carries `title` + `capabilities`
only, because review and output contracts arrive with the Review/Repair
milestone. A's `kind: "system"` label has no referent yet: Hiring does not exist,
and a state nobody can reach is vocabulary nobody can act on (the same reason
v0A row 2 dropped unreachable states).

Evidence for v0B1: `tests/unit/workforce-{positions-employees,assignment,runs,workpacket}.test.mjs`,
`tests/unit/schema-migration.test.mjs`, and the real-process hard restart in
`tests/integration/restart.test.mjs` ("an employee and its assignment survive a
hard restart, and a new run finishes the work").

## Extraction v0B2 — Review & Repair Collaboration

Source: worktree **A**, branch `feat/persistent-repair-loop`, HEAD `27b11e7`
(working tree left untouched; §2 of the milestone charter). All three repair
commits are committed work in A: `163ba6a` (explicit persistent repair loop),
`afc2658` (normalized repair start and abandon semantics) and `80abacb`
(reviewer citations bound to supplied excerpts).

| # | Invariant migrated | Old behaviour (source) | New behaviour (this repo) | Why the shape changed |
| --- | --- | --- | --- | --- |
| 1 | Review is an obligation, not a task state | `REVIEW_PENDING` was a Task state; `reviewInput(id)` (`packages/control-plane/runtime.mjs`) resolved the review target from the research record at call time | `task_requirements.review_capabilities` declares the obligation; `requestReview` creates a **separate Review Task** plus an immutable `ReviewRequest`, and `completeTask` refuses while a review is owed (`REVIEW_REQUIRED`) | The old state name fused "this work is waiting for review" into the execution lifecycle, so a crashed review left the task in a state nobody could act on. Here the obligation is data and the review is its own Task, so v0A's five states stay exactly five |
| 2 | The review record is immutable | `review()` / `reviewInput()` read and wrote review fields next to the record they judged (`runtime.mjs`) | `reviews` rows carrying `PASS` / `REQUEST_REVISION` only (`packages/workforce/reviews.mjs`), with storage triggers `reviews_no_update` / `reviews_no_delete` (`REVIEW_IMMUTABLE`) | A judgment that can be edited is not a judgment. A wrong Review is corrected by a new cycle, never by rewriting history — the same rule v0A applies to Artifacts and Checkpoints |
| 3 | A review judges one exact Artifact | `reviewInput(id)` meant "whatever the current artifact is" — the target was implicit | `ReviewRequest` and `Review` both bind `targetArtifactId` + `targetArtifactDigest`; `submitReview` refuses a digest that changed (`REVIEW_TARGET_MISMATCH`) | "Review whatever is latest" drifts under repair: without a digest, a review could pass an Artifact it never read |
| 4 | A reviewer is an ordinary worker | The research runtime invoked a reviewer role internally (`runtimeRole` + provider dispatch), on a path separate from producer runs | Review Task → `assignTask` → `startWorkerRun` → review **Work Packet** (`packetVersion 2`) → `submitReview`. No reviewer process, no second runtime, same generation fencing and one-active-run rule | v0B1 already made employees, assignments and runs generic, so a reviewer needs no special machinery — and a special reviewer runtime would be the second state machine this milestone explicitly refuses |
| 5 | Repair is a new Task with exact lineage | `createRepairTask()` (`store.mjs`) created a child task and wrote `repairBinding()` (`parentTaskId` + source artifact + reason); "the open repair task" was how a repair was found again | `RepairBinding {repairTaskId (unique), reviewId (unique), sourceTaskId, targetArtifactId, targetArtifactDigest}`; `createRepairTask({ reviewId })` is idempotent per Review and copies the source requirements (`requiredCapabilities` **and** `reviewCapabilities`) | The old shape could accumulate repairs and reopen work. Keying the binding to the Review means one verdict → at most one repair task, forever, and the source Task is never reopened or modified |
| 6 | Supersession is a pointer, never an overwrite | `supersedesArtifactId` existed on the memo record, with nothing preventing a cross-record or out-of-scope pointer | `artifacts.supersedes_artifact_id` lives on the **new** row; it is required iff the producing Task has a RepairBinding (`SUPERSEDES_REQUIRED`) and forbidden otherwise (`SUPERSEDES_NOT_ALLOWED`), with cross-company / cross-work / out-of-scope pointers rejected (`SUPERSEDES_OUT_OF_SCOPE`). The old Artifact keeps its bytes, digest, producer run and creation time forever | "Latest" must be a projection over a chain, not a mutation. Making supersession a column on the replaced row would have been a write to immutable history |
| 7 | Repair assignment is deterministic | The repair re-entered the research runtime, which resolved the role again at call time | `createRepairTask` assigns the Artifact's producer **iff** it exists, is enabled, belongs to the same company and still satisfies the copied requirements (`assignmentReason: "original_producer"`); otherwise the Repair Task stays unassigned | v0B2 has no dynamic allocation and no Founder escalation. Silently picking a different employee would change who owns the fix; guessing nothing and recording nobody is the honest default |
| 8 | The repair packet carries the findings | The reviewer's remarks were passed as free-form repair input | The repair Work Packet adds `repair: { repairBindingId, reviewId, reviewVerdict, reviewSummary, reviewFindings, sourceTask, targetArtifact, supersedesArtifactId }` | The employee must know *which* output it is correcting, *why*, and *what* the corrected output must replace. "Please revise per the feedback" is not a binding |

Not migrated from A in v0B2: A's human `START_REPAIR` gate and its `HUMAN_REVIEW`
semantics (that is the beginning of Founder attention, which arrives in v0B3),
the research state names (`RESEARCH_PENDING` / `REVIEW_PENDING` / `MEMO_READY`),
and the `memo` / `claim` objects the old loop was written in. The old loop was
also where budget and delegation accounting entered execution; none of that is
here, so a review or a repair costs nothing and claims nothing.

Evidence for v0B2: `tests/unit/review-request.test.mjs` (6), `review-submission.test.mjs`
(6), `repair-lineage.test.mjs` (7), `artifact-supersession.test.mjs` (4),
`review-repair-cycles.test.mjs` (3), `review-cancellation.test.mjs` (3) and the
real-process hard restart in `tests/integration/restart.test.mjs` ("review and
repair survive a hard restart without inventing a judgment"). The full
collaboration is printed by `scripts/demo-review-repair-v0b2.mjs`.

## Provenance policy

Every future extraction adds a row (or updates one) with:

1. old repository and worktree,
2. source commit hash **if committed** — and an explicit "uncommitted" marker if not,
3. source files,
4. tests used as evidence,
5. adaptation notes (what changed while generalizing).

Provenance is not decoration: it is how a later reader answers "why does this
code exist and what proved it worked".

## Known risks to resolve before extraction

1. **Duplicate repair implementations (A vs B) — resolved for v0B2.** A is recorded as canonical and its repair semantics now pass in this repository (see §Extraction v0B2). Deleting the losing implementation in B is still open, and is the old repos' business, not this one's.
2. **Duplicate decision semantics.** A's uncommitted `resolve(disposition)` and B's `decision-plane/contracts.mjs` describe overlapping human-decision states; the new `packages/decision` must be one of them, not both.
3. **Uncommitted-only capabilities.** Decision closure and the Canvas foundation exist only in A's working tree. If A is ever cleaned, they are lost — commit them there first.
4. **Research vocabulary leakage.** The strongest legacy code paths name Research concepts (claims, snapshots, memos). Extraction must rename them into the object model *before* porting behaviour, or the new product inherits the old mother tongue.

## Explicit non-goals for the next milestone

Bulk import of `apps/`, `packages/`, `docs/`; the Swarm Office; Jev; the Pages
demo; any placeholder business code; any schema for objects that have no verified
behaviour yet.

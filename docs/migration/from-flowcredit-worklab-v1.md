# Migration manifest — from FlowCredit-worklab (v1)

Status: **first extraction done — Persistent Work Kernel v0A.** The table below
still tracks every legacy capability and its status; §"Extraction v0A" records
what was actually taken, from where, and why its shape changed. No legacy file
was copied: the kernel was written in this repository's own domain language.

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
| **Repair loop** (REQUEST_REVISION → Repair Task → START_REPAIR → lineage) | A — commit `163ba6a`, hardened by `afc2658`; tests `tests/integration/repair-loop.test.mjs` (872 lines), `tests/support/revision-stub.mjs` | committed, validated | `packages/work` (repair as first-class Work relationship) | **A is canonical.** B implemented the same milestone independently (`4a8bc0e`, +1239 test lines); do not merge both. Port A's semantics, then reconcile any B-only invariant as an explicit review item. |
| **Founder Inbox** (pure projection of runtime conditions) | A — commit `27b11e7`; `apps/web/view-model.js` (`projectFounderInbox`), `tests/unit/inbox.test.mjs` | committed, validated | `packages/projections` + later Canvas Inbox module | Port the *classifier rules* (action-driven, not state-name-driven; id determinism; reading is not an exit) as a contract + tests. Keep the UI mapping out of the first extraction. |
| **Agent Identity** (stable system profiles) | A — commit `c2e1199`; `packages/agent-work/profiles.mjs`, `tests/unit/agent-identity.test.mjs` | committed, validated | `packages/workforce` | Seed of MVP 2/3. Generalize from two system profiles (Researcher/Reviewer) to **Position + Employee**; keep the rule that identity comes from recorded runs, never from a role guess. |
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

1. **Duplicate repair implementations (A vs B).** Decide and record A as canonical; delete the losing implementation in the old repo only after the winner passes its tests in the new one.
2. **Duplicate decision semantics.** A's uncommitted `resolve(disposition)` and B's `decision-plane/contracts.mjs` describe overlapping human-decision states; the new `packages/decision` must be one of them, not both.
3. **Uncommitted-only capabilities.** Decision closure and the Canvas foundation exist only in A's working tree. If A is ever cleaned, they are lost — commit them there first.
4. **Research vocabulary leakage.** The strongest legacy code paths name Research concepts (claims, snapshots, memos). Extraction must rename them into the object model *before* porting behaviour, or the new product inherits the old mother tongue.

## Explicit non-goals for the next milestone

Bulk import of `apps/`, `packages/`, `docs/`; the Swarm Office; Jev; the Pages
demo; any placeholder business code; any schema for objects that have no verified
behaviour yet.

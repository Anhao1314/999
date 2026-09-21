# Migration manifest — from FlowCredit-worklab (v1)

Status: **plan only. Nothing has been migrated.** No line of legacy code exists in
this repository.

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
| **Persistent Work substrate** (Duty/Task/Run/Checkpoint/Artifact/Budget) | A — `packages/control-plane/{runtime,store}.mjs`, `apps/runtime/server.mjs`; commit `0c8b023` + H0–H3 baseline | committed, locally validated (122 tests green at audit) | `packages/work` + `packages/control-plane` (split by domain, not by file) | Extract the object semantics first (states, invariants, transitions), then re-implement against the new object model. Research-specific vocabulary must be generalized: *Duty* → **Company**, *Snapshot of a claim* → **Task input scope**, *memo* → **Artifact**. |
| **Repair loop** (REQUEST_REVISION → Repair Task → START_REPAIR → lineage) | A — commit `163ba6a`, hardened by `afc2658`; tests `tests/integration/repair-loop.test.mjs` (872 lines), `tests/support/revision-stub.mjs` | committed, validated | `packages/work` (repair as first-class Work relationship) | **A is canonical.** B implemented the same milestone independently (`4a8bc0e`, +1239 test lines); do not merge both. Port A's semantics, then reconcile any B-only invariant as an explicit review item. |
| **Founder Inbox** (pure projection of runtime conditions) | A — commit `27b11e7`; `apps/web/view-model.js` (`projectFounderInbox`), `tests/unit/inbox.test.mjs` | committed, validated | `packages/projections` + later Canvas Inbox module | Port the *classifier rules* (action-driven, not state-name-driven; id determinism; reading is not an exit) as a contract + tests. Keep the UI mapping out of the first extraction. |
| **Agent Identity** (stable system profiles) | A — commit `c2e1199`; `packages/agent-work/profiles.mjs`, `tests/unit/agent-identity.test.mjs` | committed, validated | `packages/workforce` | Seed of MVP 2/3. Generalize from two system profiles (Researcher/Reviewer) to **Position + Employee**; keep the rule that identity comes from recorded runs, never from a role guess. |
| **Founder Decision Closure** | A — **uncommitted** (`packages/control-plane/store.mjs` `resolve(disposition)`, `apps/runtime/server.mjs` disposition branch), test `tests/integration/decision-closure.test.mjs` | uncommitted work in progress | `packages/decision` (human decision record) | **Must be committed in A before extraction** (it exists only as working-tree state today). Policy: a decision is explicit or fails closed — nothing defaults to ACCEPT. |
| **Company Canvas Interaction Foundation** | A — **uncommitted** `apps/web/company-canvas/*` + `docs/company-canvas-ui-port-contract-v0.md`; tests `tests/unit/company-canvas-{contracts,interaction,projection}.test.mjs` | uncommitted, browser-verified | `apps/web` (future shell) + `docs/architecture` contract | Migrate the **contract** (slots, hooks, interaction arbitration, layout schema, projection boundary) and its tests — not the reference skin. Blocks MVP 1's "personalized Company Canvas" only after Genesis exists. |
| **Decision Plane / Jev / reconciliation evidence** | B — commits `296661f`, `85625c6`, `19aaec8` + uncommitted `packages/decision-plane/*`, `packages/control-plane/jev-*.mjs`, `experiments/reconciliation/**` | research, shadow-only | `experiments/jev/` (never `packages/`) | **NOT a production migration.** The new Runtime must run with zero sensor dependencies. Future policy: `SemanticSensor → structured probability signal`, resolved from evidence, not from a hard `@typesafe-ai/sdk` import inside product packages. |
| **Swarm Office** (pixel office visualization) | A/B/C — `apps/web/swarm-space/**` | demo, no runtime dependency | none (stays in the old repo) | **Do not migrate to product core.** If a demo is ever wanted, it returns as an explicitly labelled demo entry, never as product navigation. |
| **Northstar synthetic研究库** | A/B — `fixtures/northstar/{seed.mjs,identity.mjs}` | synthetic fixture | future `fixtures/` (test material only) | Fixture/research material only. Never a product data source; product surfaces must keep the SYNTHETIC label if it is ever used. |
| **Pages demos / demo transport** | A/C — `apps/pages/demo-runtime.js`, `scripts/build-pages.mjs`, `.github/workflows/pages.yml` | build artifact for a public demo | none | **Do not migrate to product core.** The public demo stays a rendering of the old repo; the new product must not inherit a preset-simulation transport. |

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

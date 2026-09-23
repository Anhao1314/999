# Contract — Founder Workspace v0 (Experience-backed Product Shell)

Status: **historical frozen semantics for the Founder Workspace v0C slice.**
The subsequent Founder Work product integration is recorded in
`docs/contracts/founder-workspace-product-integration-v1.md`; its one bounded
write supersedes this document's read-only UI boundary. This document freezes one
idea and nothing more:

> The Founder Workspace shows the company, not the dashboard: Company reality
> rendered from the Workforce Experience projections, never a second truth.

Protocol addition: the optional `founderAssistant` field in the existing
Founder Workspace Experience projection. The Workspace reads Experience projections and is
allowed no write at all. Not covered (later milestones): Canvas persistence,
company-level Activity feed, Founder Work definition / Task planning, Founder
Decision UI (executing ACCEPT), Hiring, Genesis, Knowledge admission, Laya,
Jev, General A2A, dynamic allocation, schedulers.

Builds on `docs/contracts/workforce-experience-v0.md` (v0A) and
`docs/contracts/employee-lobby-v0.md`. Nothing in those is redefined here; this
document only says how a screen may consume them.

---

## 1. Layers

| Object | Kind | Lives in |
| --- | --- | --- |
| **Founder Workspace content** | derived read model, recomputed per read | `packages/experience/` |
| **Workspace screen** | presentation of that projection | `apps/workspace/` (static shell + client) |
| **Selection, open panels, zoom, nav view** | presentation only, invented by the UI | the UI, never Runtime |
| **Transport state** (`CONNECTING` / `LIVE` / `RUNTIME_UNAVAILABLE`) | the client's own link state | the client, never a Company or Employee state |
| **Runtime truth** | Company / Work / Task / Assignment / Employee / Review / Repair / Decision | `packages/runtime/` |

Four rules decide every question below:

1. **The Workspace is not Runtime.** It holds no kernel, opens no database,
   derives no Company fact of its own. Between two polls the screen may be
   stale; Runtime is always right.
2. **Canvas != Runtime truth.** The canvas is a visualization of durable facts:
   nodes exist because Runtime facts exist. Attention, delivery and workforce
   summary cards may be dragged or reordered for presentation only. A drag
   never runs a command or changes a Work, Employee, Artifact or Founder
   decision. No x/y/width/height/zIndex is persisted.
3. **UI state != Company truth.** Selection, Inspector, zoom, nav view, open
   panels and card positions live in the browser's memory. They are never
   written to the Runtime and never persisted.
4. **Transport is not Company state.** `RUNTIME_UNAVAILABLE` means the client
   could not read; it never changes an Employee's availability, a Work's status
   or a Delivery's accepted state. A failed read keeps the last known
   projection, visibly marked as not fresh, and never substitutes demo data.

## 2. Truth, and only truth

Reads (all GET, all bounded, all derived per request):

- `GET /experience/companies/:id/workspace` — the single source for company,
  runtime status, attention, primary Work, workforce summary, optional Founder
  assistant, recent deliveries
  and pulse. Polled on a fixed interval (v0: ~2 s) and replaced whole.
- `GET /experience/employees/:id` — the Employee Inspector.
- `GET /experience/works/:id/lineage` — the Work Inspector.
- `GET /companies` — discovery of Company identity only. It is never used to
  derive Company runtime state.

Selected Employee/Work detail is re-read when the projection's basis changes
(attention, primary Work, on-duty cards, deliveries, pulse) — not on every poll.
There is no cache, no optimistic mutation, no event-by-event patching and no
SSE/WebSocket in v0C. Loading the Workspace creates **no** Activity and no
business row: every projection is a pure read.

## 3. Vocabulary

`founderAssistant` is `null` unless an actual Employee's Position carries the
`founder.assistant` capability. When present, identity, position and availability
come from the same workforce derivation as the Employee Lobby. The homepage
companion offers only read-only summaries and navigation to existing details;
it cannot chat, decide, assign or perform commands. Its opening state is
presentation only.

The screen renders frozen Experience values through fixed product language:
`AVAILABLE` / `WORKING` / `DISABLED` → 空闲 / 工作中 / 已停用; roles
`EXECUTION` / `REVIEW` / `REPAIR` → 执行中 / 审核中 / 返工中; Work status, stage,
Task state, WorkerRun state, verdicts and accepted states likewise. `ONLINE`,
`OFFLINE`, `IDLE`, `DISCONNECTED` and `FAILED` do not exist here. Unknown values
fail closed to neutral phrases — a raw Runtime identifier is never rendered as
product language. `MULTIPLE_ACTIVE_RUNS` renders as a check-needed diagnostic,
never as a fourth availability.

## 4. Needs You (read-only in v0C)

`workspace.attention` is the only attention source. It stays a Runtime
projection: the screen creates no unread counter, no dismissal, no local
lifecycle and no notification table. The bubble appears only while
`attention.count > 0` and disappears when Runtime truth changes.

The panel shows each item's kind, Work, conditions and the actions the Runtime
currently offers. **It executes none of them in v0C.** This is a recorded gap,
not a hidden button: the bounded attention view deliberately carries
`{kind, effect}` and not the `artifactId` / `artifactDigest` / `basis` binding
`acceptWork` requires, and the client will not reconstruct that binding from
lower-level endpoints. Wiring ACCEPT belongs to the Founder Decision UI
milestone and must extend the Experience projection, not bypass it.

## 5. No write path

The Workspace owns no command. It contains no `/commands`, no POST, no assign,
no start, no review, no repair and no acceptance — not hidden, absent.

`+ 新建 Work` is an honest disabled affordance. The kernel command `createWork`
exists, but the product flow — Founder defines Work, FlowCredit plans and
coordinates it — is not closed yet; exposing a Work that the Runtime cannot
decompose into Tasks would fake completeness. That flow is a later milestone
and never a UI-side backend change.

The only product relationship is the link from the AI Workforce widget to the
merged Employee Lobby (`/employees`), where the Founder's single authority act
(`setEmployeeEnabled`) already lives.

## 6. Placeholders

`Work` (list), `Hiring`, `Artifacts`, `Knowledge` and `Settings` are honest
placeholder views: an Apple-style statement of what will open later, no fake
candidates, counts or sample artifacts. `Workspace` and `AI Employees` are the
implemented areas; the navigation keeps the distinction visible without
cluttering the interface.

## 7. Frozen test surface

`tests/unit/workspace-domain.test.mjs`, `tests/unit/workspace-adapter.test.mjs`
and `tests/unit/workspace-source.test.mjs` freeze the screen: full Runtime
vocabulary coverage, fail-closed mapping, store replacement and transport
separation, the exact Experience read paths, the absence of every write path,
LIVE-only source (no demo), honest placeholders and the ban on raw execution
fields. `tests/integration/workspace-http.test.mjs` freezes the live journey
against a real Runtime process: the static shell, the origin gate, the `/`
redirect, the decision-ready projection (attention, primary Work, deliveries,
pulse, Reviewer PASS ≠ accepted), Employee/Work detail reads, the no-Activity
guarantee, the empty canvas and the `FLOWCREDIT_WORKSPACE_UI=0` switch.

Deterministic fixtures for this surface live in
`tests/support/workspace-fixture.mjs` and are built through canonical Runtime
commands only: no model, no storage write, no invented history.

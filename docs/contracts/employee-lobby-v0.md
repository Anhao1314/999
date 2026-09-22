# Contract — Employee Lobby v0 (Runtime-backed UI Integration)

Status: **frozen semantics for the Lobby v0 integration slice.** It freezes one
idea and nothing more:

> The Employee Lobby is a presentation client of the Workforce Experience v0A
> projections. It shows Runtime truth; it never becomes Runtime.

Protocol additions: **none.** The Lobby reads three GET projections and is
allowed exactly one Founder write, `setEmployeeEnabled`, which is an authority
act and not a coordination act. Not covered (later milestones): Founder
Workspace production UI, company-level activity feed, Hiring, Genesis, Canvas
persistence, Laya, Jev, General A2A, dynamic allocation, schedulers.

Builds on `docs/contracts/workforce-experience-v0.md` (v0A). Nothing in it is
redefined here; this document only says how a screen may consume it.

---

## 1. Layers

| Object | Kind | Lives in |
| --- | --- | --- |
| **Workforce / Employee / Work-lineage projection** | derived read model, recomputed per read | `packages/experience/` |
| **Lobby screen** | presentation of that projection | `apps/employee/` (static shell + client) |
| **Seat, table, x/y, walk animation** | presentation only, invented by the UI | the UI, never Runtime |
| **Transport state** (`CONNECTING` / `LIVE` / `RUNTIME_UNAVAILABLE`) | the client's own link state | the client, never an Employee state |
| **`?demo=1` data** | labelled synthetic simulator | the client, never persisted |
| **Assignment / WorkerRun / Review** | Runtime facts, rendered only | `packages/runtime/` |

Four rules decide every question below:

1. **The Lobby is not Runtime.** It holds no kernel, opens no database, derives
   no fact of its own. Between two polls the screen may be stale; Runtime is
   always right.
2. **Availability is not transport.** `WORKING` means a WorkerRun is open.
   `RUNTIME_UNAVAILABLE` means the client could not read. The second never
   changes the first, and a failed read never degrades an Employee into a
   different state.
3. **Rendering is fail closed.** An unknown availability, role or activity kind
   is not displayed as a new state and never as a raw Runtime identifier.
4. **One authority act, no coordination.** Enabling or disabling an Employee is
   a Founder authority act. Assigning, starting, reviewing, repairing and
   accepting are not reachable from this UI at all.

---

## 2. Truth, and only truth

Reads (all GET, all bounded, all derived per request):

- `GET /experience/companies/:id/workforce` — the roster, summary and each
  member's derived `availability` / `currentWork` / `condition` / `execution`.
- `GET /experience/employees/:id` — the member card.
- `GET /experience/works/:id/lineage` — the read-only work line.

The client polls on a fixed interval (v0: 2 s). There is no cache, no
optimistic mutation and no locally invented Employee. If the canonical company
is not known yet, the client reads the company list once and then polls the
workforce projection. When a read fails:

- the Lobby keeps the **last known projection**,
- stops animations,
- disables writes,
- states plainly that Runtime is unavailable and that transport state is not
  Employee state.

It never substitutes demo data for a failed live read. Demo data appears only
when it was explicitly requested with `?demo=1`.

---

## 3. Vocabulary

| Runtime projection | Lobby |
| --- | --- |
| `availability: AVAILABLE / WORKING / DISABLED` | 空闲 / 工作中 / 已停用 (verbatim, no fourth state) |
| `currentWork.role: EXECUTION / REVIEW / REPAIR` | 执行中 / 审核中 / 返工中 |
| `condition: MULTIPLE_ACTIVE_RUNS` | 执行状态异常，需要检查 + explanatory banner |
| Activity kinds (`WORKER_RUN_STARTED`, `task.created`, …) | fixed product phrases; unknown kinds render a neutral phrase |

`founderBoundary` from the lineage projection is rendered as the Founder 边界
block: a `REQUEST_REVISION` → repair → `PASS` story ends at
`waitingForFounder: true` with `decision: null` until the Founder accepts
through the Runtime command seam. The Lobby never writes an outcome, and a
Reviewer PASS is never drawn as an acceptance.

---

## 4. The single write

```
POST /commands { command: "setEmployeeEnabled", input: { employeeId, enabled } }
```

- It is an **authority** act (Founder controls who works for the company), not a
  scheduling act. Enable/disable never creates an Assignment.
- It is reachable only from the member card's 员工控制 view, and only through
  the same origin-gated command seam every other Founder command uses
  (`LOCAL_ORIGIN_REQUIRED`).
- Everything else the Lobby shows is read-only. `assignTask`,
  `startWorkerRun`, `requestReview`, `acceptWork` and every other command are
  absent from the client, from the adapter and from the static shell — not
  merely hidden in the UI.

In LIVE mode the Lobby is therefore never a scheduler: `Founder 组建团队，
FlowCredit 调度团队` — the Lobby lets the Founder look, and lets the Founder
enable or disable a person; the Runtime decides what work exists and who runs
it.

---

## 5. Demo mode

`/employees?demo=1` renders a synthetic adapter with the same read-model shape:
one company, seats, a labelled feed, a fake interruption control. It writes
nothing, calls no model, and is visibly labelled as a simulation. Leaving the
query string leaves the mode; there is no way for a live session to degrade into
demo and no way for demo data to appear unannounced.

---

## 6. What the Lobby must never contain

- a kernel, a store handle, SQL, a second Employee table or a second lifecycle;
- `/employee-api/*`-style projection routes owned by the UI app: the shell
  serves static files, nothing else;
- any assignment, start, claim, retry, review or acceptance from the UI;
- raw `WorkerRun` ids, session ids, PIDs, prompts or artifact bodies;
- a Todo / Inbox / read-flag object: attention belongs to the Runtime
  projection, rendered as a view, never re-implemented as UI state;
- a company-level activity feed it does not have: when the v0A Experience
  surface does not project it, the Lobby says so instead of inventing one.

---

## 7. Known gap (v0A), recorded not fixed

The Experience v0A surface has no company-level activity projection. The Lobby
therefore renders an explicit gap statement in LIVE mode and keeps its local
feed only in demo mode. Adding that projection is a later milestone; it must
arrive as a Runtime-derived read, never as a UI-side event log.

---

## 8. Frozen minimal test surface

`tests/unit/employee-domain.test.mjs`, `tests/unit/employee-adapter.test.mjs`
and `tests/unit/employee-lobby-source.test.mjs` freeze the client: availability
and role vocabulary, transport separated from Employee state, adapter endpoint
and command usage, fail-closed mapping, poll-failure behaviour and the source
prohibitions above. `tests/integration/employee-http.test.mjs` freezes the LIVE
journey against a real Runtime process: static shell, cross-origin refusal,
absence of the legacy projection API, AVAILABLE / WORKING / DISABLED,
EXECUTION / REVIEW / REPAIR, `MULTIPLE_ACTIVE_RUNS`, the Founder boundary in the
work line, the enable/disable control and the no-legacy-state-words guarantee.

# Founder Workspace module

The product homepage, hosted by the existing loopback Runtime at `/workspace`
(`/` redirects there). It adds no runtime dependency, no scheduler, no provider
integration and no database migration.

## Boundaries

- `server.mjs`: static asset allowlist for the page. It holds no kernel and
  mounts no route that reads or writes Company truth; the loopback-origin gate
  is shared with the Employee Lobby (`apps/local-origin.mjs`).
- `adapter.mjs`: every browser read; the frozen Workforce Experience API is the
  only source. It owns **no write path at all** — no `/commands`, no POST.
- `domain.mjs`: the screen's read model and product vocabulary. Transport state
  (`CONNECTING` / `LIVE` / `RUNTIME_UNAVAILABLE`) is kept strictly apart from
  Company truth; unknown Runtime values fail closed to neutral product phrases.
- `app.mjs`: canvas composition, Needs-You panel, selection-driven Inspector,
  local search over already loaded data, presentation-only zoom. Selection and
  layout live in memory and are never persisted.
- `styles.css`: macOS/Apple-inspired shell — glass only on the top layer (top
  bar, Inspector, Needs-You, overlay controls), solid surfaces for the primary
  Work, large whitespace, weak borders. Pixel portraits reuse the Lobby's
  assets (`/employee-assets/assets/portrait-*.png`); no binaries are copied.

## Truth rules

- The homepage renders `workspace.primaryWork`, `workspace.attention`,
  `workspace.workforce`, `workspace.recentDeliveries` and `workspace.pulse`
  from one projection: `GET /experience/companies/:companyId/workspace`,
  polled every ~2 s. It never reconstructs those semantics from lower-level
  endpoints, and it never patches Company truth event by event.
- The Canvas is a visualization, not an editor: lineage nodes exist because
  Runtime facts exist. Nothing on the page can assign, start, review, repair
  or accept Work. Where the Runtime offers a Founder action (for example
  `ACCEPT`), the Needs-You panel shows it read-only; v0C never executes it.
- Unfinished navigation areas (Work list, Hiring, Artifacts, Knowledge,
  Settings) are honest placeholders with no invented data.
- There is no demo mode: a failed read keeps the last known projection, marked
  as not fresh, and never substitutes synthetic data.

## Current limits

- Company-level Activity is not projected (v0A gap, recorded not fixed).
- Canvas positions and zoom are not persisted; there is no drag interaction.
- `+ 新建 Work` is a disabled affordance: the Founder Work-definition flow
  (creating Work and letting FlowCredit decompose/coordinate it) is a later
  milestone, not a v0C backend change.
- ACCEPT is not executable from the page yet: the bounded attention view does
  not carry the decision binding (`artifactId` / `artifactDigest` / `basis`)
  that `acceptWork` requires, and the client will not reconstruct it from
  lower-level endpoints. This is a recorded gap for the Founder Decision UI
  milestone.

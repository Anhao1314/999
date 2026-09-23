# Founder Workspace module

The product homepage, hosted by the existing loopback Runtime at `/workspace`
(`/` redirects there). It adds no runtime dependency, no scheduler, no provider
integration and no database migration.

## Boundaries

- `server.mjs`: static asset allowlist for the page. It holds no kernel and
  mounts no route that reads or writes Company truth; the loopback-origin gate
  is shared with the Employee Lobby (`apps/local-origin.mjs`).
- `adapter.mjs`: every browser read. The homepage uses the frozen Workforce
  Experience projection; the Work page enumerates the existing read-only
  `/companies/:id/works` inventory and reads each Work's Experience lineage.
  It owns **no write path at all** — no browser command requests.
- `domain.mjs`: the screen's read model and product vocabulary. Transport state
  (`CONNECTING` / `LIVE` / `RUNTIME_UNAVAILABLE`) is kept strictly apart from
  Company truth; unknown Runtime values fail closed to neutral product phrases.
- `app.mjs`, `subpages.mjs`, `placement.mjs` and `board-layout.mjs`: canvas and
  Founder subpage composition,
  anchored summary and detail bubbles, bounded card placement, local search
  over already loaded data, and presentation-only zoom.
  Selection and layout live in memory and are never persisted.
- Home navigation opens a bounded floating dialog over the Canvas. AI Employees
  runs in a same-origin embedded view inside it; Work, Deliverables, Hiring,
  Company Memory and Settings share a responsive subpage shell. Escape and the close button
  restore focus to the triggering option, and unsaved Employee edits ask before
  the outer dialog closes. The source option lifts while the backdrop blurs;
  the dialog expands and contracts in about 0.2 s, and reduced-motion mode
  removes that movement. Direct `/employees` navigation remains available.
- `styles.css` and `assets/alpine-wallpaper.png`: the Company Canvas visual
  composition from PR #6, with a pale blue alpine background, translucent
  shell, spacious Work center and compact surrounding cards. Pixel portraits
  reuse the Lobby's assets (`/employee-assets/assets/portrait-*.png`).

## Truth rules

- The homepage renders `workspace.primaryWork`, `workspace.attention`,
  `workspace.workforce`, `workspace.recentDeliveries` and `workspace.pulse`
  from one projection: `GET /experience/companies/:companyId/workspace`,
  polled every ~2 s. It never reconstructs those semantics from lower-level
  endpoints, and it never patches Company truth event by event.
- The Canvas is a visualization, not an editor: lineage nodes exist because
  Runtime facts exist. Nothing on the page can assign, start, review, repair
  or accept Work. Where the Runtime offers a Founder action (for example
  `ACCEPT`), the attention detail shows it read-only; v0C never executes it.
- Attention, recent deliveries and on-duty workforce appear as three movable
  cards on the right side of the Canvas. A click opens a small summary; a
  double-click opens a bounded detail page. Dragging or Alt+Arrow moves a card
  within the desktop canvas. Compact views use a horizontal reorderable tray;
  phone widths keep the tray behind the More menu so it does not cover Work.
  These changes affect presentation only and never write to Runtime.
- A Founder-facing assistant appears as a small animated pixel Employee when
  the Runtime workforce includes a Position with `founder.assistant`. Its
  single-click bubble summarizes real attention and the Employee's current
  status; double-click opens the normal Employee detail. The art reuses the
  Lobby's original sprite sheets. There is no simulated chat or decision.
- Work and Deliverables show only Runtime/Experience facts. Deliverables is
  scoped to the projection's recent-delivery window. Hiring and Company Memory
  are labelled PROTOTYPE throughout; Memory shows an honest empty seam until
  real candidates, sources and acceptance records are available.
- A failed read keeps the last known projection, marked as stale, and never
  substitutes synthetic live data.

## Living Company Canvas

- The first screen leads with an honest company moment, then Needs You, the
  current Work, its recorded participants and lineage, and a short company
  account. Needs You takes precedence over employee activity when both exist.
- Work lineage shows exact Artifact versions and the recorded review or repair
  target. The bounded action trail is derived from that lineage. It does not
  claim tool execution, source verification, dependency satisfaction or
  company learning, because these facts are not in this projection.
- Company Pulse is narrative text derived from the same workspace projection;
  absent fields remain unknown. Memory and Evolution have a visible seam but
  no fabricated candidate or growth metric.
- Primary navigation is Company, Work, Employees, Memory and Settings. Hiring
  and Deliverables remain accessible under More. Presentation view uses the
  same projection and hides secondary navigation, draggable cards and canvas
  controls; it creates no alternate data source.
- An Evolution moment will need a Runtime candidate identity, explicit
  candidate/not-active status, linked Work/Review/Repair evidence, version
  difference, evaluation and governance. None is projected today, so the
  homepage shows only an empty boundary. Relay Sense/Jev also has no Founder
  projection here; future sensing belongs in evidence detail and never implies
  authority to dispatch, review or accept Work.

## PR #6 visual translation

The prototype's wallpaper, glass, card placement, portrait treatment and
Inspector hierarchy are visual references. Its local draft Work, demo
employees, fabricated tests and metrics, sample deliveries, message affordance
and mock status are absent. The production welcome names the real Company
instead of assuming a Founder identity or greeting. Needs You shows only
Runtime attention; its zero state is explicit. Primary Work may be absent while
the workforce, deliveries and pulse still render their real empty or counted
states. Pulse translates actual Runtime facts into short lines, without invented trends.
Work, Employee and Delivery details open only after selection in a bounded
dialog near the triggering card. The attention view remains read-only. Search
highlights the keyboard-selected result and opens
the same detail dialog. Escape, outside click and the close button dismiss
these surfaces; focus returns to the source or its surviving region. Reduced
motion replaces spatial transitions with brief fades. The Work flow wraps
vertically on phones. Zoom is presentation-only and limited to 80–100% on
desktop so it cannot crop the canvas.

## Current limits

- Company-level Activity is not projected (v0A gap, recorded not fixed).
- Canvas card positions and zoom are not persisted across app restarts.
- `+ 新建 Work` opens a local intent composer, while its submit action remains
  disabled until a safe product command boundary is available. Draft text is
  presentation state only and is not saved.
- ACCEPT is not executable from the page yet: the bounded attention view does
  not carry the decision binding (`artifactId` / `artifactDigest` / `basis`)
  that `acceptWork` requires, and the client will not reconstruct it from
  lower-level endpoints. This is a recorded gap for the Founder Decision UI
  milestone.

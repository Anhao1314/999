# AI employee module

An additive module hosted by the existing loopback Runtime at `/employees`. It adds no runtime dependency, scheduler, provider integration or database migration.

## Boundaries

- `server.mjs`: same-process read projection, bounded public activity pagination, a small command adapter and static asset allowlist. It calls existing Kernel operations and does not choose work or employees autonomously.
- `adapter.mjs`: all live browser requests; serial full-snapshot polling with abort/timeout cleanup. A persisted Activity head is a snapshot revision, **not** a contiguous event cursor. Older snapshots cannot replace newer ones.
- `domain.mjs`: shared store, six display-only rooms with stable seats, separate Employee/Run/Task/connection/visual state, unknown usage and crop geometry.
- `app.mjs`: lobby, roster, accessible native dialogs, inline settings/assignment/history, keyboard and history boundaries. Public text uses DOM text nodes.
- `avatar.mjs`: local file MIME/magic/size checks. The browser decodes and crops; output is an in-memory PNG preview, never a server upload or persistent asset.
- `demo.mjs`: explicitly requested `?demo=1` synthetic adapter. No HTTP writes. Demo config versions, command delays, guarded archive and message animations are not production capabilities.
- `styles.css`: all styles are scoped under the employee page or `fc-` classes.

## Employee continuity

The live employee card groups evidence by time: recent deliveries and public
activity, current Work and role, then the boundary for future capability
evidence. These are bounded Experience reads, not a complete employee history.
Provider, model, execution backend, identifiers and position capability
definitions sit in a collapsed technical disclosure. A position capability is
not presented as earned capability evidence, and no future Work match is
invented. The production lobby no longer advertises the separate synthetic
demo link; `?demo=1` remains an explicitly labelled direct test route.

## Provenance

The supplied `ai_employee_codex_kit` (core algorithms and pixel atlas/portraits) is the source of the adapted seat/crop logic and 16 geometric placeholder PNGs. The supplied license notes authorize team modification; no third-party game assets, fonts or reference branding are included. These are placeholder portraits/sprites, not final character artwork. The prototype website was not copied or embedded. No code was imported from the old FlowCredit worklab repositories.

## Current limits

The live Kernel has no model execution, profile/config versions, message/tool events, usage meter, safe-point pause, durable command receipts, upload storage or archive/tombstone transaction. Those live controls are disabled. Enabling/disabling changes eligibility for future dispatch; it does not pause an active run.

Module commands use a bounded in-memory idempotency cache (512 entries, this process only), synchronous confirmation and no automatic retry. After an uncertain response or restart, re-read state before acting; this is not durable exactly-once delivery. Assignment preserves an expected assignment ID; starting checks current assignment again. Production authentication and multi-user authorization remain the team's responsibility; local origin/Host checks are not a login system.

Native dialogs maintain their origin focus. Only the top modal responds to Back/Esc. DOM animation is visual only and cannot start or stop a run. WorkerRun status follows Runtime; offline state stops animation without rewriting that status.

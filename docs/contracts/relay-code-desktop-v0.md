# Relay Code Desktop v0

## Identity

- External product name: **Relay Code**
- Internal Runtime name: **FlowCredit Runtime**
- Bundle identifier: `com.flowcredit.relaycode`
- Desktop package: `apps/desktop/`
- Packaged application: `Relay Code.app`

Renaming the desktop product never renames FlowCredit company, work, workforce or
Runtime semantics.

## Architecture

```text
Relay Code Desktop Shell
  -> Founder Workspace
  -> Workforce Experience
  -> FlowCredit Runtime
  -> Worker Harness
```

The Desktop Shell owns process lifecycle. The FlowCredit Runtime owns Company
lifecycle. Electron is not a second Runtime, database owner or scheduler.

## Process Contract

- One Desktop process owns at most one FlowCredit Runtime child process.
- The Runtime is started with `FLOWCREDIT_PORT=0`; the actual dynamic loopback
  port is taken from the Runtime ready line.
- Readiness is proven twice: the ready line plus a real `/health` probe that
  must answer `{ "status": "ok" }`. A bound process is not a ready Runtime.
- Startup and shutdown are bounded. Startup failure shows a generic product
  dialog; raw stack traces stay on stdout.
- Runtime state is rooted at `app.getPath("userData")/runtime` for packaged
  launches and `userData/runtime-dev` for development launches, never inside
  the application bundle. A dev session cannot consume the product database.
- The packaged Runtime is loaded from
  `Contents/Resources/runtime-bundle/apps/runtime/server.mjs`; a repository
  checkout is not required at runtime.
- The Desktop Shell sends `SIGTERM` and waits for Runtime shutdown before the
  application exits. A bounded force-kill is only the fallback.
- A second Desktop launch exits and focuses the existing window. It never starts
  a second Runtime.
- The Desktop Shell starts, probes, supervises and stops the Runtime process.
  It never sends business commands (`/commands`): no assignment, WorkerRun,
  review, repair, acceptance or direct Company-truth mutation.

## Window Contract

- The initial URL is the Runtime's `/workspace`.
- Same-origin navigation, including `/employees`, remains available.
- BrowserWindow uses `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`, `webSecurity: true` and `webviewTag: false`.
- New windows, webviews and permission requests are denied. External HTTP(S)
  links leave the desktop shell instead of replacing Runtime content.
- Navigation is limited to the active Runtime origin.
- The renderer has no Node, filesystem, `child_process`, SQLite or environment
  bridge.

## Packaging Contract

- `relay-code-master.png` is the frozen source. Its SHA-256 is pinned and
  verified before icon generation; the master is never recolored, cropped or
  overwritten.
- `RelayCode.icns` is a **generated artifact** produced by macOS `sips` and
  `iconutil` from that master. The committed source of truth is the master PNG
  plus `scripts/generate-icon.mjs`; the `.icns` itself is not committed.
- The bundle advertises `CFBundleIconFile = RelayCode.icns` and the packaged
  icon resource is normalised to that name.
- The packaged runtime bundle contains `apps/runtime`, `apps/workspace`,
  `apps/employee`, `apps/local-origin.mjs` and `packages`.
- Packaging removes stale `dist/` output, stages the runtime bundle from the
  repository, then audits the finished bundle for SQLite files, `.git`, logs and
  absolute developer checkout paths before it reports success.
- `build/`, `dist/`, `node_modules/` and the packaged `Relay Code.app` are
  generated outputs and stay gitignored. Only source, tests, contract and
  dependency metadata are committed.

## Menu Contract

- App: About, Hide, Quit (plus the standard macOS hide-others/unhide roles).
- File: `New Work` stays disabled while deferred, then Close Window.
- View: Full Screen. DevTools appears only in unpackaged development runs and
  is absent from packaged launches by default.

## Presentation Contract

Desktop loads the unmodified Workspace: no `?desktop=1` style flag, no forked
Workspace business logic, no Desktop-specific Experience semantics and no
simulated window chrome or custom drag regions to maintain.

## Build Honesty

- Desktop v0 is an unsigned, unnotarized local development build. It makes no
  production distribution, notarization or auto-update claim.
- The packaged app is smoke-tested with the Worker backend switched off. Real
  Codex CLI discovery from a Finder launch is **not** proven:
  `CODEX_BACKEND_FROM_DESKTOP=NOT_VERIFIED`. This is future work, not a Desktop
  v0 correctness blocker.
- macOS-first: only the darwin packaging path is implemented.

## Out of Scope

Desktop v0 does not add Company Genesis, Founder Decision UI, Hiring, Knowledge,
Canvas persistence, a scheduler, another database or any new Runtime truth.

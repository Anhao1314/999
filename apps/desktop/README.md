# Relay Code Desktop Shell

Relay Code is the external desktop product for FlowCredit. It owns the process
lifecycle of one FlowCredit Runtime; it does not own Company truth.

```text
Relay Code Desktop Shell
  -> Founder Workspace (/workspace)
  -> Workforce Experience
  -> FlowCredit Runtime
  -> Worker Harness
```

## Boundaries

- `src/main.mjs` owns one secure BrowserWindow, one Runtime child process and
  one application instance. It loads `/workspace` by default and permits
  same-origin navigation to `/employees`.
- `src/runtime-lifecycle.mjs` starts the Runtime on an ephemeral loopback port
  and stops it gracefully. The Runtime always receives `FLOWCREDIT_PORT=0`; the
  Desktop Shell learns the actual port from the Runtime ready line.
- `src/worker-backend-discovery.mjs` resolves the local Worker backend the
  Runtime should use. A Finder-launched application inherits no developer
  `PATH`, so discovery resolves a bounded set of candidates (explicit
  `FLOWCREDIT_CODEX_BIN`, the process `PATH`, well-known macOS locations, known
  application bundles), validates the file and probes it with `codex --version`
  through a direct spawn. `src/runtime-environment.mjs` then passes the resolved
  absolute path to the Runtime as `FLOWCREDIT_CODEX_BIN`. No shell profile is
  sourced, no shell is involved, and the executable path never reaches the
  renderer.
- A ready line is not enough: startup also probes `/health` and requires
  `{ "status": "ok" }` before the Workspace is loaded. Startup and shutdown are
  bounded, and a failed start shows a generic dialog rather than a stack trace.
- Runtime state is stored under `app.getPath("userData")/runtime` for packaged
  launches and `userData/runtime-dev` in development, always outside the `.app`
  bundle and outside the repository checkout.
- The Runtime source is copied into `Contents/Resources/runtime-bundle` during
  packaging. The packaged app does not require a repository checkout.
- Browser content has no Node integration. `contextIsolation`, Chromium
  sandboxing and web security remain enabled; permissions and new windows are
  denied, and navigation is restricted to the active Runtime origin.

## Commands

```sh
npm install
npm start
npm test
npm run spike:electron
npm run icon
npm run package
```

`npm run package` creates:

```text
dist/Relay Code-darwin-<arch>/Relay Code.app
```

## Backend discovery

Contract: [Desktop Worker Backend Discovery v0](../../docs/contracts/desktop-worker-backend-discovery-v0.md).

On this kind of install the Desktop Shell can discover the Codex binary in the
ChatGPT application bundle and run real Work through it without sourcing a
shell profile or exporting a `PATH`. That result was verified on one specific
macOS environment with a LaunchServices launch, not for every Mac or install
shape.

Real-provider verification is local and manual only, never part of `npm test`:

```sh
node scripts/desktop-codex-discovery-smoke.mjs --mode execution
node scripts/desktop-codex-discovery-smoke.mjs --mode quit
```

Both modes mutate only a disposable fixture under `TMPDIR` and use an isolated
`userData` directory.

The application bundle identifier is `com.flowcredit.relaycode`. The external
product name is `Relay Code`; the internal Runtime and domain remain
`FlowCredit`.

## Icon

`assets/relay-code-master.png` is the frozen source image; `npm run icon`
verifies its pinned SHA-256 and generates `build/RelayCode.icns` through macOS
`sips` and `iconutil`. The `.icns` is a generated artifact and is not committed;
`build/` and `dist/` stay gitignored.

## Status

Desktop v0 is an unsigned, unnotarized macOS development build. Real Codex CLI
discovery from a Finder launch is not verified.

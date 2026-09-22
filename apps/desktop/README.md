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

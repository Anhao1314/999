# Contract — Desktop Worker Backend Discovery v0

**Status: implemented and locally verified (2026-09-23) on the verified macOS
environment against the locally installed `codex-cli
0.155.0-alpha.9.2`.**

The discovery proof is a LaunchServices launch of the packaged `Relay Code.app`
with no developer `PATH` and no shell profile, plus one real Worker attempt
executed end to end and one real active-Worker Quit. Real-provider smoke is
local and manual: it is never part of `node --test` or CI.

Depends on: [Relay Code Desktop v0](relay-code-desktop-v0.md) ·
[Worker Harness v0](worker-harness-v0.md) ·
[CodexExecAdapter v1](codex-exec-adapter-v1.md).

This contract covers one question and its consequences:

> Is a Worker backend executable locally available to a Finder-launched Relay
> Code, and what exactly is that answer allowed to change?

It does not restate how a WorkerRun becomes a `codex exec` child. That is
`codex-exec-adapter-v1.md`.

## 1. Identity

- Desktop package: `apps/desktop/`
- Discovery module: `apps/desktop/src/worker-backend-discovery.mjs`
- Runtime environment composition: `apps/desktop/src/runtime-environment.mjs`
- Override environment variable: `FLOWCREDIT_CODEX_BIN`
- Manual real-provider smoke: `scripts/desktop-codex-discovery-smoke.mjs`

```text
Relay Code.app (LaunchServices)
  -> DesktopWorkerBackendDiscovery   which local executable is available
  -> Runtime startup environment     FLOWCREDIT_CODEX_BIN, absolute path only
  -> FlowCredit Runtime              Company control, unchanged
  -> WorkerHost                      execution ownership, unchanged
  -> CodexExecAdapter                provider-specific execution, unchanged
```

## 2. Backend discovery is infrastructure

Discovery answers exactly one question: *is this backend executable locally
available?* It resolves a candidate, validates it, probes it, and returns a
bounded result. It never executes Work, never chooses an Employee, Task,
assignment or Permission, and never writes Company truth.

```text
Backend discovery != scheduler
Backend availability != Employee availability
Executable path != Employee identity
Executable path != Company truth
```

An available backend grants nothing. The Runtime still decides which Task is
dispatchable, which Employee is eligible and whether a WorkerRun starts.

## 3. Employee is not the backend

`Codex` is an intelligence resource the Harness rents for one attempt. Finding
the executable does not make it an Employee, does not change Employee identity,
status, capability or availability, and does not create a WorkerRun.

## 4. Discovery result

```js
{
  backendType: "codex-exec",
  available: true,
  executablePath: "/absolute/path/to/codex",  // as configured
  resolvedPath: "/absolute/real/path",        // what is executed
  version: "0.155.0-alpha.9.2",
  discoveredBy: "EXPLICIT_OVERRIDE | PATH | STANDARD_LOCATION | KNOWN_APP_BUNDLE | NONE",
  checkedAt: "<ISO timestamp>",
  rejections: [ /* bounded, capped candidate rejections */ ],
}
```

The result is process-local infrastructure state. It is never persisted as Work
truth, Employee identity or Company configuration.

The absolute executable path never reaches the renderer. Experience may keep
showing only the bounded backend identity/version already in its contract.

## 5. Discovery policy

Resolution precedence:

1. `FLOWCREDIT_CODEX_BIN` — explicit operator override
2. inherited GUI process `PATH`
3. well-known macOS locations
4. bounded product-specific known application bundles

Each source is bounded and auditable. Candidate directories are read with a
fixed entry budget, duplicates are dropped by resolved real path, and the
recorded rejection list is capped.

Resolution is completed by the first candidate that validates, probes and
reports a recognisable version.

## 6. Explicit override

`FLOWCREDIT_CODEX_BIN=/absolute/path/to/codex`

- absolute path only
- no shell parsing, no whitespace splitting, no embedded arguments
- no `~` or `$VAR` expansion
- validated before use (exists, regular file, executable, resolvable)
- fails closed: an unusable override stops the Runtime with a clear message and
  is never silently replaced by an automatic candidate

This is a provider-specific executable path, never a generic arbitrary command.

## 7. Candidate validation

The candidate's file name is never evidence.

- absolute path required; control characters rejected
- must exist and be a regular file; directories are rejected
- must be executable (`X_OK`)
- the resolved real path is validated and is what a caller executes
- a legitimate package-manager or application-bundle symlink stays legal
- a bounded direct spawn of the candidate with `--version` is the only probe
- probe output is capped and the probe is bounded by a timeout
- a candidate that cannot be probed or reports nothing recognisable is rejected

## 8. No shell, ever

- no `zsh -lc`, `bash -lc`, `source ~/.zshrc`, `source ~/.profile`
- no `eval`, no shell interpolation, no `shell: true`, no `/bin/sh -c`
- the user's interactive shell environment is never imported
- the probe and the worker child are direct spawns with an explicit argv

A GUI process is not given a terminal's profile, only the current process
environment plus the narrow configuration named here.

## 9. Runtime configuration seam

The Desktop composes the Runtime child's environment. When discovery found a
usable `codex-exec` executable, it adds:

```text
FLOWCREDIT_CODEX_BIN=<resolved absolute path>
```

When it did not, the operator's own override is forwarded untouched and no
path is invented. Existing execution configuration
(`FLOWCREDIT_CODEX_REPO`, base revision, verification command, protected paths,
evidence directory, worker timeout) passes through unchanged.

The Runtime's `codex-exec` backend resolves `FLOWCREDIT_CODEX_BIN` at startup
and falls back to the literal `codex` command when the variable is absent, so
non-Desktop development and CI behavior is unchanged.

## 10. LaunchServices proof requirement

A backend-resolution claim for the packaged product requires a genuine
LaunchServices/Finder-style launch of `Relay Code.app` — `open` with no
manually injected developer `PATH` and no shell-profile setup — followed by a
successful `codex --version` probe and a real Worker attempt.

Launching Electron directly from a terminal is development evidence, not the
packaged-product proof. The manual smoke script is the harness for that proof:

```sh
node scripts/desktop-codex-discovery-smoke.mjs --mode execution
node scripts/desktop-codex-discovery-smoke.mjs --mode quit
```

## 11. Real-provider smoke is local and manual

- never imported by `node --test`, never part of the default CI path
- needs no repository credentials and writes none
- mutates only a disposable fixture under `TMPDIR`, never the FlowCredit
  checkout or this worktree
- uses an isolated `userData` directory
- labels itself as real-provider execution
- keeps real model usage to the minimum: one execution scenario and one
  active-run Quit scenario

Deterministic discovery and shutdown tests run in CI instead, with fake
executables and a controlled fake adapter child.

## 12. Process ownership

```text
Desktop    = Process Lifecycle     supervises the Runtime process
Runtime    = Company Control       owns WorkerRun truth and interruption
WorkerHost = Execution Ownership    owns adapter handles and cancellation
Adapter    = Provider Execution    owns exactly one provider child
```

On application Quit the Desktop asks the Runtime to stop gracefully. The
Runtime stops the WorkerHost, the WorkerHost cancels every attempt it is
holding through `WorkerAdapter.cancel`, and the adapter terminates its own
child with a bounded escalation. Durable interruption is committed by the
Runtime before the process exits.

The Desktop never scans for, and never kills, arbitrary user Codex processes.
Only the exact child processes owned by the Runtime it started are terminated,
identified by PID lineage from that Runtime process.

## 13. Work continuity across the Desktop lifecycle

The Desktop is a lifecycle, not an identity. Quitting it must never destroy
Work:

- Work, Tasks, Artifacts and WorkerRun history stay in the durable store
- an interrupted WorkerRun is recorded with the existing Runtime interruption
  reason; no new reason is invented for host shutdown
- a relaunched Desktop opens the same store, rediscovers the backend and needs
  no manual repair
- a stale generation cannot submit a result or an Artifact after relaunch
- `Work persists. Workers come and go.` holds under Desktop Quit

## 14. Renderer authority

The renderer has no backend discovery authority and no filesystem or `PATH`
access. It cannot choose a backend, name an executable, inspect discovery
rejections or trigger a probe. Backend discovery stays in the Desktop main
process and configures the Runtime process it starts.

## 15. Bounded evidence in logs

Desktop discovery logs the bounded backend identity: backend type, availability,
discovery source, resolved path and version. Environment inspection logs only
bounded facts (path entry count, presence flags) and redacts anything whose name
contains `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `AUTH` or `CREDENTIAL`. No full
environment and no credentials are ever recorded.

## 16. Out of scope

- no backend settings UI, no version support matrix
- no bundling of a private Codex binary into Git
- no modification of system shell profiles or global installations
- no automatic model authority: discovery never decides that Work may run

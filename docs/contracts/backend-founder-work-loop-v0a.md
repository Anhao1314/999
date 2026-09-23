# Backend Founder Work Loop v0A — product command and local execution context

This slice lets a Founder-level local caller state one Work intent. It does not
implement Company Genesis, Hiring, Founder ACCEPT, Relay, Laya, Knowledge or
MCP. `createCompany` plus the existing idempotent `bootstrapWorkforce` are
bootstrap/MVP support only.

## Authority and transport

`POST /product/commands` accepts exactly `{ "command": "CreateFounderWork",
"input": { "requestId", "companyId", "title", "intent", "contextId" } }`.
Extra input keys are rejected, including Employee, WorkerRun, generation,
reviewer, Artifact, repair, next action and executable fields. The body is
limited to 16 KiB, JSON only, on same-origin loopback. The route is an explicit
whitelist. Unknown product commands fail. `GET /product/execution-context`
returns `{ available, contextId }` so a caller can confirm the active local
project before creating Work. There is no cloud authentication claim.

`POST /commands` remains the legacy Kernel transport for local engineering
and tests. Browser-origin writes to it are rejected except the existing
Employee Lobby's `setEmployeeEnabled` command. It is not a Founder product
authority; a future Founder UI uses only `/product/commands`. The exception is
existing Lobby behavior and should move to a product command in a later slice.
Experience routes remain GET-only and derive from Runtime truth.

## Creation and idempotency

`requestId` is a caller-generated stable identifier. The Kernel stores Work and
its immutable execution binding in one transaction. A replay with the same
request and identical normalized Company, title, intent and context returns the
original Work with `replayed: true`. A changed intent or context with the same
request returns `FOUNDER_WORK_REQUEST_CONFLICT`. A missing Company or invalid
input creates nothing. Founder chooses intent; the existing Continuation Driver
and deterministic NextActionProposer materialize Tasks. Assignment, WorkerRun,
result, review and repair remain Runtime/Harness actions.

## Local execution binding

The current backend has one configured repository per Runtime process. For
`codex-exec`, it is `FLOWCREDIT_CODEX_REPO`; for deterministic `test-worker`
proof it is `FLOWCREDIT_PRODUCT_REPO`. The product context resolver requires
the path to be a Git root and resolves the configured base revision to a commit
at creation. `contextId` is a SHA-256 fingerprint of the canonical local root
path; the Work binding stores that fingerprint and pinned commit, never the
absolute path. It is local execution provenance, separate from Company,
Employee and Work identity. `WorkerExecutionBinding` remains the distinct
per-attempt record of a run workspace and backend.

An executing Runtime checks all Founder Work bindings before the Driver or
WorkerHost starts. Another repository, missing configured context, missing
pinned commit or Driver without a Worker backend refuses active startup. The
WorkerHost resolver uses the Work's pinned commit for each attempt; legacy
Kernel-created Work retains the legacy static resolver. A Runtime with
coordination off may open the store without executing. One process supports one local project in v0A;
multi-project dispatch needs an explicit future resolver and mapping.

## Runtime profile

Default coordination and backend remain `off`. CreateFounderWork requires
`FLOWCREDIT_COORDINATION=driver`, a selected Worker backend and a valid Git
context. `codex-exec` also retains its executable/version verification and
adapter controls. `GET /product/execution-context` reports profile readiness,
not Employee availability. Backend availability is not Employee availability; a Work
without eligible enabled employees can persist and wait. Merely opening Relay
Code or this Runtime with defaults never invokes Codex. Enabling the executing
profile allows the existing Driver to act on committed Work; it is an explicit
operator choice, not an implicit UI launch side effect.

## Proof boundary

`node scripts/demo-founder-work-v0a.mjs` uses a real Runtime child process,
real SQLite store, `createCompany`, `bootstrapWorkforce`, product HTTP route,
Continuation Driver and deterministic test Worker. It checks creation,
assignment, WorkerRun, Artifact, review, idempotency, invalid input, unknown
Company, command injection, origin gate, unavailable profile, HEAD advancing
between two creates, immutable pinning, and restart with a matching, wrong or
missing-history repository. It runs no Codex process. Mid-flight
interruption and generation recovery remain the existing Kernel/Harness path.

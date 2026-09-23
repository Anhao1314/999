# Founder Workspace product integration v1

The production Workspace UI is rebased onto the current Runtime and retains
the visual Founder Workspace v0C composition. This slice connects one existing
product command, `CreateFounderWork`; it adds no planner, scheduler, permission
model, provider, ResultContract or second Runtime.

## Command boundary

1. The browser reads `GET /product/execution-context` and enables submission
   only when `available` is true, the Runtime connection is live and both
   bounded fields are present. A ready context means the operator configured
   the existing Continuation Driver, Worker backend and local Git project. It
   does not claim that an Employee is available.
2. Immediately before sending, the browser reads the execution context again.
   It sends exactly `requestId`, `companyId`, `title`, `intent` and `contextId`
   in the existing `CreateFounderWork` product command. Title is required and
   limited to 160 characters; intent is required and limited to 2000.
3. Runtime owns Work creation, the immutable execution binding, Task planning,
   assignment, WorkerRun, independent review and repair. The Workspace reads
   resulting facts from Experience projections and the Work inventory/lineage.
   It never posts a raw `/commands` write to start or coordinate Work.
4. A response that does not confirm creation keeps the original request ID
   and locks the draft to an identical retry. The Founder may inspect the Work
   list and explicitly begin a new request. Drafts and request IDs exist only
   in page memory; after an app restart, inspect the Work list before trying
   the same goal again.

The Desktop's executing profile remains an explicit operator choice. The
default profile is `off`, so opening the app cannot start a Worker. The UI
reports this accurately and keeps submission unavailable.

## Read and authority boundaries

The Canvas, Work list, Employee detail and Deliverables continue to render
Runtime/Experience facts. Hiring and Company Memory remain marked prototypes.
Founder ACCEPT is not yet exposed through a bounded product command or a
decision binding in the Experience projection, so the UI keeps its decision
actions disabled. Reviewer PASS remains distinct from Founder acceptance.

The app shell owns its process and secure navigation; it does not execute
commands, hold the Kernel or decide which Employee works. Employee Lobby's
existing enable/disable exception remains unchanged.

## Verification

`tests/integration/workspace-founder-work.test.mjs` starts a real Runtime
process with a deterministic test Worker, submits through the Workspace HTTP
adapter, observes one Work, two WorkerRuns, a reviewed Artifact, and a Founder
decision still pending. Workspace unit/source tests freeze the single product
write and read projection boundaries. A manual browser check verifies the
composer is disabled in the default profile and submits in an executing test
profile.

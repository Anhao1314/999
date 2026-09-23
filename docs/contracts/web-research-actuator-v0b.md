# Web Research Actuator v0B — read-only source observation

This slice gives the existing GenericModelWorkerAdapter two Relay capabilities:
`research.web.search` discovers bounded candidate URLs, and `research.web.read`
observes one public HTTP(S) URL. It introduces no Employee, Product Research
artifact, Runtime source table, company memory or permission system. An
Actuator's availability does not authorize its use; the Host must still issue
an explicit run/generation-bound ToolGrant through AuthorizedToolSession.

## Search and read contracts

`SearchProvider.search({ query, limit, signal })` returns at most five bounded
candidate records `{ url, title?, snippet? }`. Providers own their own external
request, must honor AbortSignal and must never pass credentials to the model.
There is no production SearchProvider in v0B. Search results contain no
`sourceId` and never create SourceObservation.

`WebReader.read({ url, signal })` performs only unauthenticated GET. The default
transport uses Node HTTP(S) with explicit noncredential headers, no proxy or
cookie forwarding, and DNS address pinning. URL parsing rejects userinfo,
nonstandard ports, unsupported schemes, local/internal/metadata hosts and
nonpublic IP literals. Before *every* connection, it resolves the hostname,
rejects the whole answer set if any address is nonpublic, and pins one validated
address. Each redirect is parsed and checked again; it never inherits approval
from the previous hop. Production A/AAAA resolution is cancelled on abort.
HTTPS retains normal hostname and certificate checks.

Limits: three redirects, eight seconds end to end, 8 KiB headers, 128 KiB raw
response, 16 KiB extracted text, 2 KiB URL and five search results. Only
`text/html` and `text/plain` with identity content encoding are observed.
Unsupported or oversized responses fail without a source. HTML extraction is
plain text only; no scripts, browser state, login, cookies or forms execute.

After a successful read, WebResearchActuator returns the bounded observation
without an ID. AuthorizedToolSession validates it, mints an unpredictable
`src_` ID and adds it to the `TOOL_RESULT` and the matching successful receipt.
The model cannot supply an ID in read input. The SourceObservation includes
`sourceId`, canonical URL, observed title if present, timestamp, digest of the
raw response bytes and bounded extracted text. Host evidence keeps source ID,
receipt call ID, origin, full URL digest, content digest and timestamp; it does
not persist the page, URL path/query or provider output. Evidence is bounded
to 32 KiB. The source list is absent for existing non-Web Actuators, preserving
their v2 evidence shape and digest inputs. Runtime continues to receive only its existing evidence digest and
result submission fields. Product Research v0C should validate any
domain-specific source references at the Host output-postcondition boundary:
compare candidate references with this run's Host-observed source registry
before Runtime submission, and reject an unobserved reference with
`WORKER_OUTPUT_REJECTED`. Generic WorkerResult does not need a sourceIds field.
Model-written strings that resemble source IDs remain assertions in result
content, never SourceObservation evidence.

## Failure and cancellation

Malformed requests and model-supplied source IDs are protocol errors. URL,
DNS, HTTP, provider and size failures are execution failures with a bounded
Host evidence subtype. Host or reader timeout maps to `WORKER_TIMEOUT`; a
protocol-valid final candidate rejected by Host remains
`WORKER_OUTPUT_REJECTED`. Host.stop and timeout propagate AbortSignal through
the model, session, provider and active HTTP request. A cancelled request
returns no tool result or source. The provider contract requires its own
implementation to stop external work on abort; no real provider is bundled.

`scripts/smoke-web-read-v0b.mjs` is manual, local-only and forbidden in CI. It
requires `FLOWCREDIT_WEB_READ_SMOKE_URL`, uses a synthetic nonpersistent tool
session to verify Host-side source minting, and reports only bounded metadata.
The normal suite uses fake provider, DNS and transport seams and makes no
external network calls.

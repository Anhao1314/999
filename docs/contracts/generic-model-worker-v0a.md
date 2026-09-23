# Generic Model Worker v0A — implementation candidate for freeze review

This slice adds one bounded model/tool loop inside one existing WorkerRun. It
does not add a WorkerRun state, a ResultContract, a provider session, or a
database table. The existing Host remains the only caller of Runtime delivery
and interruption commands.

## Execution boundary

`WorkerAdapter.start(input, context)` accepts an optional
`context.authorizedToolSession`. The value is run-scoped, non-serializable and
never enters WorkerRunInput. Existing adapters receive the same context as
before. `GenericModelWorkerAdapter` compiles fresh messages from the durable
WorkPacket and the Runtime-selected ResultContract, calls a provider-neutral
`ModelBackend.invoke({ messages, tools, resultContract, abortSignal })`, and
returns one final candidate through the existing `wait()` result.

The model step vocabulary is `TOOL_REQUEST`, `FINAL_RESULT`, `PROVIDER_ERROR`.
`TOOL_REQUEST` contains a unique callId, a capability name and bounded input.
The Adapter sends it to the Host-created AuthorizedToolSession. The session
checks the grant, budget, cancellation and actuator support before calling the
Actuator. It returns a bounded `TOOL_RESULT` to the Adapter; only the Adapter
adds that result to the next model step. The model never receives credentials.

## Authority and budget

`toolPolicy` is a trusted WorkerHost composition input. Its
`approvedCapabilities` is an explicit, static approval fixture for this slice,
not a persistent Founder permission system or a production authorization path.
No policy means no tool session. A ToolGrant is bound to WorkerRun id and
generation and contains only the intersection of approved capabilities, Skill
allowed tools and available Actuators when the Skill's required organizational
capabilities appear in both the Task requirements and Position. Capability or
Actuator availability alone never grants permission.

ToolBudget bounds total calls, calls per capability, elapsed time and single
tool call time. Input, output and compiled model context also have byte limits.
Only a valid, granted request that begins Actuator dispatch consumes the
execution call budget, whether that dispatch later succeeds or fails. A denied,
malformed, unsupported or over-budget request consumes no execution call, but
closes the session. At most 32 dispatched calls plus one terminal refusal can
appear as receipts. No tool call proceeds after a failed check. Model and Actuator implementations
must honor AbortSignal; Host.stop and Host timeout abort both boundaries. A
future real Actuator must prove that its external work is actually terminated.

## Results, failure and evidence

`FINAL_RESULT.candidate` goes to the existing Host parser. ARTIFACT_DELIVERY
still creates exactly one Runtime Artifact; REVIEW_JUDGMENT still creates a
Runtime Review from the exact review WorkPacket. Neither is Founder approval.

Malformed requests, duplicate call IDs and invalid final candidates map to
`WORKER_PROTOCOL_ERROR`. Tool and provider failures without a usable final
candidate map to `WORKER_EXECUTION_FAILED`; timeouts map to `WORKER_TIMEOUT`.
The same reason replaces the older Host mapping of a valid WorkerResult with
`outcome: FAILED` to `WORKER_PROCESS_EXIT`; a reported failure does not prove a
child process exited.
The specific tool or provider code stays in bounded Host-side Evidence v2 and
the Host report; interruption still persists only the coarse Runtime reason. A Host
stop preserves the existing recovery contract: the run remains RUNNING until
Runtime reopen records `PROCESS_INTERRUPTED`.

HarnessEvidence v2 adds a Host-observed ToolGrant digest, ToolBudget and bounded
tool receipts, plus Adapter-reported model and Skill versions, step count,
duration and input/output digests. It also binds the normalized final result
digest submitted to Runtime. The v1 digest formula remains byte-identical for
historical v1 evidence; Runtime stores only its existing digest/summary fields
and needs no migration. Raw prompts, tool output, reasoning and
credentials are absent. Runtime receives only the evidence digest and its
existing bounded submission fields.

## Deterministic proof and limits

`tests/integration/generic-model-worker.test.mjs` exercises fake search,
fake read, final Artifact delivery, Review judgment, approval denial, total
and per-capability budgets, malformed/duplicate requests, provider failure,
invalid final output, model timeout, tool timeout, and stop/recovery during a
model call, an active tool call and the gap after a tool result. It also proves
that REQUEST_REVISION enters the existing Repair continuation, and that the
new failure reason obeys the existing three-attempt retry budget.
TestModelBackend and FakeActuator perform no network access.
There is no Web, MCP, Product Research Employee, Skill registry, UI or
persistent model session in this slice.

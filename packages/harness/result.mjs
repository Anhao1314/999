// WorkerResult and HarnessEvidence — two different things, never one array.
// Contract: docs/contracts/worker-harness-v0.md §5, §15–§17.
//
//   WorkerResult    = what the Worker reports about its own attempt.
//   HarnessEvidence = what the Host observed about the execution.
//
// Neither is approval. A WorkerResult SUCCEEDED is not an accepted Task; a
// Host observation is not a verification verdict. The Host parses the result
// and submits only what the Runtime command accepts.
import { BOUNDS, digestOf } from "../work/records.mjs";
import { REVIEW_VERDICT_VALUES } from "../workforce/reviews.mjs";

export const WORKER_RESULT_VERSION = 1;
export const WORKER_REVIEW_RESULT_VERSION = 1;
export const HARNESS_EVIDENCE_VERSION = 1;
export const WORKER_RESULT_OUTCOMES = Object.freeze(["SUCCEEDED", "FAILED"]);
export const WORKER_REVIEW_VERDICTS = Object.freeze([...REVIEW_VERDICT_VALUES]);

const RESULT_KEYS = Object.freeze([
  "resultVersion",
  "outcome",
  "summary",
  "completionClaim",
  "reportedVerification",
  "blockers",
  "proposedArtifacts",
  "suggestedNextActions",
]);

export const HARNESS_BOUNDS = Object.freeze({
  summaryMax: 2000,
  blockerMax: 500,
  blockersMax: 20,
  artifactTitleMax: 200,
  artifactKindMax: 48,
  artifactContentMax: 100 * 1024,
  nextActionsMax: 5,
  nextActionMax: 300,
  eventKindsMax: 32,
});

const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const boundedText = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max;

// The Host's parsing boundary. Production adapters may hand over a raw payload
// plus their own parse result; the Host only accepts a payload that parses to a
// complete, bounded WorkerResult. Anything else is WORKER_PROTOCOL_ERROR.
export function parseWorkerResult(raw) {
  if (!isPlainObject(raw)) return { ok: false, reason: "worker result is not a structured object" };
  for (const key of Object.keys(raw))
    if (!RESULT_KEYS.includes(key))
      return { ok: false, reason: `unknown worker result field: ${key}` };
  if (raw.resultVersion !== undefined && raw.resultVersion !== WORKER_RESULT_VERSION)
    return { ok: false, reason: `unsupported worker result version: ${raw.resultVersion}` };
  if (!WORKER_RESULT_OUTCOMES.includes(raw.outcome))
    return { ok: false, reason: `unknown worker result outcome: ${raw.outcome}` };
  if (!boundedText(raw.summary, HARNESS_BOUNDS.summaryMax))
    return { ok: false, reason: "the worker result carries no bounded summary" };
  for (const field of ["completionClaim", "reportedVerification"]) {
    const value = raw[field];
    if (value !== undefined && value !== null && !boundedText(value, HARNESS_BOUNDS.summaryMax))
      return { ok: false, reason: `${field} must be a bounded string when present` };
  }
  const blockers = raw.blockers ?? [];
  if (!Array.isArray(blockers) || blockers.length > HARNESS_BOUNDS.blockersMax)
    return { ok: false, reason: "blockers must be a short list" };
  if (blockers.some((entry) => !boundedText(entry, HARNESS_BOUNDS.blockerMax)))
    return { ok: false, reason: "every blocker must be a bounded string" };
  const proposedArtifacts = raw.proposedArtifacts ?? [];
  if (!Array.isArray(proposedArtifacts))
    return { ok: false, reason: "proposedArtifacts must be a list" };
  for (const artifact of proposedArtifacts) {
    if (!isPlainObject(artifact)) return { ok: false, reason: "a proposed artifact must be an object" };
    if (!boundedText(artifact.kind, HARNESS_BOUNDS.artifactKindMax))
      return { ok: false, reason: "a proposed artifact requires a bounded kind" };
    if (!boundedText(artifact.title, HARNESS_BOUNDS.artifactTitleMax))
      return { ok: false, reason: "a proposed artifact requires a bounded title" };
    if (!boundedText(artifact.content, HARNESS_BOUNDS.artifactContentMax))
      return { ok: false, reason: "a proposed artifact requires bounded content" };
    if (
      artifact.supersedesArtifactId !== undefined &&
      artifact.supersedesArtifactId !== null &&
      typeof artifact.supersedesArtifactId !== "string"
    )
      return { ok: false, reason: "supersedesArtifactId must be an id or absent" };
  }
  const nextActions = raw.suggestedNextActions ?? [];
  if (!Array.isArray(nextActions) || nextActions.length > HARNESS_BOUNDS.nextActionsMax)
    return { ok: false, reason: "suggestedNextActions must be a short list" };
  if (nextActions.some((entry) => !boundedText(entry, HARNESS_BOUNDS.nextActionMax)))
    return { ok: false, reason: "every suggested next action must be a bounded string" };
  return {
    ok: true,
    result: Object.freeze({
      resultVersion: WORKER_RESULT_VERSION,
      outcome: raw.outcome,
      summary: raw.summary,
      completionClaim: raw.completionClaim ?? null,
      reportedVerification: raw.reportedVerification ?? null,
      blockers: Object.freeze([...blockers]),
      proposedArtifacts: Object.freeze(
        proposedArtifacts.map((artifact) =>
          Object.freeze({
            kind: artifact.kind,
            title: artifact.title,
            content: artifact.content,
            supersedesArtifactId: artifact.supersedesArtifactId ?? null,
          }),
        ),
      ),
      suggestedNextActions: Object.freeze([...nextActions]),
    }),
  };
}

// The identity of a delivered result: what the Worker reported, exactly. The
// Runtime binds it durably at delivery time.
export function workerResultDigest(result) {
  return digestOf(
    JSON.stringify({
      resultVersion: result.resultVersion,
      outcome: result.outcome,
      summary: result.summary,
      completionClaim: result.completionClaim,
      reportedVerification: result.reportedVerification,
      blockers: [...result.blockers],
      proposedArtifacts: result.proposedArtifacts.map((artifact) => ({
        kind: artifact.kind,
        title: artifact.title,
        content: artifact.content,
        supersedesArtifactId: artifact.supersedesArtifactId,
      })),
      suggestedNextActions: [...result.suggestedNextActions],
    }),
  );
}

// WorkerReviewResult — what a Reviewer Worker reports about the one exact
// Artifact its WorkPacket named. It is a Worker judgment, never Founder
// approval, and never a Review: the Runtime writes the Review from this report
// through its one Review primitive.
export const REVIEW_RESULT_KEYS = Object.freeze([
  "schemaVersion",
  "workerRunId",
  "generation",
  "verdict",
  "findings",
  "summary",
]);

// The Host's parsing boundary for a Reviewer result. Same discipline as
// parseWorkerResult: the provider-specific extraction belongs to the adapter,
// the provider-neutral schema validation belongs here, and anything else is a
// protocol error rather than Runtime truth.
//
// `summary` stays optional on the wire — a Worker may omit it — but a judgment
// delivered to this Runtime must carry one, because the frozen Review primitive
// requires a bounded summary and the Harness never invents Review text.
export function parseWorkerReviewResult(raw) {
  if (!isPlainObject(raw))
    return { ok: false, reason: "worker review result is not a structured object" };
  for (const key of Object.keys(raw))
    if (!REVIEW_RESULT_KEYS.includes(key))
      return { ok: false, reason: `unknown worker review result field: ${key}` };
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== WORKER_REVIEW_RESULT_VERSION)
    return { ok: false, reason: `unsupported worker review result version: ${raw.schemaVersion}` };
  if (typeof raw.workerRunId !== "string" || raw.workerRunId.length === 0)
    return { ok: false, reason: "the worker review result does not name its WorkerRun" };
  if (!Number.isInteger(raw.generation) || raw.generation < 0)
    return { ok: false, reason: "the worker review result does not name its generation" };
  if (!WORKER_REVIEW_VERDICTS.includes(raw.verdict))
    return { ok: false, reason: `unknown review verdict: ${JSON.stringify(raw.verdict)}` };
  const findings = raw.findings ?? [];
  if (!Array.isArray(findings) || findings.length > BOUNDS.reviewFindingsMax)
    return { ok: false, reason: "findings must be a short list" };
  if (findings.some((finding) => !boundedText(finding, BOUNDS.reviewFindingMax)))
    return { ok: false, reason: "every finding must be a bounded string" };
  if (raw.verdict === "REQUEST_REVISION" && findings.length === 0)
    return { ok: false, reason: "a REQUEST_REVISION judgment must say what has to change" };
  const summary = raw.summary ?? null;
  if (summary !== null && !boundedText(summary, BOUNDS.reviewSummaryMax))
    return { ok: false, reason: "summary must be a bounded string when present" };
  return {
    ok: true,
    result: Object.freeze({
      schemaVersion: WORKER_REVIEW_RESULT_VERSION,
      workerRunId: raw.workerRunId,
      generation: raw.generation,
      verdict: raw.verdict,
      findings: Object.freeze([...findings]),
      summary,
    }),
  };
}

// The identity of one delivered judgment, exactly as parseWorkerReviewResult
// returned it. The Runtime binds these bytes durably at delivery time.
export function workerReviewResultDigest(result) {
  return digestOf(
    JSON.stringify({
      schemaVersion: result.schemaVersion,
      workerRunId: result.workerRunId,
      generation: result.generation,
      verdict: result.verdict,
      findings: [...result.findings],
      summary: result.summary,
    }),
  );
}

// Host-observed evidence. This object stays Host-side / in test artifacts; the
// Runtime persists only its digest and a bounded verification summary.
export function buildHarnessEvidence({
  run,
  processOutcome,
  events = [],
  resultParse,
  reportedVerification = null,
  containment,
  observedAt,
}) {
  const eventKinds = Object.freeze(
    [...new Set(events.map((event) => event.kind))].sort().slice(0, HARNESS_BOUNDS.eventKindsMax),
  );
  const payload = Object.freeze({
    evidenceVersion: HARNESS_EVIDENCE_VERSION,
    workerRunId: run.id,
    generation: run.generation,
    taskId: run.taskId,
    processOutcome,
    eventCount: events.length,
    eventKinds,
    resultParse,
    // "REPORTED" means the Worker said so; the Host performed no independent
    // verification in this slice, and the evidence says exactly that.
    verification: Object.freeze(
      reportedVerification
        ? { status: "REPORTED", summary: reportedVerification }
        : { status: "NOT_PERFORMED", summary: null },
    ),
    containment: Object.freeze({
      sandboxMode: containment.sandboxMode,
      workspaceRoot: containment.workspaceRoot,
      scratchRoot: containment.scratchRoot,
      knownLimitations: Object.freeze([...(containment.knownLimitations ?? [])]),
    }),
    observedAt,
  });
  return Object.freeze({ ...payload, evidenceDigest: harnessEvidenceDigest(payload) });
}

export function harnessEvidenceDigest(evidence) {
  return digestOf(
    JSON.stringify({
      evidenceVersion: evidence.evidenceVersion,
      workerRunId: evidence.workerRunId,
      generation: evidence.generation,
      taskId: evidence.taskId,
      processOutcome: evidence.processOutcome,
      eventCount: evidence.eventCount,
      eventKinds: [...evidence.eventKinds],
      resultParse: evidence.resultParse,
      verification: {
        status: evidence.verification.status,
        summary: evidence.verification.summary,
      },
      containment: {
        sandboxMode: evidence.containment.sandboxMode,
        workspaceRoot: evidence.containment.workspaceRoot,
        scratchRoot: evidence.containment.scratchRoot,
        knownLimitations: [...evidence.containment.knownLimitations],
      },
      observedAt: evidence.observedAt,
    }),
  );
}

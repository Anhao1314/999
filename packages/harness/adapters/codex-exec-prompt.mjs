// Prompt and result-schema compilation for the Codex execution backend.
// Contract: docs/contracts/codex-exec-adapter-v1.md §Prompt compilation.
//
// The prompt is an execution artifact composed ONLY from committed Runtime
// facts: the durable WorkPacket and the run envelope. It names the role for
// this attempt, the objective, the success criteria, the assigned workspace,
// the expected result schema and the prohibited external effects. It carries
// no company history, no chain-of-thought request and no other Work's facts.
import { RESULT_CONTRACT_KINDS } from "../worker-run-input.mjs";
import { REVIEW_VERDICT_VALUES } from "../../workforce/reviews.mjs";

export const ARTIFACT_REPORT_KEYS = Object.freeze([
  "outcome",
  "summary",
  "completionClaim",
  "reportedVerification",
  "blockers",
]);

export const REVIEW_REPORT_KEYS = Object.freeze(["verdict", "findings", "summary"]);

const ARTIFACT_MAX = 2000;
const BLOCKER_MAX = 500;
const FINDING_MAX = 1000;

// The model reports the attempt; the Harness records identity and lineage.
// No run id, artifact id or review id is ever requested from the model.
export function artifactReportSchema() {
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["outcome", "summary"],
    properties: Object.freeze({
      outcome: Object.freeze({ type: "string", enum: Object.freeze(["SUCCEEDED", "FAILED"]) }),
      summary: Object.freeze({ type: "string", minLength: 1, maxLength: ARTIFACT_MAX }),
      completionClaim: Object.freeze({ type: "string", maxLength: ARTIFACT_MAX }),
      reportedVerification: Object.freeze({ type: "string", maxLength: ARTIFACT_MAX }),
      blockers: Object.freeze({
        type: "array",
        maxItems: 20,
        items: Object.freeze({ type: "string", maxLength: BLOCKER_MAX }),
      }),
    }),
  });
}

export function reviewReportSchema() {
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["verdict", "findings", "summary"],
    properties: Object.freeze({
      verdict: Object.freeze({ type: "string", enum: Object.freeze([...REVIEW_VERDICT_VALUES]) }),
      findings: Object.freeze({
        type: "array",
        maxItems: 50,
        items: Object.freeze({ type: "string", maxLength: FINDING_MAX }),
      }),
      summary: Object.freeze({ type: "string", minLength: 1, maxLength: ARTIFACT_MAX }),
    }),
  });
}

export function codexReportSchemaFor(kind) {
  return kind === RESULT_CONTRACT_KINDS.REVIEW_JUDGMENT
    ? reviewReportSchema()
    : artifactReportSchema();
}

export const ARTIFACT_REPORT_EXAMPLE =
  '{"outcome":"SUCCEEDED","summary":"Implemented the validation; the repository tests pass.","reportedVerification":"node --test"}' +
  " (drop reportedVerification/blockers/completionClaim when you have nothing truthful to put there)";

export const REVIEW_REPORT_EXAMPLE =
  '{"verdict":"PASS","findings":[],"summary":"The patch implements the documented behavior and the tests pass."}';

const list = (items, fallback) =>
  items.length > 0 ? items.map((entry) => `- ${entry}`).join("\n") : `- ${fallback}`;

function shortRevision(sha) {
  return typeof sha === "string" && sha.length > 12 ? sha.slice(0, 12) : String(sha ?? "unknown");
}

function artifactSection(review) {
  const artifact = review.targetArtifact;
  const content = typeof artifact.content === "string" ? artifact.content : "";
  return [
    `- Artifact: ${artifact.kind} "${artifact.title}"`,
    `- Artifact id: ${artifact.id} · generation ${artifact.generation} · recorded digest ${artifact.contentDigest}`,
    `- Reviewed digest binding: ${review.reviewedDigest}`,
    "- The artifact content is a unified diff against the base revision.",
    "",
    "```diff",
    content,
    "```",
  ].join("\n");
}

function repairSection(repair) {
  if (!repair) return null;
  return [
    "REPAIR CONTEXT",
    `- A reviewer asked for changes to an earlier delivery of this task (review ${repair.reviewId}).`,
    `- Reviewer summary: ${repair.reviewSummary}`,
    "- Reviewer findings that must be addressed:",
    list(repair.reviewFindings.map((finding) => String(finding)), "(the review recorded no explicit findings)"),
    `- The corrected result replaces artifact ${repair.supersedesArtifactId}; it is checked out from the base revision, so rebuild the change on top of the current workspace state.`,
  ].join("\n");
}

// ARTIFACT_DELIVERY — one execution or Repair attempt.
export function compileArtifactPrompt({ input, verification, protectedPaths, baseSha }) {
  const packet = input.workPacket;
  const workspaceRoot = input.executionBinding.workspaceRoot;
  const scratchRoot = input.executionBinding.scratchRoot;
  const repair = packet.repair ? repairSection(packet.repair) : null;
  return [
    "You are a worker inside a small software company's execution harness.",
    "You operate one isolated git workspace. You are non-interactive: nobody will answer a question, so decide and continue.",
    "",
    "ROLE",
    `- Employee: ${packet.employee.displayName} (${packet.position.title})`,
    `- Task: ${packet.task.title}`,
    `- Task intent: ${packet.task.intent}`,
    `- Work intent: ${packet.work.intent}`,
    `- Required capabilities: ${packet.requirements.requiredCapabilities.join(", ") || "(none recorded)"}`,
    "",
    "WORKSPACE",
    `- Read and write only inside: ${workspaceRoot}`,
    `- Temporary scratch directory: ${scratchRoot}`,
    `- The workspace is a fresh git checkout at revision ${shortRevision(baseSha)}.`,
    "",
    "SUCCESS CRITERIA",
    "- Implement the task intent in the workspace, following any documented requirements in the repository.",
    verification
      ? `- The repository's verification command will be run independently after you stop: \`${verification.command.join(" ")}\`. A failing verification means this attempt is not delivered.`
      : "- Leave the workspace in the state you believe satisfies the task; a harness check runs afterwards.",
    "- The delivered result is the workspace diff against the base revision: leave your change in the working tree. Do NOT commit, and do not leave the workspace unchanged — an empty change is not a deliverable.",
    protectedPaths.length > 0
      ? `- These paths are protected and compared byte-for-byte afterwards: ${protectedPaths.join(", ")}. Do not modify them.`
      : "- No protected paths are recorded for this attempt.",
    "",
    "PROHIBITED EFFECTS",
    "- No git commit, no git push, no remote change, no publishing and no deployment.",
    "- No edits outside the workspace and scratch directory; copy nothing elsewhere and run no cleanup commands against other paths — the sandbox refuses those, and a refused command can end your attempt.",
    "- No company decisions: you cannot accept, review, assign, repair or approve anything.",
    ...(repair ? ["", repair] : []),
    "",
    "FINAL ANSWER (required)",
    "- When finished, end your turn with exactly one JSON object and no other text — no markdown fences.",
    "- Required shape:",
    JSON.stringify(artifactReportSchema()),
    `- Example: ${ARTIFACT_REPORT_EXAMPLE}`,
    "- Report only what you actually did. The harness observes the workspace independently.",
  ].join("\n");
}

// REVIEW_JUDGMENT — one Review attempt.
export function compileReviewPrompt({ input, protectedPaths, baseSha }) {
  const packet = input.workPacket;
  const review = packet.review;
  const workspaceRoot = input.executionBinding.workspaceRoot;
  const scratchRoot = input.executionBinding.scratchRoot;
  return [
    "You are the reviewer inside a small software company's execution harness.",
    "You operate one isolated git workspace and you judge exactly one delivered artifact. You are non-interactive.",
    "",
    "ROLE",
    `- Employee: ${packet.employee.displayName} (${packet.position.title})`,
    `- Review task: ${packet.task.title}`,
    `- Review intent: ${packet.task.intent}`,
    `- Source task intent: ${review.sourceTask.intent}`,
    `- Work intent: ${packet.work.intent}`,
    `- Required capabilities: ${packet.requirements.requiredCapabilities.join(", ") || "(none recorded)"}`,
    "",
    "ARTIFACT UNDER REVIEW",
    artifactSection(review),
    "",
    "WHAT TO JUDGE",
    "- Does the artifact satisfy the source task's intent and the repository's documented requirements?",
    "- Is it correct and complete — no missing pieces, no broken behavior?",
    `- Inspect and test inside the workspace only: it is a fresh checkout at revision ${shortRevision(baseSha)}; apply ${scratchRoot}/artifact.patch there (git apply), run the repository's tests there, and judge the result.`,
    "- Do not copy the workspace elsewhere and do not run cleanup or deployment commands: the sandbox refuses writes outside the workspace, and a refused command can end your attempt without a judgment.",
    "- Judge only against the recorded intent and the repository's requirements; do not invent new requirements.",
    "",
    "RULES",
    "- Do not modify or \"fix\" the artifact; judge it as delivered.",
    "- No git commit, no git push, no publishing, no deployment.",
    protectedPaths.length > 0
      ? `- These paths are protected and compared byte-for-byte afterwards: ${protectedPaths.join(", ")}. Do not modify them.`
      : "- No protected paths are recorded for this attempt.",
    "",
    "FINAL ANSWER (required)",
    "- End your turn with exactly one JSON object and no other text — no markdown fences.",
    "- Required shape:",
    JSON.stringify(reviewReportSchema()),
    `- Example: ${REVIEW_REPORT_EXAMPLE}`,
    "- PASS only if the artifact is acceptable as delivered. REQUEST_REVISION requires concrete, actionable findings.",
  ].join("\n");
}

export function compileCodexPrompt({ input, verification = null, protectedPaths = [], baseSha }) {
  const kind = input.resultContract?.kind;
  if (kind === RESULT_CONTRACT_KINDS.REVIEW_JUDGMENT)
    return compileReviewPrompt({ input, protectedPaths, baseSha });
  return compileArtifactPrompt({ input, verification, protectedPaths, baseSha });
}

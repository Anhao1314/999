// Relay Sense v0: one bounded, provider-neutral reading and question pack.
// Signals are probabilistic observations; Runtime truth and authority stay
// with the Kernel, Continuation policy, Reviewer and Founder.
import { createHash } from "node:crypto";

export const RELAY_SENSE_STATE_VERSION = "v0";
export const RELAY_SENSE_QUESTION_PACK_VERSION = "v0";
export const MAX_RELAY_SENSE_STATE_BYTES = 8_192;
export const MAX_SYSTEM_ONE_RESPONSE_BYTES = 32_768;

export const RELAY_SENSE_QUESTIONS = Object.freeze({
  objectiveComplete: { type: "noul", instructions: "Does the available evidence indicate that the Work objective is substantively complete? Task completion and Reviewer PASS do not imply Founder acceptance." },
  actionableWorkExists: { type: "noul", instructions: "Does this state contain actionable Work that the Runtime can continue now?" },
  evidenceSufficient: { type: "noul", instructions: "Is the reviewed evidence sufficient for a Founder to make an informed decision?" },
  requiresFounder: { type: "noul", instructions: "Does this state require Founder attention or a Founder decision?" },
  blockerType: { type: "choice", instructions: "What is the most relevant blocker?", criteria: {
    NONE: "no blocker", CAPABILITY: "required employee capability is missing", AVAILABILITY: "eligible employee is unavailable", REVIEW: "review or repair is pending", DEPENDENCY: "an upstream dependency is incomplete", OTHER: "another blocker",
  } },
  continuationMode: { type: "choice", instructions: "Which continuation mode best describes the situation? This is an observation, not a command.", criteria: {
    CONTINUE: "Runtime can continue autonomously", WAIT: "wait for active work or prerequisites", REPAIR: "follow the existing review and repair path", FOUNDER: "Founder attention or decision is needed", STOP: "Work has ended",
  } },
  riskLevel: { type: "choice", instructions: "How much risk is indicated by the available evidence?", criteria: {
    LOW: "no material risk is evident", MEDIUM: "some uncertainty or incomplete evidence", HIGH: "material interruption, revision or blocker", UNKNOWN: "insufficient facts to assess risk",
  } },
});

const choiceValues = Object.fromEntries(Object.entries(RELAY_SENSE_QUESTIONS)
  .filter(([, question]) => question.type === "choice")
  .map(([name, question]) => [name, new Set(Object.keys(question.criteria))]));

function boundedText(value, limit = 240) {
  return typeof value === "string" ? value.slice(0, limit) : null;
}

// Only task and evidence summaries cross this boundary. No Artifact content,
// tool grant, employee configuration, credential or entire Runtime projection.
export function compileRelaySenseState({ decisionState, truth, boundary }) {
  const projection = truth.projection;
  const latestReview = projection.latestReview;
  const taskById = new Map(truth.tasks.map((task) => [task.id, task]));
  const artifactTaskIds = new Set(projection.artifacts.map((artifact) => artifact.taskId));
  const state = {
    version: RELAY_SENSE_STATE_VERSION,
    decisionState,
    workGoal: boundedText(truth.work.intent, 400),
    workStatus: projection.status,
    outcomeState: projection.outcome?.state ?? null,
    founderAttentionKind: projection.founderAttention?.item?.kind ?? null,
    actionAvailable: Boolean(boundary.action),
    actionCommand: boundary.action?.command ?? null,
    diagnosticCode: boundary.diagnostic?.code ?? null,
    taskCounts: projection.taskCounts,
    dependencyCount: Math.min(truth.dependencies.length, 16),
    dependencyStates: truth.dependencies.slice(0, 16).map((edge) => ({
      prerequisiteState: taskById.get(edge.prerequisiteTaskId)?.state ?? null,
      prerequisiteHasArtifact: artifactTaskIds.has(edge.prerequisiteTaskId),
      downstreamState: taskById.get(edge.taskId)?.state ?? null,
    })),
    artifactCount: Math.min(projection.artifacts.length, 16),
    reviewCount: Math.min(projection.reviews.length, 16),
    latestReview: latestReview ? {
      verdict: latestReview.verdict,
      summary: boundedText(latestReview.summary),
      findings: (latestReview.findings ?? []).slice(0, 3).map((finding) => boundedText(finding, 160)),
    } : null,
  };
  if (Buffer.byteLength(JSON.stringify(state), "utf8") > MAX_RELAY_SENSE_STATE_BYTES)
    throw new Error("Relay Sense state exceeds its input bound");
  return structuredClone(state);
}

export function relaySenseStateDigest(state) {
  return `sha256:${createHash("sha256").update(JSON.stringify(state), "utf8").digest("hex")}`;
}

export function validateRelaySenseSignals(signals) {
  if (!signals || typeof signals !== "object" || Array.isArray(signals) ||
      Object.keys(signals).length !== Object.keys(RELAY_SENSE_QUESTIONS).length)
    throw new Error("Relay Sense signals have the wrong shape");
  for (const [name, question] of Object.entries(RELAY_SENSE_QUESTIONS)) {
    const value = signals[name];
    if (question.type === "noul") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
        throw new Error(`Relay Sense ${name} is not a probability`);
    } else if (!choiceValues[name].has(value)) {
      throw new Error(`Relay Sense ${name} is not a known choice`);
    }
  }
  return Object.freeze({ ...signals });
}

export function parseRelaySenseAnswers(payload, { requireTypes = false } = {}) {
  const answers = payload?.answers;
  if (!answers || typeof answers !== "object") throw new Error("Sense response has no answers");
  const signals = {};
  for (const [name, question] of Object.entries(RELAY_SENSE_QUESTIONS)) {
    const answer = answers[name];
    if (!answer || typeof answer !== "object" || (requireTypes && answer.type !== question.type))
      throw new Error(`Sense response lacks typed ${name}`);
    signals[name] = question.type === "noul" ? answer.noul : answer.choice;
  }
  return validateRelaySenseSignals(signals);
}

export async function readBoundedSystemOneResponse(response) {
  if (!response.ok) {
    const error = new Error(`Sense HTTP ${response.status}`);
    error.code = response.status === 429 ? "RATE_LIMITED" :
      response.status === 408 || response.status === 504 ? "TIMEOUT" : "UNAVAILABLE";
    throw error;
  }
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_SYSTEM_ONE_RESPONSE_BYTES)
    throw new Error("Sense response exceeds its bound");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Sense response has no body");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SYSTEM_ONE_RESPONSE_BYTES) throw new Error("Sense response exceeds its bound");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

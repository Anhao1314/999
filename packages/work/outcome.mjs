// Derived Work outcome (pure): which Artifact can still become the accepted
// outcome of a Work, and what the Founder decided about it.
// Contract: docs/contracts/founder-attention-acceptance-v0.md §6–§7.
//
// Nothing here is stored. The outcome is a function of Artifacts (and their
// supersession links), Task states and the immutable Founder Decision.
export const OUTCOME_STATES = Object.freeze({
  NO_CANDIDATE: "NO_CANDIDATE",
  READY: "READY",
  AMBIGUOUS: "AMBIGUOUS",
  ACCEPTED: "ACCEPTED",
});

const byCreatedAt = (records) =>
  [...records].sort((a, b) =>
    a.createdAt === b.createdAt
      ? a.id.localeCompare(b.id)
      : a.createdAt.localeCompare(b.createdAt),
  );

// A current outcome candidate is an Artifact whose producing Task finished, at
// the generation that Task finished on, and that nothing in the Work has
// replaced. "Latest" is never consulted: the contract decides by supersession,
// never by recency.
//
// Historical evidence is not current outcome reality. An Artifact left behind
// by an abandoned or interrupted generation stays readable and immutable
// forever, but it can never become a candidate again once its Task moves on.
export function currentOutcomeCandidates({ tasks = [], artifacts = [] } = {}) {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const superseded = new Set(
    artifacts.map((artifact) => artifact.supersedesArtifactId).filter(Boolean),
  );
  return byCreatedAt(
    artifacts.filter((artifact) => {
      if (superseded.has(artifact.id)) return false;
      const producer = taskById.get(artifact.taskId);
      return (
        Boolean(producer) &&
        producer.state === "COMPLETED" &&
        artifact.generation === producer.generation
      );
    }),
  );
}

const candidateView = (artifact) => ({
  id: artifact.id,
  taskId: artifact.taskId,
  digest: artifact.contentDigest,
  supersedesArtifactId: artifact.supersedesArtifactId,
  generation: artifact.generation,
  createdAt: artifact.createdAt,
});

// The Founder Decision projected as durable facts only. Invocation metadata
// (such as whether the committing call was a retry) is never part of truth.
const acceptedView = (decision) => ({
  decisionId: decision.id,
  disposition: decision.disposition,
  artifactId: decision.artifactId,
  artifactDigest: decision.artifactDigest,
  decidedAt: decision.createdAt,
  basis: decision.basisSequence,
});

export function deriveOutcome({ tasks = [], artifacts = [], decision = null } = {}) {
  const candidateArtifacts = currentOutcomeCandidates({ tasks, artifacts });
  if (decision) {
    return {
      state: OUTCOME_STATES.ACCEPTED,
      candidateArtifacts: candidateArtifacts.map(candidateView),
      accepted: acceptedView(decision),
    };
  }
  const state =
    candidateArtifacts.length === 0
      ? OUTCOME_STATES.NO_CANDIDATE
      : candidateArtifacts.length === 1
        ? OUTCOME_STATES.READY
        : OUTCOME_STATES.AMBIGUOUS;
  return {
    state,
    candidateArtifacts: candidateArtifacts.map(candidateView),
    accepted: null,
  };
}

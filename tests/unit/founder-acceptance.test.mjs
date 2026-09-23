// The Founder Decision: what ACCEPT means, what it refuses, and what it must
// never touch. Contract: docs/contracts/founder-attention-acceptance-v0.md.
import test from "node:test";
import assert from "node:assert/strict";
import { newActivityEvent } from "../../packages/work/records.mjs";
import {
  openTempKernel,
  reopenKernel,
  seedCompanyAndWork,
  seedTask,
  seedWorkReadyForDecision,
} from "../support/kernel.mjs";

const acceptInput = (flow) => ({
  workId: flow.work.id,
  artifactId: flow.artifact.id,
  artifactDigest: flow.artifact.contentDigest,
  basis: null,
});

test("a passing review is not an acceptance: the Founder still owns the decision", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedWorkReadyForDecision(kernel);
    const projection = kernel.workProjection(flow.work.id);

    assert.equal(flow.passed.verdict, "PASS");
    assert.equal(
      projection.status,
      "READY_FOR_DECISION",
      "a PASS hands the Work to the Founder; it does not carry it past them",
    );
    assert.equal(projection.outcome.state, "READY", "the outcome is not ACCEPTED");
    assert.equal(projection.outcome.accepted, null);
    assert.deepEqual(
      projection.outcome.candidateArtifacts.map((entry) => entry.id),
      [flow.artifact.id],
    );
    assert.equal(kernel.status().counts.founderDecisions, 0);
    assert.equal(
      kernel.activity({ workId: flow.work.id, limit: 500 }).some(
        (event) => event.kind === "WORK_ACCEPTED",
      ),
      false,
    );
  } finally {
    cleanup();
  }
});

test("ACCEPT records the exact artifact, digest and basis — and changes nothing else", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedWorkReadyForDecision(kernel);
    const before = kernel.workProjection(flow.work.id);
    const countsBefore = kernel.status().counts;
    const reviewsBefore = kernel.reviews({ workId: flow.work.id });
    const tasksBefore = kernel.tasks(flow.work.id);

    const result = kernel.acceptWork({
      ...acceptInput(flow),
      basis: before.decisionBasis,
    });

    assert.equal(result.idempotent, false);
    assert.equal(result.decision.disposition, "ACCEPT", "the act is ACCEPT…");
    assert.equal(result.decision.artifactId, flow.artifact.id);
    assert.equal(result.decision.artifactDigest, flow.artifact.contentDigest);
    assert.equal(result.decision.basisSequence, before.decisionBasis);
    assert.equal(result.decision.companyId, flow.company.id);
    assert.equal(result.decision.workId, flow.work.id);

    // …and the derived condition is ACCEPTED. Two names for two different
    // things: what the Founder did, and what the Work now is.
    assert.equal(result.work.outcome.state, "ACCEPTED");
    assert.equal(result.work.outcome.accepted.disposition, "ACCEPT");
    assert.equal(result.work.outcome.accepted.artifactId, flow.artifact.id);
    assert.equal(result.work.outcome.accepted.artifactDigest, flow.artifact.contentDigest);
    assert.equal(result.work.outcome.accepted.basis, before.decisionBasis);
    assert.equal(result.work.outcome.accepted.decidedAt, result.decision.createdAt);
    assert.equal(
      result.work.status,
      "READY_FOR_DECISION",
      "ACCEPTED is not a collaboration status; that vocabulary is unchanged",
    );

    assert.equal(kernel.status().counts.founderDecisions, countsBefore.founderDecisions + 1);
    assert.equal(kernel.status().counts.activity, countsBefore.activity + 1);
    for (const table of [
      "companies",
      "works",
      "tasks",
      "checkpoints",
      "artifacts",
      "positions",
      "employees",
      "assignments",
      "workerRuns",
      "reviews",
      "reviewRequests",
      "repairBindings",
    ])
      assert.equal(
        kernel.status().counts[table],
        countsBefore[table],
        `an acceptance must not write ${table}`,
      );

    // No Review is rewritten, and no Task changes state: acceptance is a
    // decision about work, not a mutation of it.
    assert.deepEqual(kernel.reviews({ workId: flow.work.id }), reviewsBefore);
    assert.deepEqual(kernel.tasks(flow.work.id), tasksBefore);
    assert.equal(kernel.artifact(flow.firstArtifact.id).contentDigest, flow.firstArtifact.contentDigest);
  } finally {
    cleanup();
  }
});

test("the projection exposes only durable decision facts, never invocation metadata", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedWorkReadyForDecision(kernel);
    const accepted = kernel.acceptWork({
      ...acceptInput(flow),
      basis: kernel.workProjection(flow.work.id).decisionBasis,
    });
    const projection = kernel.workProjection(flow.work.id);

    assert.deepEqual(Object.keys(projection.outcome.accepted).sort(), [
      "artifactDigest",
      "artifactId",
      "basis",
      "decidedAt",
      "decisionId",
      "disposition",
    ]);
    assert.equal("idempotent" in projection.outcome.accepted, false);
    assert.equal("idempotent" in projection.outcome, false);
    assert.equal("idempotent" in projection, false);
    assert.equal("idempotent" in accepted.decision, false);
    assert.equal(accepted.idempotent, false, "the response says how the call went; truth does not");
  } finally {
    cleanup();
  }
});

test("retrying an identical ACCEPT is idempotent and invisible to the read model", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedWorkReadyForDecision(kernel);
    const input = { ...acceptInput(flow), basis: kernel.workProjection(flow.work.id).decisionBasis };
    const first = kernel.acceptWork(input);
    const projectionAfterFirst = kernel.workProjection(flow.work.id);
    const activityAfterFirst = kernel.activity({ workId: flow.work.id, limit: 500 });

    const retry = kernel.acceptWork(input);

    assert.equal(retry.idempotent, true, "the same decision committed twice is one decision");
    assert.equal(retry.decision.id, first.decision.id);
    assert.equal(retry.decision.createdAt, first.decision.createdAt);
    assert.equal(kernel.status().counts.founderDecisions, 1);
    assert.deepEqual(
      kernel.activity({ workId: flow.work.id, limit: 500 }),
      activityAfterFirst,
      "a retry writes no second event",
    );
    assert.deepEqual(
      kernel.workProjection(flow.work.id),
      projectionAfterFirst,
      "the projection cannot tell a retry from the original",
    );
  } finally {
    cleanup();
  }
});

test("a conflicting decision is refused, and never re-adjudicates the Work", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedWorkReadyForDecision(kernel);
    const basis = kernel.workProjection(flow.work.id).decisionBasis;
    const first = kernel.acceptWork({ ...acceptInput(flow), basis });

    // A different basis is a different decision, even though the artifact is
    // the same — and it is refused before staleness is even considered.
    assert.throws(() => kernel.acceptWork({ ...acceptInput(flow), basis: basis + 1 }), {
      code: "WORK_ALREADY_DECIDED",
    });
    // The superseded first draft is refused for the same reason: there is no
    // second decision to make about this Work at all.
    assert.throws(
      () =>
        kernel.acceptWork({
          workId: flow.work.id,
          artifactId: flow.firstArtifact.id,
          artifactDigest: flow.firstArtifact.contentDigest,
          basis,
        }),
      { code: "WORK_ALREADY_DECIDED" },
    );
    assert.equal(kernel.status().counts.founderDecisions, 1);
    assert.equal(kernel.workProjection(flow.work.id).outcome.accepted.decisionId, first.decision.id);
  } finally {
    cleanup();
  }
});

test("a decision against a basis the Work has moved past is refused as stale", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedWorkReadyForDecision(kernel);
    const inspected = kernel.workProjection(flow.work.id).decisionBasis;

    // No v0B3 command can move a Work that already derives READY_FOR_DECISION:
    // every unfinished Task would un-ready it first. The guard exists for the
    // writer that eventually will — the one that advances a Work between the
    // Founder's read and their decision. That writer is simulated here by
    // appending the same Work-scoped Activity such a mutation is required to
    // append.
    kernel.store.appendActivity(
      newActivityEvent({
        companyId: flow.company.id,
        workId: flow.work.id,
        kind: "work.reality_changed",
        detail: { note: "an out-of-band writer advanced this Work" },
        createdAt: "2026-09-22T00:00:00.000Z",
      }),
    );

    assert.throws(() => kernel.acceptWork({ ...acceptInput(flow), basis: inspected }), {
      code: "STALE_DECISION_BASIS",
    });
    assert.equal(
      kernel.status().counts.founderDecisions,
      0,
      "a refused decision leaves no row behind",
    );

    // Reading again and deciding on the reality that actually exists works.
    const decided = kernel.acceptWork({
      ...acceptInput(flow),
      basis: kernel.workProjection(flow.work.id).decisionBasis,
    });
    assert.equal(decided.work.outcome.state, "ACCEPTED");
  } finally {
    cleanup();
  }
});

test("a basis ahead of the Work is an invalid basis, not a stale one", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedWorkReadyForDecision(kernel);
    const head = kernel.workProjection(flow.work.id).decisionBasis;
    for (const basis of [head + 1, head + 100])
      assert.throws(() => kernel.acceptWork({ ...acceptInput(flow), basis }), {
        code: "INVALID_DECISION_BASIS",
      });
    for (const basis of [0, -1, 1.5, "1", null, undefined])
      assert.throws(() => kernel.acceptWork({ ...acceptInput(flow), basis }), {
        code: "INVALID_INPUT",
      });
    assert.equal(kernel.status().counts.founderDecisions, 0);
  } finally {
    cleanup();
  }
});

test("the decision binds to an exact digest, an exact artifact and an exact Work", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedWorkReadyForDecision(kernel);
    const basis = kernel.workProjection(flow.work.id).decisionBasis;

    assert.throws(
      () => kernel.acceptWork({ ...acceptInput(flow), artifactDigest: "sha256:not-the-digest", basis }),
      { code: "DECISION_TARGET_MISMATCH" },
    );
    assert.throws(
      () => kernel.acceptWork({ ...acceptInput(flow), artifactId: "art_does_not_exist", basis }),
      { code: "DECISION_TARGET_MISMATCH" },
    );

    // The superseded first draft is not the current outcome candidate.
    assert.throws(
      () =>
        kernel.acceptWork({
          workId: flow.work.id,
          artifactId: flow.firstArtifact.id,
          artifactDigest: flow.firstArtifact.contentDigest,
          basis,
        }),
      { code: "ARTIFACT_NOT_CURRENT" },
    );

    // An artifact of another Work is another Work's business.
    const other = seedCompanyAndWork(kernel, { workTitle: "Some other work" });
    const otherTask = seedTask(kernel, other.work.id);
    const otherEmployee = kernel.createEmployee({
      companyId: other.company.id,
      positionId: kernel.createPosition({
        companyId: other.company.id,
        title: "Producer",
        capabilities: ["capability.produce"],
      }).id,
      displayName: "Other Producer",
    });
    kernel.assignTask({ taskId: otherTask.id, employeeId: otherEmployee.id, reason: "fixture" });
    const otherRun = kernel.startWorkerRun({ taskId: otherTask.id });
    const stray = kernel.recordArtifact({
      taskId: otherTask.id,
      generation: otherRun.generation,
      workerRunId: otherRun.workerRun.id,
      kind: "document",
      title: "Unrelated",
      content: "unrelated\n",
    });
    assert.throws(
      () =>
        kernel.acceptWork({
          workId: flow.work.id,
          artifactId: stray.id,
          artifactDigest: stray.contentDigest,
          basis,
        }),
      { code: "DECISION_TARGET_MISMATCH" },
    );
    assert.equal(kernel.status().counts.founderDecisions, 0);
  } finally {
    cleanup();
  }
});

test("a Work that is not finished has nothing to accept", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const { company, work } = seedCompanyAndWork(kernel);
    const task = seedTask(kernel, work.id);
    assert.equal(kernel.workProjection(work.id).status, "OPEN");
    assert.throws(
      () =>
        kernel.acceptWork({
          workId: work.id,
          artifactId: "art_anything",
          artifactDigest: "sha256:anything",
          basis: 1,
        }),
      { code: "DECISION_TARGET_MISMATCH" },
    );
    assert.equal(task.state, "OPEN");
    assert.equal(company.id, work.companyId);

    // …and a Work that does not exist is not silently accepted either.
    assert.throws(
      () =>
        kernel.acceptWork({
          workId: "wrk_missing",
          artifactId: "art_anything",
          artifactDigest: "sha256:anything",
          basis: 1,
        }),
      { code: "WORK_NOT_FOUND" },
    );
  } finally {
    cleanup();
  }
});

test("two current candidates make the outcome ambiguous, and the newest is never chosen", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedWorkReadyForDecision(kernel);
    // A repaired output and a second, unreviewed line of work both current:
    // nothing supersedes either one, and the Runtime has no basis to prefer
    // one over the other.
    const competing = kernel.createTask({
      workId: flow.work.id,
      title: "Produce a second, independent draft",
      intent: "One output the founder can act on",
    });
    kernel.assignTask({ taskId: competing.id, employeeId: flow.producer.id, reason: "fixture" });
    const run = kernel.startWorkerRun({ taskId: competing.id });
    const second = kernel.recordArtifact({
      taskId: competing.id,
      generation: run.generation,
      workerRunId: run.workerRun.id,
      kind: "document",
      title: "Independent second draft",
      content: "a different draft entirely\n",
    });
    kernel.completeWorkerRun({ taskId: competing.id, generation: run.generation });

    const projection = kernel.workProjection(flow.work.id);
    assert.equal(projection.status, "READY_FOR_DECISION");
    assert.equal(projection.outcome.state, "AMBIGUOUS");
    assert.equal(projection.outcome.accepted, null);
    assert.equal(projection.outcome.candidateArtifacts.length, 2);
    assert.ok(
      projection.latestArtifact,
      "the v0B2 latest-artifact reading still exists — and is still not an outcome decision",
    );
    assert.throws(
      () =>
        kernel.acceptWork({
          workId: flow.work.id,
          artifactId: second.id,
          artifactDigest: second.contentDigest,
          basis: projection.decisionBasis,
        }),
      { code: "OUTCOME_AMBIGUOUS" },
    );
    assert.equal(kernel.status().counts.founderDecisions, 0);
    assert.equal(projection.founderAttention.item, null, "ambiguity is not an actionable item");
  } finally {
    cleanup();
  }
});

test("an accepted Work takes no new Tasks; a merely ready Work still does", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const ready = seedWorkReadyForDecision(kernel);
    assert.equal(kernel.workProjection(ready.work.id).status, "READY_FOR_DECISION");
    const after = kernel.createTask({
      workId: ready.work.id,
      title: "A late addition",
      intent: "One output the founder can act on",
    });
    assert.equal(after.state, "OPEN", "READY_FOR_DECISION is not a lock: reality may still change");
    kernel.cancelTask({ taskId: after.id, note: "fixture cleanup" });
    assert.equal(kernel.workProjection(ready.work.id).status, "READY_FOR_DECISION");

    kernel.acceptWork({
      workId: ready.work.id,
      artifactId: ready.artifact.id,
      artifactDigest: ready.artifact.contentDigest,
      basis: kernel.workProjection(ready.work.id).decisionBasis,
    });
    assert.throws(
      () => kernel.createTask({ workId: ready.work.id, title: "Too late", intent: "too late" }),
      { code: "WORK_ACCEPTED_LOCKED" },
    );
  } finally {
    cleanup();
  }
});

test("acceptance closes the Work to new Tasks but not to reading its history", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedWorkReadyForDecision(kernel);
    kernel.acceptWork({
      ...acceptInput(flow),
      basis: kernel.workProjection(flow.work.id).decisionBasis,
    });
    const projection = kernel.workProjection(flow.work.id);
    assert.equal(projection.artifacts.length, 2, "both drafts remain readable");
    assert.equal(projection.reviews.length, 2);
    assert.equal(projection.repairBindings.length, 1);
    assert.equal(projection.outcome.candidateArtifacts.length, 1);
    assert.equal(projection.founderAttention.item, null, "accepted work asks nothing of the Founder");
  } finally {
    cleanup();
  }
});

test("a decision is durable: it survives closing and reopening the store", () => {
  const { dir, kernel, cleanup } = openTempKernel();
  try {
    const flow = seedWorkReadyForDecision(kernel);
    const accepted = kernel.acceptWork({
      ...acceptInput(flow),
      basis: kernel.workProjection(flow.work.id).decisionBasis,
    });
    const before = kernel.workProjection(flow.work.id);
    kernel.close();

    const reopened = reopenKernel(dir);
    try {
      assert.equal(reopened.status().schemaVersion, 7);
      assert.equal(reopened.status().counts.founderDecisions, 1);
      assert.deepEqual(reopened.workProjection(flow.work.id), before);
      assert.deepEqual(
        reopened.store.founderDecisionForWork(flow.work.id),
        accepted.decision,
        "the stored record is the record that was returned",
      );
      assert.equal(reopened.recovery.count, 0, "recovery never touches a Founder Decision");
      assert.equal(reopened.workProjection(flow.work.id).outcome.state, "ACCEPTED");
    } finally {
      reopened.close();
    }
  } finally {
    cleanup();
  }
});

test("a decision row is immutable and there is at most one per Work", () => {
  const { kernel, cleanup } = openTempKernel();
  try {
    const flow = seedWorkReadyForDecision(kernel);
    const decision = kernel.acceptWork({
      ...acceptInput(flow),
      basis: kernel.workProjection(flow.work.id).decisionBasis,
    }).decision;

    assert.throws(
      () =>
        kernel.store.db
          .prepare("UPDATE founder_decisions SET disposition='ACCEPT' WHERE id=?")
          .run(decision.id),
      /DECISION_IMMUTABLE/,
    );
    assert.throws(
      () => kernel.store.db.prepare("DELETE FROM founder_decisions WHERE id=?").run(decision.id),
      /DECISION_IMMUTABLE/,
    );
    assert.throws(
      () =>
        kernel.store.db
          .prepare(
            "INSERT INTO founder_decisions(id,company_id,work_id,disposition,artifact_id,artifact_digest,basis_sequence,created_at) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            "dec_second",
            flow.company.id,
            flow.work.id,
            "ACCEPT",
            flow.artifact.id,
            flow.artifact.contentDigest,
            1,
            "2026-09-22T00:00:00.000Z",
          ),
      /UNIQUE/,
    );
    assert.throws(
      () =>
        kernel.store.db
          .prepare(
            "INSERT INTO founder_decisions(id,company_id,work_id,disposition,artifact_id,artifact_digest,basis_sequence,created_at) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run("dec_reject", flow.company.id, flow.work.id, "REJECT", flow.artifact.id, "sha256:x", 1, "x"),
      /UNIQUE|CHECK/,
    );
  } finally {
    cleanup();
  }
});

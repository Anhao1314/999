// test-worker — the deterministic execution backend for the Worker Harness.
// Contract: docs/contracts/worker-harness-v0.md §22.
//
// This is NOT intelligence and NOT a model: it is a deterministic, asynchronous
// execution path that proves the WorkerHost, the binding seam, workspace
// isolation and the delivery seams independently of any CLI or provider. It
// emits the frozen WorkerEvent vocabulary, writes and reads back a real
// run-scoped workspace file, and returns a valid result candidate for the
// role-specific contract the Runtime granted — an artifact delivery for an
// execution or Repair Task, a judgment for a Review Task. It must never be
// presented as AI autonomy.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { newWorkerEvent } from "../events.mjs";
import { RESULT_CONTRACT_KINDS } from "../worker-run-input.mjs";

export const TEST_WORKER_ADAPTER_TYPE = "test-worker";
export const TEST_WORKER_ADAPTER_VERSION = "0.1.0";

export const TEST_WORKER_BEHAVIORS = Object.freeze([
  "complete",
  "hang",
  "exit",
  "invalid-result",
  "no-result",
  "no-artifact",
  "request-revision",
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createSignal() {
  let fire;
  let promise = new Promise((resolve) => {
    fire = resolve;
  });
  return {
    wait: () => promise,
    fire: () => {
      const resolve = fire;
      promise = new Promise((next) => {
        fire = next;
      });
      resolve();
    },
  };
}

export function createTestWorkerAdapter({ behavior = "complete", stepDelayMs = 1 } = {}) {
  const behaviorFor = (input) => (typeof behavior === "function" ? behavior(input) : behavior);
  const assertKnownBehavior = (resolved) => {
    if (!TEST_WORKER_BEHAVIORS.includes(resolved))
      throw new Error(`unknown test worker behavior: ${resolved}`);
    return resolved;
  };
  if (typeof behavior !== "function") assertKnownBehavior(behavior);

  const handles = new Map();

  function emit(handle, kind, detail = null) {
    handle.events.push(
      newWorkerEvent({
        kind,
        sequence: handle.events.length + 1,
        detail,
        at: new Date(0).toISOString(),
      }),
    );
    handle.signal.fire();
  }

  function settle(handle, terminal) {
    if (handle.finished) return;
    handle.finished = true;
    handle.terminal = terminal;
    for (const resolve of handle.waiters.splice(0)) resolve(terminal);
    handle.signal.fire();
  }

  function reviewJudgment(handle, verdict) {
    return {
      schemaVersion: 1,
      workerRunId: handle.input.workerRunId,
      generation: handle.input.generation,
      verdict,
      findings:
        verdict === "REQUEST_REVISION"
          ? ["The deliverable does not answer the intent recorded in the work packet."]
          : [],
      summary:
        verdict === "REQUEST_REVISION"
          ? "The deliverable needs another pass before it can be accepted."
          : "The deliverable matches the intent recorded in the work packet.",
    };
  }

  async function execute(handle) {
    emit(handle, "RUN_STARTED", { workerRunId: handle.input.workerRunId });
    if (handle.cancelled) return;

    // A real run-scoped workspace: the adapter writes into the directory the
    // Host allocated for this attempt and reads its own output back.
    const outputPath = join(handle.workspaceRoot, "output.txt");
    mkdirSync(handle.workspaceRoot, { recursive: true });
    writeFileSync(
      outputPath,
      `deterministic test worker output for ${handle.input.workerRunId} g${handle.input.generation}\n`,
      "utf8",
    );
    const echoed = readFileSync(outputPath, "utf8");
    emit(handle, "TOOL_FINISHED", { tool: "write-output", bytes: Buffer.byteLength(echoed) });

    if (handle.behavior === "hang") return;
    await sleep(stepDelayMs);
    if (handle.cancelled) return;

    const runId = handle.input.workerRunId;
    const isReview =
      handle.input.resultContract?.kind === RESULT_CONTRACT_KINDS.REVIEW_JUDGMENT;

    if (handle.behavior === "exit") {
      emit(handle, "RUN_FAILED", { reason: "PROCESS_EXIT" });
      settle(handle, { terminalStatus: "FAILED", failureReason: "PROCESS_EXIT" });
      return;
    }
    if (handle.behavior === "invalid-result") {
      emit(handle, "RESULT_READY", { parseable: false });
      // A production adapter may hand over the extraction it managed; whether
      // that extraction is a result is the Host's decision, not the adapter's.
      settle(handle, {
        terminalStatus: "SUCCEEDED",
        resultCandidate: isReview ? "not a structured review judgment" : "not a structured worker result",
      });
      return;
    }
    if (handle.behavior === "no-result") {
      emit(handle, "RESULT_READY", { candidate: null });
      // The provider produced terminal output the adapter could not map to any
      // candidate. The adapter says exactly that; it never invents one.
      settle(handle, {
        terminalStatus: "SUCCEEDED",
        resultCandidate: null,
        adapterMeta: { parse: "NO_CANDIDATE" },
      });
      return;
    }

    // A Review attempt delivers a judgment about the Artifact its packet names
    // — never an Artifact of its own.
    if (isReview) {
      const verdict = handle.behavior === "request-revision" ? "REQUEST_REVISION" : "PASS";
      emit(handle, "RESULT_READY", { verdict });
      settle(handle, {
        terminalStatus: "SUCCEEDED",
        resultCandidate: reviewJudgment(handle, verdict),
      });
      return;
    }

    if (handle.behavior === "no-artifact") {
      emit(handle, "RESULT_READY", { proposedArtifacts: 0 });
      settle(handle, {
        terminalStatus: "SUCCEEDED",
        resultCandidate: {
          resultVersion: 1,
          outcome: "SUCCEEDED",
          summary: `deterministic test worker finished ${runId} with nothing to deliver`,
          reportedVerification: "deterministic test worker: read back its own workspace file",
          blockers: [],
          proposedArtifacts: [],
          suggestedNextActions: [],
        },
      });
      return;
    }

    emit(handle, "RESULT_READY", { proposedArtifacts: 1 });
    settle(handle, {
      terminalStatus: "SUCCEEDED",
      resultCandidate: {
        resultVersion: 1,
        outcome: "SUCCEEDED",
        summary: `deterministic test worker completed ${runId}`,
        completionClaim: null,
        reportedVerification: "deterministic test worker: wrote and read back its own workspace file",
        blockers: [],
        proposedArtifacts: [
          {
            kind: "document",
            title: `Deterministic output for ${runId}`,
            content: echoed,
          },
        ],
        suggestedNextActions: [],
      },
    });
  }

  return Object.freeze({
    manifest() {
      return {
        adapterType: TEST_WORKER_ADAPTER_TYPE,
        adapterVersion: TEST_WORKER_ADAPTER_VERSION,
        containment: {
          sandboxMode: "none",
          knownLimitations: [
            "deterministic in-process test backend; it performs no real work",
            "no OS-level isolation, no network policy and no filesystem confinement beyond the allocated workspace",
          ],
        },
      };
    },
    start(input, context) {
      const handle = {
        id: `twh_${randomUUID()}`,
        input,
        workspaceRoot: context.workspaceRoot,
        scratchRoot: context.scratchRoot,
        behavior: assertKnownBehavior(behaviorFor(input)),
        cancelled: false,
        finished: false,
        terminal: null,
        events: [],
        waiters: [],
        signal: createSignal(),
      };
      handles.set(input.workerRunId, handle);
      void execute(handle);
      return handle;
    },
    async *events(handle) {
      let index = 0;
      while (true) {
        while (index < handle.events.length) yield handle.events[index++];
        if (handle.finished) return;
        await handle.signal.wait();
      }
    },
    wait(handle) {
      // The Host enforces the wall-clock budget; in "hang" mode this promise is
      // never settled, so what the test proves is the Host's timeout, not the
      // adapter's good manners.
      if (handle.terminal) return Promise.resolve(handle.terminal);
      return new Promise((resolve) => handle.waiters.push(resolve));
    },
    cancel(handle, reason) {
      // Idempotent by contract: a second cancel is a no-op.
      if (handle.cancelled) return;
      handle.cancelled = true;
      settle(handle, { terminalStatus: "CANCELLED", reason: reason ?? null });
    },
    handleFor(workerRunId) {
      return handles.get(workerRunId) ?? null;
    },
  });
}

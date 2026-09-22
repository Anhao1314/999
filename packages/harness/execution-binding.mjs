// Workspace allocation and the WorkspaceLease derivation.
// Contract: docs/contracts/worker-harness-v0.md §8, §9.
//
// The lease is not a second object: it is WorkerRun truth read a certain way.
// One mutable execution workspace belongs to exactly one WorkerRun + generation,
// so a new attempt always gets a new run-scoped directory tree. Correctness
// does not depend on killing an orphan: an orphan may keep writing its old
// workspace, and the new generation never reads or reuses it.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export const WORKSPACE_LEASE_STATES = Object.freeze({
  ACTIVE: "ACTIVE",
  RELEASED: "RELEASED",
  INVALIDATED: "INVALIDATED",
});

const LEASE_BY_RUN_STATE = Object.freeze({
  RUNNING: WORKSPACE_LEASE_STATES.ACTIVE,
  COMPLETED: WORKSPACE_LEASE_STATES.RELEASED,
  CANCELLED: WORKSPACE_LEASE_STATES.RELEASED,
  INTERRUPTED: WORKSPACE_LEASE_STATES.INVALIDATED,
});

// Derived, never stored: a lease is ACTIVE while its attempt runs, RELEASED
// when the attempt ended normally, and INVALIDATED when the attempt was
// interrupted — an invalidated workspace is not a candidate for reuse.
export function leaseStateForRun(runState) {
  const state = LEASE_BY_RUN_STATE[runState];
  if (!state) throw new Error(`unknown WorkerRun state for a lease: ${runState}`);
  return state;
}

// <runtimeRoot>/workspaces/<workId>/runs/<workerRunId>-g<generation>/
//   workspace/   the mutable run workspace the adapter may write
//   scratch/     host-provided scratch, never part of the deliverable
export function runWorkspaceLayout({ runtimeRoot, workId, workerRunId, generation }) {
  if (!runtimeRoot) throw new Error("runWorkspaceLayout requires a runtimeRoot");
  if (!workId || !workerRunId) throw new Error("runWorkspaceLayout requires workId and workerRunId");
  if (!Number.isInteger(generation) || generation < 0)
    throw new Error("runWorkspaceLayout requires a non-negative generation");
  const runRoot = join(runtimeRoot, "workspaces", workId, "runs", `${workerRunId}-g${generation}`);
  return Object.freeze({
    runRoot,
    workspaceRoot: join(runRoot, "workspace"),
    scratchRoot: join(runRoot, "scratch"),
  });
}

export function ensureRunWorkspace(layout) {
  mkdirSync(layout.workspaceRoot, { recursive: true });
  mkdirSync(layout.scratchRoot, { recursive: true });
  return layout;
}

// Founder intent enters here; scheduling and execution stay with Runtime.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { digestOf } from "../work/records.mjs";
import { kernelError } from "../runtime/errors.mjs";

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

export function resolveLocalExecutionContext({ repository, revision = "HEAD" } = {}) {
  if (typeof repository !== "string" || !repository || typeof revision !== "string" || !revision)
    throw kernelError("PRODUCT_CONTEXT_UNAVAILABLE", "a local Git repository and revision are required");
  try {
    const root = realpathSync(repository);
    if (realpathSync(git(root, "rev-parse", "--show-toplevel")) !== root)
      throw new Error("repository must name its Git root");
    const baseRevision = git(root, "rev-parse", "--verify", `${revision}^{commit}`);
    if (!/^[a-f0-9]{40,64}$/.test(baseRevision)) throw new Error("invalid commit");
    return Object.freeze({
      contextId: `local-repo:${digestOf(root)}`,
      baseRevision,
      repository: root, // process-private; never written to Company truth or API output
    });
  } catch {
    throw kernelError("PRODUCT_CONTEXT_UNAVAILABLE", "configured local Git execution context is invalid");
  }
}

export function assertBoundFounderWorks({ kernel, context }) {
  for (const binding of kernel.founderWorkExecutionBindings()) {
    if (!context || binding.contextId !== context.contextId)
      throw kernelError("PRODUCT_CONTEXT_MISMATCH", "Founder Work is bound to another local execution context");
    try {
      git(context.repository, "cat-file", "-e", `${binding.baseRevision}^{commit}`);
    } catch {
      throw kernelError("PRODUCT_CONTEXT_MISMATCH", "a Founder Work base commit is unavailable in the configured repository");
    }
  }
}

export function createFounderWorkCommand({ kernel, context, resolveContext, coordination, workerBackend } = {}) {
  if (typeof resolveContext !== "function") throw new Error("CreateFounderWork requires a live context resolver");
  return (input) => {
    if (!input || typeof input !== "object" || Array.isArray(input) ||
        Object.keys(input).some((key) => !["requestId", "companyId", "title", "intent", "contextId"].includes(key)))
      throw kernelError("INVALID_INPUT", "CreateFounderWork accepts only requestId, companyId, title, intent and contextId");
    if (coordination !== "driver")
      throw kernelError("PRODUCT_COORDINATION_UNAVAILABLE", "Founder Work execution requires the Continuation Driver");
    if (workerBackend === "off")
      throw kernelError("PRODUCT_BACKEND_UNAVAILABLE", "Founder Work execution requires a verified Worker backend");
    if (!context)
      throw kernelError("PRODUCT_CONTEXT_UNAVAILABLE", "a valid local execution context is required");
    if (input.contextId !== context.contextId)
      throw kernelError("PRODUCT_CONTEXT_MISMATCH", "execution context does not match this Runtime");
    // HEAD is an input to this command, not a process-start snapshot. Resolve
    // it immediately before the atomic Work+binding write. An idempotent
    // replay still returns its original pinned revision from Runtime truth.
    const current = resolveContext();
    if (current.contextId !== context.contextId)
      throw kernelError("PRODUCT_CONTEXT_MISMATCH", "configured repository changed while Runtime was open");
    assertBoundFounderWorks({ kernel, context: current });
    const result = kernel.createFounderWork({ ...input, baseRevision: current.baseRevision });
    return { work: result.work, contextId: result.binding.contextId, replayed: result.replayed };
  };
}

export function createFounderBoundResolver({ kernel, context, resolver }) {
  return Object.freeze({
    resolverType: "founder-bound-v0a",
    resolve(input) {
      const binding = kernel.founderWorkExecutionBinding(input.workerRun?.workId);
      if (!binding) return resolver.resolve(input); // pre-existing Kernel Work
      if (!context || binding.contextId !== context.contextId) return null;
      const resolved = resolver.resolve(input);
      return resolved && Object.freeze({ ...resolved, baseRevision: binding.baseRevision });
    },
  });
}

// The NextActionProposer seam: who turns "this Work has no Task" into a
// proposal the Runtime may validate and materialize.
// Contract: docs/contracts/work-continuity-v0.md §5, §7, §13.
//
// A proposer produces a *proposal*, never a decision. It names work and
// nothing else: it may not name an Employee, a permission, a verdict or a
// Runtime state, and the Runtime rejects any proposal that tries (the schema is
// strict, §13). This file ships the deterministic v0 adapter, which exists so
// the Runtime can be exercised end to end without a language model. A real
// System 2 adapter implements the same one-method interface and does not change
// one line of the Runtime.
export const NEXT_ACTION_PROPOSER_VERSION = "v0b4.1";

// The deterministic adapter's vocabulary. Capabilities are data, not policy:
// a company's Positions decide what its Employees can do, and a company that
// wants Work materialization to be dispatchable simply staffs these.
export const DEFAULT_REQUIRED_CAPABILITIES = Object.freeze(["work.execute"]);
export const DEFAULT_REVIEW_CAPABILITIES = Object.freeze(["work.review"]);

// A proposer is `{ name, version, propose({ work, basis, tasks }) -> proposal }`.
// It must be synchronous and side-effect free: the Driver calls it while it is
// deciding, and a proposer that reads the world twice would be a second source
// of truth. Returning `null` means "I have nothing to propose" — the Driver
// records PLANNING_EXHAUSTED and stops; it never invents work.
export function deterministicNextActionProposer({
  requiredCapabilities = DEFAULT_REQUIRED_CAPABILITIES,
  reviewCapabilities = DEFAULT_REVIEW_CAPABILITIES,
} = {}) {
  return Object.freeze({
    name: "deterministic-next-action",
    version: NEXT_ACTION_PROPOSER_VERSION,
    propose({ work }) {
      return {
        taskKind: "EXECUTION",
        title: `Produce: ${work.title}`,
        intent: work.intent,
        requiredCapabilities: [...requiredCapabilities],
        reviewCapabilities: [...reviewCapabilities],
      };
    },
  });
}

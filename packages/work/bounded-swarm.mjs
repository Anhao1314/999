// One deliberately small fan-out/fan-in shape. This is a proposal boundary,
// not a Swarm entity or a general DAG language. Runtime mints the Task IDs.
import { isCapability } from "../workforce/capabilities.mjs";
import { BOUNDS } from "./records.mjs";

export const BOUNDED_SWARM_PARALLELISM = 3;
export const BOUNDED_SWARM_TASKS = 4;

const fields = ["taskKind", "title", "intent", "requiredCapabilities", "reviewCapabilities", "dependsOn"];
const plain = (value) => value && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const validText = (value, max) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const invalid = (reason) => ({ ok: false, code: "INVALID_PROPOSAL", message: reason });

export function validateBoundedSwarmProposal(proposal) {
  if (!exact(proposal, ["planKind", "tasks"]) || proposal.planKind !== "BOUNDED_FAN_IN" ||
      !Array.isArray(proposal.tasks) || proposal.tasks.length !== BOUNDED_SWARM_TASKS)
    return invalid("bounded fan-in requires exactly three source Tasks and one synthesis Task");
  const roles = new Set();
  for (let index = 0; index < BOUNDED_SWARM_TASKS; index += 1) {
    const task = proposal.tasks[index];
    if (!exact(task, fields) || task.taskKind !== "EXECUTION" ||
        !validText(task.title, BOUNDS.taskTitleMax) || !validText(task.intent, BOUNDS.taskIntentMax) ||
        !Array.isArray(task.requiredCapabilities) || task.requiredCapabilities.length !== 1 ||
        !isCapability(task.requiredCapabilities[0]) || roles.has(task.requiredCapabilities[0]) ||
        !Array.isArray(task.reviewCapabilities) ||
        task.reviewCapabilities.some((capability) => !isCapability(capability)) ||
        !Array.isArray(task.dependsOn)) return invalid("invalid bounded Task or capability");
    roles.add(task.requiredCapabilities[0]);
    if (index < BOUNDED_SWARM_PARALLELISM) {
      if (task.dependsOn.length !== 0 || task.reviewCapabilities.length !== 0)
        return invalid("source Tasks must be independent and have no individual review");
    } else if (task.dependsOn.length !== BOUNDED_SWARM_PARALLELISM ||
        task.dependsOn.some((dependency, position) => dependency !== position) ||
        task.reviewCapabilities.length !== 1)
      return invalid("synthesis must depend on all three sources and require independent review");
  }
  return { ok: true, proposal };
}

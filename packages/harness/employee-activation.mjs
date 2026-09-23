// A small, trusted composition table for one WorkerRun at a time. Runtime has
// already persisted Employee, Assignment, Task requirements and WorkPacket.
// This table chooses a method; it does not create identity or permission.
import { createGenericModelWorkerAdapter, GENERIC_MODEL_WORKER_ADAPTER_TYPE } from "./adapters/generic-model-worker.mjs";
import { assertModelBackend } from "./model-backend.mjs";
import { RESULT_CONTRACT_KINDS, defaultRequestedPolicy, resultContractForWorkPacket } from "./worker-run-input.mjs";
import { assertActuator } from "./tool-session.mjs";

const CONTRACT_KINDS = Object.values(RESULT_CONTRACT_KINDS);

export function createEmployeeActivationResolver({ profiles, policyForRun = () => ({ approvedCapabilities: [] }) } = {}) {
  if (!Array.isArray(profiles) || profiles.length === 0 || typeof policyForRun !== "function")
    throw new Error("Employee Activation requires profiles and a policyForRun function");
  const available = profiles.map((profile) => {
    const proposedSkill = profile?.skill;
    const skill = proposedSkill && Object.freeze({
      skillId: proposedSkill.skillId, version: proposedSkill.version,
      requiredCapabilities: Object.freeze([...(proposedSkill.requiredCapabilities ?? [])]),
      allowedToolCapabilities: Object.freeze([...(proposedSkill.allowedToolCapabilities ?? [])]),
      rules: Object.freeze([...(proposedSkill.rules ?? [])]),
    });
    if (!skill || !Array.isArray(skill.requiredCapabilities) || skill.requiredCapabilities.length === 0 ||
        skill.requiredCapabilities.some((value) => typeof value !== "string" || !value) ||
        !Array.isArray(skill.allowedToolCapabilities))
      throw new Error("Activation Skill requires organizational and tool capabilities");
    const candidate = assertModelBackend(profile.modelBackend);
    // Preserve provider identity for Host-side execution provenance. The
    // profile metadata below remains a frozen, non-secret projection.
    const backend = candidate;
    const executionVersion = `${backend.backendType}@${backend.backendVersion}`;
    if (executionVersion.length > 64)
      throw new Error("Activation ModelBackend identity exceeds the execution-binding version bound");
    const adapter = createGenericModelWorkerAdapter({ modelBackend: backend, skill });
    const contracts = profile.resultContracts ?? [RESULT_CONTRACT_KINDS.ARTIFACT_DELIVERY];
    if (!Array.isArray(contracts) || contracts.length === 0 || contracts.some((kind) => !CONTRACT_KINDS.includes(kind)))
      throw new Error("Activation profile has an invalid ResultContract kind");
    const actuators = Object.freeze([...(profile.actuators ?? [])].map(assertActuator));
    if (profile.artifactPostcondition != null && typeof profile.artifactPostcondition !== "function")
      throw new Error("Activation artifactPostcondition must be a function");
    return Object.freeze({ skill, backend, adapter, executionVersion, actuators, contracts: Object.freeze([...contracts]),
      artifactPostcondition: profile.artifactPostcondition ?? null });
  });

  return Object.freeze({
    activate({ workerRun, employee, position, company } = {}) {
      const packet = workerRun?.workPacket;
      if (!packet || packet.employee.id !== employee?.id || packet.position.id !== position?.id ||
          packet.company.id !== company?.id || workerRun.employeeId !== employee.id ||
          workerRun.positionId !== position.id || workerRun.companyId !== company.id)
        throw new Error("Activation requires matching persisted WorkerRun identity");
      const taskCapabilities = packet.requirements?.requiredCapabilities ?? [];
      const positionCapabilities = new Set(position.capabilities);
      if (!Array.isArray(taskCapabilities) || taskCapabilities.length === 0 ||
          taskCapabilities.some((capability) => !positionCapabilities.has(capability)))
        throw new Error("Task requirement does not match assigned Employee Position");
      const contract = resultContractForWorkPacket(packet).kind;
      const matches = available.filter(({ skill, contracts }) => contracts.includes(contract) &&
        skill.requiredCapabilities.every((capability) =>
          taskCapabilities.includes(capability) && positionCapabilities.has(capability)));
      if (matches.length !== 1) throw new Error("Activation requires exactly one matching active Skill");
      const selected = matches[0];
      const policy = policyForRun({ workerRun, employee, position, company, skill: selected.skill });
      if (!policy || !Array.isArray(policy.approvedCapabilities))
        throw new Error("Activation policy must return an explicit capability list");
      return Object.freeze({
        adapter: selected.adapter,
        modelBackend: Object.freeze({ backendType: selected.backend.backendType,
          backendVersion: selected.backend.backendVersion }),
        resolution: Object.freeze({ backendType: GENERIC_MODEL_WORKER_ADAPTER_TYPE,
          backendVersion: selected.executionVersion, baseRevision: null, externalSessionRef: null }),
        requestedPolicy: policy.requestedPolicy ?? defaultRequestedPolicy(),
        toolPolicy: Object.freeze({ skill: selected.skill,
          approvedCapabilities: Object.freeze([...policy.approvedCapabilities]),
          actuators: Object.freeze([...(policy.actuators ?? selected.actuators)].map(assertActuator)),
          budget: policy.budget ?? {} }),
        artifactPostcondition: selected.artifactPostcondition,
      });
    },
  });
}

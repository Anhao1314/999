// Founder intent over the existing Hiring Runtime. This module accepts only a
// small product vocabulary; it never writes Employee, Review or WorkerRun rows.
import { digestOf } from "../work/records.mjs";
import { kernelError, isKernelError } from "../runtime/errors.mjs";
import { parsePublicWebUrl } from "../harness/web-network-policy.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9_:.-]{0,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const CAPABILITIES = new Set(["customer.research", "evidence.analysis"]);
const SKILLS = new Set(["CustomerInsight@v1", "EvidenceSynthesis@v1"]);
const fail = (code, message) => { throw kernelError(code, message); };
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const exact = (input, allowed, required) => {
  if (!plain(input) || Object.keys(input).some(key => !allowed.includes(key)) ||
      required.some(key => !Object.hasOwn(input, key)))
    fail("HIRING_INPUT_INVALID", "unsupported Founder Hiring input");
};
const id = (value, field) => {
  if (typeof value !== "string" || !ID.test(value)) fail("HIRING_INPUT_INVALID", `${field} is invalid`);
  return value;
};
const text = (value, field, max) => {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > max)
    fail("HIRING_INPUT_INVALID", `${field} is invalid`);
  return value;
};
const basis = (value, field) => {
  if (!Number.isSafeInteger(value) || value < 1) fail("HIRING_INPUT_INVALID", `${field} is invalid`);
  return value;
};
const digest = value => {
  if (typeof value !== "string" || !DIGEST.test(value)) fail("HIRING_INPUT_INVALID", "Artifact digest is invalid");
  return value;
};
const list = (value, allowed, required) => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2 ||
      new Set(value).size !== value.length || !value.includes(required) ||
      value.some(item => !allowed.has(item)))
    fail("HIRING_INPUT_INVALID", "unsupported organizational reference");
  return [...value].sort();
};
const mapped = operation => {
  try { return operation(); }
  catch (error) {
    if (!isKernelError(error)) throw error;
    const code = {
      INVALID_INPUT: "HIRING_INPUT_INVALID",
      CROSS_COMPANY_ASSIGNMENT: "HIRING_CROSS_COMPANY",
      HIRING_STALE_BASIS: "HIRING_BASIS_STALE",
      STALE_DECISION_BASIS: "HIRING_BASIS_STALE",
      HIRING_NOT_READY: "HIRING_TRIAL_NOT_PASSED",
      HIRING_TRIAL_UNAVAILABLE: "HIRING_TRIAL_UNAVAILABLE",
      HIRING_NOT_CONFIRMED: "HIRING_TRIAL_NOT_PASSED",
      EMPLOYEE_DISABLED: "HIRING_TRIAL_UNAVAILABLE",
      WORK_ALREADY_DECIDED: "HIRING_EVIDENCE_MISMATCH",
      DECISION_TARGET_MISMATCH: "HIRING_EVIDENCE_MISMATCH",
    }[error.code];
    if (!code) throw error;
    fail(code, "Founder Hiring command cannot apply to the current Runtime facts");
  }
};

export function createFounderHiringCommands({ kernel, trialExecutionReady = () => false } = {}) {
  if (!kernel || typeof trialExecutionReady !== "function")
    throw new Error("Founder Hiring commands require Runtime and an execution readiness check");
  const owned = (companyId, employeeId) => {
    const employee = kernel.employee(employeeId);
    if (!employee) fail("EMPLOYEE_NOT_FOUND", "Employee does not exist");
    if (employee.companyId !== companyId) fail("HIRING_CROSS_COMPANY", "Employee belongs to another Company");
    return { employee, hiring: kernel.employeeHiring(employeeId) };
  };
  const commit = (command, input, material, perform) => kernel.commitFounderHiringCommand({
    requestId: id(input.requestId, "requestId"), companyId: id(input.companyId, "companyId"),
    command, inputDigest: digestOf(JSON.stringify([command, material])), perform,
  });

  const CreateEmployeeDraft = input => mapped(() => {
    exact(input, ["requestId", "companyId", "name", "positionTitle", "declaredCapabilities",
      "eligibleSkills", "authorityProfile", "knowledgeScope", "reasoningProfile"],
    ["requestId", "companyId", "name", "positionTitle"]);
    const name = text(input.name, "name", 120);
    const positionTitle = text(input.positionTitle, "positionTitle", 120);
    const declaredCapabilities = list(input.declaredCapabilities ?? ["customer.research", "evidence.analysis"],
      CAPABILITIES, "customer.research");
    const eligibleSkills = list(input.eligibleSkills ?? ["CustomerInsight@v1", "EvidenceSynthesis@v1"],
      SKILLS, "CustomerInsight@v1");
    const authorityProfile = input.authorityProfile ?? "PUBLIC_WEB_READ_ONLY";
    const knowledgeScope = input.knowledgeScope ?? "NONE";
    const reasoningProfile = input.reasoningProfile ?? "STANDARD";
    if (authorityProfile !== "PUBLIC_WEB_READ_ONLY" || knowledgeScope !== "NONE" ||
        reasoningProfile !== "STANDARD" ||
        (eligibleSkills.includes("EvidenceSynthesis@v1") && !declaredCapabilities.includes("evidence.analysis")))
      fail("HIRING_INPUT_INVALID", "unsupported Hiring method or authority reference");
    const material = [input.companyId, name, positionTitle, declaredCapabilities, eligibleSkills,
      authorityProfile, knowledgeScope, reasoningProfile];
    return commit("CreateEmployeeDraft", input, material, () => {
      const created = kernel.createEmployeeDraft({ companyId: input.companyId, displayName: name,
        positionTitle, declaredCapabilities, eligibleSkills, authorityProfile, knowledgeScope, reasoningProfile });
      return { command: "CreateEmployeeDraft", employeeId: created.employee.id,
        positionId: created.position.id, lifecycleState: "DRAFT" };
    });
  });

  const StartEmployeeTrial = input => mapped(() => {
    exact(input, ["requestId", "companyId", "employeeId", "publicUrl"],
      ["requestId", "companyId", "employeeId", "publicUrl"]);
    const employeeId = id(input.employeeId, "employeeId");
    const publicUrl = text(input.publicUrl, "publicUrl", 300);
    let normalized;
    try { normalized = parsePublicWebUrl(publicUrl).href; }
    catch { fail("HIRING_INPUT_INVALID", "trial URL is not an allowed public page"); }
    if (!normalized.startsWith("https:")) fail("HIRING_INPUT_INVALID", "trial URL must use HTTPS");
    return commit("StartEmployeeTrial", input, [input.companyId, employeeId, normalized], () => {
      if (!trialExecutionReady()) fail("HIRING_EXECUTION_UNAVAILABLE", "real trial execution is unavailable");
      const { hiring } = owned(input.companyId, employeeId);
      if (hiring.origin !== "FOUNDER_DRAFT" || hiring.state !== "DRAFT")
        fail("HIRING_TRIAL_UNAVAILABLE", "only an untried Employee draft can start a trial");
      const started = kernel.startEmployeeTrial({ companyId: input.companyId, employeeId, publicUrl: normalized });
      return { command: "StartEmployeeTrial", employeeId, trialWorkId: started.work.id,
        taskId: started.task.id, workerRunId: started.workerRun.id, lifecycleState: "TRIAL" };
    });
  });

  const ConfirmEmployeeHire = input => mapped(() => {
    exact(input, ["requestId", "companyId", "employeeId", "trialWorkId", "artifactId",
      "artifactDigest", "reviewId", "expectedHiringBasis", "expectedWorkBasis"],
    ["requestId", "companyId", "employeeId", "trialWorkId", "artifactId",
      "artifactDigest", "reviewId", "expectedHiringBasis", "expectedWorkBasis"]);
    const employeeId = id(input.employeeId, "employeeId");
    const trialWorkId = id(input.trialWorkId, "trialWorkId");
    const artifactId = id(input.artifactId, "artifactId");
    const artifactDigest = digest(input.artifactDigest);
    const reviewId = id(input.reviewId, "reviewId");
    const expectedHiringBasis = basis(input.expectedHiringBasis, "expectedHiringBasis");
    const expectedWorkBasis = basis(input.expectedWorkBasis, "expectedWorkBasis");
    const material = [input.companyId, employeeId, trialWorkId, artifactId, artifactDigest,
      reviewId, expectedHiringBasis, expectedWorkBasis];
    return commit("ConfirmEmployeeHire", input, material, () => {
      const { hiring } = owned(input.companyId, employeeId);
      if (hiring.state === "ACTIVE") fail("HIRING_ALREADY_ACTIVE", "Employee is already active");
      if (hiring.origin !== "FOUNDER_DRAFT" || hiring.state !== "READY_FOR_FOUNDER_CONFIRMATION")
        fail("HIRING_TRIAL_NOT_PASSED", "trial is not ready for Founder confirmation");
      if (hiring.basis !== expectedHiringBasis) fail("HIRING_BASIS_STALE", "Hiring basis changed");
      if (hiring.trial.workId !== trialWorkId || hiring.trial.reviewedArtifactId !== artifactId ||
          hiring.trial.reviewedArtifactDigest !== artifactDigest || hiring.trial.reviewId !== reviewId)
        fail("HIRING_EVIDENCE_MISMATCH", "trial evidence does not match the Founder decision");
      const review = kernel.review(reviewId);
      const artifact = kernel.artifact(artifactId);
      const producer = artifact?.workerRunId ? kernel.workerRun(artifact.workerRunId) : null;
      const reviewer = review?.reviewerWorkerRunId ? kernel.workerRun(review.reviewerWorkerRunId) : null;
      if (review?.verdict !== "PASS" || review.targetArtifactId !== artifactId ||
          review.targetArtifactDigest !== artifactDigest || producer?.employeeId !== employeeId ||
          !reviewer || reviewer.employeeId === employeeId)
        fail("HIRING_EVIDENCE_MISMATCH", "independent review of this Artifact is required");
      const projection = kernel.workProjection(trialWorkId);
      if (projection.decisionBasis !== expectedWorkBasis)
        fail("HIRING_BASIS_STALE", "trial Work basis changed");
      if (!projection.outcome.accepted)
        kernel.acceptWork({ workId: trialWorkId, artifactId, artifactDigest, basis: expectedWorkBasis });
      else if (projection.outcome.accepted.artifactId !== artifactId ||
          projection.outcome.accepted.artifactDigest !== artifactDigest)
        fail("HIRING_EVIDENCE_MISMATCH", "trial Work accepted a different Artifact");
      const confirmed = kernel.confirmEmployeeHire({ companyId: input.companyId, employeeId,
        expectedBasis: expectedHiringBasis, reviewId, artifactDigest });
      return { command: "ConfirmEmployeeHire", employeeId, trialWorkId,
        artifactId, reviewId, lifecycleState: confirmed.hiring.state };
    });
  });

  const DisableEmployee = input => mapped(() => {
    exact(input, ["requestId", "companyId", "employeeId", "expectedHiringBasis"],
      ["requestId", "companyId", "employeeId", "expectedHiringBasis"]);
    const employeeId = id(input.employeeId, "employeeId");
    const expectedHiringBasis = basis(input.expectedHiringBasis, "expectedHiringBasis");
    return commit("DisableEmployee", input, [input.companyId, employeeId, expectedHiringBasis], () => {
      const { hiring } = owned(input.companyId, employeeId);
      if (hiring.origin !== "FOUNDER_DRAFT" || !hiring.founderConfirmation)
        fail("HIRING_TRIAL_NOT_PASSED", "Employee has no Founder hire record");
      if (hiring.state === "DISABLED") fail("HIRING_ALREADY_DISABLED", "Employee is already disabled");
      if (hiring.state !== "ACTIVE" || hiring.basis !== expectedHiringBasis)
        fail("HIRING_BASIS_STALE", "Employee lifecycle basis changed");
      kernel.setEmployeeEnabled({ employeeId, enabled: false });
      return { command: "DisableEmployee", employeeId, lifecycleState: "DISABLED" };
    });
  });

  return Object.freeze({ CreateEmployeeDraft, StartEmployeeTrial, ConfirmEmployeeHire, DisableEmployee });
}

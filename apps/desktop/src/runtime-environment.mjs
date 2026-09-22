// What the Desktop Shell hands the Runtime process, and what it is allowed to
// say about its own environment.
// Contract: docs/contracts/desktop-worker-backend-discovery-v0.md §5, §7.
//
// Two narrow responsibilities, both pure:
//
//   desktopRuntimeEnvironment  composes the environment for the Runtime child:
//      the operator's execution switches pass through, and a discovered Codex
//      executable is handed over as an absolute path. Nothing else is added,
//      and a discovery result can only ever produce that one variable.
//
//   boundedEnvironmentFacts    summarises the shell's own environment for local
//      diagnostics: PATH, HOME, USER, SHELL, TMPDIR — with any value that looks
//      like a credential removed before it is ever written anywhere.
//
// Neither function is a bridge to the renderer, and neither can write Company
// truth: they describe the process the shell is about to start.

// Everything the Runtime may need to configure execution, and nothing else. A
// declared list keeps the handover auditable: no arbitrary environment blob is
// copied into the Runtime process by this module.
export const EXECUTION_CONFIG_PASSTHROUGH = Object.freeze([
  "FLOWCREDIT_CODEX_REPO",
  "FLOWCREDIT_CODEX_BASE_REVISION",
  "FLOWCREDIT_CODEX_VERIFICATION",
  "FLOWCREDIT_CODEX_PROTECTED_PATHS",
  "FLOWCREDIT_CODEX_EVIDENCE_DIR",
  "FLOWCREDIT_WORKER_TIMEOUT_MS",
]);

export const WORKER_BACKENDS = Object.freeze(["off", "test-worker", "codex-exec"]);
export const CODEX_BACKEND = "codex-exec";
export const CODEX_EXECUTABLE_ENV = "FLOWCREDIT_CODEX_BIN";

const REDACTION_MARKER = /KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL/i;
const MAX_REPORTED_PATH_CHARS = 240;

// A PATH entry is only ever logged when it does not look like it carries a
// credential. Everything else is replaced, never truncated: a partially
// redacted secret is still a leak.
export function redactPathValue(value, { maxChars = MAX_REPORTED_PATH_CHARS } = {}) {
  if (typeof value !== "string") return "";
  const kept = value
    .split(":")
    .map((entry) => (entry.length === 0 || REDACTION_MARKER.test(entry) ? "<redacted>" : entry))
    .join(":");
  return kept.length <= maxChars ? kept : `${kept.slice(0, maxChars)}…(truncated)`;
}

export function boundedEnvironmentFacts({ env = process.env } = {}) {
  const rawPath = typeof env?.PATH === "string" ? env.PATH : "";
  return Object.freeze({
    path: redactPathValue(rawPath),
    pathEntryCount: rawPath.split(":").filter((entry) => entry.length > 0).length,
    home: env?.HOME ? "set" : "unset",
    user: env?.USER ? "set" : "unset",
    shell: env?.SHELL ?? "unset",
    tmpdir: env?.TMPDIR ? "set" : "unset",
  });
}

export function describeEnvironmentFacts(facts) {
  return [
    `pathEntries=${facts.pathEntryCount}`,
    `path=${facts.path}`,
    `home=${facts.home}`,
    `user=${facts.user}`,
    `shell=${facts.shell}`,
    `tmpdir=${facts.tmpdir}`,
  ].join(" ");
}

// The Desktop Shell is not a scheduler and not a second Runtime: this function
// only says which process configuration the Runtime child is started with.
export function desktopRuntimeEnvironment({ env = process.env, discovery = null } = {}) {
  const workerBackend = env?.["FLOWCREDIT_WORKER_BACKEND"] ?? "off";
  const environment = {
    FLOWCREDIT_COORDINATION: env?.["FLOWCREDIT_COORDINATION"] ?? "off",
    FLOWCREDIT_WORKER_BACKEND: workerBackend,
  };
  for (const name of EXECUTION_CONFIG_PASSTHROUGH) {
    const value = env?.[name];
    if (typeof value === "string" && value.length > 0) environment[name] = value;
  }

  // The one addition discovery may make: a validated absolute path, and only
  // when the operator asked for the backend that consumes it. A discovery
  // result never changes the backend selection itself.
  if (workerBackend === CODEX_BACKEND) {
    if (discovery?.available === true && discovery.resolvedPath) {
      environment[CODEX_EXECUTABLE_ENV] = discovery.resolvedPath;
    } else {
      // Discovery failed. An operator's explicit instruction is forwarded
      // untouched so the Runtime can refuse it in its own words — the Shell
      // never substitutes a different executable for one the operator named.
      const override = env?.[CODEX_EXECUTABLE_ENV];
      if (typeof override === "string" && override.length > 0)
        environment[CODEX_EXECUTABLE_ENV] = override;
    }
  }
  return Object.freeze(environment);
}

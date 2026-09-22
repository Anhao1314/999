// DesktopWorkerBackendDiscovery — which local Worker backend executable this
// machine offers.
// Contract: docs/contracts/desktop-worker-backend-discovery-v0.md.
//
// Infrastructure discovery only. It answers exactly one question — "is this
// backend executable locally available?" — and returns a bounded result: an
// absolute path, a version and where it was found. It never executes Work,
// never picks an Employee, Task or Permission, and never writes Company truth.
// An available backend grants nothing: the Runtime still decides what runs.
//
// Nothing here touches a shell: candidates are absolute paths, the probe is a
// direct spawn of the candidate with `--version`, no profile is sourced, and no
// user-supplied string is ever interpolated into a command line. The renderer
// never sees any of this: the result configures the Runtime process this shell
// starts, and stops there.
import { spawn } from "node:child_process";
import { accessSync, constants, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const CODEX_BACKEND_TYPE = "codex-exec";
// The one explicit override shape this slice accepts: an absolute path to the
// provider executable. Not a command line, not a shell string, not a PATH.
export const OVERRIDE_ENV = "FLOWCREDIT_CODEX_BIN";

export const DISCOVERY_SOURCES = Object.freeze({
  EXPLICIT_OVERRIDE: "EXPLICIT_OVERRIDE",
  PATH: "PATH",
  STANDARD_LOCATION: "STANDARD_LOCATION",
  KNOWN_APP_BUNDLE: "KNOWN_APP_BUNDLE",
  NONE: "NONE",
});

export const REJECTION_CODES = Object.freeze([
  "PATH_NOT_ABSOLUTE",
  "PATH_MALFORMED",
  "PATH_MISSING",
  "PATH_NOT_A_FILE",
  "PATH_NOT_EXECUTABLE",
  "PATH_UNRESOLVABLE",
  "DUPLICATE",
  "PROBE_FAILED",
  "PROBE_TIMEOUT",
  "VERSION_UNRECOGNIZED",
]);

export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
export const MAX_DISCOVERY_REJECTIONS = 12;

const MAX_PATH_ENTRIES = 64;
const MAX_DIRECTORY_ENTRIES = 256;
const MAX_PROBE_OUTPUT_BYTES = 8 * 1024;
const MAX_REPORTED_PATH = 240;
const VERSION_LINE = /^codex-cli\s+(\S+)$/;
const BARE_VERSION_LINE = /^\d+\.\d+\.\d+[A-Za-z0-9.+-]*$/;

const boundedPath = (value) =>
  typeof value === "string" ? value.slice(0, MAX_REPORTED_PATH) : String(value).slice(0, MAX_REPORTED_PATH);

// Well-known executable locations for this platform. A bounded, declared list:
// never a recursive search of /Applications or the home directory.
export function defaultStandardLocations({ home = homedir() } = {}) {
  return Object.freeze([
    "/usr/local/bin/codex",
    "/opt/homebrew/bin/codex",
    join(home, ".local", "bin", "codex"),
  ]);
}

// Product-specific bundles that ship a Codex executable. Declared and bounded
// on purpose: one path per known product, plus a single non-recursive listing
// of the editor extension directories that name the extension explicitly.
function editorExtensionCandidates({ home }) {
  const candidates = [];
  for (const root of [".vscode/extensions", ".vscode-insiders/extensions"]) {
    const directory = join(home, root);
    let entries = [];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    if (entries.length > MAX_DIRECTORY_ENTRIES) entries = entries.slice(0, MAX_DIRECTORY_ENTRIES);
    const versions = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("openai.chatgpt-"))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const name of versions)
      candidates.push(join(directory, name, "bin", "macos-aarch64", "codex"));
  }
  return candidates;
}

export function defaultAppBundleCandidates({ home = homedir() } = {}) {
  return Object.freeze([
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    join(home, "Applications", "ChatGPT.app", "Contents", "Resources", "codex"),
    ...editorExtensionCandidates({ home }),
  ]);
}

// Path shape validation only — no execution, no PATH lookup. Returns the
// resolved real path so a package-manager or app-bundle symlink stays legal
// while a directory or a non-executable regular file never is.
export function validateCodexCandidatePath(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0)
    return Object.freeze({ ok: false, code: "PATH_MALFORMED" });
  if (candidate.includes("\0") || /[\r\n]/.test(candidate) || candidate.trim() !== candidate)
    return Object.freeze({ ok: false, code: "PATH_MALFORMED" });
  if (!isAbsolute(candidate)) return Object.freeze({ ok: false, code: "PATH_NOT_ABSOLUTE" });

  let stats = null;
  try {
    stats = statSync(candidate);
  } catch {
    return Object.freeze({ ok: false, code: "PATH_MISSING" });
  }
  if (!stats.isFile()) return Object.freeze({ ok: false, code: "PATH_NOT_A_FILE" });
  try {
    accessSync(candidate, constants.X_OK);
  } catch {
    return Object.freeze({ ok: false, code: "PATH_NOT_EXECUTABLE" });
  }
  let resolvedPath = null;
  try {
    resolvedPath = realpathSync(candidate);
  } catch {
    return Object.freeze({ ok: false, code: "PATH_UNRESOLVABLE" });
  }
  return Object.freeze({ ok: true, resolvedPath });
}

// A bounded, direct probe: the candidate is spawned as the executable, never
// through a shell, with a hard timeout and a small output cap. A backend that
// cannot state its own version is not accepted.
export function probeCodexExecutable(executablePath, { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    let child = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Object.freeze(result));
    };
    const timer = setTimeout(() => {
      try {
        child?.kill("SIGKILL");
      } catch {
        // best effort
      }
      finish({ ok: false, code: "PROBE_TIMEOUT" });
    }, timeoutMs);
    timer.unref?.();

    try {
      child = spawn(executablePath, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      finish({ ok: false, code: "PROBE_FAILED" });
      return;
    }
    child.once("error", () => finish({ ok: false, code: "PROBE_FAILED" }));
    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_PROBE_OUTPUT_BYTES) stdout += chunk.toString().slice(0, MAX_PROBE_OUTPUT_BYTES);
    });
    child.stderr.on("data", () => {});
    child.once("close", (code) => {
      if (code !== 0) return finish({ ok: false, code: "PROBE_FAILED" });
      const line = stdout
        .split("\n")
        .map((entry) => entry.trim())
        .find((entry) => entry.length > 0);
      const matched = line ? line.match(VERSION_LINE) : null;
      const version = matched ? matched[1] : line && BARE_VERSION_LINE.test(line) ? line : null;
      if (!version || version.length > 128) return finish({ ok: false, code: "VERSION_UNRECOGNIZED" });
      return finish({ ok: true, version });
    });
  });
}

function pathEntries(env) {
  const raw = typeof env?.PATH === "string" ? env.PATH : "";
  return raw
    .split(":")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, MAX_PATH_ENTRIES);
}

// Precedence, declared here and auditable end to end:
//   1. FLOWCREDIT_CODEX_BIN    an explicit absolute path (wins, or fails closed)
//   2. the inherited PATH      the environment this shell was actually given
//   3. standard locations      /usr/local/bin, /opt/homebrew/bin, ~/.local/bin
//   4. known product bundles   ChatGPT.app, installed editor extensions
export async function discoverCodexBackend({
  env = process.env,
  home = homedir(),
  standardLocations = defaultStandardLocations({ home }),
  appBundleCandidates = defaultAppBundleCandidates({ home }),
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  probe = probeCodexExecutable,
  now = () => new Date().toISOString(),
} = {}) {
  const rejections = [];
  const seen = new Set();
  const reject = (candidate, code) => {
    if (rejections.length < MAX_DISCOVERY_REJECTIONS)
      rejections.push(Object.freeze({ candidate: boundedPath(candidate), code }));
  };

  const result = (found) =>
    Object.freeze({
      backendType: CODEX_BACKEND_TYPE,
      available: found !== null,
      executablePath: found?.executablePath ?? null,
      resolvedPath: found?.resolvedPath ?? null,
      version: found?.version ?? null,
      discoveredBy: found?.discoveredBy ?? DISCOVERY_SOURCES.NONE,
      checkedAt: now(),
      rejections: Object.freeze([...rejections]),
    });

  const attempt = async (candidate, discoveredBy) => {
    const validated = validateCodexCandidatePath(candidate);
    if (!validated.ok) {
      reject(candidate, validated.code);
      return null;
    }
    if (seen.has(validated.resolvedPath)) {
      reject(candidate, "DUPLICATE");
      return null;
    }
    seen.add(validated.resolvedPath);
    const probed = await probe(validated.resolvedPath, { timeoutMs: probeTimeoutMs });
    if (!probed.ok) {
      reject(candidate, probed.code);
      return null;
    }
    return {
      executablePath: candidate,
      resolvedPath: validated.resolvedPath,
      version: probed.version,
      discoveredBy,
    };
  };

  // 1. Explicit override. An operator who names a path gets that path or a
  // clear failure — never a silent fallback to some other executable.
  const override = typeof env?.[OVERRIDE_ENV] === "string" ? env[OVERRIDE_ENV] : "";
  if (override.trim().length > 0) {
    const found = await attempt(override, DISCOVERY_SOURCES.EXPLICIT_OVERRIDE);
    return result(found);
  }

  // 2. The PATH this process actually inherited (under LaunchServices that is
  // the system default, not a developer's interactive shell PATH).
  for (const entry of pathEntries(env)) {
    const found = await attempt(join(entry, "codex"), DISCOVERY_SOURCES.PATH);
    if (found) return result(found);
  }

  // 3. Standard macOS executable locations.
  for (const location of standardLocations) {
    const found = await attempt(location, DISCOVERY_SOURCES.STANDARD_LOCATION);
    if (found) return result(found);
  }

  // 4. Declared product bundles known to ship this backend.
  for (const candidate of appBundleCandidates) {
    const found = await attempt(candidate, DISCOVERY_SOURCES.KNOWN_APP_BUNDLE);
    if (found) return result(found);
  }

  return result(null);
}

// The bounded, developer-facing form of a discovery result. Paths stay out of
// the product UI; this line is local infrastructure evidence only.
export function describeDiscovery(discovery) {
  const rejections = discovery.rejections.map((entry) => entry.code).join("|") || "none";
  return [
    `backendType=${discovery.backendType}`,
    `available=${discovery.available}`,
    `source=${discovery.discoveredBy}`,
    `version=${discovery.version ?? "unknown"}`,
    `path=${discovery.resolvedPath ?? "none"}`,
    `rejections=${rejections}`,
  ].join(" ");
}

export const DISCOVERY_BOUNDS = Object.freeze({
  pathEntries: MAX_PATH_ENTRIES,
  directoryEntries: MAX_DIRECTORY_ENTRIES,
  probeOutputBytes: MAX_PROBE_OUTPUT_BYTES,
  reportedPathLength: MAX_REPORTED_PATH,
});

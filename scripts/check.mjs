// Bootstrap-era project check. Zero dependencies, no network, no model calls.
//
// It answers four questions that matter for a clean re-foundation repository:
//   1. does the required project structure exist,
//   2. did generated state or local tool state get tracked by mistake,
//   3. does any tracked file contain something that looks like a credential,
//   4. has legacy implementation been copied in (see AGENTS.md / migration manifest).
//
// The legacy tripwire in `LEGACY_SIGNATURES` is intentional and must be updated
// deliberately when a capability is officially extracted.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const failures = [];
const notes = [];

const REQUIRED_PATHS = [
  "README.md",
  "AGENTS.md",
  ".gitignore",
  ".nvmrc",
  "package.json",
  "docs/product/mvp-v0.md",
  "docs/architecture/principles.md",
  "docs/architecture/object-model.md",
  "docs/migration/from-flowcredit-worklab-v1.md",
];

const FORBIDDEN_TRACKED = [
  /^node_modules\//,
  /^\.runtime\//,
  /^\.pages\//,
  /^dist\//,
  /^build\//,
  /^coverage\//,
  /^\.test-[^/]+\//,
  /^\.negative-[^/]+\//,
  /^\.vscode\//,
  /^\.xgrok\//,
  /^\.peridot\//,
  /\.log$/,
  /\.pid$/,
  /\.sqlite3?$/,
  /\.db$/,
];

// Paths that only appear here if an old repository was copied in wholesale.
const LEGACY_SIGNATURES = [
  "apps/runtime/server.mjs",
  "packages/control-plane/store.mjs",
  "packages/harness-adapter",
  "apps/web/swarm-space",
  "experiments/reconciliation",
  "fixtures/northstar/seed.mjs",
];

// Assembled at runtime so this file does not contain the literal it searches
// for (otherwise the credential scan flags the checker itself).
const SENSOR_CREDENTIAL_MARKER = ["TYPESAFE", "API", "KEY"].join("_");

const SECRET_PATTERNS = [
  [/sk-[A-Za-z0-9]{16,}/, "provider-style secret key"],
  [/apikey_[A-Za-z0-9]{16,}/, "api key identifier"],
  [/(ghp_|gho_|github_pat_)[A-Za-z0-9_]{20,}/, "github token"],
  [/AKIA[0-9A-Z]{16}/, "aws access key id"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key block"],
  [/\b(sk|pk)_(live|test)_[A-Za-z0-9]{16,}/, "stripe-style key"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, "slack token"],
  [new RegExp(SENSOR_CREDENTIAL_MARKER), "sensor credential reference"],
];

const fileExists = (relative) => existsSync(join(root, relative));

// --- 1. structure -----------------------------------------------------------
for (const relative of REQUIRED_PATHS) {
  if (!fileExists(relative)) failures.push(`missing required file: ${relative}`);
}

// --- 2. generated / local state must not be tracked -------------------------
let tracked = [];
try {
  tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
} catch {
  notes.push("git not available or not a repository: tracked-file checks skipped");
}
for (const path of tracked) {
  for (const pattern of FORBIDDEN_TRACKED)
    if (pattern.test(path)) failures.push(`generated or local state is tracked: ${path}`);
}

// --- 3. credentials must never be committed ---------------------------------
for (const path of tracked) {
  if (/\.(png|jpg|jpeg|gif|ico|woff2?|ttf|tgz|zip)$/i.test(path)) continue;
  let text;
  try {
    if (statSync(join(root, path)).size > 512 * 1024) continue;
    text = readFileSync(join(root, path), "utf8");
  } catch {
    continue;
  }
  for (const [pattern, label] of SECRET_PATTERNS)
    if (pattern.test(text)) failures.push(`${label} pattern in ${path}`);
}

// --- 4. no legacy copy ------------------------------------------------------
for (const signature of LEGACY_SIGNATURES)
  if (fileExists(signature))
    failures.push(`legacy implementation copied in without extraction: ${signature}`);

// --- report -----------------------------------------------------------------
if (failures.length) {
  console.error(`FAIL (${failures.length})`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `OK — structure: ${REQUIRED_PATHS.length} required files, tracked files: ${tracked.length}, no credentials, no copied legacy.`,
);
for (const note of notes) console.log(`note: ${note}`);

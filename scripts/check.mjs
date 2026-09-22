// Project check. Zero dependencies, no network, no model calls.
//
// It answers five questions that matter for a clean re-foundation repository:
//   1. does the required project structure exist,
//   2. did generated state or local tool state get tracked by mistake,
//   3. does any tracked file contain something that looks like a credential,
//   4. has legacy implementation been copied in (see AGENTS.md / migration manifest),
//   5. does the product core still speak its own domain language
//      (milestone charter §32: no legacy research vocabulary in `packages/`
//      or `apps/runtime/`).
//
// The legacy tripwire in `LEGACY_SIGNATURES` is intentional and must be updated
// deliberately when a capability is officially extracted.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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
  "docs/contracts/persistent-work-kernel-v0.md",
  "docs/contracts/workforce-identity-assignment-v0.md",
  "docs/contracts/review-repair-collaboration-v0.md",
  "docs/contracts/founder-attention-acceptance-v0.md",
  "docs/contracts/work-continuity-v0.md",
  "docs/migration/from-flowcredit-worklab-v1.md",
  "packages/runtime/index.mjs",
  "apps/runtime/server.mjs",
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
  "packages/control-plane",
  "packages/research-adapter",
  "packages/harness-adapter",
  "apps/web/swarm-space",
  "apps/pages/demo-runtime.js",
  "experiments/reconciliation",
  "fixtures/northstar/seed.mjs",
];

// Directories that hold the product core. They must never regain the old
// domain vocabulary: migration docs, tests and provenance comments may quote
// it, the running core may not.
const CORE_ROOTS = ["packages", "apps/runtime"];

// Assembled at runtime so this file does not contain its own tripwires.
const LEGACY_DOMAIN_TERMS = [
  [new RegExp(["RESEARCH", "_PENDING"].join(""), "i"), "legacy task state"],
  [new RegExp(["REVIEW", "_PENDING"].join(""), "i"), "legacy task state"],
  [new RegExp(["MEMO", "_READY"].join(""), "i"), "legacy task state"],
  [new RegExp(["north", "star"].join(""), "i"), "legacy duty name"],
  [new RegExp(["Research", "Duty"].join(""), ""), "legacy duty object"],
  [new RegExp(["\\b", "memo", "s?\\b"].join(""), "i"), "legacy artifact name"],
  [new RegExp(["\\b", "claim", "s?\\b"].join(""), "i"), "legacy research object"],
  [new RegExp(["\\bR-", "0\\d\\b"].join(""), ""), "legacy record id"],
];

// The workforce core must stay domain-generic: capabilities, requirements,
// employee ids and position ids are what it handles. Shipped employee names and
// capability ids are seed *data* (fixtures/seeds/), never core logic.
const HARDCODED_ROLE_TERMS = [
  [new RegExp(["Research", " Analyst"].join(""), "i"), "hardcoded employee name"],
  [new RegExp(["Independent", " Reviewer"].join(""), "i"), "hardcoded employee name"],
  [new RegExp(["research", ".execute"].join(""), ""), "hardcoded capability id"],
  [new RegExp(["review", ".independent"].join(""), ""), "hardcoded capability id"],
];

function walkFiles(relative) {
  const found = [];
  const visit = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else found.push(path);
    }
  };
  visit(relative);
  return found;
}

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

// --- 5. the core keeps its own language -------------------------------------
let coreFiles = 0;
const IMPORT_PATTERN = /(?:^|\n)\s*import\s+(?:[^"'();]*?from\s*)?["']([^"']+)["']/g;
for (const coreRoot of CORE_ROOTS) {
  if (!fileExists(coreRoot)) continue;
  for (const path of walkFiles(coreRoot)) {
    if (!/\.(mjs|js|json|md)$/.test(path)) continue;
    coreFiles += 1;
    const text = readFileSync(join(root, path), "utf8");
    for (const [pattern, label] of LEGACY_DOMAIN_TERMS)
      if (pattern.test(text))
        failures.push(`legacy domain vocabulary (${label}) in core file ${path}`);
    for (const [pattern, label] of HARDCODED_ROLE_TERMS)
      if (pattern.test(text))
        failures.push(`${label} in core file ${path}`);
    // The kernel must run with zero third-party dependencies (charter §23, §33).
    for (const [, specifier] of text.matchAll(IMPORT_PATTERN))
      if (!specifier.startsWith("node:") && !specifier.startsWith("."))
        failures.push(
          `core file ${path} imports a third-party dependency: ${specifier}`,
        );
      else if (/(^|\/)(fixtures|scripts)\//.test(specifier))
        failures.push(
          `core file ${path} imports from outside the core: ${specifier}`,
        );
  }
}

// --- report -----------------------------------------------------------------
if (failures.length) {
  console.error(`FAIL (${failures.length})`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(
  `OK — structure: ${REQUIRED_PATHS.length} required files, tracked files: ${tracked.length}, no credentials, no copied legacy, core vocabulary clean (${coreFiles} files).`,
);
for (const note of notes) console.log(`note: ${note}`);

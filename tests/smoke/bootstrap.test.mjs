import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Bootstrap-stage contract. These tests protect the *foundation* — module mode,
// frozen MVP scope, honest status reporting and the no-legacy-copy rule — so a
// future milestone cannot quietly turn this repository into something else.
// They deliberately do not test business behaviour, because none exists yet.

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (relative) => readFileSync(join(root, relative), "utf8");
const pkg = JSON.parse(read("package.json"));

test("package.json declares ESM, the pinned Node line and no dependencies", () => {
  assert.equal(pkg.type, "module");
  assert.equal(pkg.private, true);
  assert.match(pkg.engines.node, /^>=24\.19\.0 <25$/);
  assert.equal(pkg.scripts.test, "node --test");
  assert.equal(pkg.scripts.check, "node scripts/check.mjs");
  assert.deepEqual(pkg.dependencies ?? {}, {}, "bootstrap must stay dependency-free");
  assert.deepEqual(pkg.devDependencies ?? {}, {});
});

test("the running Node satisfies the repository pin", () => {
  const pinned = read(".nvmrc").trim();
  assert.match(pinned, /^24\.19\.\d+$/);
  const [major] = process.versions.node.split(".");
  assert.equal(major, pinned.split(".")[0], "Node major must match .nvmrc");
  assert.ok(
    process.versions.node.localeCompare(pinned, undefined, { numeric: true }) >= 0,
    `expected Node >= ${pinned}, got ${process.versions.node}`,
  );
});

test("the product definition exists and freezes the three MVPs", () => {
  const mvp = read("docs/product/mvp-v0.md");
  for (const name of ["Company Genesis", "AI Workforce Loop", "AI Hiring Loop"])
    assert.ok(mvp.includes(name), `mvp doc must define ${name}`);
  assert.ok(mvp.includes("Company Canvas ≠ MVP 4"));
  assert.ok(mvp.includes("Jev ≠ MVP 4"));
  assert.ok(/Dynamic Swarm 不是当前 blocker/.test(mvp));
  // The five missing product objects that MVP 1/3 introduce must be named, not implied.
  for (const object of ["FounderProfile", "CompanyProfile", "WorkspaceProfile", "Position", "Employee"])
    assert.ok(mvp.includes(object), `mvp doc must name ${object}`);
});

test("README reports bootstrap status honestly", () => {
  const readme = read("README.md");
  assert.match(readme, /Re-foundation \/ bootstrap stage/);
  assert.match(readme, /没有任何 MVP 实现|not started/);
  assert.ok(readme.includes("docs/migration/from-flowcredit-worklab-v1.md"));
  assert.match(readme, /capability by capability/);
});

test("AGENTS.md carries the reusable engineering rules", () => {
  const agents = read("AGENTS.md");
  for (const clause of [
    /三个 MVP 是最高优先级/,
    /READ ONLY/,
    /capability by capability, contract by contract, test by test/,
    /Runtime truth > UI/,
    /不放 fake production data/,
    /Founder = Authority/,
    /Work 持久，员工流动/,
    /未经明确授权不 commit/,
  ])
    assert.match(agents, clause);
});

test("the migration manifest keeps provenance for every legacy capability", () => {
  const manifest = read("docs/migration/from-flowcredit-worklab-v1.md");
  for (const capability of [
    "Persistent Work substrate",
    "Repair loop",
    "Founder Inbox",
    "Agent Identity",
    "Founder Decision Closure",
    "Company Canvas Interaction Foundation",
    "Decision Plane / Jev",
    "Swarm Office",
    "Northstar",
    "Pages demos",
  ])
    assert.ok(manifest.includes(capability), `manifest must cover ${capability}`);
  // Provenance must record where a capability came from, including uncommitted work.
  assert.ok(manifest.includes("uncommitted"));
  assert.ok(manifest.includes("do not merge both") || manifest.includes("A is canonical"));
});

test("generated state and local tool state are ignored, canonical files are not", () => {
  const ignore = read(".gitignore");
  for (const pattern of ["node_modules/", ".runtime/", ".pages/", ".test-*/", ".env", "coverage/", ".vscode/", ".peridot/"])
    assert.ok(ignore.includes(pattern), `.gitignore must ignore ${pattern}`);
  const ignored = (path) => {
    try {
      execFileSync("git", ["check-ignore", "-q", path], { cwd: root });
      return true;
    } catch {
      return false;
    }
  };
  for (const canonical of ["AGENTS.md", "README.md", "docs", "package.json", ".nvmrc"])
    assert.equal(ignored(canonical), false, `${canonical} must not be ignored`);
});

test("no legacy implementation has been copied in", () => {
  for (const legacy of [
    "apps/runtime/server.mjs",
    "packages/control-plane/store.mjs",
    "apps/web/swarm-space",
    "experiments/reconciliation",
  ])
    assert.equal(existsSync(join(root, legacy)), false, `legacy path present: ${legacy}`);
});

test("the repository check passes on a clean tree", () => {
  const output = execFileSync("node", ["scripts/check.mjs"], { cwd: root, encoding: "utf8" });
  assert.match(output, /^OK —/);
});

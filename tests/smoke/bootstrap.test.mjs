import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Foundation contract. These tests protect the *repository itself* — module
// mode, frozen MVP scope, honest status reporting, the extraction contract and
// the no-legacy-copy rule — so a future milestone cannot quietly turn this
// repository into something else. Business behaviour is covered by the kernel
// tests under tests/unit and tests/integration.

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

test("README reports implementation status honestly", () => {
  const readme = read("README.md");
  assert.match(
    readme,
    /Foundation \+ Persistent Work Kernel v0A \+ Workforce Identity & Assignment v0B1/,
  );
  assert.match(readme, /Review \/ Repair Collaboration v0B2/);
  assert.match(readme, /Reviewer PASS ≠ Founder ACCEPT/);
  assert.match(readme, /Three MVPs: \*\*still not complete\.\*\*/);
  assert.match(readme, /docs\/contracts\/persistent-work-kernel-v0\.md/);
  assert.match(readme, /docs\/contracts\/workforce-identity-assignment-v0\.md/);
  assert.match(readme, /docs\/contracts\/review-repair-collaboration-v0\.md/);
  assert.ok(readme.includes("docs/migration/from-flowcredit-worklab-v1.md"));
  assert.match(readme, /capability by capability/);
});

test("the extraction contract freezes the kernel semantics", () => {
  const contract = read("docs/contracts/persistent-work-kernel-v0.md");
  for (const section of [
    "## 1. Company",
    "## 2. Work",
    "## 3. Task",
    "## 5. Artifact",
    "## 6. Checkpoint",
    "## 7. Activity / Event",
    "## 9. Recovery",
    "## 10. Cancellation",
  ])
    assert.ok(contract.includes(section), `contract must define ${section}`);
  assert.ok(contract.includes("Duty is not Company"), "the Duty correction must be explicit");
  assert.match(contract, /Fencing token/i);
});

test("the workforce contract freezes identity, assignment and provenance", () => {
  const contract = read("docs/contracts/workforce-identity-assignment-v0.md");
  for (const section of [
    "## 2. Position",
    "## 3. Employee",
    "## 4. TaskRequirement",
    "## 5. Assignment",
    "## 6. WorkerRun",
    "## 9. Artifact producer provenance",
    "## 12. Storage and the v1 → v2 migration",
    "## 13. Where the system employees live",
  ])
    assert.ok(contract.includes(section), `workforce contract must define ${section}`);
  assert.match(contract, /provider/i, "the contract must address provider vs identity");
  assert.match(contract, /NULL/, "honest absence of a producer must be stated");
});

test("the review / repair contract freezes the collaboration protocol", () => {
  const contract = read("docs/contracts/review-repair-collaboration-v0.md");
  for (const section of [
    "## 2. Review requirement",
    "## 4. Review — the immutable judgment record",
    "## 5. Review execution uses the ordinary workforce",
    "## 8. Repair",
    "## 9. Artifact supersession",
    "## 12. Work collaboration projection",
    "## 14. Storage: schema v2 → v3",
  ])
    assert.ok(contract.includes(section), `review contract must define ${section}`);
  // The three refusals this milestone exists to make explicit.
  assert.ok(contract.includes("second state machine"), "repair must reuse the v0A Task lifecycle");
  assert.ok(contract.includes("REVIEW_IMMUTABLE"), "immutable review history must be stated");
  assert.ok(contract.includes("never a write to the old one"), "supersession must not rewrite history");
  assert.match(contract, /PASS does \*\*not\*\* mean Founder ACCEPT/);
  assert.ok(contract.includes("Reviewer PASS ≠ Founder ACCEPT"));
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
    "packages/control-plane",
    "packages/research-adapter",
    "packages/harness-adapter",
    "apps/web/swarm-space",
    "apps/pages/demo-runtime.js",
    "experiments/reconciliation",
    "fixtures/northstar/seed.mjs",
  ])
    assert.equal(existsSync(join(root, legacy)), false, `legacy path present: ${legacy}`);

  // The runtime app is the new kernel transport, not a copied old server.
  const server = read("apps/runtime/server.mjs");
  assert.match(server, /Persistent Work Kernel/);
  assert.ok(server.includes("packages/runtime/index.mjs"));
});

test("the repository check passes on a clean tree", () => {
  const output = execFileSync("node", ["scripts/check.mjs"], { cwd: root, encoding: "utf8" });
  assert.match(output, /^OK —/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { applicationMenuTemplate } from "../../apps/desktop/src/application-menu.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (relative) => readFile(new URL(`../../${relative}`, import.meta.url), "utf8");

const rolesOf = (template) =>
  template.flatMap((item) => (item.submenu ?? []).map((entry) => entry.role).filter(Boolean));

test("Relay Code menu stays minimal and hides DevTools from packaged launches", () => {
  const packaged = applicationMenuTemplate({
    appName: "Relay Code",
    isPackaged: true,
    platform: "darwin",
  });
  const development = applicationMenuTemplate({
    appName: "Relay Code",
    isPackaged: false,
    platform: "darwin",
  });

  const appMenu = packaged.find((item) => item.label === "Relay Code");
  assert.ok(appMenu, "macOS application menu must be present");
  for (const role of ["about", "hide", "quit"])
    assert.ok(rolesOf([appMenu]).includes(role), `application menu must expose ${role}`);

  const fileMenu = packaged.find((item) => item.label === "File");
  assert.deepEqual(
    fileMenu.submenu.filter((entry) => entry.label === "New Work").map((entry) => entry.enabled),
    [false],
    "New Work stays disabled while deferred",
  );

  assert.ok(rolesOf(packaged).includes("togglefullscreen"));
  assert.equal(rolesOf(packaged).includes("toggleDevTools"), false);
  assert.equal(rolesOf(development).includes("toggleDevTools"), true);
});

test("desktop navigation menu uses the same page names, shortcuts and current-page mark", () => {
  const destinations = [];
  const menu = applicationMenuTemplate({
    appName: "Relay Code",
    isPackaged: true,
    platform: "darwin",
    currentPath: "/employees",
    navigate: (path) => destinations.push(path),
  });
  const entries = menu.find((item) => item.label === "导航")?.submenu ?? [];
  const company = entries.find((item) => item.label === "公司");
  const employees = entries.find((item) => item.label === "AI 员工");
  const search = entries.find((item) => item.label === "搜索当前页面");
  assert.equal(company?.checked, false);
  assert.equal(employees?.checked, true);
  assert.equal(company?.accelerator, "CmdOrCtrl+1");
  assert.equal(employees?.accelerator, "CmdOrCtrl+2");
  assert.equal(search?.accelerator, "CmdOrCtrl+K");
  company.click(); employees.click(); search.click();
  assert.deepEqual(destinations, ["/workspace", "/employees", "search"]);
});

test("the frozen master icon is a valid, unmodified 1254x1254 PNG", async () => {
  const iconPath = fileURLToPath(
    new URL("../../apps/desktop/assets/relay-code-master.png", import.meta.url),
  );
  const bytes = await readFile(iconPath);
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "master icon must be a PNG",
  );
  assert.equal(bytes.readUInt32BE(16), 1254);
  assert.equal(bytes.readUInt32BE(20), 1254);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "0a1956a24e0f5d742ef22bfba5d39cf77b1ccbc5b231601914082b05b2d88bf3",
  );
});

test("icon generation derives RelayCode.icns from the frozen master without rewriting it", async () => {
  const script = await read("apps/desktop/scripts/generate-icon.mjs");
  assert.match(script, /0a1956a24e0f5d742ef22bfba5d39cf77b1ccbc5b231601914082b05b2d88bf3/);
  assert.match(script, /"sips"/);
  assert.match(script, /"iconutil"/);
  assert.match(script, /build\/RelayCode\.icns/);
  assert.doesNotMatch(script, /Downloads/);
  assert.doesNotMatch(script, /writeFile/, "icon generation must not rewrite the master");
});

test("packaging names the icon resource, audits the bundle and ignores stale dist output", async () => {
  const script = await read("apps/desktop/scripts/package.mjs");
  assert.match(script, /const ICON_RESOURCE_NAME = "RelayCode\.icns"/);
  assert.match(script, /CFBundleIconFile: ICON_RESOURCE_NAME/);
  assert.match(script, /generateIcon/);
  assert.match(script, /ICON_SOURCE=\$\{icon\.master\}/);
  assert.match(script, /from "\.\/generate-icon\.mjs"/);
  assert.doesNotMatch(script, /Downloads/);
  assert.match(
    script,
    /await rm\(DIST_DIR, \{ recursive: true, force: true \}\)/,
    "packaging must not rely on leftover dist output",
  );
  assert.match(script, /auditBundleResources/);
  assert.match(script, /leaks the checkout path/);
});

test("desktop source owns process lifecycle only and never commands the Runtime", async () => {
  const files = await readdir(new URL("../../apps/desktop/src/", import.meta.url), {
    withFileTypes: true,
  });
  const sources = await Promise.all(
    files
      .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
      .map(async (entry) => [entry.name, await read(`apps/desktop/src/${entry.name}`)]),
  );
  const combined = sources.map(([, text]) => text).join("\n");

  for (const forbidden of [
    "node:sqlite",
    "DatabaseSync",
    "contextBridge",
    "ipcRenderer",
    "/commands",
    "createCompany",
    "createWork",
    "createTask",
    "startTask",
    "assignTask",
    "startWorkerRun",
    "completeWorkerRun",
    "submitWorkerResult",
    "interruptWorkerRun",
    "requestReview",
    "submitReview",
    "createRepairTask",
    "acceptWork",
    "materializeNextAction",
    "driveWork",
    "bootstrapWorkforce",
  ])
    assert.equal(
      combined.includes(forbidden),
      false,
      `desktop source must not contain ${forbidden}`,
    );

  const main = sources.find(([name]) => name === "main.mjs")?.[1] ?? "";
  assert.equal(main.includes("fetch("), false, "only the Runtime lifecycle probes /health");
  const lifecycle = sources.find(([name]) => name === "runtime-lifecycle.mjs")?.[1] ?? "";
  assert.equal(
    lifecycle.split("fetch(").length - 1,
    1,
    "the Runtime lifecycle owns the single /health probe",
  );
  assert.match(lifecycle, /\/health/);
});

test("desktop window keeps the frozen security and navigation contract", async () => {
  const main = await read("apps/desktop/src/main.mjs");
  assert.match(main, /const APP_NAME = "Relay Code"/);
  assert.match(main, /const BUNDLE_ID = "com\.flowcredit\.relaycode"/);
  assert.match(main, /contextIsolation: true/);
  assert.match(main, /nodeIntegration: false/);
  assert.match(main, /sandbox: true/);
  assert.match(main, /webSecurity: true/);
  assert.match(main, /allowRunningInsecureContent: false/);
  assert.match(main, /webviewTag: false/);
  assert.match(main, /navigateOnDragDrop: false/);
  assert.match(main, /contents\.on\("will-navigate"/);
  assert.match(main, /setWindowOpenHandler/);
  assert.match(main, /will-attach-webview/);
  assert.match(main, /setPermissionRequestHandler/);
  assert.match(main, /setPermissionCheckHandler\(\(\) => false\)/);
  assert.match(main, /requestSingleInstanceLock/);
  assert.match(main, /app\.on\("second-instance"[\s\S]*?mainWindow\.focus\(\)/);
  assert.match(main, /desktopRuntimeDataDir/);
  assert.match(main, /app\.getPath\("userData"\)/);
});

test("desktop build outputs stay ignored while the master icon stays canonical", () => {
  const ignored = (path) => {
    try {
      // --no-index keeps the answer a pure pathname rule: CI checks out a tree
      // where build outputs do not exist yet.
      execFileSync("git", ["check-ignore", "-q", "--no-index", path], { cwd: ROOT });
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(ignored("apps/desktop/dist/"), true);
  assert.equal(ignored("apps/desktop/build/"), true);
  assert.equal(ignored("apps/desktop/node_modules/"), true);
  assert.equal(ignored("apps/desktop/dist/Relay Code-darwin-arm64/Relay Code.app"), true);
  assert.equal(ignored("apps/desktop/assets/relay-code-master.png"), false);
  assert.equal(ignored("apps/desktop/src/main.mjs"), false);
  assert.equal(ignored("apps/desktop/scripts/package.mjs"), false);
});

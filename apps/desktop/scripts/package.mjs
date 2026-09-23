import { packager } from "@electron/packager";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { generateIcon } from "./generate-icon.mjs";
const execFileAsync = promisify(execFile);
const APP_DIR = fileURLToPath(new URL("../", import.meta.url));
const REPOSITORY_ROOT = resolve(APP_DIR, "../..");
const BUILD_DIR = resolve(APP_DIR, "build");
const RUNTIME_BUNDLE = resolve(BUILD_DIR, "runtime-bundle");
const DIST_DIR = resolve(APP_DIR, "dist");
const APP_NAME = "Relay Code";
const BUNDLE_ID = "com.flowcredit.relaycode";
const ICON_RESOURCE_NAME = "RelayCode.icns";
const APP_PACKAGE = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const RUNTIME_PATHS = [
  "apps/runtime",
  "apps/workspace",
  "apps/employee",
  "apps/local-origin.mjs",
  "packages",
];

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(path) {
  const hash = createHash("sha256");
  const { createReadStream } = await import("node:fs");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function stageRuntimeBundle() {
  await rm(RUNTIME_BUNDLE, { recursive: true, force: true });
  await mkdir(RUNTIME_BUNDLE, { recursive: true });
  for (const relative of RUNTIME_PATHS) {
    await cp(resolve(REPOSITORY_ROOT, relative), resolve(RUNTIME_BUNDLE, relative), {
      recursive: true,
    });
  }
}

async function readPlistValue(plist, key) {
  const { stdout } = await execFileAsync("plutil", ["-extract", key, "raw", plist]);
  return stdout.trim();
}

// @electron/packager ships the icon under its own default resource name, so
// the producer normalises it to the name CFBundleIconFile advertises.
async function normalizeIconResource(appPath) {
  const resources = join(appPath, "Contents", "Resources");
  const target = join(resources, ICON_RESOURCE_NAME);
  if (await exists(target)) return target;
  for (const candidateName of ["electron.icns", "Default.icns"]) {
    const candidate = join(resources, candidateName);
    if (!(await exists(candidate))) continue;
    await rename(candidate, target);
    return target;
  }
  throw new Error(`packaged application is missing ${ICON_RESOURCE_NAME}`);
}

const FORBIDDEN_RESOURCE_NAMES = [
  /^\..*\.swp$/,
  /^\.env(?:\..*)?$/,
  /\.(?:sqlite3?|db|db-wal|db-shm)$/i,
  /\.(?:log|pid|tmp)$/i,
];

// Runtime truth must stay in userData: no database, VCS directory, log or
// developer checkout path may be frozen into the shipped bundle.
async function auditBundleResources(resources) {
  const forbidden = [];
  const leakedPaths = [];
  const checkout = Buffer.from(REPOSITORY_ROOT);

  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git") forbidden.push(path);
        await visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (FORBIDDEN_RESOURCE_NAMES.some((pattern) => pattern.test(entry.name)))
        forbidden.push(path);
      const content = await readFile(path);
      if (content.includes(checkout)) leakedPaths.push(path);
    }
  };
  await visit(resources);
  return { forbidden, leakedPaths };
}

async function verifyApp(appPath) {
  const plist = join(appPath, "Contents", "Info.plist");
  const bundleId = await readPlistValue(plist, "CFBundleIdentifier");
  if (bundleId !== BUNDLE_ID)
    throw new Error(`unexpected bundle identifier: ${bundleId}`);

  const productName = await readPlistValue(plist, "CFBundleName");
  if (productName !== APP_NAME)
    throw new Error(`unexpected product name: ${productName}`);

  const iconName = await readPlistValue(plist, "CFBundleIconFile");
  if (iconName !== ICON_RESOURCE_NAME)
    throw new Error(`unexpected bundle icon: ${iconName}`);

  const executable = join(appPath, "Contents", "MacOS", APP_NAME);
  await stat(executable);

  const resources = join(appPath, "Contents", "Resources");
  const icon = join(resources, ICON_RESOURCE_NAME);
  await stat(icon);
  const asar = join(resources, "app.asar");
  await stat(asar);

  const bundledRuntime = join(
    appPath,
    "Contents",
    "Resources",
    "runtime-bundle",
    "apps",
    "runtime",
    "server.mjs",
  );
  await stat(bundledRuntime);

  const { forbidden, leakedPaths } = await auditBundleResources(resources);
  if (forbidden.length > 0)
    throw new Error(`packaged app contains state files: ${forbidden.join(", ")}`);
  if (leakedPaths.length > 0)
    throw new Error(`packaged app leaks the checkout path: ${leakedPaths.join(", ")}`);

  return {
    plist,
    executable,
    bundledRuntime,
    icon,
    asar,
    iconSha256: await sha256File(icon),
  };
}

const icon = await generateIcon();
await rm(DIST_DIR, { recursive: true, force: true });
await stageRuntimeBundle();

const applications = await packager({
  dir: APP_DIR,
  name: APP_NAME,
  executableName: APP_NAME,
  appBundleId: BUNDLE_ID,
  appCategoryType: "public.app-category.productivity",
  appVersion: APP_PACKAGE.version,
  buildVersion: APP_PACKAGE.version,
  platform: "darwin",
  arch: process.arch,
  icon: icon.output,
  out: DIST_DIR,
  overwrite: true,
  prune: true,
  asar: true,
  extraResource: [RUNTIME_BUNDLE],
  ...(process.env.FLOWCREDIT_ELECTRON_ZIP_DIR
    ? { electronZipDir: process.env.FLOWCREDIT_ELECTRON_ZIP_DIR }
    : {}),
  extendInfo: {
    CFBundleIconFile: ICON_RESOURCE_NAME,
    NSAppTransportSecurity: {
      NSAllowsArbitraryLoads: false,
      NSAllowsLocalNetworking: true,
    },
  },
  ignore: [
    /[/\\]build(?:[/\\]|$)/,
    /[/\\]dist(?:[/\\]|$)/,
    /[/\\]node_modules(?:[/\\]|$)/,
    /[/\\]scripts(?:[/\\]|$)/,
    /[/\\]tests(?:[/\\]|$)/,
    /\/assets\/relay-code-master\.png$/,
  ],
});

if (applications.length !== 1)
  throw new Error(`expected one packaged application, received ${applications.length}`);
const appPath = join(applications[0], `${APP_NAME}.app`);
await normalizeIconResource(appPath);
const verified = await verifyApp(appPath);
process.stdout.write(
  [
    `PACKAGED_APP=${appPath}`,
    `BUNDLE_ID=${BUNDLE_ID}`,
    `PRODUCT_NAME=${APP_NAME}`,
    `ICON_SOURCE=${icon.master}`,
    `ICON_SOURCE_SHA256=${icon.sha256}`,
    `ICON_RESOURCE=${verified.icon}`,
    `ICON_RESOURCE_SHA256=${verified.iconSha256}`,
    `RUNTIME=${verified.bundledRuntime}`,
  ].join("\n") + "\n",
);

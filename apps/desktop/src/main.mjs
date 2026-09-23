import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, session, shell } = require("electron");
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRuntimeUrl, isSafeExternalUrl } from "./navigation-policy.mjs";
import { desktopRuntimeDataDir } from "./desktop-paths.mjs";
import { applicationMenuTemplate } from "./application-menu.mjs";
import { RuntimeLifecycle } from "./runtime-lifecycle.mjs";
import { LocalSecretStore } from "./local-secret-store.mjs";
import { createJevSettingsController } from "./jev-settings-controller.mjs";
import { createDeepSeekSettingsController, DEEPSEEK_SECRET_NAME } from "./deepseek-settings-controller.mjs";
import { describeDiscovery, discoverCodexBackend } from "./worker-backend-discovery.mjs";
import {
  boundedEnvironmentFacts,
  describeEnvironmentFacts,
  desktopRuntimeEnvironment,
} from "./runtime-environment.mjs";

const APP_NAME = "Relay Code";
const BUNDLE_ID = "com.flowcredit.relaycode";
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

let mainWindow = null;
let settingsWindow = null;
let runtime = null;
let runtimeBaseUrl = null;
let shutdownPromise = null;
let shutdownComplete = false;
let runtimeMutation = Promise.resolve();
let secretStore = null;
let runtimeLocationValue = null;
let backendDiscovery = null;

function runtimeLocation() {
  if (app.isPackaged) {
    const root = join(process.resourcesPath, "runtime-bundle");
    return {
      root,
      entry: join(root, "apps", "runtime", "server.mjs"),
    };
  }
  return {
    root: REPOSITORY_ROOT,
    entry: join(REPOSITORY_ROOT, "apps", "runtime", "server.mjs"),
  };
}

function log(message) {
  process.stdout.write(`[relay-code] ${message}\n`);
}

function runtimeDataDir() {
  return desktopRuntimeDataDir({
    userDataPath: app.getPath("userData"),
    isPackaged: app.isPackaged,
  });
}

function installApplicationMenu() {
  const navigate = (target) => {
    if (!mainWindow || !runtimeBaseUrl) return;
    const current = new URL(mainWindow.webContents.getURL());
    const path = target === "search" ? (() => {
      const page = current.pathname === "/employees" ? "/employees" : "/workspace";
      const params = new URLSearchParams(current.search);
      params.set("search", "1");
      return `${page}?${params}`;
    })() : target;
    if (target !== "search" && current.pathname === path) return;
    void mainWindow.loadURL(`${runtimeBaseUrl}${path}`);
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      applicationMenuTemplate({ appName: APP_NAME, isPackaged: app.isPackaged, navigate, openSettings, currentPath: mainWindow?.webContents.getURL() ? new URL(mainWindow.webContents.getURL()).pathname : "/workspace" }),
    ),
  );
}

function openSettings() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  const window = new BrowserWindow({
    title: "模型与 Relay Sense 设置", width: 660, height: 710, minWidth: 560, minHeight: 600,
    parent: mainWindow ?? undefined, show: false, backgroundColor: "#f5f6f8",
    webPreferences: {
      preload: fileURLToPath(new URL("./settings-preload.cjs", import.meta.url)),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      webviewTag: false, navigateOnDragDrop: false,
    },
  });
  settingsWindow = window;
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.on("closed", () => { if (settingsWindow === window) settingsWindow = null; });
  void window.loadFile(fileURLToPath(new URL("./settings.html", import.meta.url)))
    .then(() => window.show())
    .catch(() => { if (!window.isDestroyed()) window.close(); });
}

function installSettingsIpc(controller, deepseek) {
  const trusted = (event) => settingsWindow && !settingsWindow.isDestroyed() &&
    event.sender === settingsWindow.webContents &&
    event.senderFrame?.url === new URL("./settings.html", import.meta.url).href;
  const handle = (channel, action) => ipcMain.handle(channel, (event, ...args) => {
    if (!trusted(event)) throw new Error("Settings request rejected");
    return action(...args);
  });
  handle("relay-jev-status", () => controller.status());
  handle("relay-jev-save", (key) => controller.save(key));
  handle("relay-jev-remove", () => controller.remove());
  handle("relay-jev-test", () => controller.test());
  handle("relay-deepseek-status", () => deepseek.status());
  handle("relay-deepseek-save", (key) => deepseek.save(key));
  handle("relay-deepseek-remove", () => deepseek.remove());
  handle("relay-deepseek-test", () => deepseek.test());
}

function secureRuntimeWindow() {
  const window = new BrowserWindow({
    title: APP_NAME,
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: "#f5f5f7",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
    },
  });

  const contents = window.webContents;
  contents.on("will-navigate", (event, target) => {
    if (!isRuntimeUrl(target, runtimeBaseUrl)) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isRuntimeUrl(url, runtimeBaseUrl)) {
      void window.loadURL(url);
    } else if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("did-fail-load", (_event, code, description, url) => {
    log(`workspace-load-failed code=${code} description=${JSON.stringify(description)} url=${url}`);
  });
  contents.on("did-navigate", () => installApplicationMenu());
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  return window;
}

async function loadWorkspace(window) {
  const url = `${runtimeBaseUrl}/workspace?launch=1`;
  await window.loadURL(url);
  log(`workspace-loaded url=${window.webContents.getURL()}`);
}

async function createWindow() {
  const window = secureRuntimeWindow();
  mainWindow = window;
  try {
    await loadWorkspace(window);
  } catch (error) {
    log(`workspace-load-error message=${JSON.stringify(error?.message ?? String(error))}`);
    throw error;
  }
  return window;
}

async function stopRuntime(reason) {
  if (!runtime) return;
  log(`runtime-stop-requested reason=${reason}`);
  try {
    const result = await runtime.stop();
    log(`runtime-stopped code=${result?.code ?? ""} signal=${result?.signal ?? ""}`);
  } catch (error) {
    log(`runtime-stop-error message=${JSON.stringify(error?.message ?? String(error))}`);
  } finally {
    runtime = null;
    runtimeBaseUrl = null;
  }
}

async function startRuntime() {
  // Only the protected local store supplies child-process credentials.
  let jevKey = null;
  let modelKey = null;
  try { jevKey = await secretStore.getSecret("relay-sense.jev"); } catch { /* fail closed */ }
  try { modelKey = await secretStore.getSecret(DEEPSEEK_SECRET_NAME); } catch { /* fail closed */ }
  const env = desktopRuntimeEnvironment({ env: process.env, discovery: backendDiscovery });
  const selectedBackend = env.FLOWCREDIT_WORKER_BACKEND === "off" && !process.env.FLOWCREDIT_WORKER_BACKEND && modelKey
    ? "deepseek-hiring" : env.FLOWCREDIT_WORKER_BACKEND;
  const selectedCoordination = selectedBackend === "deepseek-hiring" && modelKey && !process.env.FLOWCREDIT_COORDINATION
    ? "driver" : env.FLOWCREDIT_COORDINATION;
  runtime = new RuntimeLifecycle({
    entry: runtimeLocationValue.entry,
    cwd: runtimeLocationValue.root,
    dataDir: runtimeDataDir(),
    env: {
      ...env,
      FLOWCREDIT_RELAY_SENSE: env.FLOWCREDIT_RELAY_SENSE ?? (jevKey ? "jev" : "off"),
      TYPESAFE_API_KEY: jevKey ?? "",
      FLOWCREDIT_WORKER_BACKEND: selectedBackend === "deepseek-hiring" && !modelKey ? "off" : selectedBackend,
      FLOWCREDIT_COORDINATION: selectedCoordination,
      FLOWCREDIT_DEEPSEEK_API_KEY: modelKey ?? "",
    },
    onStdout: () => {}, onStderr: () => {},
    onUnexpectedExit: ({ code, signal }) => {
      log(`runtime-exited-unexpectedly code=${code ?? ""} signal=${signal ?? ""}`);
      void dialog.showMessageBox({
        type: "error", title: APP_NAME, message: "FlowCredit Runtime 已停止",
        detail: "Relay Code 将关闭，以避免在没有 Runtime 的情况下继续运行。",
      }).finally(() => app.quit());
    },
  });
  const started = await runtime.start();
  runtimeBaseUrl = started.baseUrl;
  log(`runtime-ready base=${started.baseUrl} pid=${started.pid} health=${started.health.status} dataDir=${runtimeDataDir()}`);
}

async function restartRuntime() {
  const operation = runtimeMutation.then(async () => {
    if (shutdownPromise || shutdownComplete) throw new Error("Desktop is closing");
    if (runtime) {
      await runtime.stop();
      runtime = null;
      runtimeBaseUrl = null;
    }
    if (shutdownPromise || shutdownComplete) throw new Error("Desktop is closing");
    await startRuntime();
    if (mainWindow && !mainWindow.isDestroyed()) await loadWorkspace(mainWindow);
  });
  runtimeMutation = operation.catch(() => {});
  return operation;
}

function showFatalError(error) {
  const message = error?.message ?? String(error);
  log(`fatal-error message=${JSON.stringify(message)}`);
  dialog.showErrorBox(
    "Relay Code 无法启动",
    "FlowCredit Runtime 未能启动。请检查本机日志后重试。",
  );
}

async function bootstrap() {
  await app.whenReady();
  app.setAppUserModelId(BUNDLE_ID);
  app.setName(APP_NAME);
  installApplicationMenu();

  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);

  runtimeLocationValue = runtimeLocation();
  if (!existsSync(runtimeLocationValue.entry)) {
    throw new Error(`FlowCredit Runtime entry is missing: ${runtimeLocationValue.entry}`);
  }

  // Discovery runs once per application session, before the Runtime starts,
  // and answers one infrastructure question: is this backend executable
  // locally available? It chooses nothing and grants nothing — the Runtime
  // still owns Task, Assignment, WorkerRun and Permission.
  log(`desktop-environment ${describeEnvironmentFacts(boundedEnvironmentFacts({ env: process.env }))}`);
  backendDiscovery = await discoverCodexBackend({ env: process.env });
  log(`worker-backend-discovery ${describeDiscovery(backendDiscovery)}`);
  secretStore = new LocalSecretStore({ userDataPath: app.getPath("userData"), safeStorage });
  installSettingsIpc(createJevSettingsController({ store: secretStore, restartRuntime }),
    createDeepSeekSettingsController({ store: secretStore, restartRuntime }));
  await startRuntime();
  await createWindow();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  log("duplicate-instance-detected");
  app.quit();
} else {
  app.on("second-instance", () => {
    log("second-instance-focused");
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on("window-all-closed", () => app.quit());
  app.on("activate", () => {
    if (!mainWindow && runtime?.running && runtimeBaseUrl) void createWindow();
  });
  app.on("before-quit", (event) => {
    if (shutdownComplete) return;
    event.preventDefault();
    if (shutdownPromise) return;
    shutdownPromise = runtimeMutation.then(() => stopRuntime("app-quit")).finally(() => {
      shutdownComplete = true;
      app.quit();
    });
  });

  process.on("SIGTERM", () => app.quit());
  process.on("SIGINT", () => app.quit());

  bootstrap().catch((error) => {
    showFatalError(error);
    void stopRuntime("startup-failure").finally(() => app.exit(1));
  });
}

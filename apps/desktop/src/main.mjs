import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { app, BrowserWindow, dialog, Menu, session, shell } = require("electron");
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isRuntimeUrl, isSafeExternalUrl } from "./navigation-policy.mjs";
import { desktopRuntimeDataDir } from "./desktop-paths.mjs";
import { applicationMenuTemplate } from "./application-menu.mjs";
import { RuntimeLifecycle } from "./runtime-lifecycle.mjs";

const APP_NAME = "Relay Code";
const BUNDLE_ID = "com.flowcredit.relaycode";
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

let mainWindow = null;
let runtime = null;
let runtimeBaseUrl = null;
let shutdownPromise = null;
let shutdownComplete = false;

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
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      applicationMenuTemplate({ appName: APP_NAME, isPackaged: app.isPackaged }),
    ),
  );
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
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  return window;
}

async function loadWorkspace(window) {
  const url = `${runtimeBaseUrl}/workspace`;
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

  const location = runtimeLocation();
  if (!existsSync(location.entry)) {
    throw new Error(`FlowCredit Runtime entry is missing: ${location.entry}`);
  }

  runtime = new RuntimeLifecycle({
    entry: location.entry,
    cwd: location.root,
    dataDir: runtimeDataDir(),
    env: {
      FLOWCREDIT_COORDINATION: process.env.FLOWCREDIT_COORDINATION ?? "off",
      FLOWCREDIT_WORKER_BACKEND: process.env.FLOWCREDIT_WORKER_BACKEND ?? "off",
    },
    onUnexpectedExit: ({ code, signal }) => {
      log(`runtime-exited-unexpectedly code=${code ?? ""} signal=${signal ?? ""}`);
      void dialog
        .showMessageBox({
          type: "error",
          title: APP_NAME,
          message: "FlowCredit Runtime 已停止",
          detail: "Relay Code 将关闭，以避免在没有 Runtime 的情况下继续运行。",
        })
        .finally(() => app.quit());
    },
  });

  const started = await runtime.start();
  runtimeBaseUrl = started.baseUrl;
  log(
    `runtime-ready base=${started.baseUrl} pid=${started.pid} health=${started.health.status} dataDir=${runtimeDataDir()}`,
  );

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
    shutdownPromise = stopRuntime("app-quit").finally(() => {
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

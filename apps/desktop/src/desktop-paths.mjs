import { join } from "node:path";

const PACKAGED_STATE_DIRECTORY = "runtime";
const DEVELOPMENT_STATE_DIRECTORY = "runtime-dev";

// Packaged launches must never consume a developer checkout database, and dev
// launches must never write into the product's durable user data.
export function runtimeStateDirectoryName(isPackaged) {
  return isPackaged ? PACKAGED_STATE_DIRECTORY : DEVELOPMENT_STATE_DIRECTORY;
}

export function desktopRuntimeDataDir({ userDataPath, isPackaged }) {
  if (!userDataPath)
    throw new Error("desktopRuntimeDataDir requires the Electron userData path");
  return join(userDataPath, runtimeStateDirectoryName(isPackaged));
}

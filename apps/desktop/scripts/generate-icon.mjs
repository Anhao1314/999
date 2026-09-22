import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const APP_DIR = fileURLToPath(new URL("../", import.meta.url));
const EXPECTED_MASTER_SHA256 =
  "0a1956a24e0f5d742ef22bfba5d39cf77b1ccbc5b231601914082b05b2d88bf3";

const ICON_SIZES = [
  [16, "icon_16x16.png"],
  [32, "icon_16x16@2x.png"],
  [32, "icon_32x32.png"],
  [64, "icon_32x32@2x.png"],
  [128, "icon_128x128.png"],
  [256, "icon_128x128@2x.png"],
  [256, "icon_256x256.png"],
  [512, "icon_256x256@2x.png"],
  [512, "icon_512x512.png"],
  [1024, "icon_512x512@2x.png"],
];

async function sha256(path) {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function generateIcon({ masterPath, outputPath } = {}) {
  if (process.platform !== "darwin")
    throw new Error("RelayCode.icns generation requires macOS iconutil");

  const master = masterPath ?? resolve(APP_DIR, "assets/relay-code-master.png");
  const output = outputPath ?? resolve(APP_DIR, "build/RelayCode.icns");
  const iconset = resolve(APP_DIR, "build/RelayCode.iconset");
  const digest = await sha256(master);
  if (digest !== EXPECTED_MASTER_SHA256) {
    throw new Error(`relay-code-master.png digest mismatch: ${digest}`);
  }

  await rm(iconset, { recursive: true, force: true });
  await mkdir(iconset, { recursive: true });
  for (const [size, name] of ICON_SIZES) {
    await execFileAsync("sips", [
      "-z",
      String(size),
      String(size),
      master,
      "--out",
      resolve(iconset, name),
    ]);
  }
  await execFileAsync("iconutil", ["-c", "icns", iconset, "-o", output]);
  const info = await stat(output);
  if (info.size <= 0) throw new Error("RelayCode.icns is empty");
  return { master, output, sha256: digest, size: info.size };
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const result = await generateIcon();
  process.stdout.write(
    `generated ${result.output} from ${result.master} sha256=${result.sha256} bytes=${result.size}\n`,
  );
}

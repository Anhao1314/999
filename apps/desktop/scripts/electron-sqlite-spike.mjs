import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
if (!process.versions.electron) {
  process.stderr.write("electron-sqlite-spike must run under Electron\n");
  process.exit(1);
}
const { app } = require("electron");
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

async function run() {
  await app.whenReady();
  const directory = await mkdtemp(join(tmpdir(), "relay-code-electron-sqlite-"));
  const databasePath = join(directory, "probe.sqlite");
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("CREATE TABLE probe(value TEXT NOT NULL)");
    database.prepare("INSERT INTO probe(value) VALUES (?)").run("relay-code");
    const row = database.prepare("SELECT value FROM probe").get();
    const sqlite = database.prepare("SELECT sqlite_version() AS version").get();
    process.stdout.write(
      `${JSON.stringify(
        {
          electron: process.versions.electron,
          node: process.versions.node,
          processType: process.type,
          sqlite: sqlite.version,
          value: row.value,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}

run()
  .then(() => app.exit(0))
  .catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    app.exit(1);
  });

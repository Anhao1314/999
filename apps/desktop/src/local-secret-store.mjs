import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const NAME = /^[a-z][a-z0-9.-]{1,79}$/;

export class LocalSecretStore {
  constructor({ userDataPath, safeStorage, platform = process.platform }) {
    if (!userDataPath || !safeStorage) throw new Error("Secure local storage is not configured");
    this.directory = join(userDataPath, "local-secrets-v0");
    this.safeStorage = safeStorage;
    this.platform = platform;
  }

  path(name) {
    if (!NAME.test(name)) throw new Error("Invalid secret name");
    return join(this.directory, `${createHash("sha256").update(name).digest("hex")}.bin`);
  }

  available() {
    try {
      if (this.safeStorage.isEncryptionAvailable() !== true) return false;
      if (this.platform === "linux") {
        const backend = this.safeStorage.getSelectedStorageBackend?.();
        return Boolean(backend && !["basic_text", "unknown"].includes(backend));
      }
      return true;
    } catch { return false; }
  }

  requireAvailable() {
    if (!this.available()) throw new Error("SECURE_STORAGE_UNAVAILABLE");
  }

  async hasSecret(name) {
    const path = this.path(name);
    this.requireAvailable();
    try { return (await stat(path)).isFile(); }
    catch (error) { if (error?.code === "ENOENT") return false; throw new Error("SECRET_STORE_UNAVAILABLE"); }
  }

  // Trusted Desktop code only. Never bridge this method to a renderer.
  async getSecret(name) {
    const path = this.path(name);
    this.requireAvailable();
    let encrypted;
    try { encrypted = await readFile(path); }
    catch (error) { if (error?.code === "ENOENT") return null; throw new Error("SECRET_STORE_UNAVAILABLE"); }
    if (encrypted.length < 1 || encrypted.length > 16_384) throw new Error("SECRET_STORE_UNAVAILABLE");
    try {
      const value = this.safeStorage.decryptString(encrypted);
      if (typeof value !== "string" || value.length < 1 || value.length > 4096)
        throw new Error("invalid decrypted value");
      return value;
    }
    catch { throw new Error("SECRET_STORE_UNAVAILABLE"); }
  }

  async setSecret(name, value) {
    const path = this.path(name);
    this.requireAvailable();
    if (typeof value !== "string" || value.length < 1 || value.length > 4096)
      throw new Error("INVALID_SECRET_VALUE");
    let encrypted;
    try { encrypted = this.safeStorage.encryptString(value); }
    catch { throw new Error("SECRET_STORE_UNAVAILABLE"); }
    if (!Buffer.isBuffer(encrypted) || encrypted.length < 1 || encrypted.length > 16_384 ||
      encrypted.includes(Buffer.from(value))) throw new Error("SECRET_STORE_UNAVAILABLE");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, encrypted, { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }

  async deleteSecret(name) {
    const path = this.path(name);
    this.requireAvailable();
    await rm(path, { force: true });
  }
}

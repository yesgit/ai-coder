import { safeStorage } from "electron";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * 凭证安全存储。使用 Electron safeStorage 加密后落盘，
 * 运行时解密注入内存，不明文写入 settings.json。
 *
 * Linux 依赖 libsecret / GNOME Keyring；不可用时降级拒绝。
 */
export class CredentialsStore {
  private readonly filePath: string;

  constructor(storeDir = path.join(os.homedir(), ".ai-coder")) {
    this.filePath = path.join(storeDir, "credentials.dat");
  }

  async set(platform: string, token: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("系统不支持安全存储（safeStorage 不可用）。请确保桌面环境已安装 libsecret / GNOME Keyring。");
    }
    const encrypted = safeStorage.encryptString(token);
    const all = await this.readAll();
    all[platform] = encrypted.toString("base64");
    await this.writeAll(all);
  }

  async get(platform: string): Promise<string | null> {
    const all = await this.readAll();
    const encoded = all[platform];
    if (!encoded) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    try {
      const encrypted = Buffer.from(encoded, "base64");
      return safeStorage.decryptString(encrypted);
    } catch {
      return null;
    }
  }

  async has(platform: string): Promise<boolean> {
    const all = await this.readAll();
    return platform in all;
  }

  async remove(platform: string): Promise<void> {
    const all = await this.readAll();
    delete all[platform];
    await this.writeAll(all);
  }

  private async readAll(): Promise<Record<string, string>> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  private async writeAll(data: Record<string, string>): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(data), {
      encoding: "utf8",
      mode: 0o600
    });
  }
}

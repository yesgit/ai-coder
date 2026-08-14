import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "../../shared/types.js";

/**
 * 应用级设置持久化存储。文件位于 ~/.ai-coder/settings.json。
 * 读取时自动合并 DEFAULT_APP_SETTINGS，保证新字段有默认值、旧字段不会丢失。
 */
export class SettingsStore {
  private readonly filePath: string;

  constructor(storeDir = path.join(os.homedir(), ".ai-coder")) {
    this.filePath = path.join(storeDir, "settings.json");
  }

  async get(): Promise<AppSettings> {
    const raw = await this.readRaw();
    if (raw === null) return { ...DEFAULT_APP_SETTINGS };
    return { ...DEFAULT_APP_SETTINGS, ...raw };
  }

  async update(partial: Partial<AppSettings>): Promise<AppSettings> {
    const current = await this.get();
    const merged: AppSettings = { ...current, ...partial };
    await this.write(merged);
    return merged;
  }

  /**
   * 返回当前生效的 commit 印记文本；如果功能关闭或印记为空，返回空字符串。
   * 供 Agent Runner 在构建系统提示词时同步读取。
   */
  async getCommitMark(): Promise<string> {
    const settings = await this.get();
    if (!settings.commit_mark_enabled) return "";
    return settings.commit_mark.trim();
  }

  private async readRaw(): Promise<Partial<AppSettings> | null> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      return this.sanitize(parsed);
    } catch (error) {
      if (isMissingPathError(error)) {
        return null;
      }
      throw error;
    }
  }

  private async write(settings: AppSettings): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(settings, null, 2), {
      encoding: "utf8",
      mode: 0o600
    });
  }

  /**
   * 清洗用户输入：只保留 AppSettings 已知字段，并做类型归一化。
   * 防止 IPC 传入未知字段或错误类型污染存储。
   */
  private sanitize(input: Partial<AppSettings>): Partial<AppSettings> {
    const result: Partial<AppSettings> = {};
    if (typeof input.commit_mark === "string") {
      result.commit_mark = input.commit_mark;
    }
    if (typeof input.commit_mark_enabled === "boolean") {
      result.commit_mark_enabled = input.commit_mark_enabled;
    }
    return result;
  }
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

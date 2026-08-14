import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ClaimedTaskRecord, ClaimedTaskStatus, TaskPlatformKind } from "../../shared/types.js";

/**
 * 已认领任务持久化存储。模仿 SessionStore 的原子写入模式
 * （temp file + fs.rename），存于 ~/.ai-coder/claimed-tasks.json。
 */
export class ClaimedTaskStore {
  private readonly filePath: string;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(storeDir = path.join(os.homedir(), ".ai-coder")) {
    this.filePath = path.join(storeDir, "claimed-tasks.json");
  }

  async list(): Promise<ClaimedTaskRecord[]> {
    const raw = await this.readRaw();
    return raw ?? [];
  }

  async findBySessionId(sessionId: string): Promise<ClaimedTaskRecord | null> {
    const all = await this.list();
    return all.find((r) => r.session_id === sessionId) ?? null;
  }

  async findByTaskId(taskId: string): Promise<ClaimedTaskRecord | null> {
    const all = await this.list();
    return all.find((r) => r.task_id === taskId) ?? null;
  }

  async countByStatus(status: ClaimedTaskStatus): Promise<number> {
    const all = await this.list();
    return all.filter((r) => r.status === status).length;
  }

  async record(record: ClaimedTaskRecord): Promise<void> {
    await this.enqueueWrite(async () => {
      const all = await this.readRaw() ?? [];
      all.push(record);
      await this.writeRaw(all);
    });
  }

  async linkSession(taskId: string, sessionId: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const all = await this.readRaw() ?? [];
      const record = all.find((r) => r.task_id === taskId);
      if (record) {
        record.session_id = sessionId;
        record.status = "executing";
        record.updated_at = new Date().toISOString();
        await this.writeRaw(all);
      }
    });
  }

  async markPRSubmitted(taskId: string, prUrl: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const all = await this.readRaw() ?? [];
      const record = all.find((r) => r.task_id === taskId);
      if (record) {
        record.status = "pr_submitted";
        record.pr_url = prUrl;
        record.updated_at = new Date().toISOString();
        await this.writeRaw(all);
      }
    });
  }

  async markReleased(taskId: string, error?: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const all = await this.readRaw() ?? [];
      const record = all.find((r) => r.task_id === taskId);
      if (record) {
        record.status = "released";
        record.last_error = error ?? null;
        record.updated_at = new Date().toISOString();
        await this.writeRaw(all);
      }
    });
  }

  async markFailed(taskId: string, error: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const all = await this.readRaw() ?? [];
      const record = all.find((r) => r.task_id === taskId);
      if (record) {
        record.status = "failed";
        record.failure_count += 1;
        record.last_error = error;
        record.updated_at = new Date().toISOString();
        await this.writeRaw(all);
      }
    });
  }

  /** 查询多个状态的记录。 */
  async listByStatuses(statuses: ClaimedTaskStatus[]): Promise<ClaimedTaskRecord[]> {
    const all = await this.list();
    const statusSet = new Set(statuses);
    return all.filter((r) => statusSet.has(r.status));
  }

  /** 标记为 reviewing 状态。 */
  async markReviewing(taskId: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const all = await this.readRaw() ?? [];
      const record = all.find((r) => r.task_id === taskId);
      if (record) {
        record.status = "reviewing";
        record.updated_at = new Date().toISOString();
        await this.writeRaw(all);
      }
    });
  }

  /** 更新 review 元数据（最后处理时间、轮次）。 */
  async updateReviewMeta(taskId: string, reviewedAt: string, round: number): Promise<void> {
    await this.enqueueWrite(async () => {
      const all = await this.readRaw() ?? [];
      const record = all.find((r) => r.task_id === taskId);
      if (record) {
        record.last_reviewed_at = reviewedAt;
        record.review_round = round;
        record.updated_at = new Date().toISOString();
        await this.writeRaw(all);
      }
    });
  }

  /** 更新 MR 相关信息（从 GitLab 创建 MR 后回写）。 */
  async updateMRInfo(taskId: string, mrIid: number, gitlabProjectId: string): Promise<void> {
    await this.enqueueWrite(async () => {
      const all = await this.readRaw() ?? [];
      const record = all.find((r) => r.task_id === taskId);
      if (record) {
        record.mr_iid = mrIid;
        record.gitlab_project_id = gitlabProjectId;
        record.updated_at = new Date().toISOString();
        await this.writeRaw(all);
      }
    });
  }

  private async readRaw(): Promise<ClaimedTaskRecord[] | null> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async writeRaw(records: ClaimedTaskRecord[]): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tempPath = path.join(dir, `.claimed-tasks.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(tempPath, JSON.stringify(records, null, 2), {
        encoding: "utf8",
        mode: 0o600
      });
      await fs.rename(tempPath, this.filePath);
    } finally {
      await fs.unlink(tempPath).catch(() => undefined);
    }
  }

  private async enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeChain;
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, (error) => {
      console.error("[claimedTaskStore] write failed:", error);
    }).catch(() => undefined);
    this.writeChain = tail;
    return result;
  }
}

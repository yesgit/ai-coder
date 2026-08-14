import type {
  ClaimedTaskRecord,
  TaskClaimResult,
  UnifiedTask
} from "../../shared/types.js";
import type { AuthorizedProjects } from "../security/authorizedProjects.js";
import type { SettingsStore } from "../settings/settingsStore.js";
import { BranchManager } from "./branchManager.js";
import { ClaimedTaskStore } from "./claimedTaskStore.js";
import type { TaskPlatformRegistry } from "./taskPlatformRegistry.js";

/**
 * 任务认领编排器。协调平台 API 认领 → git 分支创建 → 持久化记录。
 */
export class TaskClaimManager {
  constructor(
    private readonly registry: TaskPlatformRegistry,
    private readonly branchManager: BranchManager,
    private readonly claimedTaskStore: ClaimedTaskStore,
    private readonly authorizedProjects: AuthorizedProjects,
    private readonly settingsStore: SettingsStore
  ) {}

  /**
   * 认领任务并准备工作分支。
   * @returns TaskClaimResult（成功时包含分支名和时间戳）
   */
  async claimAndPrepare(task: UnifiedTask): Promise<TaskClaimResult> {
    // 1. 检查并发上限
    const settings = await this.settingsStore.get();
    const running = await this.claimedTaskStore.countByStatus("executing");
    const limit = settings.task_automation.concurrent_task_limit;
    if (running >= limit) {
      return {
        success: false,
        task,
        branch: "",
        claimed_at: "",
        error: `并发上限已达（${running}/${limit}）`
      };
    }

    // 2. 检查是否已认领
    const existing = await this.claimedTaskStore.findByTaskId(task.task_id);
    if (existing && existing.status !== "released" && existing.status !== "failed") {
      return {
        success: false,
        task,
        branch: existing.branch,
        claimed_at: existing.claimed_at,
        error: "任务已被认领"
      };
    }

    const mapping = task.project_mapping;

    try {
      // 3. 确保项目已授权
      await this.authorizedProjects.authorize(mapping.local_repo_path);

      // 4. 平台认领
      const adapter = this.registry.get(task.platform);
      if (!adapter) {
        return { success: false, task, branch: "", claimed_at: "", error: "平台适配器不可用" };
      }

      const claimResult = await adapter.claim(task.task_id);
      if (!claimResult.success) {
        return { success: false, task, branch: "", claimed_at: "", error: claimResult.error };
      }

      // 5. 创建特性分支
      const branch = await this.branchManager.createFeatureBranch(
        mapping.local_repo_path,
        mapping.default_base_branch,
        mapping.branch_prefix,
        task.task_id
      );

      // 6. 持久化认领记录
      const now = new Date().toISOString();
      const record: ClaimedTaskRecord = {
        task_id: task.task_id,
        platform: task.platform,
        branch,
        base_branch: mapping.default_base_branch,
        repo_path: mapping.local_repo_path,
        session_id: null,
        status: "claimed",
        claimed_at: now,
        updated_at: now,
        pr_url: null,
        failure_count: 0,
        last_error: null,
        mr_iid: null,
        gitlab_project_id: null,
        last_reviewed_at: null,
        review_round: 0
      };
      await this.claimedTaskStore.record(record);

      return { success: true, task, branch, claimed_at: now };
    } catch (error) {
      // 认领失败回滚
      const adapter = this.registry.get(task.platform);
      if (adapter) {
        await adapter.release(task.task_id, "Branch creation failed").catch(() => undefined);
      }
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { success: false, task, branch: "", claimed_at: "", error: errorMsg };
    }
  }

  /** 释放任务（失败回滚）。 */
  async release(taskId: string, reason: string): Promise<void> {
    const record = await this.claimedTaskStore.findByTaskId(taskId);
    if (!record) return;

    // 平台释放
    const adapter = this.registry.get(record.platform);
    if (adapter) {
      await adapter.release(taskId, reason).catch(() => undefined);
    }

    // 删除本地分支
    if (record.branch) {
      await this.branchManager.deleteBranch(record.repo_path, record.branch).catch(() => undefined);
    }

    // 更新记录
    await this.claimedTaskStore.markReleased(taskId, reason);
  }
}

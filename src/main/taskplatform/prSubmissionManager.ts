import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentSession, WorkflowTemplate } from "../../shared/types.js";
import type { SettingsStore } from "../settings/settingsStore.js";
import { BranchManager } from "./branchManager.js";
import { ClaimedTaskStore } from "./claimedTaskStore.js";
import { detectGitHost, type GitHostAdapter } from "./gitHostAdapter.js";
import type { TaskPlatformRegistry } from "./taskPlatformRegistry.js";

const execFileAsync = promisify(execFile);

/**
 * PR 提交管理器。会话完成后触发：运行测试 → commit + push → 创建 PR → 回写平台状态。
 */
export class PRSubmissionManager {
  constructor(
    private readonly branchManager: BranchManager,
    private readonly platformRegistry: TaskPlatformRegistry,
    private readonly claimedTaskStore: ClaimedTaskStore,
    private readonly settingsStore: SettingsStore,
    private readonly getGitHostToken: () => Promise<string | null>
  ) {}

  /** 为完成的会话提交 PR。 */
  async submitForSession(session: AgentSession): Promise<void> {
    const record = await this.claimedTaskStore.findBySessionId(session.id);
    if (!record) return; // 非自动任务会话

    try {
      const settings = await this.settingsStore.get();

      // 1. 可选运行测试
      if (settings.task_automation.auto_run_tests) {
        await this.runTests(record.repo_path);
      }

      // 2. 构建 commit message
      const commitMark = await this.settingsStore.get().then((s) =>
        s.commit_mark_enabled ? s.commit_mark.trim() : ""
      );
      const commitMessage = this.buildCommitMessage(record.task_id, session.title ?? "", commitMark);

      // 3. commit + push
      const remoteRef = await this.branchManager.commitAndPush(record.repo_path, commitMessage);
      if (!remoteRef) {
        // 无变更，直接标记完成
        await this.claimedTaskStore.markReleased(record.task_id, "No changes to commit");
        return;
      }

      // 4. 创建 PR
      const gitHostToken = await this.getGitHostToken();
      if (!gitHostToken) {
        throw new Error("Git host token not configured");
      }

      const remoteUrl = await this.branchManager.getRemoteUrl(record.repo_path);
      const gitHost = detectGitHost(remoteUrl, gitHostToken);
      if (!gitHost) {
        throw new Error(`Unsupported git host: ${remoteUrl}`);
      }

      const prResult = await gitHost.createPullRequest({
        repo_path: record.repo_path,
        head: record.branch,
        base: record.base_branch,
        title: `[${record.task_id}] ${session.title ?? "AI 完成的任务"}`,
        body: this.buildPRBody(record, session),
        labels: ["ai-generated"]
      });

      // 5. 回写平台状态
      const adapter = this.platformRegistry.get(record.platform);
      if (adapter) {
        await adapter.transitionToReview(record.task_id, prResult.url);
      }

      // 6. 回写 MR 元数据（GitLab 特有字段，用于后续 review 轮询）
      if (prResult.mr_iid !== undefined && prResult.project_id !== undefined) {
        await this.claimedTaskStore.updateMRInfo(
          record.task_id,
          prResult.mr_iid,
          prResult.project_id
        );
      }

      // 7. 更新认领记录
      await this.claimedTaskStore.markPRSubmitted(record.task_id, prResult.url);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.claimedTaskStore.markFailed(record.task_id, `PR submission failed: ${errorMsg}`);
      throw error;
    }
  }

  private buildCommitMessage(taskId: string, title: string, commitMark: string): string {
    const lines = [`feat: ${title || `implement ${taskId}`}`, "", `Refs: ${taskId}`];
    if (commitMark) lines.push(commitMark);
    return lines.join("\n");
  }

  private buildPRBody(
    record: { task_id: string; platform: string; branch: string; base_branch: string },
    session: AgentSession
  ): string {
    return [
      `## 自动完成的任务`,
      ``,
      `- **任务 ID**: ${record.task_id}`,
      `- **平台**: ${record.platform}`,
      `- **分支**: ${record.branch} → ${record.base_branch}`,
      ``,
      `## 实现摘要`,
      ``,
      session.title ?? "由 AI Coder 自动完成",
      ``,
      `---`,
      `*此 PR 由 AI Coder 自动生成*`
    ].join("\n");
  }

  private async runTests(repoPath: string): Promise<void> {
    try {
      await execFileAsync("npm", ["test"], {
        cwd: repoPath,
        timeout: 120_000,
        encoding: "utf8"
      });
    } catch (error) {
      console.warn("[PRSubmission] Tests failed, proceeding with PR anyway:", error);
    }
  }
}

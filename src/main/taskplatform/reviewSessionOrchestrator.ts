import type {
  AgentMessage,
  AgentSession,
  ClaimedTaskRecord,
  MRDiffNote,
  ReviewAction,
  WorkflowTemplate
} from "../../shared/types.js";
import type { ClaudeAgentRunner } from "../agent/claudeAgentRunner.js";
import type { AuthorizedProjects } from "../security/authorizedProjects.js";
import type { SessionStore } from "../sessions/sessionStore.js";
import { runSessionInBackground } from "../sessions/sessionRunner.js";
import type { WorkflowRegistry } from "../workflows/workflowRegistry.js";
import type { BranchManager } from "./branchManager.js";
import type { ClaimedTaskStore } from "./claimedTaskStore.js";
import type { GitHostAdapter } from "./gitHostAdapter.js";
import { buildReviewPrompt } from "./reviewPromptBuilder.js";

/**
 * Review 会话编排器。在已有 MR 上针对 review 评论启动新的 AI 会话，
 * 修改代码后提交推送。
 */
export class ReviewSessionOrchestrator {
  private readonly queuedUserMessages = new Map<string, AgentMessage[]>();

  constructor(
    private readonly sessions: SessionStore,
    private readonly workflowRegistry: WorkflowRegistry,
    private readonly runner: ClaudeAgentRunner,
    private readonly branchManager: BranchManager,
    private readonly claimedTaskStore: ClaimedTaskStore,
    private readonly authorizedProjects: AuthorizedProjects,
    private readonly getGitHostAdapter: (repoPath: string) => Promise<GitHostAdapter | null>
  ) {}

  /**
   * 针对 review 评论启动 AI 会话。
   * @returns session ID
   */
  async orchestrateReview(
    record: ClaimedTaskRecord,
    actions: ReviewAction[],
    diffs: MRDiffNote[]
  ): Promise<string> {
    // 1. 授权项目路径
    const projectPath = await this.authorizedProjects.authorize(record.repo_path);

    // 2. 切换到 MR 分支并拉取最新
    await this.branchManager.checkoutAndPull(record.repo_path, record.branch);

    // 3. 加载工作流（复用原始任务的工作流，默认 careful-coder）
    const workflow = await this.workflowRegistry.get("careful-coder", projectPath);
    if (!workflow) {
      throw new Error("Workflow 'careful-coder' not found for review session");
    }

    // 自主模式：覆盖 shell 审批
    const autonomousWorkflow: WorkflowTemplate = {
      ...workflow,
      permissions: {
        ...workflow.permissions,
        shell: { ...workflow.permissions.shell, approval_required: false }
      }
    };

    // 4. 构建 review prompt
    const reviewPrompt = buildReviewPrompt(record, actions, diffs);

    // 5. 创建会话
    const session = await this.sessions.create(
      projectPath,
      autonomousWorkflow,
      reviewPrompt,
      undefined, // onboarding
      undefined, // attachments
      undefined  // routing
    );

    session.auto_approve = true;
    session.status = "running";
    await this.sessions.save(session);

    // 6. 启动后台执行
    this.startReviewSessionRun(session, autonomousWorkflow, record, actions);

    return session.id;
  }

  private startReviewSessionRun(
    session: AgentSession,
    workflow: WorkflowTemplate,
    record: ClaimedTaskRecord,
    actions: ReviewAction[]
  ): void {
    runSessionInBackground({
      runner: this.runner,
      sessions: this.sessions,
      session,
      workflow,
      queuedUserMessages: this.queuedUserMessages,
      onComplete: async (completed) => {
        try {
          // 会话完成后提交并推送
          const commitMark = await this.getCommitMark();
          const commentSummary = actions
            .map((a) => a.comment.body.slice(0, 50))
            .join("; ");
          const commitMessage = [
            `fix: address MR review comments`,
            ``,
            `Review feedback: ${commentSummary}`,
          ];
          if (commitMark) commitMessage.push(commitMark);

          const remoteRef = await this.branchManager.commitAndPush(
            record.repo_path,
            commitMessage.join("\n")
          );

          if (!remoteRef) {
            console.log("[ReviewSessionOrchestrator] No changes to commit after review session");
          }

          // 更新 review 元数据
          const now = new Date().toISOString();
          await this.claimedTaskStore.updateReviewMeta(
            record.task_id,
            now,
            record.review_round + 1
          );

          // 恢复为 pr_submitted 状态（等待下一轮 review）
          await this.claimedTaskStore.markPRSubmitted(
            record.task_id,
            record.pr_url ?? ""
          );
        } catch (error) {
          console.error("[ReviewSessionOrchestrator] Post-review commit failed:", error);
          await this.claimedTaskStore.markFailed(
            record.task_id,
            `Review commit failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      },
      onFailure: async (failed, error) => {
        console.error("[ReviewSessionOrchestrator] Review session failed:", error);
        await this.claimedTaskStore.markFailed(
          record.task_id,
          `Review session failed: ${error.message}`
        );
      }
    });
  }

  private async getCommitMark(): Promise<string> {
    // 简单的 commit mark 读取，避免循环依赖 SettingsStore
    return "";
  }
}

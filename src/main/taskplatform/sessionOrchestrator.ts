import type { AgentSession, UnifiedTask, TaskClaimResult, WorkflowTemplate } from "../../shared/types.js";
import type { AuthorizedProjects } from "../security/authorizedProjects.js";
import type { SessionStore } from "../sessions/sessionStore.js";
import { runSessionInBackground } from "../sessions/sessionRunner.js";
import type { ClaudeAgentRunner } from "../agent/claudeAgentRunner.js";
import type { WorkflowRegistry } from "../workflows/workflowRegistry.js";
import type { ClaimedTaskStore } from "./claimedTaskStore.js";
import type { PRSubmissionManager } from "./prSubmissionManager.js";
import { buildTaskPrompt } from "./taskPromptBuilder.js";
import type { AgentMessage } from "../../shared/types.js";

/**
 * 会话编排器。将认领的平台任务转换为 AI Coder 会话，
 * 复用现有 SessionStore + WorkflowEngine + ClaudeAgentRunner 链路。
 */
export class SessionOrchestrator {
  private readonly queuedUserMessages = new Map<string, AgentMessage[]>();

  constructor(
    private readonly sessions: SessionStore,
    private readonly workflowRegistry: WorkflowRegistry,
    private readonly runner: ClaudeAgentRunner,
    private readonly authorizedProjects: AuthorizedProjects,
    private readonly claimedTaskStore: ClaimedTaskStore,
    private readonly prManager: PRSubmissionManager
  ) {}

  /**
   * 将认领的任务编排为 AI Coder 会话并启动执行。
   * @returns session ID
   */
  async orchestrate(task: UnifiedTask, claim: TaskClaimResult): Promise<string> {
    const mapping = task.project_mapping;

    // 1. 授权项目
    const projectPath = await this.authorizedProjects.authorize(mapping.local_repo_path);

    // 2. 加载工作流
    const originalWorkflow = await this.workflowRegistry.get(mapping.workflow_id, projectPath);
    if (!originalWorkflow) {
      throw new Error(`Workflow not found: ${mapping.workflow_id}`);
    }

    // 自主模式：覆盖 permissions.shell.approval_required 为 false，
    // 防止非白名单命令卡住会话。浅克隆避免污染共享工作流模板。
    const workflow: typeof originalWorkflow = {
      ...originalWorkflow,
      permissions: {
        ...originalWorkflow.permissions,
        shell: { ...originalWorkflow.permissions.shell, approval_required: false }
      }
    };

    // 3. 构建 task_prompt
    const taskPrompt = buildTaskPrompt(task, claim);

    // 4. 创建会话（复用 SessionStore.create 签名）
    const session = await this.sessions.create(
      projectPath,
      workflow,
      taskPrompt,
      undefined, // onboarding（自主模式跳过）
      undefined, // attachments
      undefined  // routing（自主模式不路由）
    );

    // 5. 自主模式配置
    session.auto_approve = true;
    session.status = "running";
    await this.sessions.save(session);

    // 6. 关联会话 ID 到认领记录
    await this.claimedTaskStore.linkSession(claim.task.task_id, session.id);

    // 7. 启动后台执行
    this.startSessionRun(session, workflow);

    return session.id;
  }

  private startSessionRun(session: AgentSession, workflow: WorkflowTemplate): void {
    runSessionInBackground({
      runner: this.runner,
      sessions: this.sessions,
      session,
      workflow,
      queuedUserMessages: this.queuedUserMessages,
      onComplete: async (completed) => {
        // 会话完成后提交 PR
        try {
          await this.prManager.submitForSession(completed);
        } catch (error) {
          console.error("[SessionOrchestrator] PR submission failed:", error);
        }
      },
      onFailure: async (failed, error) => {
        // 会话失败：更新认领记录
        const record = await this.claimedTaskStore.findBySessionId(failed.id);
        if (record) {
          await this.claimedTaskStore.markFailed(record.task_id, error.message);
        }
      }
    });
  }
}

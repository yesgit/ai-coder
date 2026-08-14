import type {
  ClaimedTaskRecord,
  MRComment,
  MRDiffNote,
  ReviewAction
} from "../../shared/types.js";
import type { SettingsStore } from "../settings/settingsStore.js";
import type { ClaimedTaskStore } from "./claimedTaskStore.js";
import type { GitHostAdapter } from "./gitHostAdapter.js";
import type { ReviewSessionOrchestrator } from "./reviewSessionOrchestrator.js";

/**
 * Review 评论分类与处理编排。
 * 负责判断评论类型（代码修改 vs 文字回复），并分发到对应处理流程。
 */
export class ReviewHandler {
  constructor(
    private readonly reviewSessionOrchestrator: ReviewSessionOrchestrator,
    private readonly claimedTaskStore: ClaimedTaskStore,
    private readonly settingsStore: SettingsStore,
    private readonly getGitHostAdapter: (repoPath: string) => Promise<GitHostAdapter | null>
  ) {}

  /**
   * 处理一批 review 评论。先分类，再分别执行代码修改或文字回复。
   */
  async handleReview(
    record: ClaimedTaskRecord,
    comments: MRComment[]
  ): Promise<void> {
    if (!record.mr_iid || !record.gitlab_project_id) {
      console.warn("[ReviewHandler] Missing MR info, skipping");
      return;
    }

    // 读取配置
    const settings = await this.settingsStore.get();
    const reviewSettings = settings.task_automation.review_handling;

    // 标记为 reviewing
    await this.claimedTaskStore.markReviewing(record.task_id);

    // 分类所有评论
    const actions = comments.map((comment) => this.classify(comment));

    // 分组：代码修改 vs 文字回复
    const codeChanges = actions.filter((a) => a.type === "code_change");
    const textReplies = reviewSettings.auto_reply_text_comments
      ? actions.filter((a) => a.type === "text_reply")
      : [];

    try {
      // 处理代码修改评论
      if (codeChanges.length > 0) {
        const adapter = await this.getGitHostAdapter(record.repo_path);
        let diffs: MRDiffNote[] = [];
        if (adapter) {
          diffs = await adapter.getMRDiff({
            repo_path: record.repo_path,
            mr_iid: record.mr_iid!,
            project_id: record.gitlab_project_id!
          });
        }

        // 启动 AI 会话处理代码修改
        await this.reviewSessionOrchestrator.orchestrateReview(
          record,
          codeChanges,
          diffs
        );

        // 回复已处理
        if (adapter) {
          for (const action of codeChanges) {
            await adapter.postMRComment({
              repo_path: record.repo_path,
              mr_iid: record.mr_iid!,
              project_id: record.gitlab_project_id!,
              body: "✅ 已根据此评论进行代码修改，请重新审查。",
              in_reply_to_id: action.comment.id
            }).catch((error) => {
              console.warn("[ReviewHandler] Failed to post reply:", error);
            });
          }
        }
      }

      // 处理文字回复评论
      if (textReplies.length > 0) {
        await this.handleTextReplies(record, textReplies);
      }

      // 更新 review 元数据
      const latestCommentTime = this.getLatestCommentTime(comments);
      const newRound = record.review_round + (codeChanges.length > 0 ? 1 : 0);
      await this.claimedTaskStore.updateReviewMeta(
        record.task_id,
        latestCommentTime,
        newRound
      );

      // 如果没有代码修改，恢复为 pr_submitted 状态
      if (codeChanges.length === 0) {
        await this.claimedTaskStore.markPRSubmitted(
          record.task_id,
          record.pr_url ?? ""
        );
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await this.claimedTaskStore.markFailed(
        record.task_id,
        `Review handling failed: ${errorMsg}`
      );
      throw error;
    }
  }

  /**
   * 分类单条评论：根据内容特征判断是代码修改还是文字回复。
   */
  classify(comment: MRComment): ReviewAction {
    const body = comment.body.toLowerCase();

    // 1. 行级 diff 评论 → 几乎总是需要代码修改
    if (comment.position && comment.position.new_path) {
      // 但如果内容是纯赞同/感谢，则作为文字回复
      if (this.isApprovalComment(body)) {
        return {
          type: "text_reply",
          comment,
          context: `Line comment on ${comment.position.new_path}:${comment.position.new_line}`,
          suggested_reply: "感谢反馈！"
        };
      }
      return {
        type: "code_change",
        comment,
        context: `Diff comment on ${comment.position.new_path}:${comment.position.new_line}`
      };
    }

    // 2. 包含代码块 → 代码修改
    if (body.includes("```") || body.includes("``")) {
      return {
        type: "code_change",
        comment,
        context: "Comment contains code block"
      };
    }

    // 3. 明确的修改请求关键词 → 代码修改
    if (this.isCodeChangeRequest(body)) {
      return {
        type: "code_change",
        comment,
        context: "Comment requests code change"
      };
    }

    // 4. 默认作为文字回复
    return {
      type: "text_reply",
      comment,
      context: "General comment"
    };
  }

  /**
   * 处理文字回复类型的评论。
   * 对于提问类评论，生成简单的确认回复。
   */
  private async handleTextReplies(
    record: ClaimedTaskRecord,
    actions: ReviewAction[]
  ): Promise<void> {
    const adapter = await this.getGitHostAdapter(record.repo_path);
    if (!adapter) return;

    for (const action of actions) {
      const reply = this.buildTextReply(action);
      try {
        await adapter.postMRComment({
          repo_path: record.repo_path,
          mr_iid: record.mr_iid!,
          project_id: record.gitlab_project_id!,
          body: reply,
          in_reply_to_id: action.comment.id
        });
      } catch (error) {
        console.warn(
          `[ReviewHandler] Failed to reply to comment ${action.comment.id}:`,
          error
        );
      }
    }
  }

  /**
   * 构建文字回复内容。
   */
  private buildTextReply(action: ReviewAction): string {
    const body = action.comment.body.toLowerCase();

    // LGTM / Approved / Looks good
    if (this.isApprovalComment(body)) {
      return "感谢审查！🙏";
    }

    // Nit / Typo 类
    if (body.includes("nit:") || body.includes("nitpick") || body.includes("typo")) {
      return "已确认，感谢指正。";
    }

    // 提问类（"为什么" / "是否考虑"）
    if (this.isQuestionComment(body)) {
      return "感谢提问，会在后续迭代中考虑这个建议。";
    }

    // 默认回复
    return action.suggested_reply ?? "已收到反馈，感谢审查。";
  }

  private isApprovalComment(body: string): boolean {
    const approvalPatterns = [
      "lgtm",
      "looks good",
      "approved",
      "👍",
      ":+1:",
      "nice",
      "good job",
      "well done"
    ];
    return approvalPatterns.some((p) => body.includes(p));
  }

  private isCodeChangeRequest(body: string): boolean {
    const changePatterns = [
      "请修改",
      "能否改成",
      "建议修改",
      "需要修改",
      "改成",
      "改为",
      "should be",
      "needs to be",
      "please change",
      "could you change",
      "please update",
      "fix:",
      "fix this",
      "refactor",
      "rename",
      "remove this",
      "删除",
      "重命名"
    ];
    return changePatterns.some((p) => body.includes(p));
  }

  private isQuestionComment(body: string): boolean {
    const questionPatterns = [
      "为什么",
      "是否考虑",
      "是否应该",
      "这里是否",
      "why",
      "what if",
      "have you considered",
      "could we",
      "is it possible",
      "?"
    ];
    return questionPatterns.some((p) => body.includes(p));
  }

  private getLatestCommentTime(comments: MRComment[]): string {
    return comments.reduce(
      (latest, c) => (c.created_at > latest ? c.created_at : latest),
      ""
    );
  }
}

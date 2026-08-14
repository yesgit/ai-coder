import type {
  ClaimedTaskRecord,
  MRComment,
  ReviewHandlingSettings
} from "../../shared/types.js";
import type { SettingsStore } from "../settings/settingsStore.js";
import type { ClaimedTaskStore } from "./claimedTaskStore.js";
import type { GitHostAdapter } from "./gitHostAdapter.js";
import { GitLabAdapter } from "./gitlabAdapter.js";

/**
 * MR 评论轮询服务。定期扫描 pr_submitted / reviewing 状态的认领记录，
 * 调用 GitLab API 获取新评论。发现新评论后通过回调通知处理。
 */
export class ReviewWatcher {
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private processing = false;

  /** 外部设置的回调：发现新评论需要处理时触发。 */
  onReviewNeeded?: (record: ClaimedTaskRecord, comments: MRComment[]) => Promise<void>;

  constructor(
    private readonly claimedTaskStore: ClaimedTaskStore,
    private readonly settingsStore: SettingsStore,
    private readonly getGitHostAdapter: (repoPath: string) => Promise<GitHostAdapter | null>
  ) {}

  /** 启动定时轮询。 */
  async start(): Promise<void> {
    this.stopped = false;
    const settings = await this.settingsStore.get();
    const reviewSettings = settings.task_automation.review_handling;
    if (!reviewSettings.enabled) return;

    const intervalMs = reviewSettings.polling_interval_seconds * 1000;
    this.timer = setInterval(() => {
      if (!this.stopped) {
        this.pollOnce().catch((error) => {
          console.error("[ReviewWatcher] poll error:", error);
        });
      }
    }, intervalMs);

    // 启动后立即执行一次
    this.pollOnce().catch((error) => {
      console.error("[ReviewWatcher] initial poll error:", error);
    });
  }

  /** 停止轮询。 */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 手动触发一次轮询。 */
  async pollOnce(): Promise<void> {
    if (this.processing) return; // 防止并发
    this.processing = true;

    try {
      const settings = await this.settingsStore.get();
      const reviewSettings = settings.task_automation.review_handling;
      if (!reviewSettings.enabled) return;

      // 查询所有等待 review 的记录
      const records = await this.claimedTaskStore.listByStatuses([
        "pr_submitted",
        "reviewing"
      ]);

      for (const record of records) {
        if (this.stopped) break;

        // 检查是否超过最大 review 轮次
        if (record.review_round >= reviewSettings.max_review_rounds) {
          console.warn(
            `[ReviewWatcher] MR ${record.pr_url} reached max review rounds (${reviewSettings.max_review_rounds}), skipping`
          );
          continue;
        }

        // 只处理有 MR 信息的记录
        if (!record.mr_iid || !record.gitlab_project_id) {
          continue;
        }

        try {
          await this.checkRecordComments(record, reviewSettings);
        } catch (error) {
          console.error(
            `[ReviewWatcher] Failed to check comments for ${record.task_id}:`,
            error
          );
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private async checkRecordComments(
    record: ClaimedTaskRecord,
    reviewSettings: ReviewHandlingSettings
  ): Promise<void> {
    const adapter = await this.getGitHostAdapter(record.repo_path);
    if (!adapter) return;

    const comments = await adapter.listMRComments({
      repo_path: record.repo_path,
      mr_iid: record.mr_iid!,
      project_id: record.gitlab_project_id!,
      since: record.last_reviewed_at ?? undefined
    });

    // 过滤已处理的评论（按时间戳）
    const newComments = this.filterNewComments(
      comments,
      record.last_reviewed_at,
      reviewSettings.ignore_authors
    );

    if (newComments.length === 0) return;

    console.log(
      `[ReviewWatcher] Found ${newComments.length} new comment(s) on MR ${record.pr_url}`
    );

    // 通知处理
    if (this.onReviewNeeded) {
      await this.onReviewNeeded(record, newComments);
    }
  }

  /**
   * 过滤出新评论：排除已处理（时间戳早于 lastReviewedAt）
   * 和忽略列表中的作者。
   */
  private filterNewComments(
    comments: MRComment[],
    lastReviewedAt: string | null,
    ignoreAuthors: string[]
  ): MRComment[] {
    const ignoreSet = new Set(ignoreAuthors.map((a) => a.toLowerCase()));

    return comments.filter((comment) => {
      // 排除已处理的
      if (lastReviewedAt && comment.created_at <= lastReviewedAt) {
        return false;
      }
      // 排除忽略的作者
      if (ignoreSet.has(comment.author.toLowerCase())) {
        return false;
      }
      return true;
    });
  }
}

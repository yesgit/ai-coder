import type {
  TaskPlatformKind,
  TaskSearchQuery,
  UnifiedTask
} from "../../shared/types.js";

/**
 * 平台适配器抽象接口。Jira / PingCode 各自实现此接口，
 * 由 TaskPlatformRegistry 按配置选择实例。
 */
export interface TaskPlatformAdapter {
  readonly kind: TaskPlatformKind;

  /** 健康检查：验证凭证与连通性。 */
  ping(): Promise<{ ok: boolean; error?: string }>;

  /** 按过滤条件检索待认领任务。 */
  searchBacklog(query: TaskSearchQuery): Promise<UnifiedTask[]>;

  /** 认领任务：流转状态 + 分配给自己。 */
  claim(taskId: string): Promise<{ success: boolean; error?: string }>;

  /** 提交 PR 后流转到 review 状态。 */
  transitionToReview(taskId: string, prUrl: string): Promise<{ success: boolean; error?: string }>;

  /** 标记完成（PR 合并后）。 */
  transitionToDone(taskId: string): Promise<{ success: boolean; error?: string }>;

  /** 取消认领（失败回滚）。 */
  release(taskId: string, reason: string): Promise<{ success: boolean; error?: string }>;
}

import type {
  DifficultyLevel,
  TaskPlatformKind,
  UnifiedTask
} from "../../shared/types.js";
import type { SettingsStore } from "../settings/settingsStore.js";
import { DifficultyEstimator } from "./difficultyEstimator.js";
import type { TaskClaimManager } from "./taskClaimManager.js";
import type { TaskPlatformRegistry } from "./taskPlatformRegistry.js";

/**
 * 任务侦察服务。后台轮询平台 backlog，评估难度后交给
 * TaskClaimManager 认领。支持手动触发和定时轮询。
 */
export class TaskScout {
  private readonly timers = new Map<TaskPlatformKind, NodeJS.Timeout>();
  private readonly activeScans = new Map<TaskPlatformKind, Promise<UnifiedTask[]>>();
  private readonly claimLock = new Set<string>(); // 正在认领的 task_id
  private readonly failureCounts = new Map<TaskPlatformKind, number>();
  private readonly estimator = new DifficultyEstimator();
  private stopped = false;

  /** 外部设置的回调：认领成功后通知（用于触发会话编排）。 */
  onTaskClaimed?: (task: UnifiedTask) => Promise<void>;

  /** 外部设置的回调：广播队列更新给 UI。 */
  onQueueUpdated?: (tasks: UnifiedTask[]) => void;

  /** 外部设置的回调：凭证过期时通知 UI。 */
  onCredentialsExpired?: (platform: TaskPlatformKind) => void;

  constructor(
    private readonly registry: TaskPlatformRegistry,
    private readonly claimManager: TaskClaimManager,
    private readonly settingsStore: SettingsStore,
    private readonly getToken: (kind: TaskPlatformKind) => Promise<string | null>
  ) {}

  /** 启动定时轮询。 */
  async start(): Promise<void> {
    this.stopped = false;
    const settings = await this.settingsStore.get();
    const taskSettings = settings.task_automation;
    if (!taskSettings.enabled) return;

    const intervalMs = taskSettings.polling_interval_seconds * 1000;

    for (const platformConfig of taskSettings.platforms) {
      if (!platformConfig.enabled) continue;
      this.startTimer(platformConfig.kind, intervalMs);
    }
  }

  /** 停止所有轮询。 */
  stop(): void {
    this.stopped = true;
    for (const [kind, timer] of this.timers) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  /** 手动触发一次全平台扫描。 */
  async scanAll(): Promise<UnifiedTask[]> {
    const settings = await this.settingsStore.get();
    const allTasks: UnifiedTask[] = [];
    for (const platformConfig of settings.task_automation.platforms) {
      if (!platformConfig.enabled) continue;
      const tasks = await this.scanOnce(platformConfig.kind);
      allTasks.push(...tasks);
    }
    return allTasks;
  }

  /** 手动触发单平台扫描。 */
  async scanOnce(kind: TaskPlatformKind): Promise<UnifiedTask[]> {
    // 防止并发扫描同一平台
    const active = this.activeScans.get(kind);
    if (active) return active;

    const scan = this.performScan(kind);
    this.activeScans.set(kind, scan);
    try {
      const result = await scan;
      return result;
    } finally {
      this.activeScans.delete(kind);
    }
  }

  private async performScan(kind: TaskPlatformKind): Promise<UnifiedTask[]> {
    const settings = await this.settingsStore.get();
    const taskSettings = settings.task_automation;

    const token = await this.getToken(kind);
    const adapter = this.registry.get(kind, token ?? undefined);
    if (!adapter) return [];

    try {
      // 凭证健康检查：每次轮询前 ping 适配器，失败时广播 credentials:expired
      const pingResult = await adapter.ping();
      if (!pingResult.ok) {
        console.warn(`[TaskScout] Platform ${kind} health check failed: ${pingResult.error}`);
        if (this.onCredentialsExpired) {
          this.onCredentialsExpired(kind);
        }
        // 计入熔断计数
        const count = (this.failureCounts.get(kind) ?? 0) + 1;
        this.failureCounts.set(kind, count);
        if (count >= taskSettings.max_failure_count_before_pause) {
          console.warn(`[TaskScout] Platform ${kind} paused after ${count} consecutive failures (credentials expired)`);
          this.stopTimer(kind);
        }
        return [];
      }

      // 收集所有 project_mappings 的查询参数
      const config = taskSettings.platforms.find((c) => c.kind === kind);
      if (!config) return [];

      const projectIds = config.project_mappings.map((m) => m.platform_project_id);
      const allLabels = [...new Set(config.project_mappings.flatMap((m) => m.target_labels))];
      const allExcludeStatuses = [...new Set(config.project_mappings.flatMap((m) => m.exclude_statuses))];

      const tasks = await adapter.searchBacklog({
        project_ids: projectIds,
        labels: allLabels,
        exclude_statuses: allExcludeStatuses,
        unassigned_only: true,
        max_results: 20
      });

      // 评估难度
      for (const task of tasks) {
        task.difficulty_estimate = this.estimator.estimate(task);
      }

      // 过滤难度
      const allowedDifficulty = new Set(taskSettings.difficulty_filter);
      const candidates = tasks.filter((t) => allowedDifficulty.has(t.difficulty_estimate));

      // 通知 UI
      if (this.onQueueUpdated) {
        this.onQueueUpdated(tasks);
      }

      // 尝试自动认领
      for (const task of candidates) {
        if (this.stopped) break;
        if (this.claimLock.has(task.task_id)) continue;

        this.claimLock.add(task.task_id);
        try {
          const result = await this.claimManager.claimAndPrepare(task);
          if (result.success && this.onTaskClaimed) {
            await this.onTaskClaimed(task);
          }
          if (!result.success && result.error?.includes("并发上限")) {
            break; // 达到并发上限，停止本轮认领
          }
        } finally {
          this.claimLock.delete(task.task_id);
        }
      }

      // 成功重置失败计数
      this.failureCounts.set(kind, 0);
      return tasks;
    } catch (error) {
      // 熔断逻辑
      const count = (this.failureCounts.get(kind) ?? 0) + 1;
      this.failureCounts.set(kind, count);
      if (count >= taskSettings.max_failure_count_before_pause) {
        console.warn(`[TaskScout] Platform ${kind} paused after ${count} consecutive failures`);
        this.stopTimer(kind);
      }
      throw error;
    }
  }

  private startTimer(kind: TaskPlatformKind, intervalMs: number): void {
    if (this.timers.has(kind)) return;
    const timer = setInterval(() => {
      if (!this.stopped) {
        this.scanOnce(kind).catch((error) => {
          console.error(`[TaskScout] scan error for ${kind}:`, error);
        });
      }
    }, intervalMs);
    this.timers.set(kind, timer);

    // 启动后立即执行一次
    this.scanOnce(kind).catch((error) => {
      console.error(`[TaskScout] initial scan error for ${kind}:`, error);
    });
  }

  private stopTimer(kind: TaskPlatformKind): void {
    const timer = this.timers.get(kind);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(kind);
    }
  }
}

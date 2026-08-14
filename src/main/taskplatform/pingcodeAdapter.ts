import type {
  TaskProjectMapping,
  TaskSearchQuery,
  UnifiedTask
} from "../../shared/types.js";
import type { TaskPlatformAdapter } from "./taskPlatformAdapter.js";
import type { PlatformRateLimiter } from "./platformRateLimiter.js";

/**
 * PingCode OpenAPI 适配器。
 * 认证：Authorization: Bearer {api_token}。
 */
export class PingCodeAdapter implements TaskPlatformAdapter {
  readonly kind = "pingcode" as const;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly projectMappings: TaskProjectMapping[],
    private readonly limiter: PlatformRateLimiter
  ) {}

  private apiUrl(path: string): string {
    const base = this.baseUrl.replace(/\/$/, "");
    return `${base}/openapi${path}`;
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json"
    };
  }

  async ping(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.limiter.acquire(this.kind);
      const response = await fetch(this.apiUrl("/projects"), {
        headers: this.headers
      });
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}: ${response.statusText}` };
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async searchBacklog(query: TaskSearchQuery): Promise<UnifiedTask[]> {
    const tasks: UnifiedTask[] = [];

    for (const projectId of query.project_ids) {
      await this.limiter.acquire(this.kind);

      const params = new URLSearchParams({
        projectId,
        workItemType: "story,bug,task",
        pageSize: String(query.max_results)
      });

      if (query.labels.length > 0) {
        params.set("tagNames", query.labels.join(","));
      }

      const response = await fetch(`${this.apiUrl("/work-items")}?${params}`, {
        headers: this.headers
      });

      if (!response.ok) {
        console.warn(`PingCode search failed for project ${projectId}: HTTP ${response.status}`);
        continue;
      }

      const data = await response.json() as PingCodeSearchResponse;
      const items = data.workItems ?? data.data ?? [];

      for (const item of items) {
        // 过滤排除状态
        if (query.exclude_statuses.includes(item.statusName ?? "")) continue;
        // 过滤未分配
        if (query.unassigned_only && item.assignee) continue;

        const mapping = this.findMapping(projectId, item.labels ?? []);
        if (!mapping) continue;

        tasks.push({
          platform: this.kind,
          task_id: item.id,
          title: item.name ?? item.title ?? "",
          description: item.description ?? "",
          status: item.statusName ?? "Unknown",
          assignee: item.assignee ?? null,
          labels: item.labels ?? [],
          priority: item.priority ?? null,
          difficulty_estimate: "unknown",
          project_mapping: mapping,
          raw_url: `${this.baseUrl.replace(/\/$/, "")}/workitem/${item.id}`,
          fetched_at: new Date().toISOString()
        });
      }
    }

    return tasks;
  }

  async claim(taskId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.limiter.acquire(this.kind);
      const response = await fetch(this.apiUrl(`/work-items/${taskId}/change-status`), {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ statusName: "进行中" })
      });
      if (!response.ok) {
        return { success: false, error: `Failed to claim: HTTP ${response.status}` };
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async transitionToReview(taskId: string, prUrl: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.limiter.acquire(this.kind);
      await fetch(this.apiUrl(`/work-items/${taskId}/change-status`), {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ statusName: "评审中" })
      });
      // 添加评论
      await this.limiter.acquire(this.kind);
      await fetch(this.apiUrl(`/work-items/${taskId}/comments`), {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ content: `AI 已提交 PR: ${prUrl}` })
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async transitionToDone(taskId: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.limiter.acquire(this.kind);
      await fetch(this.apiUrl(`/work-items/${taskId}/change-status`), {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ statusName: "已完成" })
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async release(taskId: string, reason: string): Promise<{ success: boolean; error?: string }> {
    try {
      await this.limiter.acquire(this.kind);
      await fetch(this.apiUrl(`/work-items/${taskId}/change-status`), {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ statusName: "待处理" })
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private findMapping(projectId: string, labels: string[]): TaskProjectMapping | null {
    for (const mapping of this.projectMappings) {
      if (mapping.platform_project_id === projectId) {
        if (mapping.target_labels.length === 0 || mapping.target_labels.some((l) => labels.includes(l))) {
          return mapping;
        }
      }
    }
    return null;
  }
}

interface PingCodeSearchResponse {
  workItems?: Array<{
    id: string;
    name?: string;
    title?: string;
    description?: string;
    statusName?: string;
    assignee?: string;
    labels?: string[];
    priority?: string;
  }>;
  data?: Array<{
    id: string;
    name?: string;
    title?: string;
    description?: string;
    statusName?: string;
    assignee?: string;
    labels?: string[];
    priority?: string;
  }>;
}

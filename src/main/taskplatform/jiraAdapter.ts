import type {
  TaskPlatformKind,
  TaskProjectMapping,
  TaskSearchQuery,
  UnifiedTask
} from "../../shared/types.js";
import type { TaskPlatformAdapter } from "./taskPlatformAdapter.js";
import type { PlatformRateLimiter } from "./platformRateLimiter.js";

/**
 * Jira REST API 适配器。支持 Cloud（/rest/api/3）与 Server（/rest/api/2），
 * 通过 base_url 自动探测版本。
 *
 * 认证：Basic Auth（email:api_token base64）或 PAT（Server）。
 */
export class JiraAdapter implements TaskPlatformAdapter {
  readonly kind: TaskPlatformKind;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly projectMappings: TaskProjectMapping[],
    private readonly limiter: PlatformRateLimiter,
    kind: "jira_cloud" | "jira_server" = "jira_cloud"
  ) {
    this.kind = kind;
  }

  private get apiVersion(): string {
    return this.kind === "jira_cloud" ? "3" : "2";
  }

  private get authHeader(): string {
    // Cloud: email:api_token → Basic；Server: PAT → Bearer
    if (this.kind === "jira_cloud" && this.token.includes(":")) {
      return `Basic ${Buffer.from(this.token).toString("base64")}`;
    }
    return `Bearer ${this.token}`;
  }

  private apiUrl(path: string): string {
    const base = this.baseUrl.replace(/\/$/, "");
    return `${base}/rest/api/${this.apiVersion}${path}`;
  }

  async ping(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.limiter.acquire(this.kind);
      const response = await fetch(this.apiUrl("/myself"), {
        headers: { Authorization: this.authHeader }
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
    const jql = this.buildJql(query);
    await this.limiter.acquire(this.kind);

    const response = await fetch(this.apiUrl("/search"), {
      method: "POST",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        jql,
        maxResults: query.max_results,
        fields: ["summary", "description", "status", "assignee", "labels", "priority", "issuetype"]
      })
    });

    if (!response.ok) {
      throw new Error(`Jira search failed: HTTP ${response.status}`);
    }

    const data = await response.json() as JiraSearchResponse;
    const tasks: UnifiedTask[] = [];

    for (const issue of data.issues) {
      const mapping = this.findMapping(issue.fields.labels, issue.key);
      if (!mapping) continue;

      tasks.push({
        platform: this.kind,
        task_id: issue.key,
        title: issue.fields.summary,
        description: extractDescription(issue.fields.description),
        status: issue.fields.status?.name ?? "Unknown",
        assignee: issue.fields.assignee?.displayName ?? null,
        labels: issue.fields.labels ?? [],
        priority: issue.fields.priority?.name ?? null,
        difficulty_estimate: "unknown",
        project_mapping: mapping,
        raw_url: `${this.baseUrl.replace(/\/$/, "")}/browse/${issue.key}`,
        fetched_at: new Date().toISOString()
      });
    }

    return tasks;
  }

  async claim(taskId: string): Promise<{ success: boolean; error?: string }> {
    try {
      // 1. 分配给自己
      await this.limiter.acquire(this.kind);
      const assignResponse = await fetch(this.apiUrl(`/issue/${taskId}/assignee`), {
        method: "PUT",
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ accountId: this.getCurrentAccountId() })
      });
      if (!assignResponse.ok && assignResponse.status !== 204) {
        return { success: false, error: `Failed to assign: HTTP ${assignResponse.status}` };
      }

      // 2. 流转到 In Progress
      const transitionId = this.getTransitionId(taskId, "in_progress");
      if (transitionId) {
        await this.limiter.acquire(this.kind);
        await fetch(this.apiUrl(`/issue/${taskId}/transitions`), {
          method: "POST",
          headers: {
            Authorization: this.authHeader,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ transition: { id: transitionId } })
        });
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async transitionToReview(taskId: string, prUrl: string): Promise<{ success: boolean; error?: string }> {
    try {
      // 添加评论包含 PR 链接
      await this.limiter.acquire(this.kind);
      await fetch(this.apiUrl(`/issue/${taskId}/comment`), {
        method: "POST",
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          body: this.kind === "jira_cloud"
            ? { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: `AI 已提交 PR: ${prUrl}` }] }] }
            : `AI 已提交 PR: ${prUrl}`
        })
      });

      // 流转状态
      const transitionId = this.getTransitionId(taskId, "review");
      if (transitionId) {
        await this.limiter.acquire(this.kind);
        await fetch(this.apiUrl(`/issue/${taskId}/transitions`), {
          method: "POST",
          headers: {
            Authorization: this.authHeader,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ transition: { id: transitionId } })
        });
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async transitionToDone(taskId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const transitionId = this.getTransitionId(taskId, "done");
      if (transitionId) {
        await this.limiter.acquire(this.kind);
        await fetch(this.apiUrl(`/issue/${taskId}/transitions`), {
          method: "POST",
          headers: {
            Authorization: this.authHeader,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ transition: { id: transitionId } })
        });
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async release(taskId: string, reason: string): Promise<{ success: boolean; error?: string }> {
    try {
      // 清空 assignee
      await this.limiter.acquire(this.kind);
      await fetch(this.apiUrl(`/issue/${taskId}/assignee`), {
        method: "PUT",
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(this.kind === "jira_cloud" ? { accountId: null } : { name: null })
      });

      // 回退到 To Do
      const transitionId = this.getTransitionId(taskId, "todo");
      if (transitionId) {
        await this.limiter.acquire(this.kind);
        await fetch(this.apiUrl(`/issue/${taskId}/transitions`), {
          method: "POST",
          headers: {
            Authorization: this.authHeader,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ transition: { id: transitionId } })
        });
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private buildJql(query: TaskSearchQuery): string {
    const parts: string[] = [];
    if (query.project_ids.length > 0) {
      parts.push(`project in (${query.project_ids.join(", ")})`);
    }
    if (query.labels.length > 0) {
      parts.push(`labels in (${query.labels.map((l) => `"${l}"`).join(", ")})`);
    }
    if (query.exclude_statuses.length > 0) {
      parts.push(`status not in (${query.exclude_statuses.map((s) => `"${s}"`).join(", ")})`);
    }
    if (query.unassigned_only) {
      parts.push("assignee is EMPTY");
    }
    return parts.join(" AND ") || "assignee is EMPTY";
  }

  private findMapping(labels: string[], issueKey: string): TaskProjectMapping | null {
    for (const mapping of this.projectMappings) {
      // 检查 issue key 前缀匹配项目
      if (issueKey.startsWith(mapping.platform_project_id + "-")) {
        // 检查标签匹配（空 target_labels 表示接受所有）
        if (mapping.target_labels.length === 0 || mapping.target_labels.some((l) => labels.includes(l))) {
          return mapping;
        }
      }
    }
    return null;
  }

  private getTransitionId(_taskId: string, statusName: string): string | null {
    // 从 project_mappings 的 transition_ids 缓存中查找
    for (const mapping of this.projectMappings) {
      const ids = mapping.transition_ids;
      if (ids && ids[statusName]) {
        return ids[statusName];
      }
    }
    return null;
  }

  private getCurrentAccountId(): string {
    // 从 token 中提取（Cloud 格式 email:token）；Server 不需要
    if (this.kind === "jira_cloud" && this.token.includes(":")) {
      return this.token.split(":")[0];
    }
    return "";
  }
}

interface JiraSearchResponse {
  issues: Array<{
    key: string;
    fields: {
      summary: string;
      description: unknown;
      status: { name: string } | null;
      assignee: { displayName: string } | null;
      labels: string[];
      priority: { name: string } | null;
    };
  }>;
}

function extractDescription(description: unknown): string {
  if (typeof description === "string") return description;
  if (description && typeof description === "object") {
    // Cloud v3 ADF 格式：递归提取文本
    return extractAdfText(description as AdfNode);
  }
  return "";
}

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
}

function extractAdfText(node: AdfNode): string {
  if (node.text) return node.text;
  if (node.content) return node.content.map(extractAdfText).join("");
  return "";
}

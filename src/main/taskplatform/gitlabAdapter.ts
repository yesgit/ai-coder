import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  MRComment,
  MRCommentQuery,
  MRCommentReply,
  MRDiffNote,
  MRQuery
} from "../../shared/types.js";
import type { GitHostAdapter, PRInput, PRResult } from "./gitHostAdapter.js";

const execFileAsync = promisify(execFile);

/**
 * GitLab REST API 适配器。支持自托管 GitLab 实例。
 * 认证用 Private Token（PRIVATE-TOKEN header）。
 */
export class GitLabAdapter implements GitHostAdapter {
  constructor(
    private readonly token: string,
    private readonly baseUrl: string = "https://gitlab.com"
  ) {}

  detectHost(remoteUrl: string): boolean {
    const normalized = this.baseUrl.replace(/https?:\/\//, "").replace(/\/$/, "");
    return remoteUrl.includes(normalized) || remoteUrl.includes("gitlab.com");
  }

  async createPullRequest(input: PRInput): Promise<PRResult> {
    const projectId = await this.resolveProjectId(input.repo_path);
    const encodedId = encodeURIComponent(projectId);

    const response = await fetch(
      `${this.baseUrl}/api/v4/projects/${encodedId}/merge_requests`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          source_branch: input.head,
          target_branch: input.base,
          title: input.title,
          description: input.body,
          labels: input.labels?.join(",")
        })
      }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`GitLab MR creation failed: HTTP ${response.status} - ${errorBody}`);
    }

    const data = await response.json() as { web_url: string; iid: number };
    return {
      url: data.web_url,
      mr_iid: data.iid,
      project_id: projectId
    };
  }

  async listMRComments(input: MRCommentQuery): Promise<MRComment[]> {
    const encodedId = encodeURIComponent(input.project_id);
    const params = new URLSearchParams({
      per_page: "100",
      sort: "asc"
    });
    if (input.since) {
      params.set("updated_after", input.since);
    }

    const response = await fetch(
      `${this.baseUrl}/api/v4/projects/${encodedId}/merge_requests/${input.mr_iid}/notes?${params}`,
      { headers: this.headers() }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`GitLab listMRComments failed: HTTP ${response.status} - ${errorBody}`);
    }

    const notes = await response.json() as GitLabNote[];

    // 过滤掉系统自动生成的笔记（如 label 变更、状态变更等）
    return notes
      .filter((note) => !note.system)
      .map((note) => ({
        id: note.id,
        author: note.author.username,
        body: note.body,
        created_at: note.created_at,
        position: note.position ? {
          new_path: note.position.new_path,
          new_line: note.position.new_line
        } : undefined,
        resolvable: note.resolvable ?? false,
        resolved: note.resolved ?? false
      }));
  }

  async postMRComment(input: MRCommentReply): Promise<void> {
    const encodedId = encodeURIComponent(input.project_id);

    // 统一发顶层 note，不做线程回复。
    // 若需线程回复，应使用 discussions API：
    // POST /projects/:id/merge_requests/:iid/discussions/:discussion_id/notes
    const response = await fetch(
      `${this.baseUrl}/api/v4/projects/${encodedId}/merge_requests/${input.mr_iid}/notes`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ body: input.body })
      }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`GitLab postMRComment failed: HTTP ${response.status} - ${errorBody}`);
    }
  }

  async getMRDiff(input: MRQuery): Promise<MRDiffNote[]> {
    const encodedId = encodeURIComponent(input.project_id);

    const response = await fetch(
      `${this.baseUrl}/api/v4/projects/${encodedId}/merge_requests/${input.mr_iid}/changes`,
      { headers: this.headers() }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`GitLab getMRDiff failed: HTTP ${response.status} - ${errorBody}`);
    }

    const data = await response.json() as { changes: GitLabDiff[] };
    return (data.changes ?? []).map((change) => ({
      old_path: change.old_path,
      new_path: change.new_path,
      diff: change.diff,
      new_file: change.new_file,
      renamed_file: change.renamed_file,
      deleted_file: change.deleted_file
    }));
  }

  /**
   * 通过 git remote URL 解析 GitLab project path（如 "group/subgroup/project"）。
   */
  async resolveProjectId(repoPath: string): Promise<string> {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
      cwd: repoPath,
      encoding: "utf8"
    });
    const url = stdout.trim();

    // SSH: git@gitlab.example.com:group/project.git
    const sshMatch = url.match(/git@[^:]+:(.+?)(?:\.git)?$/);
    if (sshMatch) {
      return sshMatch[1];
    }

    // HTTPS: https://gitlab.example.com/group/project.git
    const baseUrlHost = this.baseUrl.replace(/https?:\/\//, "").replace(/\/$/, "");
    const httpsMatch = url.match(new RegExp(`${escapeRegex(baseUrlHost)}\\/(.+?)(?:\\.git)?$`));
    if (httpsMatch) {
      return httpsMatch[1];
    }

    // 通用 HTTPS 匹配
    const genericMatch = url.match(/https?:\/\/[^/]+\/(.+?)(?:\.git)?$/);
    if (genericMatch) {
      return genericMatch[1];
    }

    throw new Error(`Unable to parse GitLab remote URL: ${url}`);
  }

  private headers(): Record<string, string> {
    return {
      "PRIVATE-TOKEN": this.token,
      "Content-Type": "application/json"
    };
  }
}

// ─── GitLab API 响应类型 ──────────────────────────────────────────────────────

interface GitLabNote {
  id: number;
  body: string;
  created_at: string;
  author: { username: string };
  system: boolean;
  resolvable?: boolean;
  resolved?: boolean;
  position?: {
    new_path: string;
    new_line: number;
    old_path?: string;
    old_line?: number;
  };
}

interface GitLabDiff {
  old_path: string;
  new_path: string;
  diff: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

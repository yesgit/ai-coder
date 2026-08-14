import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  MRComment,
  MRCommentQuery,
  MRCommentReply,
  MRDiffNote,
  MRQuery
} from "../../shared/types.js";
import { GitLabAdapter } from "./gitlabAdapter.js";

const execFileAsync = promisify(execFile);

/**
 * Git 托管平台抽象接口。GitHub / GitLab 各自实现。
 */
export interface GitHostAdapter {
  /** 创建 Pull Request / Merge Request。返回包含 URL 和可选元数据的结果。 */
  createPullRequest(input: PRInput): Promise<PRResult>;
  /** 检测远程仓库 URL 是否属于此平台。 */
  detectHost(remoteUrl: string): boolean;
  /** 获取 MR/PR 评论列表。 */
  listMRComments(input: MRCommentQuery): Promise<MRComment[]>;
  /** 发布 MR/PR 评论回复。 */
  postMRComment(input: MRCommentReply): Promise<void>;
  /** 获取 MR/PR 的 diff 信息。 */
  getMRDiff(input: MRQuery): Promise<MRDiffNote[]>;
}

export interface PRInput {
  repo_path: string;
  head: string;
  base: string;
  title: string;
  body: string;
  labels?: string[];
}

export interface PRResult {
  url: string;
  mr_iid?: number;
  project_id?: string;
}

/**
 * GitHub REST API 适配器。认证用 PAT。
 */
export class GitHubAdapter implements GitHostAdapter {
  constructor(private readonly token: string) {}

  detectHost(remoteUrl: string): boolean {
    return remoteUrl.includes("github.com");
  }

  async createPullRequest(input: PRInput): Promise<PRResult> {
    const { owner, repo } = await this.parseRemote(input.repo_path);

    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
        labels: input.labels
      })
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`GitHub PR creation failed: HTTP ${response.status} - ${errorBody}`);
    }

    const data = await response.json() as { html_url: string };
    return { url: data.html_url };
  }

  async listMRComments(_input: MRCommentQuery): Promise<MRComment[]> {
    // TODO: GitHub PR review comments 暂未实现
    return [];
  }

  async postMRComment(_input: MRCommentReply): Promise<void> {
    // TODO: GitHub PR review comments 暂未实现
  }

  async getMRDiff(_input: MRQuery): Promise<MRDiffNote[]> {
    // TODO: GitHub PR diff 暂未实现
    return [];
  }

  private async parseRemote(repoPath: string): Promise<{ owner: string; repo: string }> {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
      cwd: repoPath,
      encoding: "utf8"
    });
    const url = stdout.trim();
    // 支持 SSH (git@github.com:owner/repo.git) 和 HTTPS (https://github.com/owner/repo.git)
    const sshMatch = url.match(/git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
    if (sshMatch) {
      return { owner: sshMatch[1], repo: sshMatch[2] };
    }
    const httpsMatch = url.match(/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
    if (httpsMatch) {
      return { owner: httpsMatch[1], repo: httpsMatch[2] };
    }
    throw new Error(`Unable to parse GitHub remote URL: ${url}`);
  }
}

/**
 * 自动检测并返回合适的 GitHostAdapter。
 */
export function detectGitHost(remoteUrl: string, token: string, baseUrl?: string): GitHostAdapter | null {
  if (remoteUrl.includes("github.com")) {
    return new GitHubAdapter(token);
  }
  if (remoteUrl.includes("gitlab") || baseUrl) {
    // 支持自托管 GitLab，通过 baseUrl 或 URL 特征判断
    const host = baseUrl ?? extractGitLabBaseUrl(remoteUrl);
    if (host) {
      return new GitLabAdapter(token, host);
    }
  }
  return null;
}

function extractGitLabBaseUrl(remoteUrl: string): string | null {
  // SSH: git@gitlab.example.com:group/project.git
  const sshMatch = remoteUrl.match(/git@([^:]+):/);
  if (sshMatch && sshMatch[1] !== "github.com") {
    return `https://${sshMatch[1]}`;
  }
  // HTTPS: https://gitlab.example.com/group/project.git
  const httpsMatch = remoteUrl.match(/https?:\/\/([^/]+)/);
  if (httpsMatch && !httpsMatch[1].includes("github.com")) {
    return `https://${httpsMatch[1]}`;
  }
  return null;
}

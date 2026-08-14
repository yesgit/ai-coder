import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Git 托管平台抽象接口。GitHub / GitLab 各自实现。
 */
export interface GitHostAdapter {
  /** 创建 Pull Request / Merge Request。返回 PR URL。 */
  createPullRequest(input: PRInput): Promise<string>;
  /** 检测远程仓库 URL 是否属于此平台。 */
  detectHost(remoteUrl: string): boolean;
}

export interface PRInput {
  repo_path: string;
  head: string;
  base: string;
  title: string;
  body: string;
  labels?: string[];
}

/**
 * GitHub REST API 适配器。认证用 PAT。
 */
export class GitHubAdapter implements GitHostAdapter {
  constructor(private readonly token: string) {}

  detectHost(remoteUrl: string): boolean {
    return remoteUrl.includes("github.com");
  }

  async createPullRequest(input: PRInput): Promise<string> {
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
    return data.html_url;
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
export function detectGitHost(remoteUrl: string, token: string): GitHostAdapter | null {
  if (remoteUrl.includes("github.com")) {
    return new GitHubAdapter(token);
  }
  // 可扩展 GitLab / Gitea 等
  return null;
}

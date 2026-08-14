import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 安全命令前缀白名单——仅这些 git 操作在自主模式下自动放行。 */
const SAFE_GIT_PREFIXES = [
  "git fetch",
  "git checkout",
  "git pull",
  "git add",
  "git commit",
  "git push",
  "git branch",
  "git status",
  "git log",
  "git diff",
  "git remote",
  "git rev-parse",
  "git config --get"
];

/** 危险命令关键词——硬阻断，不可绕过。 */
const DANGEROUS_GIT_PATTERNS = [
  "--force",
  "-f ",
  "reset --hard",
  "clean -fd",
  "clean -fX",
  "stash drop",
  "branch -D",
  "reflog expire"
];

const EXEC_TIMEOUT_MS = 30_000;

/**
 * git 分支操作封装。所有命令经安全检查：安全命令自动放行，
 * 危险命令（force/reset/clean）硬阻断。
 */
export class BranchManager {
  /**
   * 从 base 分支创建特性分支。
   * @returns 创建的分支名
   */
  async createFeatureBranch(
    repoPath: string,
    baseBranch: string,
    prefix: string,
    taskId: string
  ): Promise<string> {
    await this.execGit(repoPath, ["fetch", "origin", baseBranch]);
    await this.execGit(repoPath, ["checkout", baseBranch]);
    await this.execGit(repoPath, ["pull", "--ff-only"]);
    const branch = `${prefix}${sanitizeBranchName(taskId)}`;
    await this.execGit(repoPath, ["checkout", "-b", branch]);
    return branch;
  }

  /** 提交所有暂存文件 + 推送。返回远程分支引用。 */
  async commitAndPush(repoPath: string, message: string): Promise<string> {
    await this.execGit(repoPath, ["add", "-A"]);
    // 检查是否有变更可提交；无变更时跳过 commit
    const status = await this.execGit(repoPath, ["status", "--porcelain"]);
    if (!status.trim()) {
      return ""; // 无变更
    }
    await this.execGit(repoPath, ["commit", "-m", message]);
    const branchResult = await this.execGit(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = branchResult.trim();
    await this.execGit(repoPath, ["push", "-u", "origin", branch]);
    return `origin/${branch}`;
  }

  /** 仅删除本地分支（安全操作）。 */
  async deleteBranch(repoPath: string, branch: string): Promise<void> {
    await this.execGit(repoPath, ["checkout", "-"]);
    await this.execGit(repoPath, ["branch", "-d", branch]);
  }

  /** 获取远程仓库 URL。 */
  async getRemoteUrl(repoPath: string, remote = "origin"): Promise<string> {
    const result = await this.execGit(repoPath, ["remote", "get-url", remote]);
    return result.trim();
  }

  /**
   * 安全执行 git 命令。检查危险模式后通过 execFile 执行，
   * 避免 shell 注入风险。
   */
  private async execGit(repoPath: string, args: string[]): Promise<string> {
    const fullCommand = `git ${args.join(" ")}`;
    assertSafeGitCommand(fullCommand);
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoPath,
      timeout: EXEC_TIMEOUT_MS,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024
    });
    return stdout;
  }
}

function sanitizeBranchName(raw: string): string {
  // 只保留字母、数字、连字符、下划线、斜杠
  return raw.replace(/[^a-zA-Z0-9\-_/]/g, "-").slice(0, 60);
}

function assertSafeGitCommand(command: string): void {
  // 检查危险模式
  for (const pattern of DANGEROUS_GIT_PATTERNS) {
    if (command.includes(pattern)) {
      throw new Error(`Blocked dangerous git command: ${command}`);
    }
  }
  // 检查白名单
  const allowed = SAFE_GIT_PREFIXES.some((prefix) => command.startsWith(prefix));
  if (!allowed) {
    throw new Error(`Git command not in safe whitelist: ${command}`);
  }
}

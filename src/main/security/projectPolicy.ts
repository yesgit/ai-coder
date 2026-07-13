import fs from "node:fs/promises";
import path from "node:path";
import type { AgentSession, ToolCallRecord, WorkflowStage, WorkflowTemplate } from "../../shared/types.js";

export type ToolUseDecision =
  | { allow: true; updatedInput: Record<string, unknown> }
  | { allow: false; message: string; interrupt: boolean };

const DANGEROUS_COMMANDS = [
  "rm -rf /",
  "sudo ",
  "mkfs",
  "diskutil erase"
];

export async function assertPathInsideProject(projectPath: string, targetPath: string): Promise<void> {
  const status = await checkPathInsideProject(projectPath, targetPath);
  if (!status.inside) {
    throw new Error(`Blocked path outside project: ${targetPath}`);
  }
}

/**
 * 路径是否落在项目目录内（解析过 symlink）。返回 realpath 用于审批存档。
 */
export async function checkPathInsideProject(
  projectPath: string,
  targetPath: string
): Promise<{ inside: boolean; realTarget: string }> {
  const resolvedProject = await fs.realpath(path.resolve(projectPath));
  const resolvedTarget = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(projectPath, targetPath);
  const realTarget = await resolveExistingPathOrParent(resolvedTarget);
  const relative = path.relative(resolvedProject, realTarget);
  const inside = !relative.startsWith("..") && !path.isAbsolute(relative);
  return { inside, realTarget };
}

export function requiresShellApproval(workflow: WorkflowTemplate): boolean {
  return workflow.permissions.shell?.approval_required ?? true;
}

export function assertCommandAllowed(command: string): void {
  const normalized = command.toLowerCase();
  const blocked = DANGEROUS_COMMANDS.find((pattern) => normalized.includes(pattern));
  if (blocked) {
    throw new Error(`Blocked high-risk command pattern: ${blocked}`);
  }
}

export function hasPendingStageApproval(session: AgentSession): boolean {
  return session.approvals.some((approval) => approval.kind === "stage" && approval.status === "pending");
}

export function hasStageApproval(session: AgentSession, stageId: string): boolean {
  return session.approvals.some(
    (approval) => approval.kind === "stage" && approval.stage_id === stageId && approval.status === "approved"
  );
}

export function buildAllowedClaudeTools(workflow: WorkflowTemplate, stage?: WorkflowStage): string[] {
  const declared = new Set(stage ? (stage.allowed_tools ?? []) : workflow.stages.flatMap((item) => item.allowed_tools ?? []));
  const tools = new Set<string>(["Read", "Grep", "Glob", "LS"]);

  if (declared.has("edit_file")) {
    tools.add("Edit");
    tools.add("MultiEdit");
    tools.add("Write");
  }

  if (declared.has("shell")) {
    tools.add("Bash");
  }

  // 当阶段定义了 sub-agent 时，允许 Task 工具
  if (stage?.agents && Object.keys(stage.agents).length > 0) {
    tools.add("Task");
  }

  return [...tools];
}

export function buildDisallowedClaudeTools(workflow: WorkflowTemplate): string[] {
  const disallowed = new Set<string>();
  if (workflow.permissions.network?.enabled === false) {
    disallowed.add("WebFetch");
    disallowed.add("WebSearch");
  }
  return [...disallowed];
}

export async function approveOrDenyToolUse(
  session: AgentSession,
  workflow: WorkflowTemplate,
  toolName: string,
  input: Record<string, unknown>,
  toolUseId: string
): Promise<ToolUseDecision> {
  const now = new Date().toISOString();
  const existingToolCall = findExistingToolCall(session, toolName, input, toolUseId);
  if (existingToolCall?.status === "approved") {
    existingToolCall.status = "completed";
    existingToolCall.resolved_at = now;
    recordFileChangesForTool(session, toolName, input, true, now);
    await rememberApprovedExternalReads(session, toolName, input);
    return { allow: true, updatedInput: input };
  }
  if (existingToolCall?.status === "denied") {
    return { allow: false, message: "Tool call was denied by the user. Continue without this tool or choose an allowed alternative.", interrupt: false };
  }
  if (existingToolCall?.status === "pending_approval") {
    return { allow: false, message: "Tool call is waiting for user approval.", interrupt: true };
  }

  // 如果当前阶段声明了允许的工具，自动允许这些工具的调用
  // 对于需要阶段审批的阶段（approval_required=true），只有在阶段已获批准后才行
  // 对于不需要阶段审批的阶段（如 implementation），直接允许声明的工具
  //
  // 重要：自动放行只覆盖"逐工具点 OK"那层 UI 审批，不能跳过硬安全约束——
  // workflow.permissions.shell.approval_required / 项目外路径 / 危险命令 这些
  // 仍然必须在下面的检查里走 pending_approval 或 blocked，否则 yaml 作者写的
  // 约束会被静默忽略。
  const currentStage = workflow.stages.find((s) => s.id === session.current_stage);
  if (currentStage) {
    const stageAllowsCurrentTool =
      (isWriteTool(toolName) && currentStage.allowed_tools?.includes("edit_file")) ||
      (toolName === "Bash" && currentStage.allowed_tools?.includes("shell")) ||
      (isReadOnlyFileTool(toolName) && (currentStage.allowed_tools?.includes("read_file") || currentStage.allowed_tools?.includes("edit_file")));

    if (stageAllowsCurrentTool) {
      const needsStageApproval = currentStage.approval_required && !hasStageApproval(session, currentStage.id);
      const skippableByStageAuth = await canSkipPerToolApproval(session, workflow, toolName, input);
      if (!needsStageApproval && skippableByStageAuth) {
        // 自动允许该阶段声明的工具
        const toolCall: ToolCallRecord = {
          id: toolUseId,
          stage_id: session.current_stage,
          tool: toolName,
          input,
          status: "approved",
          created_at: now,
          resolved_at: now
        };
        session.tool_calls.push(toolCall);
        recordFileChangesForTool(session, toolName, input, true, now);
        await rememberApprovedExternalReads(session, toolName, input);
        return { allow: true, updatedInput: input };
      }
    }
  }

  // 自动审批模式：跳过逐工具审批，但硬安全规则（危险命令/项目外写入）永远生效
  if (session.auto_approve) {
    if (toolName === "Bash") {
      assertCommandAllowed(String(input.command ?? ""));
    }
    for (const filePath of extractFilePaths(input)) {
      const { inside } = await checkPathInsideProject(session.project_path, filePath);
      if (!inside && !isReadOnlyFileTool(toolName)) {
        throw new Error(`Blocked path outside project: ${filePath}`);
      }
    }
    const toolCall: ToolCallRecord = {
      id: toolUseId,
      stage_id: session.current_stage,
      tool: toolName,
      input,
      status: "approved",
      created_at: now,
      resolved_at: now
    };
    session.tool_calls.push(toolCall);
    recordFileChangesForTool(session, toolName, input, true, now);
    await rememberApprovedExternalReads(session, toolName, input);
    return { allow: true, updatedInput: input };
  }

  const record = (status: ToolCallRecord["status"]) => {
    const toolCall = {
      id: toolUseId,
      stage_id: session.current_stage,
      tool: toolName,
      input,
      status,
      created_at: now
    };
    session.tool_calls.push(toolCall);
    return toolCall;
  };

  try {
    if (toolName === "Bash") {
      const command = String(input.command ?? "");
      assertCommandAllowed(command);
      // 自主安全 shell（只读勘察 + 常见验证/构建检查）免逐次审批；危险或会改仓库状态的命令仍走审批/阻断。
      if (requiresShellApproval(workflow) && !isAutonomousSafeShellCommand(command)) {
        record("pending_approval");
        session.status = "waiting_approval";
        return { allow: false, message: "Shell command is waiting for user approval.", interrupt: true };
      }
    }

    for (const filePath of extractFilePaths(input)) {
      const { inside, realTarget } = await checkPathInsideProject(session.project_path, filePath);
      if (inside) continue;

      // 项目外路径：写工具仍硬阻断；只读工具走"按 session 缓存的"用户审批
      if (!isReadOnlyFileTool(toolName)) {
        throw new Error(`Blocked path outside project: ${filePath}`);
      }
      const approvedExternal = session.approved_external_paths ?? [];
      if (isApprovedExternalPath(realTarget, approvedExternal)) {
        continue;
      }
      record("pending_approval");
      session.status = "waiting_approval";
      return {
        allow: false,
        message: `Read access outside project is waiting for user approval: ${filePath}`,
        interrupt: true
      };
    }

    if (isWriteTool(toolName)) {
      recordFileChangesForTool(session, toolName, input, false, now);
      record("pending_approval");
      session.status = "waiting_approval";
      return { allow: false, message: "File write is waiting for user approval.", interrupt: true };
    }

    record("approved");
    return { allow: true, updatedInput: input };
  } catch (error) {
    record("blocked");
    return {
      allow: false,
      message: `${error instanceof Error ? error.message : String(error)}. Continue without this tool or choose an allowed alternative.`,
      interrupt: false
    };
  }
}

/**
 * 判定 shell 命令是否只读（不改状态）、可免逐次审批。
 *
 * 命令首段命中 read-only 白名单（git log/diff/show/blame、grep/rg/ls/cat/head/tail/wc/find 等），
 * 允许安全过滤管道和丢弃 stderr 到 /dev/null。其他重定向/命令分隔/命令替换仍回退审批。
 * 命令名本身（rm/mv/cp 等）不在白名单 → 首段不匹配 → 本就走审批，无需在此列举。
 *
 * 保守：宁可误伤（grep pattern 含 > 等少见情况）也不放行可能写/删的命令。
 * 这层让 investigate 的 git log/grep 不再每个都 interrupt（审批后重跑 stage 循环卡死的根因）。
 */
const READONLY_SHELL_PREFIXES = [
  // git 只读操作
  "git log", "git diff", "git show", "git blame", "git status", "git ls-files", "git ls-tree",
  "git remote -v", "git branch", "git config --get", "git rev-parse", "git grep",
  "git describe", "git tag -l", "git name-rev", "git merge-base", "git log ",
  // 目录/文件浏览
  "cd ", "ls ", "pwd", "find ", "du ", "df ", "stat ", "file ", "head ", "tail ", "cat ", "wc ",
  // 搜索/文本处理
  "grep ", "rg ", "echo ", "test ", "which ", "type ", "uname ", "env", "printenv", "date",
  // 网络只读（不写文件）
  "curl -s", "curl -I", "wget -q", "wget --spider"
];

/**
 * 判定 shell 命令是否只读（不改状态）、可免逐次审批。
 *
 * 规则：
 * 1. 按 && / || 分割成多段，逐段检查
 * 2. 每段必须以 READONLY_SHELL_PREFIXES 之一开头
 * 3. 允许安全过滤管道（head/tail/wc/grep 等）
 * 4. 拒绝普通重定向 (</>)、命令替换 ($()` )、分号 (;)
 *
 * 保守：宁可误伤也不放行可能写/删的命令。
 */
export function isReadOnlyShellCommand(command: string): boolean {
  return isAutonomousSafeShellCommand(command, { readonlyOnly: true });
}

export function isAutonomousSafeShellCommand(command: string, options: { readonlyOnly?: boolean } = {}): boolean {
  let trimmed = command.trim().toLowerCase();
  if (!trimmed) return false;

  trimmed = normalizeReadonlyShellCommand(trimmed);
  if (!trimmed) return false;

  // 快速拒绝：含危险语法（重定向/命令替换/分号）。管道在下面逐段校验。
  if (/[<>;`$()]/.test(trimmed)) return false;

  // 按 && / || 分割成段，逐段检查
  const segments = trimmed.split(/\s*(?:&&|\|\|)\s*/).filter(s => s.trim().length > 0);
  if (segments.length === 0) return false;

  for (const seg of segments) {
    // 每段内如果有管道 |，检查管道右边是否是安全过滤器（head/tail/wc/grep 等）
    const pipeParts = seg.split(/\s*\|\s*/).filter(p => p.trim().length > 0);
    for (let i = 0; i < pipeParts.length; i++) {
      const part = pipeParts[i].trim();
      // 第一段必须是 read-only 前缀
      if (i === 0) {
        if (!isSafeShellSegment(part, options.readonlyOnly ?? false)) return false;
      } else {
        // 管道后的段必须是安全过滤器
        const safeFilters = ['head', 'tail', 'wc', 'grep', 'rg', 'less', 'more', 'cat', 'sort', 'uniq', 'cut', 'awk', 'sed'];
        if (!safeFilters.some(f => part.startsWith(f))) return false;
      }
    }
  }

  return true;
}

function normalizeReadonlyShellCommand(command: string): string {
  // 常见只读取证命令会把 stderr 静默到 /dev/null；只允许丢弃 stderr，不允许普通写重定向。
  return command
    .replace(/\s+2>\s*\/dev\/null\b/g, "")
    .replace(/\s+2>>\s*\/dev\/null\b/g, "")
    .replace(/\s+2>&1\b/g, "");
}

function isReadonlyShellSegment(segment: string): boolean {
  if (READONLY_SHELL_PREFIXES.some((prefix) => segment.startsWith(prefix))) {
    return true;
  }
  const gitMatch = segment.match(/^git\s+(.+)$/);
  if (!gitMatch) return false;

  const tokens = gitMatch[1].trim().split(/\s+/);
  while (tokens[0] === "-c" || tokens[0] === "-C") {
    if (tokens.length < 3) return false;
    tokens.splice(0, 2);
  }

  const readonlyGitSubcommands = new Set([
    "log",
    "diff",
    "show",
    "blame",
    "status",
    "ls-files",
    "ls-tree",
    "remote",
    "branch",
    "config",
    "rev-parse",
    "grep",
    "describe",
    "tag",
    "name-rev",
    "merge-base"
  ]);
  return readonlyGitSubcommands.has(tokens[0]);
}

function isSafeShellSegment(segment: string, readonlyOnly: boolean): boolean {
  if (isReadonlyShellSegment(segment)) {
    return true;
  }
  return !readonlyOnly && isAutonomousWriteShellSegment(segment);
}

function isAutonomousWriteShellSegment(segment: string): boolean {
  return (
    /^(?:npm|yarn|pnpm|bun)\s+(?:test|run\s+(?:test|test:[\w:-]+|lint|lint:[\w:-]+|typecheck|type-check|check|build|build:[\w:-]+)\b)/.test(segment) ||
    /^(?:npm|yarn|pnpm|bun)\s+(?:install|i|ci|add|remove|uninstall|update|publish)\b/.test(segment) ||
    /^(?:npx|pnpm\s+exec|yarn\s+exec|bunx)\s+(?:vitest|jest|mocha|ava|tsc|vue-tsc|eslint|stylelint|biome|ruff|pytest)\b/.test(segment) ||
    /^(?:npx|pnpm\s+exec|yarn\s+exec|bunx)\s+prettier\b.*\s--write\b/.test(segment) ||
    /^\.\/node_modules\/\.bin\/(?:vitest|jest|mocha|ava|tsc|vue-tsc|eslint|stylelint|biome)\b/.test(segment) ||
    /^node\s+--(?:test|check)\b/.test(segment) ||
    /^python3?\s+-m\s+(?:pytest|unittest|mypy|ruff)\b/.test(segment) ||
    /^(?:pytest|ruff\s+check|mypy|tox)\b/.test(segment) ||
    /^(?:go\s+test|go\s+vet|go\s+build)\b/.test(segment) ||
    /^(?:cargo\s+(?:test|check|clippy|build)|cargo\s+fmt\s+--check)\b/.test(segment) ||
    /^(?:mvn|gradle|\.\/gradlew)\s+(?:test|check|build|verify)\b/.test(segment) ||
    /^make\s+(?:test|check|lint|typecheck|build)\b/.test(segment) ||
    /^git\s+(?:checkout|switch|stash|reset|clean)\b/.test(segment)
  );
}

function extractFilePaths(input: Record<string, unknown>): string[] {
  const directPaths = ["file_path", "path", "notebook_path"]
    .map((key) => input[key])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const edits = Array.isArray(input.edits) ? input.edits : [];
  const editPaths = edits
    .map((edit) => (isRecord(edit) ? edit.file_path ?? edit.path : undefined))
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return [...new Set([...directPaths, ...editPaths])];
}

/**
 * 判断当前调用能否走"阶段预授权"快捷通道，跳过逐工具点 OK。
 *
 * 返回 false 表示快捷通道不适用——必须落到下面完整的安全检查路径上。
 * 这些"硬安全约束"对应 yaml 作者写的不可绕过的策略：
 *   - 危险 shell 命令（DANGEROUS_COMMANDS）
 *   - workflow.permissions.shell.approval_required 显式声明的 shell 审批
 *   - 项目外路径（写工具直接 blocked，只读工具走 pending_approval）
 *
 * 反之"软约束"——比如普通的 read_file 在项目内、edit_file 在项目内——
 * 可以由阶段预授权一次性覆盖，不必每个工具调用都点 OK。
 */
async function canSkipPerToolApproval(
  session: AgentSession,
  workflow: WorkflowTemplate,
  toolName: string,
  input: Record<string, unknown>
): Promise<boolean> {
  if (toolName === "Bash") {
    const command = String(input.command ?? "");
    if (DANGEROUS_COMMANDS.some((p) => command.toLowerCase().includes(p))) return false;
    if (requiresShellApproval(workflow) && !isAutonomousSafeShellCommand(command)) return false;
    return true;
  }
  for (const filePath of extractFilePaths(input)) {
    const { inside, realTarget } = await checkPathInsideProject(session.project_path, filePath);
    if (inside) continue;
    if (!isReadOnlyFileTool(toolName)) return false; // 写工具：项目外路径必须硬阻断
    const approvedExternal = session.approved_external_paths ?? [];
    if (!isApprovedExternalPath(realTarget, approvedExternal)) return false; // 只读但未被加白名单：走 pending_approval
  }
  // 写工具落入项目内仍然可能需要逐文件审批——交给下面的 isWriteTool 分支处理：
  // 如果阶段没声明 edit_file 我们前面就不会走到这里；如果声明了，意味着 yaml 作者
  // 已经接受"这个阶段可以改文件"，不再每个 Edit 单独审批。
  return true;
}

function isWriteTool(toolName: string): boolean {
  return toolName === "Edit" || toolName === "MultiEdit" || toolName === "Write" || toolName === "NotebookEdit";
}

const READ_ONLY_FILE_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead"]);

function isReadOnlyFileTool(toolName: string): boolean {
  return READ_ONLY_FILE_TOOLS.has(toolName);
}

function isApprovedExternalPath(realTarget: string, approvedExternalPaths: string[]): boolean {
  return approvedExternalPaths.some((approvedPath) => {
    const relative = path.relative(approvedPath, realTarget);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  });
}

function sameToolCall(toolCall: ToolCallRecord, toolName: string, input: Record<string, unknown>): boolean {
  return toolCall.tool === toolName && JSON.stringify(toolCall.input) === JSON.stringify(input);
}

function findExistingToolCall(
  session: AgentSession,
  toolName: string,
  input: Record<string, unknown>,
  toolUseId: string
): ToolCallRecord | undefined {
  return (
    session.tool_calls.find((toolCall) => toolCall.id === toolUseId && sameToolCall(toolCall, toolName, input)) ??
    session.tool_calls.find((toolCall) => toolCall.status === "approved" && sameToolCall(toolCall, toolName, input)) ??
    session.tool_calls.find((toolCall) => toolCall.status === "pending_approval" && sameToolCall(toolCall, toolName, input))
  );
}

function recordFileChangesForTool(
  session: AgentSession,
  toolName: string,
  input: Record<string, unknown>,
  approved: boolean,
  createdAt: string
): void {
  if (!isWriteTool(toolName)) {
    return;
  }
  for (const filePath of extractFilePaths(input)) {
    const operation = toolName === "Write" ? "create" : "update";
    const existing = session.file_changes.find(
      (change) => change.path === filePath && change.operation === operation && change.approved === false
    );
    if (existing) {
      existing.approved = approved;
      if (!existing.stage_id) existing.stage_id = session.current_stage;
      continue;
    }
    session.file_changes.push({
      path: filePath,
      operation,
      approved,
      stage_id: session.current_stage,
      created_at: createdAt
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * 当一个只读工具调用从 approved 转为 completed 时，把它涉及的项目外路径
 * 记录到 session.approved_external_paths，使同 session 内的后续 Read 免再次审批。
 * 写工具不会走到这里（它们的项目外路径在主流程里已被硬阻断）。
 */
async function rememberApprovedExternalReads(
  session: AgentSession,
  toolName: string,
  input: Record<string, unknown>
): Promise<void> {
  if (!isReadOnlyFileTool(toolName)) return;
  const paths = extractFilePaths(input);
  if (paths.length === 0) return;
  const approved = new Set(session.approved_external_paths ?? []);
  for (const filePath of paths) {
    try {
      const { inside, realTarget } = await checkPathInsideProject(session.project_path, filePath);
      if (inside) continue;
      approved.add(realTarget);
    } catch {
      // 路径无法解析（消失等）：保守不记录
    }
  }
  if (approved.size > 0) {
    session.approved_external_paths = [...approved];
  }
}

async function resolveExistingPathOrParent(targetPath: string): Promise<string> {
  try {
    return await fs.realpath(targetPath);
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }

  const parent = path.dirname(targetPath);
  return fs.realpath(parent);
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

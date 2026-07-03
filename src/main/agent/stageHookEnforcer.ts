import path from "node:path";
import type {
  AgentSession,
  PreToolUseHookRule,
  ToolCallRecord,
  WorkflowStage
} from "../../shared/types.js";

/**
 * 阶段级工序闸门评估器。
 *
 * 与 `approveOrDenyToolUse`（策略层 / 能不能做）解耦：本评估器只回答"按不按顺序做"。
 * 仅当 stage.hooks?.pre_tool_use 显式声明时才生效；缺省即透传，对既有 workflow 零感知。
 *
 * 数据源完全依赖 session 的既有不变量：
 * - 已成功的工具调用以 status=approved/completed 留在 session.tool_calls（projectPolicy 维护）
 * - ask_human 不入 tool_calls，但会落到 session.pending_human_questions（runner 维护）
 *
 * 评估器自身**无副作用**：只读，无网络/IO。
 */
export type HookDecision = { allow: true } | { allow: false; message: string };

export function evaluateHook(
  stage: WorkflowStage,
  session: AgentSession,
  toolName: string,
  toolInput: Record<string, unknown>
): HookDecision {
  const rules = stage.hooks?.pre_tool_use;
  if (!rules || rules.length === 0) {
    return { allow: true };
  }

  for (const rule of rules) {
    if (!matches(rule, toolName, toolInput)) continue;
    const missing = checkRequire(rule, session, toolInput, stage.id);
    if (missing) {
      return { allow: false, message: `${rule.on_fail}（缺：${missing}）` };
    }
  }
  return { allow: true };
}

function matches(rule: PreToolUseHookRule, toolName: string, toolInput: Record<string, unknown>): boolean {
  const targetTool = rule.when.tool;
  if (targetTool) {
    const list = Array.isArray(targetTool) ? targetTool : [targetTool];
    if (!list.includes(toolName)) return false;
  }
  const contains = rule.when.command_contains;
  if (contains && contains.length > 0) {
    if (toolName !== "Bash") return false;
    const cmd = String((toolInput as { command?: unknown }).command ?? "").toLowerCase();
    const hit = contains.some((needle) => cmd.includes(needle.toLowerCase()));
    if (!hit) return false;
  }
  return true;
}

function checkRequire(
  rule: PreToolUseHookRule,
  session: AgentSession,
  toolInput: Record<string, unknown>,
  stageId: string
): string | null {
  const { same_file_reads_min, shell_must_have_run, ask_human_consent } = rule.require;

  if (same_file_reads_min !== undefined) {
    const targets = extractTargetPaths(toolInput);
    // 只要有一个目标文件读够次数即可放行整批；若没有任何目标路径则规则不适用
    if (targets.length > 0) {
      const allCovered = targets.every(
        (target) => countReadHits(session.tool_calls, target, session.project_path) >= same_file_reads_min
      );
      if (!allCovered) {
        return `目标文件 Read/Grep 次数不足 ${same_file_reads_min}`;
      }
    }
  }

  if (shell_must_have_run && shell_must_have_run.length > 0) {
    const missing = shell_must_have_run.filter((needle) => !hasShellRun(session.tool_calls, needle));
    if (missing.length > 0) {
      return `本会话尚未执行：${missing.join(" / ")}`;
    }
  }

  if (ask_human_consent === true) {
    const asked = (session.pending_human_questions ?? []).some((q) => q.stage_id === stageId);
    if (!asked) {
      return "本阶段尚未通过 ask_human 取得用户确认";
    }
  }

  return null;
}

/**
 * 从工具 input 抽取目标文件路径。覆盖 Edit/Write/MultiEdit/Read/Grep/Glob 等常用工具的字段形状。
 * 路径以 basename + 末段目录归一化，因为 hook 计数同文件读取时不必区分相对/绝对路径表达。
 */
function extractTargetPaths(input: Record<string, unknown>): string[] {
  const direct = ["file_path", "path", "notebook_path"]
    .map((k) => input[k])
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  const edits = Array.isArray(input.edits) ? input.edits : [];
  const editPaths = edits
    .map((edit) => {
      if (edit && typeof edit === "object" && !Array.isArray(edit)) {
        const fp = (edit as Record<string, unknown>).file_path ?? (edit as Record<string, unknown>).path;
        return typeof fp === "string" ? fp : undefined;
      }
      return undefined;
    })
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  return Array.from(new Set([...direct, ...editPaths]));
}

const READ_LIKE_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead"]);

/**
 * 统计 target 文件被 Read/Grep/Glob/LS 等读取类工具命中的次数。
 * 供 pre_tool_use 闸门（"改文件前先读够次数"）与 post_output_checks（"本阶段真看过目标"）共用。
 *
 * 传入的 toolCalls 应已按需切片：pre_tool_use 传 session 全量（累计准备度），
 * post_output_checks 传本阶段切片（验证本轮真发生）。语义由调用方决定，本函数只数命中。
 */
export function countReadHits(toolCalls: ToolCallRecord[], target: string, projectPath: string): number {
  const targetKey = normalizePath(target, projectPath);
  let count = 0;
  for (const call of toolCalls) {
    if (!READ_LIKE_TOOLS.has(call.tool)) continue;
    if (call.status !== "approved" && call.status !== "completed") continue;
    if (!isRecord(call.input)) continue;
    const paths = extractTargetPaths(call.input);
    // Grep/Glob 没有 file_path 时，命中 pattern 含目标 basename 也算（防漏）
    if (paths.length === 0 && (call.tool === "Grep" || call.tool === "Glob")) {
      const needle = path.basename(targetKey);
      const pattern = String((call.input as Record<string, unknown>).pattern ?? "");
      if (needle && pattern.toLowerCase().includes(needle.toLowerCase())) count += 1;
      continue;
    }
    if (paths.some((p) => normalizePath(p, projectPath) === targetKey)) {
      count += 1;
    }
  }
  return count;
}

export function hasShellRun(toolCalls: ToolCallRecord[], needle: string): boolean {
  const lower = needle.toLowerCase();
  return toolCalls.some((call) => {
    if (call.tool !== "Bash") return false;
    if (call.status !== "approved" && call.status !== "completed") return false;
    if (!isRecord(call.input)) return false;
    const cmd = String((call.input as Record<string, unknown>).command ?? "").toLowerCase();
    return cmd.includes(lower);
  });
}

function normalizePath(p: string, projectPath: string): string {
  // 同一文件可能被以多种方式表达：绝对路径、项目相对、./相对、a/../b 等。
  // 规范化为"项目相对路径"，让不同表达指向同一文件时折叠为同一 key，
  // 同时避免 src/utils/a.ts 与 lib/utils/a.ts 因末段相同被误算。
  const cleanedTarget = collapseSegments(p.replace(/\\/g, "/"));
  if (!projectPath) return cleanedTarget;
  const cleanedProject = collapseSegments(projectPath.replace(/\\/g, "/"));
  if (cleanedTarget.startsWith(`${cleanedProject}/`)) {
    return cleanedTarget.slice(cleanedProject.length + 1);
  }
  // 路径已是相对的，或在项目外（项目外文件命中"目标"概念基本无意义，原样返回作为最后兜底）。
  return cleanedTarget;
}

function collapseSegments(p: string): string {
  const stack: string[] = [];
  let leadingSlash = p.startsWith("/");
  for (const seg of p.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") stack.pop();
      else if (!leadingSlash) stack.push("..");
      continue;
    }
    stack.push(seg);
  }
  return (leadingSlash ? "/" : "") + stack.join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

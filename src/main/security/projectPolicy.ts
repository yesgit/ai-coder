import fs from "node:fs/promises";
import path from "node:path";
import type { AgentSession, ToolCallRecord, WorkflowTemplate } from "../../shared/types.js";

const DANGEROUS_COMMANDS = [
  "rm -rf /",
  "sudo ",
  "mkfs",
  "diskutil erase",
  "git reset --hard",
  "git clean -fd"
];

export async function assertPathInsideProject(projectPath: string, targetPath: string): Promise<void> {
  const resolvedProject = await fs.realpath(path.resolve(projectPath));
  const resolvedTarget = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(projectPath, targetPath);
  const realTarget = await resolveExistingPathOrParent(resolvedTarget);
  const relative = path.relative(resolvedProject, realTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Blocked path outside project: ${targetPath}`);
  }
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

export function buildAllowedClaudeTools(workflow: WorkflowTemplate): string[] {
  const declared = new Set(workflow.stages.flatMap((stage) => stage.allowed_tools ?? []));
  const tools = new Set<string>(["Read", "Grep", "Glob", "LS"]);

  if (declared.has("edit_file")) {
    tools.add("Edit");
    tools.add("MultiEdit");
    tools.add("Write");
  }

  if (declared.has("shell")) {
    tools.add("Bash");
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
): Promise<{ allow: true; updatedInput: Record<string, unknown> } | { allow: false; message: string }> {
  const now = new Date().toISOString();
  const existingToolCall = session.tool_calls.find(
    (toolCall) => toolCall.id === toolUseId && sameToolCall(toolCall, toolName, input)
  );
  if (existingToolCall?.status === "approved") {
    existingToolCall.status = "completed";
    existingToolCall.resolved_at = now;
    return { allow: true, updatedInput: input };
  }
  if (existingToolCall?.status === "denied") {
    return { allow: false, message: "Tool call was denied by the user." };
  }
  if (existingToolCall?.status === "pending_approval") {
    return { allow: false, message: "Tool call is waiting for user approval." };
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
      if (requiresShellApproval(workflow)) {
        record("pending_approval");
        session.status = "waiting_approval";
        return { allow: false, message: "Shell command is waiting for user approval." };
      }
    }

    for (const filePath of extractFilePaths(input)) {
      await assertPathInsideProject(session.project_path, filePath);
    }

    if (isWriteTool(toolName)) {
      record("pending_approval");
      session.status = "waiting_approval";
      return { allow: false, message: "File write is waiting for user approval." };
    }

    record("approved");
    return { allow: true, updatedInput: input };
  } catch (error) {
    record("blocked");
    return { allow: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function extractFilePaths(input: Record<string, unknown>): string[] {
  return ["file_path", "path", "notebook_path"]
    .map((key) => input[key])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

function isWriteTool(toolName: string): boolean {
  return toolName === "Edit" || toolName === "MultiEdit" || toolName === "Write" || toolName === "NotebookEdit";
}

function sameToolCall(toolCall: ToolCallRecord, toolName: string, input: Record<string, unknown>): boolean {
  return toolCall.tool === toolName && JSON.stringify(toolCall.input) === JSON.stringify(input);
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

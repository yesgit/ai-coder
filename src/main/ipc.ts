import { randomUUID } from "node:crypto";
import { readdir, readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { join, resolve, relative, extname, basename, sep } from "node:path";
import { BrowserWindow, dialog, ipcMain } from "electron";
import type { OpenDialogOptions } from "electron";
import type { Attachment, ProjectOnboardingStatus, SessionOnboardingSnapshot, StartSessionInput } from "../shared/types.js";
import { ClaudeAgentRunner } from "./agent/claudeAgentRunner.js";
import { getClaudeRuntimeStatus } from "./agent/claudeRuntime.js";
import { OnboardingStore } from "./onboarding/onboardingStore.js";
import { AuthorizedProjects } from "./security/authorizedProjects.js";
import { SessionStore } from "./sessions/sessionStore.js";
import { WorkflowEngine } from "./workflows/workflowEngine.js";
import { WorkflowRegistry } from "./workflows/workflowRegistry.js";

export function registerIpcHandlers(registry: WorkflowRegistry, sessions: SessionStore, runner: ClaudeAgentRunner): void {
  const authorizedProjects = new AuthorizedProjects();
  const workflowEngine = new WorkflowEngine();
  const onboardingStore = new OnboardingStore();

  ipcMain.handle("project:select", async (event) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: OpenDialogOptions = { properties: ["openDirectory"] };
    const result = parentWindow ? await dialog.showOpenDialog(parentWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : authorizedProjects.authorize(result.filePaths[0]);
  });

  ipcMain.handle("agent:get-status", async () => getClaudeRuntimeStatus());

  ipcMain.handle("project:onboarding-status", async (_event, projectPath: string) => {
    const authorizedProjectPath = await authorizedProjects.assertAuthorized(projectPath);
    return onboardingStore.getStatus(authorizedProjectPath);
  });

  ipcMain.handle("project:confirm-onboarding", async (_event, projectPath: string) => {
    const authorizedProjectPath = await authorizedProjects.assertAuthorized(projectPath);
    return onboardingStore.confirm(authorizedProjectPath);
  });

  ipcMain.handle("workflows:list", async (_event, projectPath?: string) => {
    const authorizedProjectPath = projectPath ? await authorizedProjects.assertAuthorized(projectPath) : undefined;
    return registry.listWithIssues(authorizedProjectPath);
  });

  ipcMain.handle("sessions:list", async () => sessions.list());

  ipcMain.handle("sessions:get", async (_event, id: string) => {
    const session = await sessions.get(id);
    if (session) {
      await authorizedProjects.assertAuthorized(session.project_path);
    }
    return session;
  });

  ipcMain.handle("sessions:approve-stage", async (_event, sessionId: string, stageId: string) => {
    const session = await sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const projectPath = await authorizedProjects.assertAuthorized(session.project_path);
    const workflow = await registry.get(session.workflow_id, projectPath);
    if (!workflow) {
      throw new Error(`Workflow not found: ${session.workflow_id}`);
    }
    workflowEngine.approveStage(session, workflow, stageId);
    session.status = "running";
    await sessions.save(session);
    runSessionInBackground(runner, sessions, session, workflow);
    return session;
  });

  ipcMain.handle("sessions:authorize-stage", async (_event, sessionId: string, stageId: string) => {
    const session = await sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const projectPath = await authorizedProjects.assertAuthorized(session.project_path);
    // 查找待处理的阶段授权
    const approval = session.approvals.find(
      (item) => item.kind === "stage" && item.stage_id === stageId && item.status === "pending"
    );
    if (!approval) {
      throw new Error(`Pending stage authorization not found for stage: ${stageId}`);
    }
    approval.status = "approved";
    approval.resolved_at = new Date().toISOString();
    session.status = "running";
    await sessions.save(session);
    // 继续执行会话
    const workflow = await registry.get(session.workflow_id, projectPath);
    if (workflow) {
      runSessionInBackground(runner, sessions, session, workflow);
    }
    return session;
  });

  ipcMain.handle("sessions:approve-rework", async (_event, sessionId: string, requestId: string) => {
    const session = await sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const projectPath = await authorizedProjects.assertAuthorized(session.project_path);
    const workflow = await registry.get(session.workflow_id, projectPath);
    if (!workflow) {
      throw new Error(`Workflow not found: ${session.workflow_id}`);
    }
    workflowEngine.approveRework(session, workflow, requestId);
    session.status = "running";
    await sessions.save(session);
    runSessionInBackground(runner, sessions, session, workflow);
    return session;
  });

  ipcMain.handle("sessions:approve-tool-call", async (_event, sessionId: string, toolCallId: string) => {
    const session = await sessions.approveToolCall(sessionId, toolCallId);
    await authorizedProjects.assertAuthorized(session.project_path);
    return session;
  });

  ipcMain.handle("sessions:deny-tool-call", async (_event, sessionId: string, toolCallId: string) => {
    const session = await sessions.denyToolCall(sessionId, toolCallId);
    await authorizedProjects.assertAuthorized(session.project_path);
    return session;
  });

  ipcMain.handle("sessions:continue", async (_event, sessionId: string) => {
    const session = await sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const projectPath = await authorizedProjects.assertAuthorized(session.project_path);
    const workflow = await registry.get(session.workflow_id, projectPath);
    if (!workflow) {
      throw new Error(`Workflow not found: ${session.workflow_id}`);
    }
    workflowEngine.ensureState(session, workflow);
    session.status = "running";
    await sessions.save(session);
    runSessionInBackground(runner, sessions, session, workflow);
    return session;
  });

  ipcMain.handle("sessions:resume", async (_event, sessionId: string) => {
    const session = await sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.status !== "failed" && session.status !== "blocked" && session.status !== "interrupted") {
      throw new Error(`Session is not resumable: ${session.status}`);
    }
    const projectPath = await authorizedProjects.assertAuthorized(session.project_path);
    const workflow = await registry.get(session.workflow_id, projectPath);
    if (!workflow) {
      throw new Error(`Workflow not found: ${session.workflow_id}`);
    }
    workflowEngine.resumeFromFailedStage(session, workflow);
    await sessions.save(session);
    runSessionInBackground(runner, sessions, session, workflow);
    return session;
  });

  ipcMain.handle("sessions:start", async (_event, input: StartSessionInput) => {
    if (!input.projectPath || !input.workflowId || !input.taskPrompt.trim()) {
      throw new Error("projectPath, workflowId, and taskPrompt are required");
    }
    const projectPath = await authorizedProjects.assertAuthorized(input.projectPath);
    const workflow = await registry.get(input.workflowId, projectPath);
    if (!workflow) {
      throw new Error(`Workflow not found: ${input.workflowId}`);
    }
    const onboardingStatus = await onboardingStore.getStatus(projectPath);
    enforceOnboardingAdmission(workflow.id, onboardingStatus, Boolean(input.onboardingOverride));
    // 处理附件：校验 + 图片保存到磁盘，转为文件引用
    let processedAttachments = input.attachments;
    if (input.attachments?.length) {
      const validMediaTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
      for (const att of input.attachments) {
        if (att.type === "image" && !validMediaTypes.has(att.media_type)) {
          throw new Error(`不支持的图片类型: ${att.media_type}`);
        }
      }
      if (input.attachments.some((a) => a.type === "image")) {
        processedAttachments = await saveImageAttachments(input.attachments, projectPath);
      }
    }
    const session = await sessions.create(
      projectPath,
      workflow,
      input.taskPrompt.trim(),
      buildOnboardingSnapshot(onboardingStatus, Boolean(input.onboardingOverride)),
      processedAttachments
    );
    session.status = "running";
    await sessions.save(session);
    runSessionInBackground(runner, sessions, session, workflow);
    return { session };
  });

  ipcMain.handle("project:list-files", async (_event, projectPath: string, query?: string) => {
    const authorizedProjectPath = await authorizedProjects.assertAuthorized(projectPath);
    const ignoreDirs = new Set(["node_modules", ".git", "dist", ".ai-coder", "__pycache__", ".next", ".nuxt", "build", "out"]);
    const ignoreExts = new Set([".pyc", ".map", ".lock"]);
    const MAX_RESULTS = 50;
    const results: string[] = [];
    try {
      const entries = await readdir(authorizedProjectPath, { recursive: true });
      for (const entry of entries) {
        if (typeof entry !== "string") continue;
        const parts = entry.split(/[/\\]/);
        if (parts.some((p) => ignoreDirs.has(p) || p.startsWith("."))) continue;
        if (ignoreExts.has(extname(entry))) continue;
        if (query && !basename(entry).toLowerCase().includes(query.toLowerCase())) continue;
        results.push(entry);
        if (results.length >= MAX_RESULTS) break;
      }
    } catch {
      // 目录不可读时返回空列表
    }
    return results;
  });

  ipcMain.handle("project:read-file", async (_event, projectPath: string, filePath: string) => {
    const authorizedProjectPath = await authorizedProjects.assertAuthorized(projectPath);
    const absolutePath = resolve(authorizedProjectPath, filePath);
    // 路径遍历防护：先检查 resolve 后的路径
    if (!absolutePath.startsWith(resolve(authorizedProjectPath) + sep) && absolutePath !== resolve(authorizedProjectPath)) {
      throw new Error("文件路径超出项目目录范围");
    }
    // 使用 stat 获取文件大小，避免读取超大文件
    const fileStat = await stat(absolutePath);
    const MAX_FILE_SIZE = 500 * 1024; // 500KB
    if (fileStat.size > MAX_FILE_SIZE) {
      throw new Error(`文件过大（${Math.round(fileStat.size / 1024)}KB），上限 500KB`);
    }
    const content = await readFile(absolutePath, "utf-8");
    return content;
  });

  ipcMain.handle("sessions:send-message", async (_event, sessionId: string, message: string, attachments?: Attachment[]) => {
    const session = await sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const projectPath = await authorizedProjects.assertAuthorized(session.project_path);
    const workflow = await registry.get(session.workflow_id, projectPath);
    if (!workflow) {
      throw new Error(`Workflow not found: ${session.workflow_id}`);
    }
    // 处理附件：校验 + 图片保存到磁盘，转为文件引用
    let processedAttachments = attachments;
    if (attachments?.length) {
      const validMediaTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
      for (const att of attachments) {
        if (att.type === "image" && !validMediaTypes.has(att.media_type)) {
          throw new Error(`不支持的图片类型: ${att.media_type}`);
        }
      }
      if (attachments.some((a) => a.type === "image")) {
        processedAttachments = await saveImageAttachments(attachments, session.project_path);
      }
    }
    // 添加用户消息到会话
    session.messages.push({
      role: "user",
      content: message.trim(),
      created_at: new Date().toISOString(),
      attachments: processedAttachments
    });
    // 将会话状态改为 running，触发新一轮执行
    session.status = "running";
    await sessions.save(session);
    runSessionInBackground(runner, sessions, session, workflow);
    return session;
  });
}

function runSessionInBackground(
  runner: ClaudeAgentRunner,
  sessions: SessionStore,
  session: Awaited<ReturnType<SessionStore["create"]>>,
  workflow: NonNullable<Awaited<ReturnType<WorkflowRegistry["get"]>>>
): void {
  void runner
    .run({
      session,
      workflow,
      onProgress: async (updated) => {
        await sessions.save(updated);
      }
    })
    .then((updated) => sessions.save(updated))
    .catch(async (error) => {
      session.status = "failed";
      session.error = error instanceof Error ? error.message : String(error);
      await sessions.save(session);
    });
}

function enforceOnboardingAdmission(
  workflowId: string,
  onboardingStatus: ProjectOnboardingStatus,
  onboardingOverride: boolean
): void {
  if (workflowId === "project-onboarding") {
    return;
  }
  if (onboardingStatus.status === "confirmed") {
    return;
  }
  if (onboardingOverride) {
    return;
  }
  throw new Error("Project onboarding must be confirmed before running development workflows.");
}

function buildOnboardingSnapshot(
  onboardingStatus: ProjectOnboardingStatus,
  onboardingOverride: boolean
): SessionOnboardingSnapshot {
  return {
    status: onboardingStatus.status,
    claude_md_hash: onboardingStatus.claude_md_hash,
    override: onboardingOverride,
    checked_at: new Date().toISOString()
  };
}

async function saveImageAttachments(attachments: Attachment[], projectPath: string): Promise<Attachment[]> {
  const uploadsDir = join(projectPath, ".ai-coder", "uploads");
  await mkdir(uploadsDir, { recursive: true });
  const result: Attachment[] = [];
  for (const att of attachments) {
    if (att.type === "image") {
      const id = randomUUID();
      const ext = att.media_type.split("/")[1] || "png";
      const fileName = `${id}.${ext}`;
      const filePath = join(uploadsDir, fileName);
      const buffer = Buffer.from(att.data_base64, "base64");
      await writeFile(filePath, buffer);
      result.push({
        type: "file_ref",
        path: relative(projectPath, filePath),
        display_name: att.display_name
      });
    } else {
      result.push(att);
    }
  }
  return result;
}

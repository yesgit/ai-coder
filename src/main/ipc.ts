import { randomUUID } from "node:crypto";
import { readdir, readFile, mkdir, writeFile, stat, realpath, unlink } from "node:fs/promises";
import { join, resolve, relative, extname, basename, sep } from "node:path";
import { pdfToImages } from "./pdfToImages.js";
import { BrowserWindow, dialog, ipcMain } from "electron";
import type { OpenDialogOptions } from "electron";
import type { AgentSession, Attachment, ProjectOnboardingStatus, ResolveWorkflowInput, SessionOnboardingSnapshot, SessionRoutingSnapshot, StartSessionInput } from "../shared/types.js";
import { ClaudeAgentRunner } from "./agent/claudeAgentRunner.js";
import { getClaudeRuntimeStatus } from "./agent/claudeRuntime.js";
import { OnboardingStore } from "./onboarding/onboardingStore.js";
import { AuthorizedProjects } from "./security/authorizedProjects.js";
import { SessionStore } from "./sessions/sessionStore.js";
import { WorkflowEngine } from "./workflows/workflowEngine.js";
import { WorkflowRegistry } from "./workflows/workflowRegistry.js";
import { WorkflowRouter } from "./workflows/workflowRouter.js";
import { PtyManager } from "./ptyManager.js";

export function registerIpcHandlers(registry: WorkflowRegistry, sessions: SessionStore, runner: ClaudeAgentRunner): void {
  const authorizedProjects = new AuthorizedProjects();
  const workflowEngine = new WorkflowEngine();
  const onboardingStore = new OnboardingStore();
  const workflowRouter = new WorkflowRouter();
  const ptyManager = new PtyManager();
  const queuedUserMessages = new Map<string, AgentSession["messages"]>();

  // 应用启动时，从会话历史中恢复已授权的项目路径
  // 这样加载历史会话时不需要重新授权，除非项目路径已变化
  void (async () => {
    const allSessions = await sessions.list();
    const uniqueProjectPaths = new Set(allSessions.map(s => s.project_path));
    for (const projectPath of uniqueProjectPaths) {
      try {
        await authorizedProjects.authorize(projectPath);
      } catch {
        // 项目路径可能已不存在，跳过
      }
    }
  })();

  ipcMain.handle("project:select", async (event) => {
    const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options: OpenDialogOptions = { properties: ["openDirectory"] };
    const result = parentWindow ? await dialog.showOpenDialog(parentWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : authorizedProjects.authorize(result.filePaths[0]);
  });

  ipcMain.handle("project:authorize-session-project", async (event, projectPath: string) => {
    const knownProject = (await sessions.list()).some((session) => session.project_path === projectPath);
    if (!knownProject) {
      throw new Error(`Project is not referenced by session history: ${projectPath}`);
    }
    try {
      return await authorizedProjects.assertAuthorized(projectPath);
    } catch {
      const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const options: OpenDialogOptions = {
        properties: ["openDirectory"],
        defaultPath: projectPath,
        title: "重新授权历史项目",
        buttonLabel: "授权项目"
      };
      const result = parentWindow ? await dialog.showOpenDialog(parentWindow, options) : await dialog.showOpenDialog(options);
      if (result.canceled || !result.filePaths[0]) {
        throw new Error("Project authorization was cancelled.");
      }
      return authorizedProjects.authorizeMatching(projectPath, result.filePaths[0]);
    }
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

  ipcMain.handle("workflows:resolve", async (_event, input: ResolveWorkflowInput) => {
    if (!input?.projectPath || !input.taskPrompt?.trim()) {
      throw new Error("projectPath and taskPrompt are required");
    }
    const projectPath = await authorizedProjects.assertAuthorized(input.projectPath);
    const workflows = await registry.list(projectPath);
    return workflowRouter.resolve(input.taskPrompt.trim(), workflows, projectPath);
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
    runSessionInBackground(runner, sessions, session, workflow, queuedUserMessages);
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
    runSessionInBackground(runner, sessions, session, workflow, queuedUserMessages);
    return session;
  });

  ipcMain.handle("sessions:approve-tool-call", async (_event, sessionId: string, toolCallId: string) => {
    const session = await sessions.approveToolCall(sessionId, toolCallId);
    await authorizedProjects.assertAuthorized(session.project_path);
    if (runner.resolveToolApproval(sessionId, toolCallId, "approved")) {
      return session;
    }
    // 兼容旧的已中断会话：没有正在等待的 runner 时，审批后才重启执行。
    if (session.status === "running") {
      const workflow = await registry.get(session.workflow_id, session.project_path);
      if (workflow) {
        runSessionInBackground(runner, sessions, session, workflow, queuedUserMessages);
      }
    }
    return session;
  });

  ipcMain.handle("sessions:deny-tool-call", async (_event, sessionId: string, toolCallId: string) => {
    const session = await sessions.denyToolCall(sessionId, toolCallId);
    await authorizedProjects.assertAuthorized(session.project_path);
    runner.resolveToolApproval(sessionId, toolCallId, "denied");
    return session;
  });

  ipcMain.handle("sessions:toggle-auto-approve", async (_event, sessionId: string) => {
    const session = await sessions.toggleAutoApprove(sessionId);
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
    runSessionInBackground(runner, sessions, session, workflow, queuedUserMessages);
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
    runSessionInBackground(runner, sessions, session, workflow, queuedUserMessages);
    return session;
  });

  ipcMain.handle("sessions:abort", async (_event, sessionId: string) => {
    const session = await sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await authorizedProjects.assertAuthorized(session.project_path);
    if (session.status !== "running" && session.status !== "waiting_approval") {
      throw new Error(`Session is not running: ${session.status}`);
    }
    const aborted = runner.abort(sessionId);
    // 取消所有待回答的人类问题，防止 abort 后用户提交答案重新激活
    const now = new Date().toISOString();
    for (const q of session.pending_human_questions ?? []) {
      if (q.status === "pending") {
        q.status = "cancelled";
        q.resolved_at = now;
      }
    }
    if (!aborted) {
      session.status = "interrupted";
    }
    await sessions.save(session);
    const refreshed = await sessions.get(sessionId);
    return refreshed ?? session;
  });

  ipcMain.handle("sessions:restart", async (_event, sessionId: string, options?: { includeProjectProfile?: boolean }) => {
    const session = await sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const projectPath = await authorizedProjects.assertAuthorized(session.project_path);
    const workflow = await registry.get(session.workflow_id, projectPath);
    if (!workflow) {
      throw new Error(`Workflow not found: ${session.workflow_id}`);
    }
    // 取消所有待回答的人类问题
    const now = new Date().toISOString();
    for (const q of session.pending_human_questions ?? []) {
      if (q.status === "pending") {
        q.status = "cancelled";
        q.resolved_at = now;
      }
    }
    // 取消所有待审批的工具调用
    for (const t of session.tool_calls ?? []) {
      if (t.status === "pending_approval") {
        t.status = "cancelled";
        t.resolved_at = now;
      }
    }
    // 重新开始任务
    workflowEngine.restartFromBeginning(session, workflow, resolveStartStageId(workflow, options?.includeProjectProfile));
    if (session.onboarding) {
      session.onboarding.project_profile_enabled = options?.includeProjectProfile !== false;
    }
    await sessions.save(session);
    runSessionInBackground(runner, sessions, session, workflow, queuedUserMessages);
    return session;
  });

  ipcMain.handle("sessions:reset-context", async (_event, sessionId: string, options?: { includeProjectProfile?: boolean }) => {
    const session = await sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const projectPath = await authorizedProjects.assertAuthorized(session.project_path);
    const workflow = await registry.get(session.workflow_id, projectPath);
    if (!workflow) {
      throw new Error(`Workflow not found: ${session.workflow_id}`);
    }
    runner.abort(sessionId);
    workflowEngine.resetSessionContext(session, workflow, resolveStartStageId(workflow, options?.includeProjectProfile));
    if (session.onboarding) {
      session.onboarding.project_profile_enabled = options?.includeProjectProfile !== false;
    }
    await sessions.save(session);
    queuedUserMessages.delete(session.id);
    runSessionInBackground(runner, sessions, session, workflow, queuedUserMessages);
    return session;
  });

  ipcMain.handle("sessions:answer-human-question", async (_event, sessionId: string, questionId: string, answer: string | string[]) => {
    const session = await sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const projectPath = await authorizedProjects.assertAuthorized(session.project_path);
    const workflow = await registry.get(session.workflow_id, projectPath);
    if (!workflow) {
      throw new Error(`Workflow not found: ${session.workflow_id}`);
    }
    // 会话必须处于等待审批状态才能回答问题
    if (session.status !== "waiting_approval") {
      throw new Error(`Session is not waiting for input: ${session.status}`);
    }
    const question = (session.pending_human_questions ?? []).find(
      (q) => q.id === questionId && q.status === "pending"
    );
    if (!question) {
      throw new Error(`Pending human question not found: ${questionId}`);
    }
    // 校验答案与类型匹配 + 选项合法性
    // 注意：UI 允许用户在单选/多选中选择"其他"并输入自定义文本，提交时该文本会替换虚拟值，
    // 因此这里只能要求每一项是非空字符串且长度合法，不能强制命中 options[].value。
    const MAX_ANSWER_LEN = 2000;
    if (question.question_type === "multi") {
      if (!Array.isArray(answer)) throw new Error("多选问题需要数组答案");
      if (answer.length === 0) throw new Error("多选问题需要至少一个答案");
      if (!answer.every((v) => typeof v === "string" && v.length > 0 && v.length <= MAX_ANSWER_LEN)) {
        throw new Error("多选答案元素必须为非空字符串且长度合法");
      }
    } else if (question.question_type === "single") {
      if (typeof answer !== "string") throw new Error("单选问题需要字符串答案");
      if (answer.length === 0) throw new Error("单选问题需要非空答案");
      if (answer.length > MAX_ANSWER_LEN) throw new Error(`回答过长，上限 ${MAX_ANSWER_LEN} 字符`);
    } else {
      if (typeof answer !== "string") throw new Error("文本问题需要字符串答案");
      if (answer.length > MAX_ANSWER_LEN) throw new Error(`回答过长，上限 ${MAX_ANSWER_LEN} 字符`);
    }
    question.status = "answered";
    question.answer = answer;
    question.resolved_at = new Date().toISOString();

    // 所有 pending 问题已答完 + 没有其他待审批 → 恢复运行
    const stillPendingQuestion = (session.pending_human_questions ?? []).some((q) => q.status === "pending");
    const hasPendingToolApproval = session.tool_calls.some((t) => t.status === "pending_approval");
    const hasPendingStageApproval = session.approvals.some((a) => a.kind === "stage" && a.status === "pending");
    if (!stillPendingQuestion && !hasPendingToolApproval && !hasPendingStageApproval) {
      session.status = "running";
      await sessions.save(session);
      runSessionInBackground(runner, sessions, session, workflow, queuedUserMessages);
    } else {
      await sessions.save(session);
    }
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
    const includeProjectProfile = input.includeProjectProfile !== false;
    // 处理附件：校验 + 图片/文件保存到磁盘，转为文件引用
    let processedAttachments = input.attachments;
    if (input.attachments?.length) {
      const mediaTypePattern = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i;
      for (const att of input.attachments) {
        if ((att.type === "image" || att.type === "file_upload") && !mediaTypePattern.test(att.media_type)) {
          throw new Error(`不支持的媒体类型: ${att.media_type}`);
        }
      }
      if (input.attachments.some((a) => a.type === "image" || a.type === "file_upload")) {
        processedAttachments = await saveBinaryAttachments(input.attachments, projectPath);
      }
    }
    const session = await sessions.create(
      projectPath,
      workflow,
      input.taskPrompt.trim(),
      buildOnboardingSnapshot(onboardingStatus, Boolean(input.onboardingOverride), includeProjectProfile),
      processedAttachments,
      normalizeRoutingSnapshot(input)
    );
    const startStageId = resolveStartStageId(workflow, includeProjectProfile);
    if (startStageId) {
      workflowEngine.restartFromBeginning(session, workflow, startStageId);
    }
    session.status = "running";
    await sessions.save(session);
    runSessionInBackground(runner, sessions, session, workflow, queuedUserMessages);
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
    const projectRoot = resolve(authorizedProjectPath);
    // 路径遍历防护：先做字符串前缀检查
    if (!absolutePath.startsWith(projectRoot + sep) && absolutePath !== projectRoot) {
      throw new Error("文件路径超出项目目录范围");
    }
    // 跟随符号链接后再次校验，防止项目内 symlink 指向项目外
    const realRoot = await realpath(projectRoot);
    const realPath = await realpath(absolutePath);
    if (!realPath.startsWith(realRoot + sep) && realPath !== realRoot) {
      throw new Error("文件路径超出项目目录范围（符号链接指向项目外）");
    }
    // 使用 stat 获取文件大小，避免读取超大文件
    const fileStat = await stat(realPath);
    const MAX_FILE_SIZE = 500 * 1024; // 500KB
    if (fileStat.size > MAX_FILE_SIZE) {
      throw new Error(`文件过大（${Math.round(fileStat.size / 1024)}KB），上限 500KB`);
    }
    const content = await readFile(realPath, "utf-8");
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
    if (session.status === "waiting_approval") {
      throw new Error("Session is waiting for approval or a required answer.");
    }
    // 处理附件：校验 + 图片保存到磁盘，转为文件引用
    let processedAttachments = attachments;
    if (attachments?.length) {
      const mediaTypePattern = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i;
      for (const att of attachments) {
        if ((att.type === "image" || att.type === "file_upload") && !mediaTypePattern.test(att.media_type)) {
          throw new Error(`不支持的媒体类型: ${att.media_type}`);
        }
      }
      if (attachments.some((a) => a.type === "image" || a.type === "file_upload")) {
        processedAttachments = await saveBinaryAttachments(attachments, session.project_path);
      }
    }
    const userMessage: AgentSession["messages"][number] = {
      role: "user",
      content: message.trim(),
      created_at: new Date().toISOString(),
      attachments: processedAttachments
    };
    session.messages.push(userMessage);
    if (session.status === "running") {
      const queued = queuedUserMessages.get(session.id) ?? [];
      queued.push(userMessage);
      queuedUserMessages.set(session.id, queued);
      session.progress_events ??= [];
      session.progress_events.push({
        id: randomUUID(),
        type: "status",
        message: "已收到用户消息，将在当前运行结束后继续处理。",
        visibility: "milestone",
        created_at: new Date().toISOString()
      });
      await sessions.save(session);
      return session;
    }
    // 将会话状态改为 running，触发新一轮执行
    if (!workflowEngine.getActiveStageRun(session)) {
      workflowEngine.startFollowUp(session, workflow, message.trim() || "Follow-up user message");
    } else {
      session.status = "running";
    }
    await sessions.save(session);
    runSessionInBackground(runner, sessions, session, workflow, queuedUserMessages);
    return session;
  });

  ipcMain.handle("sessions:delete", async (_event, sessionId: string) => {
    const session = await sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await authorizedProjects.assertAuthorized(session.project_path);
    await sessions.delete(sessionId);
    return { success: true, deletedSessionId: sessionId };
  });

  ipcMain.handle("sessions:set-pinned", async (_event, sessionId: string, pinned: boolean) => {
    const session = await sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    await authorizedProjects.assertAuthorized(session.project_path);
    return sessions.setPinned(sessionId, Boolean(pinned));
  });

  ipcMain.handle("sessions:set-archived", async (_event, sessionId: string, archived: boolean) => {
    const session = await sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    await authorizedProjects.assertAuthorized(session.project_path);
    return sessions.setArchived(sessionId, Boolean(archived));
  });

  // Terminal PTY handlers
  ipcMain.handle("terminal:start", async (_event, projectPath: string, cols: number, rows: number) => {
    const authorizedProjectPath = await authorizedProjects.assertAuthorized(projectPath);
    const terminalId = randomUUID();
    ptyManager.create(terminalId, authorizedProjectPath, cols, rows, (data: string) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("terminal:data", terminalId, data);
      }
    });
    return terminalId;
  });

  ipcMain.on("terminal:write", (_event, terminalId: string, data: string) => {
    ptyManager.write(terminalId, data);
  });

  ipcMain.on("terminal:resize", (_event, terminalId: string, cols: number, rows: number) => {
    ptyManager.resize(terminalId, cols, rows);
  });

  ipcMain.on("terminal:destroy", (_event, terminalId: string) => {
    ptyManager.destroy(terminalId);
  });
}

function runSessionInBackground(
  runner: ClaudeAgentRunner,
  sessions: SessionStore,
  session: Awaited<ReturnType<SessionStore["create"]>>,
  workflow: NonNullable<Awaited<ReturnType<WorkflowRegistry["get"]>>>,
  queuedUserMessages: Map<string, AgentSession["messages"]>
): void {
  void runner
    .run({
      session,
      workflow,
      onProgress: async (updated) => {
        await sessions.save(updated);
        broadcastSessionProgress(updated);
      }
    })
    .then(async (updated) => {
      const queued = queuedUserMessages.get(updated.id) ?? [];
      if (queued.length > 0) {
        queuedUserMessages.delete(updated.id);
        appendMissingMessages(updated, queued);
        updated.progress_events ??= [];
        updated.progress_events.push({
          id: randomUUID(),
          type: "status",
          message: `继续处理 ${queued.length} 条运行期间收到的用户消息。`,
          visibility: "milestone",
          created_at: new Date().toISOString()
        });
        if (updated.status !== "waiting_approval") {
          const workflowEngine = new WorkflowEngine();
          if (!workflowEngine.getActiveStageRun(updated)) {
            workflowEngine.startFollowUp(updated, workflow, queued.at(-1)?.content || "Follow-up user message");
          } else {
            updated.status = "running";
          }
        }
        await sessions.save(updated);
        broadcastSessionProgress(updated);
        if (updated.status === "running") {
          runSessionInBackground(runner, sessions, updated, workflow, queuedUserMessages);
        }
        return;
      }
      await sessions.save(updated);
      broadcastSessionProgress(updated);
    })
    .catch(async (error) => {
      const queued = queuedUserMessages.get(session.id) ?? [];
      if (queued.length > 0) {
        queuedUserMessages.delete(session.id);
        appendMissingMessages(session, queued);
      }
      session.status = "failed";
      session.error = error instanceof Error ? error.message : String(error);
      await sessions.save(session);
      broadcastSessionProgress(session);
    });
}

function appendMissingMessages(session: AgentSession, messages: AgentSession["messages"]): void {
  for (const message of messages) {
    const exists = session.messages.some(
      (item) =>
        item.role === message.role &&
        item.created_at === message.created_at &&
        item.content === message.content
    );
    if (!exists) {
      session.messages.push(message);
    }
  }
}

/**
 * 把会话进度推送给所有渲染窗口。后台 runner 脱离 IPC handler 上下文（拿不到 event.sender），
 * 故用 BrowserWindow.getAllWindows() 广播——单窗口 app 等价于直送，多窗口也正确。
 *
 * 渲染端收到后按 sessionId 匹配更新对应会话，避免依赖 3s 轮询才能看到"在跑"。
 * 推送整个 session 对象：onProgress 频率中等（每个 SDK 消息/工具决策/状态变化一次），
 * 渲染端直接更新对应 session 条目（React 自动 batch，timeline rebuild 开销可控）。
 * 若后续 session 体积变大或频率升高导致 IPC 压力，可改为增量 payload + 渲染端 debounce。
 */
function broadcastSessionProgress(session: AgentSession): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("session:progress", session);
  }
}

function normalizeRoutingSnapshot(input: StartSessionInput): SessionRoutingSnapshot {
  if (input.routing?.final_workflow_id === input.workflowId) {
    return {
      ...input.routing,
      candidates: input.routing.candidates.slice(0, 3),
      final_workflow_id: input.workflowId
    };
  }
  return {
    requested_mode: "manual",
    method: "manual",
    candidates: [],
    recommended_workflow_id: input.workflowId,
    final_workflow_id: input.workflowId,
    user_action: "none",
    reason: "用户手动指定工作流。"
  };
}

function enforceOnboardingAdmission(
  workflowId: string,
  onboardingStatus: ProjectOnboardingStatus,
  onboardingOverride: boolean
): void {
  void workflowId;
  void onboardingStatus;
  void onboardingOverride;
  return;
}

function buildOnboardingSnapshot(
  onboardingStatus: ProjectOnboardingStatus,
  onboardingOverride: boolean,
  includeProjectProfile = true
): SessionOnboardingSnapshot {
  return {
    status: onboardingStatus.status,
    claude_md_hash: onboardingStatus.claude_md_hash,
    override: onboardingOverride,
    project_profile_enabled: includeProjectProfile,
    checked_at: new Date().toISOString()
  };
}

function resolveStartStageId(workflow: NonNullable<Awaited<ReturnType<WorkflowRegistry["get"]>>>, includeProjectProfile = true): string | undefined {
  if (includeProjectProfile) return undefined;
  if (workflow.id !== "careful-coder") return undefined;
  return workflow.stages.find((stage) => stage.id === "understand")?.id;
}

async function saveBinaryAttachments(attachments: Attachment[], projectPath: string): Promise<Attachment[]> {
  const uploadsDir = join(projectPath, ".ai-coder", "uploads");
  await mkdir(uploadsDir, { recursive: true });
  const MAX_BINARY_BYTES = 30 * 1024 * 1024; // 30MB 单文件上限
  const result: Attachment[] = [];
  for (const att of attachments) {
    if (att.type === "image" || att.type === "file_upload") {
      const safeDisplayName = sanitizeDisplayName(att.display_name);
      const buffer = Buffer.from(att.data_base64, "base64");
      if (buffer.byteLength > MAX_BINARY_BYTES) {
        throw new Error(`附件过大（${Math.round(buffer.byteLength / 1024 / 1024)}MB），上限 ${MAX_BINARY_BYTES / 1024 / 1024}MB`);
      }

      // PDF 特殊处理：拆页渲染为 PNG，作为多条 file_ref 附件返回。
      // GLM/vLLM 后端不支持 Anthropic 的 document content block；image 块可以。
      // 模型用 Read 工具读取每页 PNG，SDK 会自动以 image block 透传给后端。
      if (att.type === "file_upload" && att.media_type === "application/pdf") {
        const id = randomUUID();
        const pdfFileName = `${id}.pdf`;
        const pdfPath = join(uploadsDir, pdfFileName);
        await writeFile(pdfPath, buffer);

        let pages;
        try {
          pages = await pdfToImages(buffer, { dpi: 150, maxPages: 50 });
        } catch (error) {
          // 渲染失败：上传整体失败。原 PDF 已落盘，需清理避免在 .ai-coder/uploads 留下垃圾文件。
          // 当前后端（GLM/vLLM）拿到 PDF 原文件也无法处理，给一条会失败的附件比
          // 直接报错更迷惑。
          // 清理失败不致命（用户已经看到 PDF 渲染失败），但写日志便于排查孤儿文件来源。
          await unlink(pdfPath).catch((cleanupError) => {
            console.error(`[uploads] 清理失败 PDF 未能删除: ${pdfPath}`, cleanupError);
          });
          throw new Error(
            `PDF 渲染失败 (${safeDisplayName}): ${error instanceof Error ? error.message : String(error)}`
          );
        }

        const pageDir = join(uploadsDir, id);
        await mkdir(pageDir, { recursive: true });
        const totalPages = pages.length;
        const pad = String(totalPages).length;
        for (const page of pages) {
          const pageName = `page-${String(page.page).padStart(pad, "0")}.png`;
          const pagePath = join(pageDir, pageName);
          await writeFile(pagePath, page.png);
          result.push({
            type: "file_ref",
            path: relative(projectPath, pagePath),
            display_name: `${safeDisplayName} · 第 ${page.page} 页 / 共 ${totalPages} 页`
          });
        }
        continue;
      }

      const id = randomUUID();
      const rawExt = att.media_type.split("/")[1]?.split("+")[0] || (att.type === "image" ? "png" : "bin");
      const ext = /^[a-z0-9]+$/i.test(rawExt) ? rawExt.toLowerCase() : (att.type === "image" ? "png" : "bin");
      const fileName = `${id}.${ext}`;
      const filePath = join(uploadsDir, fileName);
      await writeFile(filePath, buffer);
      result.push({
        type: "file_ref",
        path: relative(projectPath, filePath),
        display_name: safeDisplayName
      });
    } else {
      result.push(att);
    }
  }
  return result;
}

function sanitizeDisplayName(raw: string | undefined): string {
  if (!raw) return "untitled";
  // 剥离控制字符 + 限长，防止 prompt 注入
  const stripped = raw.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return (stripped.slice(0, 200) || "untitled");
}

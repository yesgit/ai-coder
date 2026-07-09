import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  AgentSession,
  AgentRuntimeStatus,
  ApprovalRecord,
  Attachment,
  HumanQuestion,
  ProjectOnboardingStatus,
  ReworkRequest,
  StageRun,
  ToolCallRecord,
  WorkflowTemplate
} from "../../shared/types.js";
import { buildSessionTimeline } from "./sessionTimeline.js";
import type { TimelineEvent } from "./sessionTimeline.js";
import { summarizeSessionTitle } from "../../shared/sessionTitle.js";
import { getVisibleSessions, groupSessionsByProject, resolveActiveSessionId } from "./sessionSelection.js";
import { buildWorkflowStageDisplays } from "./workflowStageStatus.js";
import {
  formatStageName,
  formatStatus,
  formatWorkflowDescription,
  formatWorkflowName
} from "./labels.js";
import "./styles.css";

// 单选/多选时 UI 自动追加的"其他"虚拟选项值——选中后提交前会被替换成用户输入的自定义文本，
// 因此前缀用一段不太可能被 agent 自然指定的字符串以避免与真实 options[].value 冲突。
const OTHER_OPTION_VALUE = "__ai_coder_other__";

export default function App() {
  const [projectPath, setProjectPath] = useState("");
  const [workflows, setWorkflows] = useState<WorkflowTemplate[]>([]);
  const [taskWorkflowId, setTaskWorkflowId] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [expandedProjectPaths, setExpandedProjectPaths] = useState<Set<string>>(() => new Set());
  const [showArchivedSessions, setShowArchivedSessions] = useState(false);
  const [openSessionMenuId, setOpenSessionMenuId] = useState<string | null>(null);
  const [taskPrompt, setTaskPrompt] = useState("");
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<AgentRuntimeStatus | null>(null);
  const [onboardingStatus, setOnboardingStatus] = useState<ProjectOnboardingStatus | null>(null);
  const [onboardingOverride, setOnboardingOverride] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [taskAttachments, setTaskAttachments] = useState<Attachment[]>([]);
  const [showFileMention, setShowFileMention] = useState(false);
  const [fileMentionQuery, setFileMentionQuery] = useState("");
  const [fileMentionResults, setFileMentionResults] = useState<string[]>([]);
  const [mentionTarget, setMentionTarget] = useState<"task" | "chat">("task");
  const [dragOverTarget, setDragOverTarget] = useState<"task" | "chat" | null>(null);
  const taskFileInputRef = useRef<HTMLInputElement>(null);
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, string | string[]>>({});
  // 单选/多选中选择"其他"时的自定义文本草稿，按 question id 存放
  const [questionOtherTexts, setQuestionOtherTexts] = useState<Record<string, string>>({});
  const [timelineLimit, setTimelineLimit] = useState(50); // 默认只显示最近 50 条事件

  // 切换 session 时清空草稿答案，避免不同 session 间的串味
  useEffect(() => {
    setQuestionAnswers({});
    setQuestionOtherTexts({});
  }, [activeSessionId]);

  // 可上传的非图片二进制文件 MIME 与扩展名（PDF、文档、表格等）
  const UPLOADABLE_MIME = new Set([
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/zip"
  ]);
  const UPLOADABLE_EXT = /\.(pdf|docx?|xlsx?|pptx?|zip|csv|txt|md|rtf)$/i;
  const MAX_UPLOAD_SIZE = 20 * 1024 * 1024; // 20MB

  function isUploadable(file: File): boolean {
    return UPLOADABLE_MIME.has(file.type) || UPLOADABLE_EXT.test(file.name);
  }

  function guessMediaType(file: File): string {
    if (file.type) return file.type;
    const ext = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
    if (ext === "pdf") return "application/pdf";
    if (ext === "txt" || ext === "md") return "text/plain";
    if (ext === "csv") return "text/csv";
    return "application/octet-stream";
  }

  function readFileAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        resolve(dataUrl.split(",")[1] ?? "");
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  const taskWorkflow = useMemo(
    () => workflows.find((workflow) => workflow.id === taskWorkflowId) ?? null,
    [taskWorkflowId, workflows]
  );
  const visibleSessions = useMemo(
    () =>
      projectPath
        ? getVisibleSessions(sessions, projectPath).filter((session) =>
            showArchivedSessions ? Boolean(session.archived_at) : !session.archived_at
          )
        : [],
    [projectPath, sessions, showArchivedSessions]
  );
  const sessionGroups = useMemo(
    () =>
      groupSessionsByProject(
        sessions.filter((session) => (showArchivedSessions ? Boolean(session.archived_at) : !session.archived_at)),
        projectPath
      ),
    [projectPath, sessions, showArchivedSessions]
  );
  const activeSession = useMemo(
    () => visibleSessions.find((session) => session.id === activeSessionId) ?? null,
    [activeSessionId, visibleSessions]
  );
  const activeWorkflow = useMemo(
    () => workflows.find((workflow) => workflow.id === activeSession?.workflow_id) ?? null,
    [activeSession?.workflow_id, workflows]
  );
  const runningVisibleSessionIds = useMemo(
    () =>
      visibleSessions
        .filter((session) => session.status === "running")
        .map((session) => session.id)
        .join(":"),
    [visibleSessions]
  );

  useEffect(() => {
    void refreshRuntimeStatus();
    void refreshWorkflows();
    void refreshSessions();
  }, []);

  useEffect(() => {
    if (!runningVisibleSessionIds) {
      return;
    }
    const interval = window.setInterval(() => {
      void refreshSessions(activeSessionId ?? undefined);
    }, 3000); // 3 秒轮询间隔，避免过于频繁
    return () => window.clearInterval(interval);
  }, [activeSessionId, runningVisibleSessionIds, showArchivedSessions]);

  // 订阅后台进度推送：main 在每次 runner 进度事件时广播整个 session，
  // 收到后直接更新 sessions 列表里对应条目（activeSession 是从 sessions 派生的 useMemo，
  // 会自动跟随）。避免依赖 3s 轮询才能看到"在跑"。轮询仍保留作兜底（冷启动/推送丢失）。
  useEffect(() => {
    const unsubscribe = window.aiCoder.onSessionProgress((updated: AgentSession) => {
      setSessions((prev) =>
        prev.some((s) => s.id === updated.id)
          ? prev.map((s) => (s.id === updated.id ? updated : s))
          : prev
      );
    });
    return unsubscribe;
  }, []);

  async function refreshRuntimeStatus() {
    setRuntimeStatus(await window.aiCoder.getAgentRuntimeStatus());
  }

  async function refreshWorkflows(nextProjectPath = projectPath, preferredWorkflowId = taskWorkflowId) {
    const result = await window.aiCoder.listWorkflows(nextProjectPath || undefined);
    const nextWorkflowId = result.workflows.some((workflow: WorkflowTemplate) => workflow.id === preferredWorkflowId)
      ? preferredWorkflowId
      : result.workflows[0]?.id ?? "";
    setWorkflows(result.workflows);
    setTaskWorkflowId(nextWorkflowId);
    return { ...result, selectedWorkflowId: nextWorkflowId };
  }

  async function refreshOnboardingStatus(nextProjectPath = projectPath) {
    if (!nextProjectPath) {
      setOnboardingStatus(null);
      return;
    }
    setOnboardingStatus(await window.aiCoder.getProjectOnboardingStatus(nextProjectPath));
  }

  async function refreshSessions(
    preferredSessionId?: string,
    options: { projectPath?: string; workflowId?: string; preferLatestForWorkflow?: boolean } = {}
  ) {
    const loaded: AgentSession[] = await window.aiCoder.listSessions();
    setSessions(loaded);
    const focusedProjectPath = options.projectPath || projectPath || loaded[0]?.project_path;
    if (focusedProjectPath) {
      setExpandedProjectPaths((current) => new Set([...current, focusedProjectPath]));
    }
    setActiveSessionId((current) => {
      const targetProjectPath = options.projectPath || projectPath;
      if (!targetProjectPath) return null;
      const selectableSessions = loaded.filter((session) =>
        showArchivedSessions ? Boolean(session.archived_at) : !session.archived_at
      );
      return resolveActiveSessionId(selectableSessions, {
        currentSessionId: current,
        preferredSessionId,
        projectPath: targetProjectPath,
        workflowId: options.workflowId,
        preferLatestForWorkflow: options.preferLatestForWorkflow
      });
    });
  }

  function upsertSession(session: AgentSession) {
    setSessions((current) => {
      const withoutSession = current.filter((item) => item.id !== session.id);
      return [session, ...withoutSession].sort((left, right) => right.created_at.localeCompare(left.created_at));
    });
    setActiveSessionId(session.id);
  }

  async function chooseProject() {
    setError("");
    setBusy(true);
    try {
      const selected = await window.aiCoder.selectProjectDirectory();
      if (selected) {
        setProjectPath(selected);
        setOnboardingOverride(false);
        setExpandedProjectPaths((current) => new Set([...current, selected]));
        await refreshWorkflows(selected);
        await refreshOnboardingStatus(selected);
        await refreshSessions(undefined, {
          projectPath: selected,
          preferLatestForWorkflow: true
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function selectSession(session: AgentSession) {
    if (session.project_path === projectPath) {
      setActiveSessionId(session.id);
      setTaskWorkflowId(session.workflow_id);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const authorizedPath = await window.aiCoder.authorizeSessionProject(session.project_path);
      setProjectPath(authorizedPath);
      setOnboardingOverride(false);
      setExpandedProjectPaths((current) => new Set([...current, authorizedPath]));
      await refreshWorkflows(authorizedPath);
      await refreshOnboardingStatus(authorizedPath);
      await refreshSessions(session.id, { projectPath: authorizedPath, preferLatestForWorkflow: false });
      setTaskWorkflowId(session.workflow_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function toggleProjectGroup(groupProjectPath: string) {
    setExpandedProjectPaths((current) => {
      const next = new Set(current);
      if (next.has(groupProjectPath)) next.delete(groupProjectPath);
      else next.add(groupProjectPath);
      return next;
    });
  }

  async function confirmOnboarding() {
    if (!projectPath) return;
    setBusy(true);
    setError("");
    try {
      setOnboardingStatus(await window.aiCoder.confirmProjectOnboarding(projectPath));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function startSession() {
    setError("");
    setBusy(true);
    try {
      const workflowId = taskWorkflowId || workflows[0]?.id;
      if (!workflowId) {
        throw new Error("未找到内置谨慎程序员工作流。");
      }
      await createSession(workflowId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitComposer() {
    if (composerSession) {
      if (!taskPrompt.trim() && taskAttachments.length === 0) return;
      await sendMessage(composerSession, taskPrompt.trim(), taskAttachments.length > 0 ? taskAttachments : undefined);
      setTaskPrompt("");
      setTaskAttachments([]);
      return;
    }
    await startSession();
  }

  async function createSession(workflowId: string) {
    const result = await window.aiCoder.startSession({
      projectPath,
      workflowId,
      taskPrompt,
      onboardingOverride,
      attachments: taskAttachments.length > 0 ? taskAttachments : undefined
    });
    upsertSession(result.session);
    setTaskPrompt("");
    setTaskAttachments([]);
    setTaskWorkflowId(result.session.workflow_id);
    await refreshSessions(result.session.id);
  }

  async function approvePendingStage(session: AgentSession) {
    const pending = session.approvals.find(
      (approval: ApprovalRecord) => approval.kind === "stage" && approval.status === "pending"
    );
    if (!pending) return;
    setBusy(true);
    setError("");
    try {
      const updated = await window.aiCoder.approveStage(session.id, pending.stage_id);
      upsertSession(updated);
      await refreshSessions(updated.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function approveReworkRequest(session: AgentSession, request: ReworkRequest) {
    setBusy(true);
    setError("");
    try {
      const updated = await window.aiCoder.approveRework(session.id, request.id);
      upsertSession(updated);
      await refreshSessions(updated.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function approveToolCall(session: AgentSession, toolCall: ToolCallRecord) {
    setBusy(true);
    setError("");
    try {
      const approved = await window.aiCoder.approveToolCall(session.id, toolCall.id);
      upsertSession(approved);
      await refreshSessions(approved.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function denyToolCall(session: AgentSession, toolCall: ToolCallRecord) {
    setBusy(true);
    setError("");
    try {
      const denied = await window.aiCoder.denyToolCall(session.id, toolCall.id);
      upsertSession(denied);
      await refreshSessions(denied.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function continueSession(session: AgentSession) {
    setBusy(true);
    setError("");
    try {
      const updated = await window.aiCoder.continueSession(session.id);
      upsertSession(updated);
      await refreshSessions(updated.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function resumeSession(session: AgentSession) {
    setBusy(true);
    setError("");
    try {
      const updated = await window.aiCoder.resumeSession(session.id);
      upsertSession(updated);
      await refreshSessions(updated.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function abortSession(session: AgentSession) {
    setBusy(true);
    setError("");
    try {
      const updated = await window.aiCoder.abortSession(session.id);
      upsertSession(updated);
      await refreshSessions(updated.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function restartSession(session: AgentSession) {
    setBusy(true);
    setError("");
    try {
      const updated = await window.aiCoder.restartSession(session.id);
      upsertSession(updated);
      await refreshSessions(updated.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function resetSessionContext(session: AgentSession) {
    setBusy(true);
    setError("");
    try {
      const updated = await window.aiCoder.resetSessionContext(session.id);
      upsertSession(updated);
      await refreshSessions(updated.id);
      setTimelineLimit(50);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function answerHumanQuestion(session: AgentSession, questionId: string, answer: string | string[]) {
    setBusy(true);
    setError("");
    try {
      const updated = await window.aiCoder.answerHumanQuestion(session.id, questionId, answer);
      upsertSession(updated);
      await refreshSessions(updated.id);
      setQuestionAnswers((prev) => {
        const next = { ...prev };
        delete next[questionId];
        return next;
      });
      setQuestionOtherTexts((prev) => {
        if (!(questionId in prev)) return prev;
        const next = { ...prev };
        delete next[questionId];
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function sendMessage(session: AgentSession, message: string, attachments?: Attachment[]) {
    setBusy(true);
    setError("");
    try {
      const updated = await window.aiCoder.sendMessage(session.id, message, attachments);
      upsertSession(updated);
      await refreshSessions(updated.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteSession(session: AgentSession) {
    setBusy(true);
    setError("");
    try {
      if (session.project_path !== projectPath) {
        await window.aiCoder.authorizeSessionProject(session.project_path);
      }
      await window.aiCoder.deleteSession(session.id);
      // 删除后刷新会话列表，如果删除的是当前会话，则清空选中状态
      setSessions((current) => current.filter((s) => s.id !== session.id));
      if (activeSessionId === session.id) {
        setActiveSessionId(null);
      }
      setOpenSessionMenuId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function updateSessionOrganization(session: AgentSession, action: "pin" | "archive") {
    setBusy(true);
    setError("");
    try {
      if (session.project_path !== projectPath) {
        await window.aiCoder.authorizeSessionProject(session.project_path);
      }
      const updated = action === "pin"
        ? await window.aiCoder.setSessionPinned(session.id, !session.pinned_at)
        : await window.aiCoder.setSessionArchived(session.id, !session.archived_at);
      setSessions((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      if (action === "archive" && !session.archived_at && activeSessionId === session.id) {
        setActiveSessionId(null);
      }
      setOpenSessionMenuId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // @文件提及搜索
  useEffect(() => {
    if (!showFileMention || !projectPath) return;
    const timer = setTimeout(() => {
      void window.aiCoder.listProjectFiles(projectPath, fileMentionQuery).then(setFileMentionResults);
    }, 200);
    return () => clearTimeout(timer);
  }, [showFileMention, fileMentionQuery, projectPath]);

  function handlePaste(e: React.ClipboardEvent, target: "task" | "chat") {
    const items = e.clipboardData.items;
    const imageItems: DataTransferItem[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        imageItems.push(items[i]);
      }
    }
    if (imageItems.length === 0) return;
    e.preventDefault();
    const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;
      if (file.size > MAX_IMAGE_SIZE) {
        setError(`图片 ${file.name} 过大（${Math.round(file.size / 1024)}KB），上限 5MB`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.split(",")[1];
        const mediaType = item.type || "image/png";
        setTaskAttachments((prev) => [
          ...prev,
          { type: "image", data_base64: base64, media_type: mediaType, display_name: file.name || "pasted-image.png" }
        ]);
      };
      reader.readAsDataURL(file);
    }
  }

  function handleDrop(e: React.DragEvent, target: "task" | "chat") {
    e.preventDefault();
    setDragOverTarget(null);
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;
    for (const file of files) {
      if (file.type.startsWith("image/")) {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const base64 = dataUrl.split(",")[1];
          const mediaType = file.type || "image/png";
          setTaskAttachments((prev) => [
            ...prev,
            { type: "image", data_base64: base64, media_type: mediaType, display_name: file.name }
          ]);
        };
        reader.readAsDataURL(file);
      } else if (isUploadable(file)) {
        if (file.size > MAX_UPLOAD_SIZE) {
          setError(`文件 ${file.name} 过大（${Math.round(file.size / 1024)}KB），上限 ${MAX_UPLOAD_SIZE / 1024 / 1024}MB`);
          continue;
        }
        void readFileAsBase64(file).then((base64) => {
          setTaskAttachments((prev) => [
            ...prev,
            { type: "file_upload", data_base64: base64, media_type: guessMediaType(file), display_name: file.name }
          ]);
        });
      } else {
        setError(`不支持的文件类型：${file.name}`);
      }
    }
  }

  function handleDragOver(e: React.DragEvent, target: "task" | "chat") {
    e.preventDefault();
    setDragOverTarget(target);
  }

  function handleDragLeave(_e: React.DragEvent, target: "task" | "chat") {
    setDragOverTarget((prev) => prev === target ? null : prev);
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>, target: "task" | "chat") {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
    for (const file of files) {
      if (file.type.startsWith("image/")) {
        if (file.size > MAX_IMAGE_SIZE) {
          setError(`图片 ${file.name} 过大（${Math.round(file.size / 1024)}KB），上限 5MB`);
          continue;
        }
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const base64 = dataUrl.split(",")[1];
          const mediaType = file.type || "image/png";
          setTaskAttachments((prev) => [
            ...prev,
            { type: "image", data_base64: base64, media_type: mediaType, display_name: file.name }
          ]);
        };
        reader.readAsDataURL(file);
      } else if (isUploadable(file)) {
        if (file.size > MAX_UPLOAD_SIZE) {
          setError(`文件 ${file.name} 过大（${Math.round(file.size / 1024)}KB），上限 ${MAX_UPLOAD_SIZE / 1024 / 1024}MB`);
          continue;
        }
        void readFileAsBase64(file).then((base64) => {
          setTaskAttachments((prev) => [
            ...prev,
            { type: "file_upload", data_base64: base64, media_type: guessMediaType(file), display_name: file.name }
          ]);
        });
      } else {
        setError(`不支持的文件类型：${file.name}`);
      }
    }
    e.target.value = "";
  }

  function handleTextareaChange(value: string, target: "task" | "chat", cursorPosition?: number) {
    setTaskPrompt(value);
    // @ 模式触发文件提及
    if (!projectPath) return;
    const pos = cursorPosition ?? value.length;
    const textBeforeCursor = value.slice(0, pos);
    const atIndex = textBeforeCursor.lastIndexOf("@");
    if (atIndex === -1 || (atIndex > 0 && textBeforeCursor[atIndex - 1] !== " " && textBeforeCursor[atIndex - 1] !== "\n")) {
      setShowFileMention(false);
      setFileMentionResults([]);
      return;
    }
    const query = textBeforeCursor.slice(atIndex + 1);
    if (query.includes(" ") || query.includes("\n")) {
      setShowFileMention(false);
      setFileMentionResults([]);
      return;
    }
    setMentionTarget(target);
    setFileMentionQuery(query);
    setShowFileMention(true);
  }

  function selectFileMention(filePath: string, target: "task" | "chat") {
    setTaskAttachments((prev) => [
      ...prev,
      { type: "file_ref", path: filePath, display_name: filePath.split(/[/\\]/).pop() || filePath }
    ]);
    // 将 @query 替换为 @filePath
    const currentValue = taskPrompt;
    const setter = setTaskPrompt;
    const lastAtIndex = currentValue.lastIndexOf("@");
    if (lastAtIndex !== -1) {
      setter(currentValue.slice(0, lastAtIndex) + `@${filePath} ` + currentValue.slice(lastAtIndex).replace(/@[\S]*/, ""));
    }
    setShowFileMention(false);
    setFileMentionResults([]);
  }

  function removeAttachment(target: "task" | "chat", index: number) {
    setTaskAttachments((prev) => prev.filter((_, i) => i !== index));
  }

  const composerSession =
    activeSession?.project_path === projectPath &&
    (activeSession.status === "running" || activeSession.status === "completed")
      ? activeSession
      : null;
  const onboardingRequired = false;
  const onboardingAdmissionAllowed = !taskWorkflowId || !onboardingRequired || onboardingOverride;
  const canStart = Boolean(projectPath && taskPrompt.trim() && workflows.length > 0 && onboardingAdmissionAllowed && !busy);
  const canSubmitComposer = composerSession
    ? Boolean(projectPath && (taskPrompt.trim() || taskAttachments.length > 0) && !busy)
    : canStart;
  const pendingToolCalls = activeSession?.tool_calls.filter((toolCall) => toolCall.status === "pending_approval") ?? [];
  const pendingHumanQuestions = activeSession?.pending_human_questions?.filter((q) => q.status === "pending") ?? [];
  const approvedToolCalls = activeSession?.tool_calls.filter((toolCall) => toolCall.status === "approved") ?? [];
  const stageRuns = activeSession?.stage_runs ?? [];
  const reworkRequests = activeSession?.rework_requests ?? [];
  const pendingReworkRequests = useMemo(
    () => reworkRequests.filter((request) => request.status === "pending"),
    [reworkRequests]
  );
  const workflowStageDisplays = useMemo(
    () => (activeWorkflow ? buildWorkflowStageDisplays(activeWorkflow.stages, activeSession, activeWorkflow.id) : []),
    [activeWorkflow, activeSession]
  );
  const timelineAll = useMemo(
    () => (activeSession ? buildSessionTimeline(activeSession) : []),
    [activeSession]
  );
  const timeline = useMemo(() => timelineAll.slice(0, timelineLimit), [timelineAll, timelineLimit]);
  const showMoreTimeline = timelineAll.length > timelineLimit;
  const activityEvents = useMemo(
    () => (activeSession?.progress_events ?? []).filter((p) => p.visibility === "transient").slice(-80),
    [activeSession]
  );
  const activityStreamRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = activityStreamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activityEvents]);
  const latestProgress = activeSession?.progress_events?.at(-1);
  const showOnboardingWarning = !composerSession && onboardingRequired;

  return (
    <main className={`app-shell${historyOpen ? " history-open" : ""}`}>
      {historyOpen && <aside className="sidebar">
        <section>
          <div className="sidebar-heading">
            <h2>{showArchivedSessions ? "已归档" : "项目与会话"}</h2>
            <div className="sidebar-heading-actions">
              <button className={`icon-btn${showArchivedSessions ? " active" : ""}`} title={showArchivedSessions ? "返回会话" : "查看归档"} onClick={() => { setShowArchivedSessions((show) => !show); setOpenSessionMenuId(null); }}>▣</button>
              <button className="icon-btn" title="关闭侧栏" onClick={() => setHistoryOpen(false)}>×</button>
            </div>
          </div>
          <div className="project-session-tree">
            {sessionGroups.map((group) => {
              const expanded = expandedProjectPaths.has(group.projectPath);
              return <section className={`project-group${group.projectPath === projectPath ? " current" : ""}`} key={group.projectPath}>
                <button className="project-group-header" title={group.projectPath} onClick={() => toggleProjectGroup(group.projectPath)}>
                  <span className="project-chevron">{expanded ? "⌄" : "›"}</span>
                  <span className="project-name">{group.projectName}</span>
                  <small>{group.sessions.length}</small>
                </button>
                {expanded && <div className="session-list">
                  {group.sessions.map((session) => (
                    <div key={session.id} className="session-item">
                      <button
                        className={activeSession?.id === session.id ? "session selected" : "session"}
                        onClick={() => void selectSession(session)}
                      >
                        <span title={session.task_prompt}>{session.title ?? summarizeSessionTitle(session.task_prompt)}</span>
                        <small>{session.pinned_at ? "已置顶 · " : ""}{formatStatus(session.status)}</small>
                      </button>
                      <button
                        className="session-menu-trigger"
                        title="更多操作"
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenSessionMenuId((current) => current === session.id ? null : session.id);
                        }}
                      >•••</button>
                      {openSessionMenuId === session.id && <div className="session-action-menu" onClick={(event) => event.stopPropagation()}>
                        <button onClick={() => void updateSessionOrganization(session, "pin")}>{session.pinned_at ? "取消置顶" : "置顶"}</button>
                        <button onClick={() => void updateSessionOrganization(session, "archive")}>{session.archived_at ? "取消归档" : "归档"}</button>
                        <button className="destructive" onClick={() => {
                          if (confirm(`确定要删除会话 "${session.title ?? summarizeSessionTitle(session.task_prompt)}" 吗？`)) void deleteSession(session);
                        }}>删除</button>
                      </div>}
                    </div>
                  ))}
                </div>}
              </section>;
            })}
          </div>
          {sessionGroups.length === 0 && <p className="nav-empty">{showArchivedSessions ? "暂无已归档会话。" : "暂无会话历史。"}</p>}
        </section>
      </aside>}

      <section className="workspace">
        <header className="topbar">
          <div className="brand"><div className="mark">慎</div><div><h1>谨慎程序员</h1><p>项目画像优先的本地编码 Agent</p></div></div>
          <div className="topbar-actions">
            <button className="secondary" onClick={() => setHistoryOpen((open) => !open)}>会话历史</button>
            <button className="secondary" disabled={busy} onClick={chooseProject}>{busy ? "选择中..." : "选择项目"}</button>
          </div>
        </header>
        <p className="path" title={projectPath}>{projectPath || "尚未选择项目"}</p>

        {onboardingStatus && <section className="onboarding-box compact">
          <div className="onboarding-status-row"><strong>项目画像</strong><span className={`status-pill ${onboardingStatus.status}`}>{formatStatus(onboardingStatus.status)}</span></div>
          {onboardingStatus.claude_md_exists && onboardingStatus.status !== "confirmed" && <button className="secondary" disabled={busy} onClick={confirmOnboarding}>确认项目画像</button>}
        </section>}

        {/* 主内容区：左侧任务/聊天，右侧阶段状态和活动流 */}
        <div className={`main-content-grid${activeWorkflow ? " has-stages" : ""}`}>
          {/* 左侧：任务输入 + 会话详情 */}
          <div className="left-panel">
            {/* 任务输入区（Composer） */}
            <div className={`composer${dragOverTarget === "task" ? " drag-over" : ""}`}
              onDragOver={(e) => handleDragOver(e, "task")}
              onDragLeave={(e) => handleDragLeave(e, "task")}
              onDrop={(e) => handleDrop(e, "task")}>
              <div className="composer-header-horizontal">
                <div className="composer-info">
                  <h2>
                    {composerSession
                      ? `当前会话：${composerSession.title ?? summarizeSessionTitle(composerSession.task_prompt)}`
                      : taskWorkflow
                        ? formatWorkflowName(taskWorkflow.id, taskWorkflow.name)
                        : "谨慎程序员"}
                  </h2>
                  <p>
                    {composerSession
                      ? composerSession.status === "running"
                        ? "消息会在当前运行结束后继续处理。"
                        : "发送消息后继续这个会话。"
                      : taskWorkflow
                      ? formatWorkflowDescription(taskWorkflow.id, taskWorkflow.description)
                      : projectPath
                        ? "使用内置谨慎程序员工作流执行任务。"
                        : "选择项目后开始任务。"}
                    {runtimeStatus && <span className={`runtime-mode ${runtimeStatus.mode}`}>{formatStatus(runtimeStatus.mode)}模式</span>}
                  </p>
                  {runtimeStatus && (
                    <div className="runtime-diagnostics">
                      <span className={runtimeStatus.sdk_available ? "diagnostic ok" : "diagnostic warn"}>SDK</span>
                      <span className={runtimeStatus.node_runtime_available ? "diagnostic ok" : "diagnostic warn"}>Node 运行时</span>
                      <span className={runtimeStatus.auth_env_available ? "diagnostic ok" : "diagnostic warn"}>Claude 凭据</span>
                    </div>
                  )}
                </div>
                {composerSession ? (
                  <button
                    className="secondary compact-action"
                    onClick={() => {
                      setActiveSessionId(null);
                      setTaskPrompt("");
                      setTaskAttachments([]);
                    }}
                  >
                    新任务
                  </button>
                ) : (
                  <div className="workflow-picker-horizontal">
                    <span>工作流</span>
                    <strong>{taskWorkflow ? formatWorkflowName(taskWorkflow.id, taskWorkflow.name) : "谨慎程序员"}</strong>
                  </div>
                )}
              </div>
              {taskAttachments.length > 0 && (
                <div className="attachment-strip">
                  {taskAttachments.map((att, i) => (
                    <div key={attachmentKey(att, i)} className="attachment-chip">
                      {att.type === "image" ? (
                        <img src={`data:${att.media_type};base64,${att.data_base64}`} alt={att.display_name} className="attachment-thumb" />
                      ) : (
                        <span className="attachment-file-icon">📄</span>
                      )}
                      <span className="attachment-name">{att.display_name}</span>
                      <button className="attachment-remove" onClick={() => removeAttachment("task", i)}>×</button>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                value={taskPrompt}
                onChange={(event) => {
                  handleTextareaChange(event.target.value, "task", event.target.selectionStart ?? undefined);
                }}
                onPaste={(e) => handlePaste(e, "task")}
                placeholder={composerSession ? "给当前会话发送消息... (可粘贴图片、拖入文件、@引用项目文件)" : "描述要执行的编码任务... (可粘贴图片、拖入文件、@引用项目文件)"}
              />
              {showFileMention && mentionTarget === "task" && fileMentionResults.length > 0 && (
                <div className="file-mention-dropdown">
                  {fileMentionResults.map((filePath) => (
                    <button key={filePath} className="file-mention-item" onClick={() => selectFileMention(filePath, "task")}>
                      {filePath}
                    </button>
                  ))}
                </div>
              )}
              <div className="actions">
                <button className="icon-btn" title="添加附件" onClick={() => taskFileInputRef.current?.click()}>📎</button>
                <button className="primary" disabled={!canSubmitComposer} onClick={() => void submitComposer()}>
                  {busy ? "处理中..." : "发送"}
                </button>
                {error && <span className="error">{error}</span>}
              </div>
              <input type="file" ref={taskFileInputRef} style={{ display: "none" }} multiple
                onChange={(e) => handleFileSelect(e, "task")} />
              {showOnboardingWarning && (
                <div className="admission-warning">
                  <span>项目画像尚未确认。请先运行项目画像，或确认已有画像入口。</span>
                  <label className="override-option">
                    <input
                      type="checkbox"
                      checked={onboardingOverride}
                      onChange={(event) => setOnboardingOverride(event.target.checked)}
                    />
                    未确认入职也继续运行
                  </label>
                </div>
              )}
            </div>

            {/* 会话详情区 */}
            <section className="session-detail" key={activeSession?.id ?? "empty-session"}>
              {activeSession ? (
                <>
                  <div className="session-header">
                    <div>
                      <h2>{activeSession.task_prompt}</h2>
                      <p>
                        {formatStatus(activeSession.status)} · {formatWorkflowName(activeSession.workflow_id, activeSession.workflow_id)} ·{" "}
                        {formatStageName(activeSession.current_stage)}
                      </p>
                      {activeSession.routing && <p>选择原因：{activeSession.routing.reason}</p>}
                      {activeSession.onboarding && (
                        <p>
                          项目画像 {formatStatus(activeSession.onboarding.status)}
                          {activeSession.onboarding.override ? " · 已跳过门禁" : ""}
                        </p>
                      )}
                    </div>
                    {(activeSession.status === "running" ||
                      activeSession.status === "waiting_approval" ||
                      activeSession.status === "failed" ||
                      activeSession.status === "blocked" ||
                      activeSession.status === "interrupted") && (
                      <div className="session-actions">
                        {(activeSession.status === "running" || activeSession.status === "waiting_approval") && (
                          <button className="secondary" disabled={busy} onClick={() => abortSession(activeSession)}>
                            停止
                          </button>
                        )}
                        {activeSession.status === "waiting_approval" && (
                          <>
                            {activeSession.approvals.some(
                              (approval) => approval.kind === "stage" && approval.status === "pending"
                            ) && (
                              <button className="primary" disabled={busy} onClick={() => approvePendingStage(activeSession)}>
                                批准阶段
                              </button>
                            )}
                            {approvedToolCalls.length > 0 && (
                              <button
                                className="secondary"
                                disabled={busy}
                                onClick={() => continueSession(activeSession)}
                              >
                                继续
                              </button>
                            )}
                          </>
                        )}
                        {(activeSession.status === "failed" ||
                          activeSession.status === "blocked" ||
                          activeSession.status === "interrupted") && (
                          <button className="primary" disabled={busy} onClick={() => resumeSession(activeSession)}>
                            断点恢复
                          </button>
                        )}
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() => {
                            if (confirm(`确定要重新开始任务 "${activeSession.task_prompt}" 吗？这将清空当前的执行进度并从第一个阶段重新开始。`)) {
                              void restartSession(activeSession);
                            }
                          }}
                          title="从工作流的第一个阶段重新开始执行"
                        >
                          重新开始
                        </button>
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() => {
                            if (confirm(`确定要重置当前会话 "${activeSession.task_prompt}" 吗？这将只保留第一条用户消息，清除所有执行过程、工具记录、审批、返工和上下文，然后重新运行。`)) {
                              void resetSessionContext(activeSession);
                            }
                          }}
                          title="只保留第一条用户消息，清除当前会话的所有执行上下文"
                        >
                          重置会话
                        </button>
                      </div>
                    )}
                  </div>
                  <div className={`activity-strip ${activeSession.status}`}>
                    <span className="activity-dot" />
                    <div>
                      <strong>{buildActivityTitle(activeSession)}</strong>
                      <small>
                        {latestProgress?.message ?? "等待下一条运行事件。"} · 最近更新 {formatTimestamp(activeSession.updated_at)}
                      </small>
                    </div>
                  </div>
                  {pendingToolCalls.length > 0 && (
                    <div className="tool-approvals">
                      {pendingToolCalls.map((toolCall: ToolCallRecord) => (
                        <article key={toolCall.id} className="tool-approval">
                          <div>
                            <strong>{toolCall.tool}</strong>
                            <small>{formatStageName(toolCall.stage_id)}</small>
                          </div>
                          <div className="markdown-content">
                            <MarkdownContent>{`\`\`\`json\n${JSON.stringify(toolCall.input, null, 2)}\n\`\`\``}</MarkdownContent>
                          </div>
                          <div className="actions">
                            <button className="primary" disabled={busy} onClick={() => approveToolCall(activeSession, toolCall)}>
                              批准
                            </button>
                            <button className="secondary" disabled={busy} onClick={() => denyToolCall(activeSession, toolCall)}>
                              拒绝
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                  {pendingHumanQuestions.length > 0 && (
                    <div className="human-questions">
                      {pendingHumanQuestions.map((q: HumanQuestion) => {
                        const currentAnswer = questionAnswers[q.id];
                        const otherText = questionOtherTexts[q.id] ?? "";
                        const trimmedOther = otherText.trim();
                        const showOtherInput =
                          (q.question_type === "single" && currentAnswer === OTHER_OPTION_VALUE) ||
                          (q.question_type === "multi" &&
                            Array.isArray(currentAnswer) &&
                            currentAnswer.includes(OTHER_OPTION_VALUE));
                        let isValid: boolean;
                        if (q.question_type === "multi") {
                          if (!Array.isArray(currentAnswer) || currentAnswer.length === 0) {
                            isValid = false;
                          } else if (currentAnswer.includes(OTHER_OPTION_VALUE) && trimmedOther.length === 0) {
                            isValid = currentAnswer.some((v) => v !== OTHER_OPTION_VALUE);
                          } else {
                            isValid = true;
                          }
                        } else if (q.question_type === "single") {
                          if (typeof currentAnswer !== "string" || currentAnswer.length === 0) {
                            isValid = false;
                          } else if (currentAnswer === OTHER_OPTION_VALUE) {
                            isValid = trimmedOther.length > 0;
                          } else {
                            isValid = true;
                          }
                        } else {
                          isValid = typeof currentAnswer === "string" && currentAnswer.trim().length > 0;
                        }
                        return (
                          <article key={q.id} className="human-question">
                            <div className="question-header">
                              <strong>助手提问</strong>
                              <small>
                                {q.question_type === "single" ? "单选" : q.question_type === "multi" ? "多选" : "文本"}
                                {" · "}
                                {formatStageName(q.stage_id)}
                              </small>
                            </div>
                            <div className="question-body">
                              <MarkdownContent>{q.question}</MarkdownContent>
                            </div>
                            {q.question_type === "single" && q.options && (
                              <div className="question-options">
                                {q.options.map((opt) => (
                                  <label key={opt.value} className="question-option">
                                    <input
                                      type="radio"
                                      name={q.id}
                                      checked={currentAnswer === opt.value}
                                      onChange={() => setQuestionAnswers((prev) => ({ ...prev, [q.id]: opt.value }))}
                                    />
                                    <span>{opt.label}</span>
                                  </label>
                                ))}
                                <label className="question-option">
                                  <input
                                    type="radio"
                                    name={q.id}
                                    checked={currentAnswer === OTHER_OPTION_VALUE}
                                    onChange={() =>
                                      setQuestionAnswers((prev) => ({ ...prev, [q.id]: OTHER_OPTION_VALUE }))
                                    }
                                  />
                                  <span>其他（自行输入）</span>
                                </label>
                              </div>
                            )}
                            {q.question_type === "multi" && q.options && (
                              <div className="question-options">
                            {q.options.map((opt) => {
                              const arr = Array.isArray(currentAnswer) ? currentAnswer : [];
                              const checked = arr.includes(opt.value);
                              return (
                                <label key={opt.value} className="question-option">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={(event) => {
                                      const next = event.target.checked
                                        ? [...arr, opt.value]
                                        : arr.filter((v) => v !== opt.value);
                                      setQuestionAnswers((prev) => ({ ...prev, [q.id]: next }));
                                    }}
                                  />
                                  <span>{opt.label}</span>
                                </label>
                              );
                            })}
                            <label className="question-option">
                              <input
                                type="checkbox"
                                checked={Array.isArray(currentAnswer) && currentAnswer.includes(OTHER_OPTION_VALUE)}
                                onChange={(event) => {
                                  const arr = Array.isArray(currentAnswer) ? currentAnswer : [];
                                  const next = event.target.checked
                                    ? [...arr, OTHER_OPTION_VALUE]
                                    : arr.filter((v) => v !== OTHER_OPTION_VALUE);
                                  setQuestionAnswers((prev) => ({ ...prev, [q.id]: next }));
                                }}
                              />
                              <span>其他（自行输入）</span>
                            </label>
                          </div>
                            )}
                            {showOtherInput && (
                              <textarea
                                className="question-textarea"
                                rows={2}
                                value={otherText}
                                onChange={(event) =>
                                  setQuestionOtherTexts((prev) => ({ ...prev, [q.id]: event.target.value }))
                                }
                                placeholder="输入你的其他意见..."
                              />
                            )}
                            {q.question_type === "text" && (
                              <textarea
                                className="question-textarea"
                                rows={3}
                                value={typeof currentAnswer === "string" ? currentAnswer : ""}
                                onChange={(event) => setQuestionAnswers((prev) => ({ ...prev, [q.id]: event.target.value }))}
                                placeholder="输入你的回答..."
                              />
                            )}
                            <div className="actions">
                              <button
                                className="primary"
                                disabled={busy || !isValid}
                                onClick={() => {
                                  let ans: string | string[];
                                  if (q.question_type === "multi") {
                                    const arr = Array.isArray(currentAnswer) ? currentAnswer : [];
                                    ans = arr
                                      .map((v) => (v === OTHER_OPTION_VALUE ? trimmedOther : v))
                                      .filter((v) => v.length > 0);
                                  } else if (q.question_type === "single") {
                                    const v = (currentAnswer as string) || "";
                                    ans = v === OTHER_OPTION_VALUE ? trimmedOther : v;
                                  } else {
                                    ans = ((currentAnswer as string) || "").trim();
                                  }
                                  void answerHumanQuestion(activeSession, q.id, ans);
                                }}
                              >
                                提交回答
                              </button>
                            </div>
                          </article>
                        );
                      })}
                    </div>
                  )}
                  {/* 实时活动流：放在阶段执行和返工请求上方，优先展示当前状态。 */}
                  {activityEvents.length > 0 && (
                    <section className="activity-stream">
                      <div className="activity-stream-header">实时活动（滚动）</div>
                      <div className="activity-stream-body" ref={activityStreamRef}>
                        {activityEvents.map((p) => (
                          <div key={p.id} className="activity-item">
                            <time>{formatTimestamp(p.created_at)}</time>
                            <span className="muted">{p.message}</span>
                          </div>
                        ))}
                      </div>
                    </section>
                  )}
                  <div className="run-panels">
                    <section className="run-panel">
                      <div className="panel-heading">
                        <h3>阶段执行</h3>
                        <small>{stageRuns.length} 次尝试</small>
                      </div>
                      {stageRuns.length > 0 ? (
                        <div className="stage-run-list">
                          {stageRuns.map((stageRun: StageRun) => (
                            <article
                              key={stageRun.id}
                              className={stageRun.stage_id === activeSession.current_stage ? "stage-run current" : "stage-run"}
                            >
                              <div className="stage-run-title">
                                <strong>{formatStageName(stageRun.stage_id)}</strong>
                                <span className={`status-pill ${stageRun.status}`}>{formatStatus(stageRun.status)}</span>
                              </div>
                              <small>第 {stageRun.attempt} 次尝试</small>
                              <p className="markdown-content">
                                <MarkdownContent>{stageRun.output_summary ?? stageRun.input_summary}</MarkdownContent>
                              </p>
                            </article>
                          ))}
                        </div>
                      ) : (
                        <p className="muted">暂无阶段执行记录。</p>
                      )}
                    </section>

                    <section className="run-panel">
                      <div className="panel-heading">
                        <h3>返工请求</h3>
                        <small>{reworkRequests.length} 个请求</small>
                      </div>
                      {reworkRequests.length > 0 ? (
                        <div className="rework-list">
                          {reworkRequests.map((request: ReworkRequest) => (
                            <article key={request.id} className="rework-request">
                              <div className="stage-run-title">
                                <strong>
                                  {formatStageName(request.from_stage_id)} -&gt; {formatStageName(request.target_stage_id)}
                                </strong>
                                <span className={`status-pill ${request.status}`}>{formatStatus(request.status)}</span>
                              </div>
                              <p className="markdown-content">
                                <MarkdownContent>{request.reason}</MarkdownContent>
                              </p>
                              {request.status === "pending" && (
                                <div className="actions">
                                  <button className="primary" disabled={busy} onClick={() => approveReworkRequest(activeSession, request)}>
                                    批准返工
                                  </button>
                                </div>
                              )}
                            </article>
                          ))}
                        </div>
                      ) : (
                        <p className="muted">暂无返工请求。</p>
                      )}
                    </section>
                  </div>
                  {pendingReworkRequests.length > 0 && (
                    <div className="pending-banner">{pendingReworkRequests.length} 个返工请求等待审批。</div>
                  )}
                  <div className="timeline">
                    {timeline.map((event: TimelineEvent) => (
                      <article key={event.id} className={`timeline-item ${event.type}`}>
                        <div className="timeline-meta">
                          <time>{formatTimestamp(event.timestamp)}</time>
                          {event.status && <span className="timeline-status">{formatStatus(event.status)}</span>}
                        </div>
                        <div className="timeline-body">
                          <strong>{event.title}</strong>
                          {event.detail && (
                            <MarkdownContent>{event.detail}</MarkdownContent>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>
                  {showMoreTimeline && (
                    <div className="timeline-more">
                      <button className="secondary" onClick={() => setTimelineLimit((n) => n + 50)}>
                        加载更多（显示更多 50 条）
                      </button>
                    </div>
                  )}
              </>
              ) : (
                <div className="empty-state">
                  <h3>{projectPath ? "暂无当前项目会话" : "尚未选择项目"}</h3>
                  <p>{projectPath ? "提交任务后，运行状态会显示在这里。" : "选择一个项目后，会话会显示在这里。"}</p>
                  {!projectPath && (
                    <button className="secondary" disabled={busy} onClick={chooseProject}>
                      选择项目
                    </button>
                  )}
                </div>
              )}
            </section>
          </div>

          {activeWorkflow && (
            <div className="right-panel">
              <div className="stages-panel">
                <h3>阶段状态</h3>
                <div className="stages stages-stepper">
                  {workflowStageDisplays.map(({ stage, status, attempt, isCurrent }) => (
                    <div key={stage.id} className={`stage ${status}${isCurrent ? " current" : ""}`}>
                      <span className={`stage-indicator ${status}`} aria-label={formatStatus(status)} />
                      <div>
                        <span>{formatStageName(stage.id, stage.name)}</span>
                        <small>
                          {formatStatus(status)}
                          {attempt ? ` · 第 ${attempt} 次` : ""}
                          {stage.approval_required ? " · 需审批" : ""}
                        </small>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

function attachmentKey(att: { type: string; data_base64?: string; path?: string }, index: number): string {
  if (att.type === "image" && att.data_base64) {
    return `img-${att.data_base64.slice(0, 16)}`;
  }
  if (att.path) {
    return `ref-${att.path}`;
  }
  return `att-${index}`;
}

function formatTimestamp(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function buildActivityTitle(session: AgentSession) {
  if (session.status === "running") {
    return `正在执行：${formatStageName(session.current_stage)}`;
  }
  if (session.status === "waiting_approval") {
    return "等待人工审批";
  }
  if (session.status === "blocked") {
    return "执行已被门禁拦截";
  }
  if (session.status === "failed") {
    return "执行失败";
  }
  if (session.status === "completed") {
    return "执行完成";
  }
  return "等待启动";
}

/** 渲染 JSON 值：字符串值用 Markdown 渲染，对象/数组递归展开 */
function JsonValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span className="json-null">null</span>;
  }
  if (typeof value === "boolean") {
    return <span className="json-bool">{String(value)}</span>;
  }
  if (typeof value === "number") {
    return <span className="json-number">{String(value)}</span>;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (hasMarkdown(trimmed)) {
      return (
        <div className="json-markdown-value">
          <MarkdownContent>{trimmed}</MarkdownContent>
        </div>
      );
    }
    return <span className="json-string">{value}</span>;
  }
  if (Array.isArray(value)) {
    return (
      <div className="json-array">
        {value.map((item, index) => (
          <div key={index} className="json-array-item">
            <JsonValue value={item} />
          </div>
        ))}
      </div>
    );
  }
  if (typeof value === "object") {
    return <JsonObject value={value as Record<string, unknown>} />;
  }
  return <span>{String(value)}</span>;
}

/** 渲染 JSON 对象为 key-value 表格 */
function JsonObject({ value }: { value: Record<string, unknown> }) {
  const entries = Object.entries(value);
  return (
    <div className="json-object">
      {entries.map(([key, val]) => (
        <div key={key} className="json-entry">
          <span className="json-key">{key}</span>
          <span className="json-colon">:</span>
          <span className="json-value">
            <JsonValue value={val} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** 判断字符串是否包含 Markdown 标记 */
function hasMarkdown(text: string): boolean {
  return /[*_~`#>|[\-]{2,}/.test(text) || text.includes("\n");
}

/** 共享的 remark 插件数组 */
const REMARK_PLUGINS = [remarkGfm];

/** 自定义 Markdown 组件：JSON 代码块用美化渲染 */
const markdownComponents: Components = {
  code({ className, children, ...props }) {
    const language = className?.replace("language-", "");
    const text = String(children).replace(/\n$/, "");

    if (language === "json") {
      try {
        const parsed = JSON.parse(text);
        return (
          <div className="json-prettified">
            <JsonValue value={parsed} />
          </div>
        );
      } catch {
        // JSON 解析失败，回退到普通代码块
      }
    }

    if (!className) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }

    return (
      <pre>
        <code className={className} {...props}>
          {children}
        </code>
      </pre>
    );
  },
  pre({ children }) {
    return <>{children}</>;
  }
};

/** 统一的 Markdown 渲染组件 */
function MarkdownContent({ children }: { children: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>{children}</ReactMarkdown>
    </div>
  );
}

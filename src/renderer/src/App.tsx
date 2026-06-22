import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
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
  WorkflowLoadIssue,
  WorkflowTemplate
} from "../../shared/types.js";
import { buildSessionTimeline } from "./sessionTimeline.js";
import type { TimelineEvent } from "./sessionTimeline.js";
import { getVisibleSessions, resolveActiveSessionId } from "./sessionSelection.js";
import { buildWorkflowStageDisplays } from "./workflowStageStatus.js";
import {
  formatStageName,
  formatStatus,
  formatWorkflowDescription,
  formatWorkflowName,
  formatWorkflowSource
} from "./labels.js";
import "./styles.css";

export default function App() {
  const [projectPath, setProjectPath] = useState("");
  const [workflows, setWorkflows] = useState<WorkflowTemplate[]>([]);
  const [workflowIssues, setWorkflowIssues] = useState<WorkflowLoadIssue[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState("");
  const [taskPrompt, setTaskPrompt] = useState("");
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<AgentRuntimeStatus | null>(null);
  const [onboardingStatus, setOnboardingStatus] = useState<ProjectOnboardingStatus | null>(null);
  const [onboardingOverride, setOnboardingOverride] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatAttachments, setChatAttachments] = useState<Attachment[]>([]);
  const [taskAttachments, setTaskAttachments] = useState<Attachment[]>([]);
  const [showFileMention, setShowFileMention] = useState(false);
  const [fileMentionQuery, setFileMentionQuery] = useState("");
  const [fileMentionResults, setFileMentionResults] = useState<string[]>([]);
  const [mentionTarget, setMentionTarget] = useState<"task" | "chat">("chat");
  const [dragOverTarget, setDragOverTarget] = useState<"task" | "chat" | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const taskFileInputRef = useRef<HTMLInputElement>(null);
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, string | string[]>>({});

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

  const selectedWorkflow = useMemo(
    () => workflows.find((workflow) => workflow.id === selectedWorkflowId) ?? null,
    [selectedWorkflowId, workflows]
  );
  const visibleSessions = useMemo(() => getVisibleSessions(sessions, projectPath), [projectPath, sessions]);
  const activeSession = useMemo(
    () => visibleSessions.find((session) => session.id === activeSessionId) ?? null,
    [activeSessionId, visibleSessions]
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
    }, 1500);
    return () => window.clearInterval(interval);
  }, [activeSessionId, runningVisibleSessionIds]);

  async function refreshRuntimeStatus() {
    setRuntimeStatus(await window.aiCoder.getAgentRuntimeStatus());
  }

  async function refreshWorkflows(nextProjectPath = projectPath, preferredWorkflowId = selectedWorkflowId) {
    const result = await window.aiCoder.listWorkflows(nextProjectPath || undefined);
    const nextWorkflowId = result.workflows.some((workflow: WorkflowTemplate) => workflow.id === preferredWorkflowId)
      ? preferredWorkflowId
      : result.workflows[0]?.id || "";
    setWorkflows(result.workflows);
    setWorkflowIssues(result.issues);
    setSelectedWorkflowId(nextWorkflowId);
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
    const loaded = await window.aiCoder.listSessions();
    setSessions(loaded);
    setActiveSessionId((current) => {
      return resolveActiveSessionId(loaded, {
        currentSessionId: current,
        preferredSessionId,
        projectPath: options.projectPath ?? projectPath,
        workflowId: options.workflowId ?? selectedWorkflowId,
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
        const workflowResult = await refreshWorkflows(selected);
        await refreshOnboardingStatus(selected);
        await refreshSessions(undefined, {
          projectPath: selected,
          workflowId: workflowResult.selectedWorkflowId,
          preferLatestForWorkflow: true
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function selectWorkflow(workflowId: string) {
    setSelectedWorkflowId(workflowId);
    setError("");
    await refreshSessions(undefined, {
      workflowId,
      projectPath,
      preferLatestForWorkflow: true
    });
  }

  function selectSession(session: AgentSession) {
    setActiveSessionId(session.id);
    // 自动切换到会话所属的项目
    if (session.project_path !== projectPath) {
      setProjectPath(session.project_path);
      // 项目切换后，重新加载工作流列表和会话列表
      refreshWorkflows(session.project_path).then((workflowResult) => {
        void refreshSessions(undefined, {
          projectPath: session.project_path,
          workflowId: workflowResult.selectedWorkflowId,
          preferLatestForWorkflow: false
        });
      });
    }
    if (session.workflow_id !== selectedWorkflowId && workflows.some((workflow) => workflow.id === session.workflow_id)) {
      setSelectedWorkflowId(session.workflow_id);
    }
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
      const result = await window.aiCoder.startSession({
        projectPath,
        workflowId: selectedWorkflowId,
        taskPrompt,
        onboardingOverride,
        attachments: taskAttachments.length > 0 ? taskAttachments : undefined
      });
      upsertSession(result.session);
      setTaskPrompt("");
      setTaskAttachments([]);
      await refreshSessions(result.session.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
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
    const setAttachments = target === "chat" ? setChatAttachments : setTaskAttachments;
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
        setAttachments((prev) => [
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
    const setAttachments = target === "chat" ? setChatAttachments : setTaskAttachments;
    for (const file of files) {
      if (file.type.startsWith("image/")) {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const base64 = dataUrl.split(",")[1];
          const mediaType = file.type || "image/png";
          setAttachments((prev) => [
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
          setAttachments((prev) => [
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
    const setAttachments = target === "chat" ? setChatAttachments : setTaskAttachments;
    const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB
    for (const file of Array.from(files)) {
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
          setAttachments((prev) => [
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
          setAttachments((prev) => [
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
    if (target === "chat") {
      setChatInput(value);
    } else {
      setTaskPrompt(value);
    }
    // 检测 @ 模式触发文件提及
    if (!projectPath) return;
    const cursorPos = cursorPosition ?? value.length;
    const textBeforeCursor = value.slice(0, cursorPos);
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
    const setAttachments = target === "chat" ? setChatAttachments : setTaskAttachments;
    setAttachments((prev) => [
      ...prev,
      { type: "file_ref", path: filePath, display_name: filePath.split(/[/\\]/).pop() || filePath }
    ]);
    // 将 @query 替换为 @filePath
    const currentValue = target === "chat" ? chatInput : taskPrompt;
    const setter = target === "chat" ? setChatInput : setTaskPrompt;
    const lastAtIndex = currentValue.lastIndexOf("@");
    if (lastAtIndex !== -1) {
      setter(currentValue.slice(0, lastAtIndex) + `@${filePath} ` + currentValue.slice(lastAtIndex).replace(/@[\S]*/, ""));
    }
    setShowFileMention(false);
    setFileMentionResults([]);
  }

  function removeAttachment(target: "task" | "chat", index: number) {
    const setAttachments = target === "chat" ? setChatAttachments : setTaskAttachments;
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }

  const onboardingConfirmed = onboardingStatus?.status === "confirmed";
  const onboardingRequired = Boolean(projectPath && selectedWorkflowId !== "project-onboarding" && !onboardingConfirmed);
  const onboardingAdmissionAllowed = !onboardingRequired || onboardingOverride;
  const canStart = Boolean(projectPath && selectedWorkflowId && taskPrompt.trim() && onboardingAdmissionAllowed && !busy);
  const pendingToolCalls = activeSession?.tool_calls.filter((toolCall) => toolCall.status === "pending_approval") ?? [];
  const pendingHumanQuestions = activeSession?.pending_human_questions?.filter((q) => q.status === "pending") ?? [];
  const approvedToolCalls = activeSession?.tool_calls.filter((toolCall) => toolCall.status === "approved") ?? [];
  const stageRuns = activeSession?.stage_runs ?? [];
  const reworkRequests = activeSession?.rework_requests ?? [];
  const pendingReworkRequests = reworkRequests.filter((request) => request.status === "pending");
  const workflowStageDisplays = selectedWorkflow
    ? buildWorkflowStageDisplays(selectedWorkflow.stages, activeSession, selectedWorkflow.id)
    : [];
  const showOnboardingWarning = onboardingRequired;
  const timeline = activeSession ? buildSessionTimeline(activeSession) : [];
  const latestProgress = activeSession?.progress_events?.at(-1);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="mark">AI</div>
          <div>
            <h1>AI Coder</h1>
            <p>本地工作流 Agent</p>
          </div>
        </div>

        <button className="secondary" disabled={busy} onClick={chooseProject}>
          {busy ? "选择中..." : "选择项目"}
        </button>
        <p className="path" title={projectPath}>
          {projectPath || "尚未选择项目"}
        </p>

        {onboardingStatus && (
          <section className="onboarding-box">
            <h2>项目画像</h2>
            <div className="onboarding-status-row">
              <span className={`status-pill ${onboardingStatus.status}`}>{formatStatus(onboardingStatus.status)}</span>
              <small>{onboardingStatus.claude_md_exists ? "已找到项目画像入口" : "缺少项目画像入口"}</small>
            </div>
            {onboardingStatus.confirmed_at && <small>确认时间 {formatTimestamp(onboardingStatus.confirmed_at)}</small>}
            {onboardingStatus.claude_md_exists && onboardingStatus.status !== "confirmed" && (
              <button className="secondary" disabled={busy} onClick={confirmOnboarding}>
                确认项目画像
              </button>
            )}
          </section>
        )}

        <section>
          <h2>工作流</h2>
          <div className="workflow-list">
            {workflows.map((workflow) => (
              <button
                key={`${workflow.source.type}:${workflow.id}`}
                className={workflow.id === selectedWorkflowId ? "workflow selected" : "workflow"}
                onClick={() => void selectWorkflow(workflow.id)}
              >
                <span>{formatWorkflowName(workflow.id, workflow.name)}</span>
                <small>{formatWorkflowSource(workflow.source.type)} · v{workflow.version}</small>
              </button>
            ))}
          </div>
          {workflows.length === 0 && (
            <p className="nav-empty">{projectPath ? "未找到可用工作流。" : "选择项目后加载工作流。"}</p>
          )}
          {workflowIssues.length > 0 && (
            <div className="workflow-issues">
              {workflowIssues.map((issue: WorkflowLoadIssue) => (
                <div key={`${issue.source_type}:${issue.path}`} className="workflow-issue">
                  <strong>{formatWorkflowSource(issue.source_type)}</strong>
                  <span title={issue.path}>{issue.path}</span>
                  <small>{issue.message}</small>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <h2>会话</h2>
          <div className="session-list">
            {visibleSessions.map((session) => (
              <button
                key={session.id}
                className={activeSession?.id === session.id ? "session selected" : "session"}
                onClick={() => selectSession(session)}
              >
                <span>{session.task_prompt}</span>
                <small>{formatStatus(session.status)}</small>
              </button>
            ))}
          </div>
          {visibleSessions.length === 0 && <p className="nav-empty">暂无当前项目会话。</p>}
        </section>
      </aside>

      <section className="workspace">
        <div className={`composer${dragOverTarget === "task" ? " drag-over" : ""}`}
          onDragOver={(e) => handleDragOver(e, "task")}
          onDragLeave={(e) => handleDragLeave(e, "task")}
          onDrop={(e) => handleDrop(e, "task")}>
          <div>
            <h2>{selectedWorkflow ? formatWorkflowName(selectedWorkflow.id, selectedWorkflow.name) : "选择工作流"}</h2>
            <p>
              {selectedWorkflow
                ? formatWorkflowDescription(selectedWorkflow.id, selectedWorkflow.description)
                : projectPath
                  ? "选择工作流后开始任务。"
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
            onChange={(event) => handleTextareaChange(event.target.value, "task", event.target.selectionStart ?? undefined)}
            onPaste={(e) => handlePaste(e, "task")}
            placeholder="描述要执行的编码任务... (可粘贴图片、拖入文件、@引用项目文件)"
          />
          <div className="actions">
            <button className="icon-btn" title="添加附件" onClick={() => taskFileInputRef.current?.click()}>📎</button>
            <button className="primary" disabled={!canStart} onClick={startSession}>
              {busy ? "运行中..." : "启动 Agent"}
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

        {selectedWorkflow && (
          <div className="stages">
            {workflowStageDisplays.map(({ stage, status, attempt, isCurrent }) => (
              <div key={stage.id} className={`stage ${status}${isCurrent ? " current" : ""}`}>
                <div>
                  <span>{formatStageName(stage.id, stage.name)}</span>
                  <small>
                    {formatStatus(status)}
                    {attempt ? ` · 第 ${attempt} 次` : ""}
                    {stage.approval_required ? " · 需审批" : ""}
                  </small>
                </div>
                <span className={`stage-indicator ${status}`} aria-label={formatStatus(status)} />
              </div>
            ))}
          </div>
        )}

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
                  {activeSession.onboarding && (
                    <p>
                      入职状态 {formatStatus(activeSession.onboarding.status)}
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
                    const isValid =
                      q.question_type === "multi"
                        ? Array.isArray(currentAnswer) && currentAnswer.length > 0
                        : typeof currentAnswer === "string" && currentAnswer.trim().length > 0;
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
                          </div>
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
                              const ans =
                                q.question_type === "multi"
                                  ? (currentAnswer as string[])
                                  : ((currentAnswer as string) || "").trim();
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
              {/* 闲聊工作流或会话已完成时显示继续对话输入框 */}
              {(activeSession?.workflow_id === "chat" || activeSession?.status === "completed") && (
                <div className={`chat-input-box${dragOverTarget === "chat" ? " drag-over" : ""}`}
                  onDragOver={(e) => handleDragOver(e, "chat")}
                  onDragLeave={(e) => handleDragLeave(e, "chat")}
                  onDrop={(e) => handleDrop(e, "chat")}>
                  {chatAttachments.length > 0 && (
                    <div className="attachment-strip">
                      {chatAttachments.map((att, i) => (
                        <div key={attachmentKey(att, i)} className="attachment-chip">
                          {att.type === "image" ? (
                            <img src={`data:${att.media_type};base64,${att.data_base64}`} alt={att.display_name} className="attachment-thumb" />
                          ) : (
                            <span className="attachment-file-icon">📄</span>
                          )}
                          <span className="attachment-name">{att.display_name}</span>
                          <button className="attachment-remove" onClick={() => removeAttachment("chat", i)}>×</button>
                        </div>
                      ))}
                    </div>
                  )}
                  <textarea
                    value={chatInput}
                    onChange={(event) => handleTextareaChange(event.target.value, "chat", event.target.selectionStart ?? undefined)}
                    onPaste={(e) => handlePaste(e, "chat")}
                    placeholder="输入消息继续对话... (可粘贴图片、拖入文件、@引用项目文件)"
                    rows={2}
                  />
                  {showFileMention && fileMentionResults.length > 0 && (
                    <div className="file-mention-dropdown">
                      {fileMentionResults.map((filePath) => (
                        <button key={filePath} className="file-mention-item" onClick={() => selectFileMention(filePath, mentionTarget)}>
                          {filePath}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="actions">
                    <button className="icon-btn" title="添加附件" onClick={() => fileInputRef.current?.click()}>📎</button>
                    <button
                      className="primary"
                      disabled={(!chatInput.trim() && chatAttachments.length === 0) || busy}
                      onClick={() => {
                        if (activeSession && (chatInput.trim() || chatAttachments.length > 0)) {
                          void sendMessage(activeSession, chatInput.trim(), chatAttachments.length > 0 ? chatAttachments : undefined);
                          setChatInput("");
                          setChatAttachments([]);
                        }
                      }}
                    >
                      发送
                    </button>
                  </div>
                  <input type="file" ref={fileInputRef} style={{ display: "none" }} multiple
                    onChange={(e) => handleFileSelect(e, "chat")} />
                </div>
              )}
            </>
          ) : (
            <div className="empty-state">
              <h3>{projectPath ? "暂无当前项目会话" : "尚未选择项目"}</h3>
              <p>{projectPath ? "选择工作流并提交任务后，运行状态会显示在这里。" : "选择一个项目后，工作流和会话会显示在这里。"}</p>
              {!projectPath && (
                <button className="secondary" disabled={busy} onClick={chooseProject}>
                  选择项目
                </button>
              )}
            </div>
          )}
        </section>
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
    // 包含 Markdown 标记的字符串用 Markdown 渲染
    if (hasMarkdown(trimmed)) {
      return (
        <div className="markdown-content json-markdown-value">
          <ReactMarkdown>{trimmed}</ReactMarkdown>
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

/** 自定义 Markdown 组件：JSON 代码块用美化渲染 */
const markdownComponents: Components = {
  code({ className, children, ...props }) {
    const language = className?.replace("language-", "");
    const text = String(children).replace(/\n$/, "");

    // JSON 代码块：解析并美化渲染
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

    // 非代码块内的内联 code
    if (!className) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }

    // 其他语言的代码块
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
      <ReactMarkdown components={markdownComponents}>{children}</ReactMarkdown>
    </div>
  );
}

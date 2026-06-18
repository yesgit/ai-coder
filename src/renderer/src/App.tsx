import { useEffect, useMemo, useState } from "react";
import type {
  AgentSession,
  AgentRuntimeStatus,
  ApprovalRecord,
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
        onboardingOverride
      });
      upsertSession(result.session);
      setTaskPrompt("");
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

  const onboardingConfirmed = onboardingStatus?.status === "confirmed";
  const onboardingRequired = Boolean(projectPath && selectedWorkflowId !== "project-onboarding" && !onboardingConfirmed);
  const onboardingAdmissionAllowed = !onboardingRequired || onboardingOverride;
  const canStart = Boolean(projectPath && selectedWorkflowId && taskPrompt.trim() && onboardingAdmissionAllowed && !busy);
  const pendingToolCalls = activeSession?.tool_calls.filter((toolCall) => toolCall.status === "pending_approval") ?? [];
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
        <div className="composer">
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
          <textarea
            value={taskPrompt}
            onChange={(event) => setTaskPrompt(event.target.value)}
            placeholder="描述要执行的编码任务..."
          />
          <div className="actions">
            <button className="primary" disabled={!canStart} onClick={startSession}>
              {busy ? "运行中..." : "启动 Agent"}
            </button>
            {error && <span className="error">{error}</span>}
          </div>
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
                {(activeSession.status === "waiting_approval" ||
                  activeSession.status === "failed" ||
                  activeSession.status === "blocked" ||
                  activeSession.status === "interrupted") && (
                  <div className="session-actions">
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
                      <pre>{JSON.stringify(toolCall.input, null, 2)}</pre>
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
                          <p>{stageRun.output_summary ?? stageRun.input_summary}</p>
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
                          <p>{request.reason}</p>
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
                      {event.detail && <pre>{event.detail}</pre>}
                    </div>
                  </article>
                ))}
              </div>
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

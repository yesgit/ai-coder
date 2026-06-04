import { useEffect, useMemo, useState } from "react";
import type {
  AgentSession,
  AgentRuntimeStatus,
  ApprovalRecord,
  ProjectOnboardingStatus,
  ReworkRequest,
  StageRun,
  ToolCallRecord,
  WorkflowStage,
  WorkflowLoadIssue,
  WorkflowTemplate
} from "../../shared/types.js";
import { buildSessionTimeline } from "./sessionTimeline.js";
import type { TimelineEvent } from "./sessionTimeline.js";
import "./styles.css";

export default function App() {
  const [projectPath, setProjectPath] = useState("");
  const [workflows, setWorkflows] = useState<WorkflowTemplate[]>([]);
  const [workflowIssues, setWorkflowIssues] = useState<WorkflowLoadIssue[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState("");
  const [taskPrompt, setTaskPrompt] = useState("");
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [activeSession, setActiveSession] = useState<AgentSession | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<AgentRuntimeStatus | null>(null);
  const [onboardingStatus, setOnboardingStatus] = useState<ProjectOnboardingStatus | null>(null);
  const [onboardingOverride, setOnboardingOverride] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const selectedWorkflow = useMemo(
    () => workflows.find((workflow) => workflow.id === selectedWorkflowId) ?? null,
    [selectedWorkflowId, workflows]
  );

  useEffect(() => {
    void refreshRuntimeStatus();
    void refreshWorkflows();
    void refreshSessions();
  }, []);

  async function refreshRuntimeStatus() {
    setRuntimeStatus(await window.aiCoder.getAgentRuntimeStatus());
  }

  async function refreshWorkflows(nextProjectPath = projectPath) {
    const result = await window.aiCoder.listWorkflows(nextProjectPath || undefined);
    setWorkflows(result.workflows);
    setWorkflowIssues(result.issues);
    setSelectedWorkflowId((current: string) => current || result.workflows[0]?.id || "");
  }

  async function refreshOnboardingStatus(nextProjectPath = projectPath) {
    if (!nextProjectPath) {
      setOnboardingStatus(null);
      return;
    }
    setOnboardingStatus(await window.aiCoder.getProjectOnboardingStatus(nextProjectPath));
  }

  async function refreshSessions(preferredSessionId?: string) {
    const loaded = await window.aiCoder.listSessions();
    setSessions(loaded);
    setActiveSession((current) => {
      const targetId = preferredSessionId ?? current?.id;
      return loaded.find((session: AgentSession) => session.id === targetId) ?? loaded[0] ?? null;
    });
  }

  async function chooseProject() {
    setError("");
    setBusy(true);
    try {
      const selected = await window.aiCoder.selectProjectDirectory();
      if (selected) {
        setProjectPath(selected);
        setOnboardingOverride(false);
        await refreshWorkflows(selected);
        await refreshOnboardingStatus(selected);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
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
      setActiveSession(result.session);
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
      setActiveSession(updated);
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
      setActiveSession(updated);
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
      setActiveSession(approved);
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
      setActiveSession(denied);
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
      setActiveSession(updated);
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
  const showOnboardingWarning = onboardingRequired;
  const timeline = activeSession ? buildSessionTimeline(activeSession) : [];

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="mark">AI</div>
          <div>
            <h1>AI Coder</h1>
            <p>Local workflow agent</p>
          </div>
        </div>

        <button className="secondary" disabled={busy} onClick={chooseProject}>
          {busy ? "Selecting..." : "Select Project"}
        </button>
        <p className="path" title={projectPath}>
          {projectPath || "No project selected"}
        </p>

        {onboardingStatus && (
          <section className="onboarding-box">
            <h2>Onboarding</h2>
            <div className="onboarding-status-row">
              <span className={`status-pill ${onboardingStatus.status}`}>{onboardingStatus.status}</span>
              <small>{onboardingStatus.claude_md_exists ? "CLAUDE.md found" : "CLAUDE.md missing"}</small>
            </div>
            {onboardingStatus.confirmed_at && <small>Confirmed {formatTimestamp(onboardingStatus.confirmed_at)}</small>}
            {onboardingStatus.claude_md_exists && onboardingStatus.status !== "confirmed" && (
              <button className="secondary" disabled={busy} onClick={confirmOnboarding}>
                Confirm CLAUDE.md
              </button>
            )}
          </section>
        )}

        <section>
          <h2>Workflow</h2>
          <div className="workflow-list">
            {workflows.map((workflow) => (
              <button
                key={`${workflow.source.type}:${workflow.id}`}
                className={workflow.id === selectedWorkflowId ? "workflow selected" : "workflow"}
                onClick={() => setSelectedWorkflowId(workflow.id)}
              >
                <span>{workflow.name}</span>
                <small>{workflow.source.type} · v{workflow.version}</small>
              </button>
            ))}
          </div>
          {workflowIssues.length > 0 && (
            <div className="workflow-issues">
              {workflowIssues.map((issue: WorkflowLoadIssue) => (
                <div key={`${issue.source_type}:${issue.path}`} className="workflow-issue">
                  <strong>{issue.source_type}</strong>
                  <span title={issue.path}>{issue.path}</span>
                  <small>{issue.message}</small>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <h2>Sessions</h2>
          <div className="session-list">
            {sessions.map((session) => (
              <button
                key={session.id}
                className={activeSession?.id === session.id ? "session selected" : "session"}
                onClick={() => setActiveSession(session)}
              >
                <span>{session.task_prompt}</span>
                <small>{session.status}</small>
              </button>
            ))}
          </div>
        </section>
      </aside>

      <section className="workspace">
        <div className="composer">
          <div>
            <h2>{selectedWorkflow?.name ?? "Select a workflow"}</h2>
            <p>
              {selectedWorkflow?.description ?? "Choose a project and workflow to start."}
              {runtimeStatus && <span className={`runtime-mode ${runtimeStatus.mode}`}>{runtimeStatus.mode} mode</span>}
            </p>
            {runtimeStatus && (
              <div className="runtime-diagnostics">
                <span className={runtimeStatus.sdk_available ? "diagnostic ok" : "diagnostic warn"}>SDK</span>
                <span className={runtimeStatus.claude_executable_available ? "diagnostic ok" : "diagnostic warn"}>Claude CLI</span>
                <span className={runtimeStatus.auth_env_available ? "diagnostic ok" : "diagnostic warn"}>Env auth</span>
              </div>
            )}
          </div>
          <textarea
            value={taskPrompt}
            onChange={(event) => setTaskPrompt(event.target.value)}
            placeholder="Describe the coding task..."
          />
          <div className="actions">
            <button className="primary" disabled={!canStart} onClick={startSession}>
              {busy ? "Running..." : "Start Agent"}
            </button>
            {error && <span className="error">{error}</span>}
          </div>
          {showOnboardingWarning && (
            <div className="admission-warning">
              <span>Project onboarding is not confirmed. Run Project Onboarding or confirm CLAUDE.md.</span>
              <label className="override-option">
                <input
                  type="checkbox"
                  checked={onboardingOverride}
                  onChange={(event) => setOnboardingOverride(event.target.checked)}
                />
                Run without confirmed onboarding
              </label>
            </div>
          )}
        </div>

        {selectedWorkflow && (
          <div className="stages">
            {selectedWorkflow.stages.map((stage: WorkflowStage) => (
              <div key={stage.id} className="stage">
                <span>{stage.name}</span>
                {stage.approval_required && <small>approval</small>}
              </div>
            ))}
          </div>
        )}

        <section className="session-detail">
          {activeSession ? (
            <>
              <div className="session-header">
                <div>
                  <h2>{activeSession.task_prompt}</h2>
                  <p>
                    {activeSession.status} · {activeSession.workflow_id} · {activeSession.current_stage}
                  </p>
                  {activeSession.onboarding && (
                    <p>
                      onboarding {activeSession.onboarding.status}
                      {activeSession.onboarding.override ? " · override" : ""}
                    </p>
                  )}
                </div>
                {activeSession.status === "waiting_approval" && (
                  <div className="session-actions">
                    {activeSession.approvals.some((approval) => approval.kind === "stage" && approval.status === "pending") && (
                      <button className="primary" disabled={busy} onClick={() => approvePendingStage(activeSession)}>
                        Approve Stage
                      </button>
                    )}
                    {approvedToolCalls.length > 0 && (
                      <button className="secondary" disabled={busy} onClick={() => continueSession(activeSession)}>
                        Continue
                      </button>
                    )}
                  </div>
                )}
              </div>
              {pendingToolCalls.length > 0 && (
                <div className="tool-approvals">
                  {pendingToolCalls.map((toolCall: ToolCallRecord) => (
                    <article key={toolCall.id} className="tool-approval">
                      <div>
                        <strong>{toolCall.tool}</strong>
                        <small>{toolCall.stage_id}</small>
                      </div>
                      <pre>{JSON.stringify(toolCall.input, null, 2)}</pre>
                      <div className="actions">
                        <button className="primary" disabled={busy} onClick={() => approveToolCall(activeSession, toolCall)}>
                          Approve
                        </button>
                        <button className="secondary" disabled={busy} onClick={() => denyToolCall(activeSession, toolCall)}>
                          Deny
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
              <div className="run-panels">
                <section className="run-panel">
                  <div className="panel-heading">
                    <h3>Stage Runs</h3>
                    <small>{stageRuns.length} attempts</small>
                  </div>
                  {stageRuns.length > 0 ? (
                    <div className="stage-run-list">
                      {stageRuns.map((stageRun: StageRun) => (
                        <article
                          key={stageRun.id}
                          className={stageRun.stage_id === activeSession.current_stage ? "stage-run current" : "stage-run"}
                        >
                          <div className="stage-run-title">
                            <strong>{stageRun.stage_id}</strong>
                            <span className={`status-pill ${stageRun.status}`}>{stageRun.status}</span>
                          </div>
                          <small>attempt {stageRun.attempt}</small>
                          <p>{stageRun.output_summary ?? stageRun.input_summary}</p>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="muted">No stage runs recorded.</p>
                  )}
                </section>

                <section className="run-panel">
                  <div className="panel-heading">
                    <h3>Rework Requests</h3>
                    <small>{reworkRequests.length} requests</small>
                  </div>
                  {reworkRequests.length > 0 ? (
                    <div className="rework-list">
                      {reworkRequests.map((request: ReworkRequest) => (
                        <article key={request.id} className="rework-request">
                          <div className="stage-run-title">
                            <strong>
                              {request.from_stage_id} -&gt; {request.target_stage_id}
                            </strong>
                            <span className={`status-pill ${request.status}`}>{request.status}</span>
                          </div>
                          <p>{request.reason}</p>
                          {request.status === "pending" && (
                            <div className="actions">
                              <button className="primary" disabled={busy} onClick={() => approveReworkRequest(activeSession, request)}>
                                Approve Rework
                              </button>
                            </div>
                          )}
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="muted">No rework requests.</p>
                  )}
                </section>
              </div>
              {pendingReworkRequests.length > 0 && (
                <div className="pending-banner">{pendingReworkRequests.length} rework request waiting for approval.</div>
              )}
              <div className="timeline">
                {timeline.map((event: TimelineEvent) => (
                  <article key={event.id} className={`timeline-item ${event.type}`}>
                    <div className="timeline-meta">
                      <time>{formatTimestamp(event.timestamp)}</time>
                      {event.status && <span className="timeline-status">{event.status}</span>}
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
            <div className="empty">No session yet.</div>
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

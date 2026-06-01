import { useEffect, useMemo, useState } from "react";
import type { AgentMessage, AgentSession, ApprovalRecord, WorkflowStage, WorkflowTemplate } from "../../shared/types.js";
import "./styles.css";

export default function App() {
  const [projectPath, setProjectPath] = useState("");
  const [workflows, setWorkflows] = useState<WorkflowTemplate[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState("");
  const [taskPrompt, setTaskPrompt] = useState("");
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [activeSession, setActiveSession] = useState<AgentSession | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const selectedWorkflow = useMemo(
    () => workflows.find((workflow) => workflow.id === selectedWorkflowId) ?? null,
    [selectedWorkflowId, workflows]
  );

  useEffect(() => {
    void refreshWorkflows();
    void refreshSessions();
  }, []);

  async function refreshWorkflows(nextProjectPath = projectPath) {
    const loaded = await window.aiCoder.listWorkflows(nextProjectPath || undefined);
    setWorkflows(loaded);
    setSelectedWorkflowId((current: string) => current || loaded[0]?.id || "");
  }

  async function refreshSessions() {
    const loaded = await window.aiCoder.listSessions();
    setSessions(loaded);
    setActiveSession((current) => current ?? loaded[0] ?? null);
  }

  async function chooseProject() {
    setError("");
    const selected = await window.aiCoder.selectProjectDirectory();
    if (selected) {
      setProjectPath(selected);
      await refreshWorkflows(selected);
    }
  }

  async function startSession() {
    setError("");
    setBusy(true);
    try {
      const result = await window.aiCoder.startSession({
        projectPath,
        workflowId: selectedWorkflowId,
        taskPrompt
      });
      setActiveSession(result.session);
      setTaskPrompt("");
      await refreshSessions();
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
      await refreshSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const canStart = Boolean(projectPath && selectedWorkflowId && taskPrompt.trim() && !busy);

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

        <button className="secondary" onClick={chooseProject}>
          Select Project
        </button>
        <p className="path" title={projectPath}>
          {projectPath || "No project selected"}
        </p>

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
            <p>{selectedWorkflow?.description ?? "Choose a project and workflow to start."}</p>
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
                </div>
                {activeSession.status === "waiting_approval" && (
                  <button className="primary" disabled={busy} onClick={() => approvePendingStage(activeSession)}>
                    Approve Stage
                  </button>
                )}
              </div>
              <div className="messages">
                {activeSession.messages.map((message: AgentMessage, index: number) => (
                  <article key={`${message.created_at}:${index}`} className={`message ${message.role}`}>
                    <strong>{message.role}</strong>
                    <pre>{message.content}</pre>
                  </article>
                ))}
                {activeSession.error && <div className="error-block">{activeSession.error}</div>}
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

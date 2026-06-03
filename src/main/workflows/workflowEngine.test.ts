import { describe, expect, it } from "vitest";
import { WorkflowEngine } from "./workflowEngine.js";
import type { AgentSession, WorkflowTemplate } from "../../shared/types.js";

const workflow: WorkflowTemplate = {
  id: "software-engineering",
  name: "Software Engineering",
  version: "1.0.0",
  description: "Test",
  source: { type: "builtin", id: "software-engineering", version: "1.0.0" },
  permissions: { filesystem: { mode: "project-only" }, shell: { approval_required: true } },
  rework: {
    enabled: true,
    allowed_targets: ["understand", "plan"],
    approval_required: true,
    invalidate_downstream: true
  },
  stages: [
    { id: "understand", name: "Understand" },
    { id: "plan", name: "Plan", approval_required: true },
    { id: "execute", name: "Execute" }
  ]
};

function createSession(): AgentSession {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    project_path: "/tmp/project",
    workflow_id: workflow.id,
    task_prompt: "Fix the bug",
    status: "created",
    current_stage: "understand",
    messages: [],
    tool_calls: [],
    file_changes: [],
    approvals: [],
    stage_runs: [],
    rework_requests: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

describe("WorkflowEngine", () => {
  it("creates the first stage run and advances after completion", () => {
    const engine = new WorkflowEngine();
    const session = createSession();

    engine.ensureState(session, workflow);
    engine.completeCurrentStage(session, workflow, "Requirements understood");

    expect(session.stage_runs).toHaveLength(2);
    expect(session.stage_runs?.[0]).toMatchObject({ stage_id: "understand", attempt: 1, status: "completed" });
    expect(session.stage_runs?.[1]).toMatchObject({ stage_id: "plan", attempt: 1, status: "running" });
    expect(session.current_stage).toBe("plan");
  });

  it("waits for approval after an approval-required stage", () => {
    const engine = new WorkflowEngine();
    const session = createSession();

    engine.ensureState(session, workflow);
    engine.completeCurrentStage(session, workflow, "Requirements understood");
    engine.completeCurrentStage(session, workflow, "Implementation plan");

    expect(session.status).toBe("waiting_approval");
    expect(session.stage_runs?.at(-1)).toMatchObject({ stage_id: "plan", status: "waiting_approval" });
    expect(session.approvals).toHaveLength(1);
  });

  it("advances to the next stage after stage approval", () => {
    const engine = new WorkflowEngine();
    const session = createSession();

    engine.ensureState(session, workflow);
    engine.completeCurrentStage(session, workflow, "Requirements understood");
    engine.completeCurrentStage(session, workflow, "Implementation plan");
    engine.approveStage(session, workflow, "plan");

    expect(session.status).toBe("running");
    expect(session.current_stage).toBe("execute");
    expect(session.stage_runs?.at(-1)).toMatchObject({ stage_id: "execute", attempt: 1, status: "running" });
  });

  it("records a rework request and creates a new target attempt after approval", () => {
    const engine = new WorkflowEngine();
    const session = createSession();

    engine.ensureState(session, workflow);
    engine.completeCurrentStage(session, workflow, "Requirements understood");
    engine.completeCurrentStage(session, workflow, "Implementation plan");
    engine.approveStage(session, workflow, "plan");
    engine.requestRework(session, workflow, "plan", "Implementation uncovered a missing API constraint");

    expect(session.status).toBe("waiting_approval");
    expect(session.rework_requests?.[0]).toMatchObject({ target_stage_id: "plan", status: "pending" });
    expect(session.stage_runs?.at(-1)).toMatchObject({ stage_id: "execute", status: "needs_rework" });

    engine.approveRework(session, workflow, session.rework_requests?.[0].id ?? "");

    expect(session.current_stage).toBe("plan");
    expect(session.stage_runs?.at(-1)).toMatchObject({ stage_id: "plan", attempt: 2, status: "running" });
    expect(session.stage_runs?.some((stageRun) => stageRun.stage_id === "plan" && stageRun.status === "superseded")).toBe(true);
  });
});

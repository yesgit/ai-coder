import { describe, expect, it } from "vitest";
import type { AgentSession } from "../../shared/types.js";
import { getProfileAgentStatus, getProfileSkillStatus } from "./profileCapabilityStatus.js";

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "session",
    project_path: "/tmp/project",
    workflow_id: "careful-coder",
    task_prompt: "task",
    status: "running",
    current_stage: "profile",
    messages: [],
    tool_calls: [],
    file_changes: [],
    approvals: [],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

describe("profile capability status", () => {
  it("shows a host-injected Skill as completed", () => {
    const current = session({
      progress_events: [{
        id: "p1",
        type: "runner",
        message: "宿主强制加载 Skill：careful-coder:clarifying-requirements",
        visibility: "milestone",
        created_at: "2026-01-01T00:00:01.000Z"
      }]
    });

    expect(getProfileSkillStatus(current, "clarifying-requirements")).toBe("completed");
  });

  it("maps the latest Task result to the corresponding Agent state", () => {
    const current = session({
      tool_calls: [
        {
          id: "planner-1",
          stage_id: "profile",
          tool: "Task",
          input: { subagent_type: "task-planner" },
          status: "completed",
          created_at: "2026-01-01T00:00:01.000Z"
        },
        {
          id: "verifier-1",
          stage_id: "profile",
          tool: "Task",
          input: { subagent_type: "task-verifier" },
          status: "blocked",
          created_at: "2026-01-01T00:00:02.000Z"
        }
      ]
    });

    expect(getProfileAgentStatus(current, "task-planner")).toBe("completed");
    expect(getProfileAgentStatus(current, "task-verifier")).toBe("failed");
    expect(getProfileAgentStatus(current, "task-executor")).toBe("not_started");
  });
});

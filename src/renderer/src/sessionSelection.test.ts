import { describe, expect, it } from "vitest";
import type { AgentSession } from "../../shared/types.js";
import { getVisibleSessions, groupSessionsByProject, resolveActiveSessionId } from "./sessionSelection.js";

const baseSession: AgentSession = {
  id: "session-a",
  project_path: "/tmp/project-a",
  workflow_id: "plan-execute",
  task_prompt: "Fix bug",
  status: "completed",
  current_stage: "execute",
  messages: [],
  tool_calls: [],
  file_changes: [],
  approvals: [],
  stage_runs: [],
  rework_requests: [],
  created_at: "2026-06-16T01:00:00.000Z",
  updated_at: "2026-06-16T01:00:00.000Z"
};

const sessions: AgentSession[] = [
  {
    ...baseSession,
    id: "session-newer-review",
    workflow_id: "code-review",
    created_at: "2026-06-16T03:00:00.000Z"
  },
  {
    ...baseSession,
    id: "session-plan",
    workflow_id: "plan-execute",
    created_at: "2026-06-16T02:00:00.000Z"
  },
  {
    ...baseSession,
    id: "session-other-project",
    project_path: "/tmp/project-b",
    workflow_id: "plan-execute",
    created_at: "2026-06-16T04:00:00.000Z"
  }
];

describe("session selection", () => {
  it("groups sessions beneath projects and prioritizes the current project", () => {
    const groups = groupSessionsByProject(sessions, "/tmp/project-b");
    expect(groups.map((group) => group.projectName)).toEqual(["project-b", "project-a"]);
    expect(groups[1].sessions.map((session) => session.id)).toEqual(["session-newer-review", "session-plan"]);
  });

  it("sorts pinned sessions before recently updated sessions", () => {
    const groups = groupSessionsByProject([
      { ...baseSession, id: "recent", updated_at: "2026-06-16T04:00:00.000Z" },
      { ...baseSession, id: "pinned", pinned_at: "2026-06-16T01:00:00.000Z", updated_at: "2026-06-16T02:00:00.000Z" }
    ]);
    expect(groups[0].sessions.map((session) => session.id)).toEqual(["pinned", "recent"]);
  });

  it("filters sessions to the selected project", () => {
    expect(getVisibleSessions(sessions, "/tmp/project-a").map((session) => session.id)).toEqual([
      "session-newer-review",
      "session-plan"
    ]);
  });

  it("keeps the current visible session during normal refreshes", () => {
    expect(
      resolveActiveSessionId(sessions, {
        currentSessionId: "session-plan",
        projectPath: "/tmp/project-a",
        workflowId: "code-review"
      })
    ).toBe("session-plan");
  });

  it("switches to the latest matching workflow session when workflow changes", () => {
    expect(
      resolveActiveSessionId(sessions, {
        currentSessionId: "session-plan",
        projectPath: "/tmp/project-a",
        workflowId: "code-review",
        preferLatestForWorkflow: true
      })
    ).toBe("session-newer-review");
  });

  it("clears the active session when the selected workflow has no project session", () => {
    expect(
      resolveActiveSessionId(sessions, {
        currentSessionId: "session-plan",
        projectPath: "/tmp/project-a",
        workflowId: "software-engineering",
        preferLatestForWorkflow: true
      })
    ).toBeNull();
  });

  it("does not fall back to another workflow when no active session is selected", () => {
    expect(
      resolveActiveSessionId(sessions, {
        currentSessionId: null,
        projectPath: "/tmp/project-a",
        workflowId: "software-engineering"
      })
    ).toBeNull();
  });
});

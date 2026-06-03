import { describe, expect, it } from "vitest";
import { buildSessionTimeline } from "./sessionTimeline.js";
import type { AgentSession } from "../../shared/types.js";

const session: AgentSession = {
  id: "session-1",
  project_path: "/tmp/project",
  workflow_id: "software-engineering",
  task_prompt: "Fix checkout bug",
  status: "waiting_approval",
  current_stage: "execute",
  created_at: "2026-06-03T01:00:00.000Z",
  updated_at: "2026-06-03T01:05:00.000Z",
  messages: [
    {
      role: "assistant",
      content: "I found the checkout handler.",
      created_at: "2026-06-03T01:02:00.000Z"
    }
  ],
  approvals: [
    {
      id: "approval-1",
      stage_id: "plan",
      kind: "stage",
      status: "approved",
      message: "Approve implementation plan",
      created_at: "2026-06-03T01:01:00.000Z",
      resolved_at: "2026-06-03T01:03:00.000Z"
    }
  ],
  tool_calls: [
    {
      id: "tool-1",
      stage_id: "execute",
      tool: "shell",
      input: { command: "npm test" },
      status: "pending_approval",
      created_at: "2026-06-03T01:04:00.000Z"
    }
  ],
  file_changes: [
    {
      path: "src/checkout.ts",
      operation: "update",
      approved: true,
      created_at: "2026-06-03T01:04:30.000Z"
    }
  ]
};

describe("buildSessionTimeline", () => {
  it("merges session records into chronological timeline events", () => {
    const events = buildSessionTimeline(session);

    expect(events.map((event) => event.title)).toEqual([
      "Task submitted",
      "Stage approval requested",
      "Assistant message",
      "Stage approval approved",
      "Tool requested: shell",
      "File update",
      "Session waiting_approval"
    ]);
  });

  it("adds an error event before the final status when the session failed", () => {
    const failedSession: AgentSession = {
      ...session,
      status: "failed",
      error: "Claude Agent SDK request failed"
    };

    const events = buildSessionTimeline(failedSession);

    expect(events.at(-2)).toMatchObject({
      type: "error",
      title: "Session failed",
      detail: "Claude Agent SDK request failed"
    });
    expect(events.at(-1)).toMatchObject({ type: "status", title: "Session failed" });
  });
});

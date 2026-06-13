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
  ],
  stage_runs: [],
  rework_requests: []
};

describe("buildSessionTimeline", () => {
  it("merges session records into chronological timeline events", () => {
    const events = buildSessionTimeline(session);

    expect(events.map((event) => event.title)).toEqual([
      "任务已提交",
      "阶段审批待处理",
      "助手消息",
      "阶段审批已批准",
      "工具请求：shell",
      "文件更新",
      "会话等待审批"
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
      title: "会话失败",
      detail: "Claude Agent SDK request failed"
    });
    expect(events.at(-1)).toMatchObject({ type: "status", title: "会话失败" });
  });

  it("includes stage attempts and rework requests", () => {
    const reworkSession: AgentSession = {
      ...session,
      stage_runs: [
        {
          id: "stage-run-1",
          stage_id: "execute",
          attempt: 1,
          status: "needs_rework",
          input_summary: "Implementation plan",
          rework_reason: "Missing API constraint",
          started_at: "2026-06-03T01:03:30.000Z",
          completed_at: "2026-06-03T01:04:45.000Z"
        },
        {
          id: "stage-run-2",
          stage_id: "plan",
          attempt: 2,
          status: "running",
          input_summary: "Rework requested from execute: Missing API constraint",
          started_at: "2026-06-03T01:05:30.000Z"
        }
      ],
      rework_requests: [
        {
          id: "rework-1",
          from_stage_id: "execute",
          target_stage_id: "plan",
          status: "approved",
          reason: "Missing API constraint",
          created_at: "2026-06-03T01:05:00.000Z",
          resolved_at: "2026-06-03T01:05:20.000Z"
        }
      ]
    };

    const events = buildSessionTimeline(reworkSession);

    expect(events.map((event) => event.title)).toContain("阶段需要返工：执行 第 1 次尝试");
    expect(events.map((event) => event.title)).toContain("返工请求：执行 -> 计划");
    expect(events.map((event) => event.title)).toContain("阶段开始：计划 第 2 次尝试");
  });
});

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

    // 倒序排列：需要用户操作的事件（待审批工具）优先，然后是其他事件按时间戳倒序
    expect(events.map((event) => event.title)).toEqual([
      "工具请求：shell", // pending_approval，needs_user_action=true，优先显示
      "会话等待审批", // sort_order=100，时间戳最新 (01:05:00)
      "文件更新", // approved=true，needs_user_action=false，时间戳 (01:04:30)
      "阶段审批已批准", // resolved_at (01:03:00)
      "助手消息", // 时间戳 (01:02:00)
      "阶段审批待处理", // created_at (01:01:00)
      "任务已提交" // 时间戳最早 (01:00:00)
    ]);
  });

  it("adds an error event before the final status when the session failed", () => {
    const failedSession: AgentSession = {
      ...session,
      status: "failed",
      error: "Claude Agent SDK request failed"
    };

    const events = buildSessionTimeline(failedSession);

    expect(events.find((event) => event.type === "error")).toMatchObject({
      type: "error",
      title: "会话失败",
      detail: "Claude Agent SDK request failed"
    });
    expect(events.find((event) => event.id === `${session.id}:status`)).toMatchObject({ type: "status", title: "会话失败" });
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

  it("shows transient progress in the timeline (marked transient)", () => {
    const events = buildSessionTimeline({
      ...session,
      progress_events: [
        {
          id: "progress-1",
          type: "sdk_message",
          message: "收到 Claude SDK 消息：assistant",
          visibility: "transient",
          created_at: "2026-06-03T01:04:10.000Z"
        },
        {
          id: "progress-2",
          type: "runner",
          message: "开始执行阶段：Plan",
          visibility: "milestone",
          created_at: "2026-06-03T01:04:20.000Z"
        }
      ]
    });

    const transientProgress = events.find((e) => e.detail === "收到 Claude SDK 消息：assistant");
    const milestoneProgress = events.find((e) => e.detail === "开始执行阶段：Plan");

    // v2：transient 现在也展示（让用户看到"在跑"），但标记 transient 以供渲染区分轻样式
    expect(transientProgress).toBeDefined();
    expect(transientProgress?.transient).toBe(true);
    expect(transientProgress?.title).toBe("实时活动");
    // milestone 不标 transient
    expect(milestoneProgress).toBeDefined();
    expect(milestoneProgress?.transient).toBeFalsy();
    expect(milestoneProgress?.title).toBe("运行进度");
  });

  it("filters out empty or placeholder assistant messages", () => {
    const events = buildSessionTimeline({
      ...session,
      messages: [
        {
          role: "assistant",
          content: "",
          created_at: "2026-06-03T01:01:00.000Z"
        },
        {
          role: "assistant",
          content: "(no content)",
          created_at: "2026-06-03T01:01:30.000Z"
        },
        {
          role: "assistant",
          content: "收到 Claude SDK 消息：assistant",
          created_at: "2026-06-03T01:02:00.000Z"
        },
        {
          role: "assistant",
          content: "Valid message with actual content",
          created_at: "2026-06-03T01:02:30.000Z"
        }
      ]
    });

    const details = events.filter((e) => e.type === "message").map((e) => e.detail);
    expect(details).not.toContain("");
    expect(details).not.toContain("(no content)");
    expect(details).not.toContain("收到 Claude SDK 消息：assistant");
    expect(details).toContain("Valid message with actual content");
  });

  it("prioritizes pending approvals and human questions at the top", () => {
    const events = buildSessionTimeline({
      ...session,
      approvals: [
        {
          id: "approval-pending",
          stage_id: "plan",
          kind: "stage",
          status: "pending",
          message: "Awaiting stage approval",
          created_at: "2026-06-03T01:01:00.000Z"
        }
      ],
      pending_human_questions: [
        {
          id: "question-1",
          stage_id: "execute",
          question: "Which testing framework should be used?",
          question_type: "single",
          options: [
            { value: "jest", label: "Jest" },
            { value: "vitest", label: "Vitest" }
          ],
          status: "pending",
          created_at: "2026-06-03T01:03:00.000Z"
        }
      ]
    });

    // 所有 pending 事件显示在最上面，pending 事件内部按时间戳倒序
    const titles = events.map((e) => e.title);
    expect(titles[0]).toBe("工具请求：shell"); // pending_approval, 时间戳最新 (01:04:00)
    expect(titles[1]).toBe("助手提问待回答"); // pending human question, 时间戳 (01:03:00)
    expect(titles[2]).toBe("阶段审批待处理"); // pending approval, 时间戳最早 (01:01:00)
  });

  it("wraps embedded JSON blocks in fenced code blocks", () => {
    const content =
      "现在我已经收集了足够的证据。让我总结 investigate 阶段的发现：\n\n" +
      JSON.stringify({
        status: "completed",
        output_summary: "已完成取证阶段。",
        required_outputs: { similar_callsites: ["a", "b"] }
      });
    const events = buildSessionTimeline({
      ...session,
      messages: [
        {
          role: "assistant",
          content,
          created_at: "2026-06-03T01:02:00.000Z"
        }
      ]
    });
    const messageEvent = events.find((e) => e.type === "message");
    expect(messageEvent).toBeDefined();
    // 中文叙述前缀保留
    expect(messageEvent!.detail).toContain("现在我已经收集了足够的证据");
    // JSON 被包成 ```json 代码块，且被 prettify（带换行缩进）
    expect(messageEvent!.detail).toMatch(/```json\n\{\n  "status": "completed",/);
    expect(messageEvent!.detail).toMatch(/\n\}\n```/);
    // 不应有原始单行 JSON 残留
    expect(messageEvent!.detail).not.toMatch(/\{"status":"completed"/);
  });

  it("does not double-wrap JSON already inside a fenced code block", () => {
    const content =
      "前文叙述。\n\n```json\n" +
      JSON.stringify({ a: 1, b: 2 }, null, 2) +
      "\n```\n\n后文叙述。";
    const events = buildSessionTimeline({
      ...session,
      messages: [
        {
          role: "assistant",
          content,
          created_at: "2026-06-03T01:02:00.000Z"
        }
      ]
    });
    const messageEvent = events.find((e) => e.type === "message");
    expect(messageEvent).toBeDefined();
    // 原 fenced code block 不被改写：仍是单一 ``` 对儿
    const fenceCount = (messageEvent!.detail!.match(/```/g) ?? []).length;
    expect(fenceCount).toBe(2);
  });

  it("leaves inline short JSON-like fragments alone", () => {
    const events = buildSessionTimeline({
      ...session,
      messages: [
        {
          role: "assistant",
          content: '配置示例：{"a":1} 就够了。',
          created_at: "2026-06-03T01:02:00.000Z"
        }
      ]
    });
    const messageEvent = events.find((e) => e.type === "message");
    expect(messageEvent!.detail).not.toContain("```");
    expect(messageEvent!.detail).toContain('{"a":1}');
  });
});

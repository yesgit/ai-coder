import { describe, expect, it } from "vitest";
import { ClaudeAgentRunner, describeSdkMessageSnippet } from "./claudeAgentRunner.js";
import type { AgentSession, WorkflowTemplate } from "../../shared/types.js";

const workflow: WorkflowTemplate = {
  id: "software-engineering",
  name: "Software Engineering",
  version: "1.0.0",
  description: "Test",
  source: { type: "builtin", id: "software-engineering", version: "1.0.0" },
  permissions: { filesystem: { mode: "project-only" }, shell: { approval_required: true } },
  rework: { enabled: false, allowed_targets: [], approval_required: true, invalidate_downstream: true },
  stages: [
    { id: "plan", name: "Plan", approval_required: true },
    { id: "execute", name: "Execute", allowed_tools: ["read_file", "edit_file", "shell"] }
  ]
};

describe("ClaudeAgentRunner", () => {
  it("continues into the next running stage until an approval gate is reached", async () => {
    const multiStageWorkflow: WorkflowTemplate = {
      ...workflow,
      stages: [
        { id: "requirements", name: "Requirements" },
        { id: "plan", name: "Plan", approval_required: true },
        { id: "execute", name: "Execute" }
      ]
    };
    let calls = 0;
    async function* query() {
      calls += 1;
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify({
          status: "completed",
          output_summary: calls === 1 ? "Requirements understood" : "Implementation plan"
        })
      };
    }

    const session: AgentSession = {
      id: "00000000-0000-4000-8000-000000000010",
      project_path: "/tmp/project",
      workflow_id: workflow.id,
      task_prompt: "Fix the bug",
      status: "running",
      current_stage: "requirements",
      messages: [],
      tool_calls: [],
      file_changes: [],
      approvals: [],
      stage_runs: [
        {
          id: "00000000-0000-4000-8000-000000000011",
          stage_id: "requirements",
          attempt: 1,
          status: "running",
          input_summary: "Initial task",
          started_at: new Date().toISOString()
        }
      ],
      rework_requests: [],
      progress_events: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow: multiStageWorkflow });

    expect(calls).toBe(2);
    expect(updated.status).toBe("waiting_approval");
    expect(updated.current_stage).toBe("plan");
    expect(updated.stage_runs?.[0]).toMatchObject({ stage_id: "requirements", status: "completed" });
    expect(updated.stage_runs?.at(-1)).toMatchObject({ stage_id: "plan", status: "waiting_approval" });
  });

  it("waits for stage approval before live or mock execution", async () => {
    const previousKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";

    const session: AgentSession = {
      id: "00000000-0000-4000-8000-000000000000",
      project_path: "/tmp/project",
      workflow_id: workflow.id,
      task_prompt: "Fix the bug",
      status: "running",
      current_stage: "plan",
      messages: [],
      tool_calls: [],
      file_changes: [],
      approvals: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          stage_id: "plan",
          kind: "stage",
          status: "pending",
          message: "Approval required",
          created_at: new Date().toISOString()
        }
      ],
      stage_runs: [
        {
          id: "00000000-0000-4000-8000-000000000002",
          stage_id: "plan",
          attempt: 1,
          status: "waiting_approval",
          input_summary: "Initial task",
          started_at: new Date().toISOString()
        }
      ],
      rework_requests: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    try {
      const updated = await new ClaudeAgentRunner().run({ session, workflow });

      expect(updated.status).toBe("waiting_approval");
      expect(updated.current_stage).toBe("plan");
      expect(updated.messages.at(-1)?.content).toContain("等待审批");
    } finally {
      if (previousKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = previousKey;
      }
    }
  });

  it("preserves SDK messages when the Claude process exits after an auth error", async () => {
    async function* query() {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "Invalid API key · Please run /login" }] },
        error: "authentication_failed"
      };
      yield {
        type: "result",
        subtype: "success",
        is_error: true,
        result: "Invalid API key · Please run /login"
      };
      throw new Error("Claude Code process exited with code 1");
    }

    const session: AgentSession = {
      id: "00000000-0000-4000-8000-000000000003",
      project_path: "/tmp/project",
      workflow_id: workflow.id,
      task_prompt: "Fix the bug",
      status: "running",
      current_stage: "execute",
      messages: [],
      tool_calls: [],
      file_changes: [],
      approvals: [],
      stage_runs: [
        {
          id: "00000000-0000-4000-8000-000000000004",
          stage_id: "execute",
          attempt: 1,
          status: "running",
          input_summary: "Approved plan",
          started_at: new Date().toISOString()
        }
      ],
      rework_requests: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow });

    expect(updated.status).toBe("failed");
    expect(updated.error).toContain("Invalid API key");
    expect(updated.messages.at(-1)?.content).toContain("Invalid API key");
    expect(updated.stage_runs?.at(-1)).toMatchObject({
      status: "failed",
      output_summary: expect.stringContaining("Invalid API key")
    });
  });
});

describe("describeSdkMessageSnippet", () => {
  it("assistant 文本 block 提取前 80 字", () => {
    const msg = {
      type: "assistant",
      message: { content: [{ type: "text", text: "正在查看登录模块的实现，确认鉴权逻辑..." }] }
    };
    expect(describeSdkMessageSnippet(msg)).toBe("正在查看登录模块的实现，确认鉴权逻辑...");
  });

  it("assistant 文本超长截断 80 字", () => {
    const long = "x".repeat(120);
    const msg = { type: "assistant", message: { content: [{ type: "text", text: long }] } };
    expect(describeSdkMessageSnippet(msg).length).toBe(80);
  });

  it("assistant tool_use 提取工具名 + file_path", () => {
    const msg = {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/auth.ts" } }] }
    };
    expect(describeSdkMessageSnippet(msg)).toBe("调用 Read(src/auth.ts)");
  });

  it("assistant tool_use 提取 command 片段", () => {
    const msg = {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git log --oneline -5" } }] }
    };
    expect(describeSdkMessageSnippet(msg)).toBe("调用 Bash(git log --oneline -5)");
  });

  it("assistant 混合 text + tool_use", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "先看一下历史。" },
          { type: "tool_use", name: "Bash", input: { command: "git log" } }
        ]
      }
    };
    expect(describeSdkMessageSnippet(msg)).toBe("先看一下历史。 | 调用 Bash(git log)");
  });

  it("assistant 无 content", () => {
    expect(describeSdkMessageSnippet({ type: "assistant", message: { content: [] } })).toBe("助手消息（无文本）");
  });

  it("result / tool_result / 其他类型", () => {
    expect(describeSdkMessageSnippet({ type: "result" })).toBe("阶段结果");
    expect(describeSdkMessageSnippet({ type: "tool_result" })).toBe("工具结果");
    expect(describeSdkMessageSnippet({ type: "system" })).toBe("SDK:system");
  });
});

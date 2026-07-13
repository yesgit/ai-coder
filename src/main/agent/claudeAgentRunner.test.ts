import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
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
    expect(updated.messages.some((message) => message.content.includes("阶段重试"))).toBe(false);
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

  it("waits inside the active SDK tool callback until a pending tool approval is resolved", async () => {
    let permissionResult: unknown;
    async function* query(params: unknown) {
      const canUseTool = (params as {
        options: {
          canUseTool: (
            toolName: string,
            input: Record<string, unknown>,
            options: { toolUseID: string }
          ) => Promise<unknown>;
        };
      }).options.canUseTool;
      permissionResult = await canUseTool("Bash", { command: "node script.js" }, { toolUseID: "tool-await" });
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify({
          status: "completed",
          output_summary: "Executed after approval"
        })
      };
    }

    const session: AgentSession = {
      id: "00000000-0000-4000-8000-000000000020",
      project_path: "/tmp/project",
      workflow_id: workflow.id,
      task_prompt: "Run tests",
      status: "running",
      current_stage: "execute",
      messages: [],
      tool_calls: [],
      file_changes: [],
      approvals: [],
      stage_runs: [
        {
          id: "00000000-0000-4000-8000-000000000021",
          stage_id: "execute",
          attempt: 1,
          status: "running",
          input_summary: "Approved plan",
          started_at: new Date().toISOString()
        }
      ],
      rework_requests: [],
      progress_events: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const runner = new ClaudeAgentRunner(query);
    const run = runner.run({ session, workflow });
    await waitFor(() => session.tool_calls.some((toolCall) => toolCall.id === "tool-await" && toolCall.status === "pending_approval"));

    expect(session.status).toBe("waiting_approval");
    expect(runner.resolveToolApproval(session.id, "tool-await", "approved")).toBe(true);

    const updated = await run;
    expect(permissionResult).toMatchObject({ behavior: "allow", updatedInput: { command: "node script.js" } });
    expect(updated.tool_calls.find((toolCall) => toolCall.id === "tool-await")).toMatchObject({ status: "completed" });
    expect(updated.status).toBe("completed");
  });

  it("does not block the session when a tool call is denied by policy", async () => {
    let permissionResult: unknown;
    async function* query(params: unknown) {
      const canUseTool = (params as {
        options: {
          canUseTool: (
            toolName: string,
            input: Record<string, unknown>,
            options: { toolUseID: string }
          ) => Promise<unknown>;
        };
      }).options.canUseTool;
      permissionResult = await canUseTool("Bash", { command: "rm -rf /" }, { toolUseID: "tool-blocked" });
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify({
          status: "completed",
          output_summary: "Continued without the blocked command"
        })
      };
    }

    const session: AgentSession = {
      id: "00000000-0000-4000-8000-000000000040",
      project_path: "/tmp/project",
      workflow_id: workflow.id,
      task_prompt: "Run something risky",
      status: "running",
      current_stage: "execute",
      messages: [],
      tool_calls: [],
      file_changes: [],
      approvals: [],
      stage_runs: [
        {
          id: "00000000-0000-4000-8000-000000000041",
          stage_id: "execute",
          attempt: 1,
          status: "running",
          input_summary: "Approved plan",
          started_at: new Date().toISOString()
        }
      ],
      rework_requests: [],
      progress_events: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow });

    expect(permissionResult).toMatchObject({ behavior: "deny", interrupt: false });
    expect(updated.tool_calls.find((toolCall) => toolCall.id === "tool-blocked")).toMatchObject({ status: "blocked" });
    expect(updated.status).toBe("completed");
    expect(updated.error).toBeUndefined();
  });

  it("denies direct PDF Read so unsupported document blocks are not sent to the backend", async () => {
    let permissionResult: unknown;
    async function* query(params: unknown) {
      const canUseTool = (params as {
        options: {
          canUseTool: (
            toolName: string,
            input: Record<string, unknown>,
            options: { toolUseID: string }
          ) => Promise<unknown>;
        };
      }).options.canUseTool;
      permissionResult = await canUseTool("Read", { file_path: ".ai-coder/uploads/spec.pdf" }, { toolUseID: "read-pdf" });
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify({
          status: "completed",
          output_summary: "Read PNG pages instead"
        })
      };
    }

    const session: AgentSession = {
      id: "00000000-0000-4000-8000-000000000050",
      project_path: "/tmp/project",
      workflow_id: workflow.id,
      task_prompt: "Read a PDF",
      status: "running",
      current_stage: "execute",
      messages: [],
      tool_calls: [],
      file_changes: [],
      approvals: [],
      stage_runs: [
        {
          id: "00000000-0000-4000-8000-000000000051",
          stage_id: "execute",
          attempt: 1,
          status: "running",
          input_summary: "Approved plan",
          started_at: new Date().toISOString()
        }
      ],
      rework_requests: [],
      progress_events: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow });

    expect(permissionResult).toMatchObject({ behavior: "deny", interrupt: false });
    expect(JSON.stringify(permissionResult)).toContain("不支持 PDF document content block");
    expect(updated.status).toBe("completed");
  });

  it("caps PDF page image reads in a stage so large documents do not exhaust context", async () => {
    const permissionResults: unknown[] = [];
    const projectPath = await mkdtemp(path.join(tmpdir(), "ai-coder-runner-"));
    const uploadPath = path.join(projectPath, ".ai-coder", "uploads", "spec");
    await mkdir(uploadPath, { recursive: true });
    for (let page = 1; page <= 9; page += 1) {
      const padded = String(page).padStart(2, "0");
      await writeFile(path.join(uploadPath, `page-${padded}.png`), "");
    }

    async function* query(params: unknown) {
      const canUseTool = (params as {
        options: {
          canUseTool: (
            toolName: string,
            input: Record<string, unknown>,
            options: { toolUseID: string }
          ) => Promise<unknown>;
        };
      }).options.canUseTool;

      for (let page = 1; page <= 9; page += 1) {
        const padded = String(page).padStart(2, "0");
        permissionResults.push(
          await canUseTool(
            "Read",
            { file_path: path.join(uploadPath, `page-${padded}.png`) },
            { toolUseID: `read-page-${padded}` }
          )
        );
      }

      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify({
          status: "completed",
          output_summary: "Summarized visible PDF pages"
        })
      };
    }

    const session: AgentSession = {
      id: "00000000-0000-4000-8000-000000000080",
      project_path: projectPath,
      workflow_id: workflow.id,
      task_prompt: "Understand a long PDF",
      status: "running",
      current_stage: "execute",
      messages: [],
      tool_calls: [],
      file_changes: [],
      approvals: [],
      stage_runs: [
        {
          id: "00000000-0000-4000-8000-000000000081",
          stage_id: "execute",
          attempt: 1,
          status: "running",
          input_summary: "Approved plan",
          started_at: new Date().toISOString()
        }
      ],
      rework_requests: [],
      progress_events: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow });

    expect(permissionResults).toHaveLength(9);
    expect(permissionResults.slice(0, 8).every((result) => JSON.stringify(result).includes("\"allow\""))).toBe(true);
    const deniedResult = permissionResults.find((result) => JSON.stringify(result).includes("\"deny\""));
    expect(deniedResult).toMatchObject({ behavior: "deny", interrupt: false });
    expect(JSON.stringify(deniedResult)).toContain("本阶段已读取 8 张 PDF 拆页图片");
    expect(updated.progress_events?.some((event) => event.message.includes("限制 PDF 拆页读取"))).toBe(true);
    expect(updated.status).toBe("completed");
  });

  it("does not record transient sdk_message progress for assistant messages without visible content", async () => {
    async function* query() {
      yield {
        type: "assistant",
        message: { content: [] }
      };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify({
          status: "completed",
          output_summary: "Done"
        })
      };
    }

    const session: AgentSession = {
      id: "00000000-0000-4000-8000-000000000030",
      project_path: "/tmp/project",
      workflow_id: workflow.id,
      task_prompt: "Run something",
      status: "running",
      current_stage: "execute",
      messages: [],
      tool_calls: [],
      file_changes: [],
      approvals: [],
      stage_runs: [
        {
          id: "00000000-0000-4000-8000-000000000031",
          stage_id: "execute",
          attempt: 1,
          status: "running",
          input_summary: "Approved plan",
          started_at: new Date().toISOString()
        }
      ],
      rework_requests: [],
      progress_events: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow });

    expect(updated.progress_events?.some((event) => event.type === "sdk_message" && event.message === "助手消息（无文本）")).toBe(false);
  });

  it("does not run or append messages for a terminal session", async () => {
    let called = false;
    async function* query() {
      called = true;
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify({ status: "completed", output_summary: "Should not run" })
      };
    }

    const session: AgentSession = {
      id: "00000000-0000-4000-8000-000000000060",
      project_path: "/tmp/project",
      workflow_id: workflow.id,
      task_prompt: "Already done",
      status: "completed",
      current_stage: "execute",
      messages: [{ role: "assistant", content: "Final answer", created_at: new Date().toISOString() }],
      tool_calls: [],
      file_changes: [],
      approvals: [],
      stage_runs: [
        {
          id: "00000000-0000-4000-8000-000000000061",
          stage_id: "execute",
          attempt: 1,
          status: "completed",
          input_summary: "Approved plan",
          output_summary: "Final answer",
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString()
        }
      ],
      rework_requests: [],
      progress_events: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow });

    expect(called).toBe(false);
    expect(updated.messages).toHaveLength(1);
    expect(updated.messages[0].content).toBe("Final answer");
  });

  it("deduplicates identical assistant transcripts in recent history", async () => {
    async function* query() {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "Repeated answer" }] }
      };
    }

    const session: AgentSession = {
      id: "00000000-0000-4000-8000-000000000070",
      project_path: "/tmp/project",
      workflow_id: workflow.id,
      task_prompt: "Repeat",
      status: "running",
      current_stage: "execute",
      messages: [{ role: "assistant", content: "Repeated   answer", created_at: new Date().toISOString() }],
      tool_calls: [],
      file_changes: [],
      approvals: [],
      stage_runs: [
        {
          id: "00000000-0000-4000-8000-000000000071",
          stage_id: "execute",
          attempt: 1,
          status: "running",
          input_summary: "Approved plan",
          started_at: new Date().toISOString()
        }
      ],
      rework_requests: [],
      progress_events: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow });

    expect(updated.status).toBe("completed");
    expect(updated.messages).toHaveLength(1);
    expect(updated.messages[0].content).toBe("Repeated   answer");
  });
});

async function waitFor(assertion: () => boolean): Promise<void> {
  const started = Date.now();
  while (!assertion()) {
    if (Date.now() - started > 1000) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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

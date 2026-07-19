import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildClaudeSdkEnv, ClaudeAgentRunner, describeSdkMessageSnippet, describeToolAttempt, evaluateHumanQuestionRequest, evaluateProfileCompletion, extractSdkTerminalError, extractSdkToolUses, extractToolExecutionResult, formatProfileAttachmentList, hasSuccessfulSdkTerminalResult, parseBestStageAgentResult } from "./claudeAgentRunner.js";
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

async function waitFor(assertion: () => boolean): Promise<void> {
  const started = Date.now();
  while (!assertion()) {
    if (Date.now() - started > 1000) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("ClaudeAgentRunner", () => {
  it("preserves a successful Profile result when the SDK process crashes during cleanup", async () => {
    const profileWorkflow: WorkflowTemplate = {
      ...workflow,
      id: "profile-workflow",
      stages: []
    };
    async function* query() {
      yield {
        type: "assistant",
        message: { content: [{ type: "text", text: "Implementation and verification completed." }] }
      };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Done"
      };
      throw new Error("Claude Code process terminated by signal SIGSEGV");
    }
    const session = {
      id: "00000000-0000-4000-8000-000000000071",
      project_path: "/tmp/project",
      workflow_id: profileWorkflow.id,
      task_prompt: "Complete the task",
      status: "running",
      current_stage: "profile",
      messages: [],
      tool_calls: [],
      file_changes: [],
      approvals: [],
      stage_runs: [],
      rework_requests: [],
      progress_events: [],
      task_tree: {
        goal_restated: "完成任务",
        strategy: "实现并验证",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        tasks: [{
          id: "t1",
          description: "实现并验证",
          dependencies: [],
          status: "completed",
          evidence: "tests passed"
        }]
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    } as AgentSession;

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect(updated.status, updated.error).toBe("completed");
    expect(updated.error).toBeUndefined();
    expect(updated.messages.at(-1)?.content).toContain("Implementation and verification completed.");
    expect(updated.progress_events?.some((event) =>
      event.message.includes("SDK 已返回成功结果；子进程随后异常退出，本轮结果已保留")
    )).toBe(true);
    expect(updated.progress_events?.some((event) => event.message.startsWith("API 调用失败："))).toBe(false);
  });

  it("retries a Profile subprocess crash that occurs before a successful terminal result", async () => {
    const profileWorkflow: WorkflowTemplate = {
      ...workflow,
      id: "profile-workflow",
      stages: []
    };
    let attempt = 0;
    async function* query() {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("Claude Code process terminated by signal SIGSEGV");
      }
      yield { type: "result", subtype: "success", is_error: false, result: "Recovered" };
    }
    const session = {
      id: "00000000-0000-4000-8000-000000000072",
      project_path: "/tmp/project",
      workflow_id: profileWorkflow.id,
      task_prompt: "Complete the task",
      status: "running",
      current_stage: "profile",
      messages: [],
      tool_calls: [],
      file_changes: [],
      approvals: [],
      stage_runs: [],
      rework_requests: [],
      progress_events: [],
      task_tree: {
        goal_restated: "完成任务",
        strategy: "实现并验证",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        tasks: [{
          id: "t1",
          description: "实现并验证",
          dependencies: [],
          status: "completed",
          evidence: "tests passed"
        }]
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    } as AgentSession;

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect(attempt).toBe(2);
    expect(updated.status, updated.error).toBe("completed");
    expect(updated.messages.at(-1)?.content).toBe("Recovered");
  });

  it("applies task-tree mutations in the host permission callback when the MCP handler produces no state", async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), "ai-coder-profile-"));
    await mkdir(path.join(projectPath, ".ai-coder/uploads/spec"), { recursive: true });
    await writeFile(path.join(projectPath, ".ai-coder/uploads/spec/page-19.png"), "fixture");
    const profileWorkflow: WorkflowTemplate = {
      ...workflow,
      id: "profile-workflow",
      stages: [],
      agents: {
        "task-planner": { description: "plan", prompt: "plan" },
        "task-executor": { description: "execute", prompt: "execute" },
        "task-verifier": { description: "verify", prompt: "verify" },
        "completeness-checker": { description: "audit", prompt: "audit" }
      }
    };
    let receivedPrompt = "";
    async function* query(params: unknown) {
      const typed = params as {
        prompt: string;
        options: {
          canUseTool: (
            toolName: string,
            input: Record<string, unknown>,
            options: { toolUseID: string }
          ) => Promise<unknown>;
        };
      };
      receivedPrompt = typed.prompt;
      await typed.options.canUseTool("mcp__ai_coder__update_task_tree", {
        action: "bootstrap",
        goal_restated: "实现附件需求",
        strategy: "按实现和验证拆分",
        tasks: {
          t1: { description: "实现并验证", dependencies: [] }
        },
        next_focus: "t1",
        next_reason: "开始实现"
      }, { toolUseID: "tree-bootstrap" });
      await typed.options.canUseTool("mcp__ai_coder__update_task_tree", {
        action: "bootstrap",
        tasks: { malformed: "not-a-task" }
      }, { toolUseID: "tree-duplicate-bootstrap" });
      await typed.options.canUseTool("Task", {
        subagent_type: "task-executor",
        description: "执行 t1"
      }, { toolUseID: "task-t1" });
      await typed.options.canUseTool("mcp__ai_coder__update_task_tree", {
        action: "update_status",
        task_id: "t1",
        new_status: "completed",
        evidence: "npm test: passed"
      }, { toolUseID: "tree-complete" });
      await typed.options.canUseTool("Task", {
        subagent_type: "completeness-checker",
        description: "审计 host-final-audit"
      }, { toolUseID: "task-final-audit" });
      await typed.options.canUseTool("mcp__ai_coder__update_task_tree", {
        action: "update_status",
        task_id: "host-final-audit",
        new_status: "completed",
        evidence: "completeness-checker: all requirements covered"
      }, { toolUseID: "tree-final-audit" });
      yield { type: "result", subtype: "success", is_error: false, result: "Done" };
    }
    const session = {
      id: "00000000-0000-4000-8000-000000000073",
      project_path: projectPath,
      workflow_id: profileWorkflow.id,
      task_prompt: "实现附件需求",
      initial_user_message: {
        role: "user",
        content: "实现附件需求",
        created_at: new Date().toISOString(),
        attachments: [{
          type: "file_ref",
          path: ".ai-coder/uploads/spec/page-19.png",
          display_name: "需求.pdf · 第 19 页 / 共 21 页"
        }]
      },
      status: "running",
      current_stage: "profile",
      messages: [],
      tool_calls: [
        {
          id: "executor-completed",
          stage_id: "profile",
          tool: "Task",
          input: { subagent_type: "task-executor", description: "执行 t1" },
          status: "completed",
          created_at: new Date().toISOString()
        },
        {
          id: "verifier-completed",
          stage_id: "profile",
          tool: "Task",
          input: { subagent_type: "task-verifier", description: "验证 t1" },
          status: "completed",
          created_at: new Date().toISOString()
        },
        {
          id: "audit-completed",
          stage_id: "profile",
          tool: "Task",
          input: { subagent_type: "completeness-checker", description: "审计 host-final-audit" },
          status: "completed",
          created_at: new Date().toISOString()
        }
      ],
      file_changes: [],
      approvals: [],
      stage_runs: [],
      rework_requests: [],
      progress_events: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    } as AgentSession;

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect(updated.status, updated.error).toBe("completed");
    expect(updated.task_tree?.tasks).toEqual([
      expect.objectContaining({ id: "t1", status: "completed", evidence: "npm test: passed" }),
      expect.objectContaining({ id: "host-final-audit", status: "completed" })
    ]);
    expect(receivedPrompt).toContain(".ai-coder/uploads/spec/page-19.png");
    expect(receivedPrompt).toContain("需求.pdf · 第 19 页 / 共 21 页");
  });

  it("stops after three successful queries with no verifiable progress", async () => {
    const profileWorkflow: WorkflowTemplate = {
      ...workflow,
      id: "profile-workflow",
      stages: []
    };
    let attempts = 0;
    async function* query() {
      attempts += 1;
      yield { type: "result", subtype: "success", is_error: false, result: "Still planning" };
    }
    const session = {
      id: "00000000-0000-4000-8000-000000000074",
      project_path: "/tmp/project",
      workflow_id: profileWorkflow.id,
      task_prompt: "Complete the task",
      status: "running",
      current_stage: "profile",
      messages: [],
      tool_calls: [],
      file_changes: [],
      approvals: [],
      stage_runs: [],
      rework_requests: [],
      progress_events: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    } as AgentSession;

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect(attempts).toBe(3);
    expect(updated.status).toBe("interrupted");
    expect(updated.error).toContain("连续 3 轮没有可验证进展");
    expect(updated.error).toContain("host-goal(in_progress)");
  });

  it("does not override the configured provider model when retrying a Profile timeout", async () => {
    const profileWorkflow: WorkflowTemplate = {
      ...workflow,
      id: "profile-workflow",
      stages: []
    };
    const attemptedModels: Array<string | undefined> = [];
    let attempt = 0;
    async function* query(params: unknown) {
      const model = (params as { options: { model?: string } }).options.model;
      attemptedModels.push(model);
      attempt += 1;
      if (attempt === 1) {
        yield {
          type: "system",
          subtype: "init",
          model: "deepseek-v4-pro",
          session_id: "sdk-session-1"
        };
        yield {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "Request timed out"
        };
        throw new Error("Claude Code process exited with code 1");
      }
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Recovered"
      };
    }
    const session: AgentSession = {
      id: "00000000-0000-4000-8000-000000000080",
      project_path: "/tmp/project",
      workflow_id: profileWorkflow.id,
      task_prompt: "Complete the task",
      status: "running",
      current_stage: "profile",
      messages: [],
      tool_calls: [],
      file_changes: [],
      approvals: [],
      stage_runs: [],
      rework_requests: [],
      progress_events: [],
      task_tree: {
        goal_restated: "完成任务",
        strategy: "实现并验证",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        tasks: [{
          id: "t1",
          description: "实现并验证",
          dependencies: [],
          status: "completed",
          evidence: "tests passed"
        }]
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect(attemptedModels).toEqual([undefined, undefined]);
    expect(updated.status).toBe("completed");
    expect(updated.error).toBeUndefined();
    expect(updated.messages.at(-1)?.content).toBe("Recovered");
    expect(updated.progress_events?.some((event) => event.message === "API 调用失败：Request timed out")).toBe(true);
    expect(updated.progress_events?.some((event) => event.message.includes("切换到 Claude"))).toBe(false);
  });

  it("keeps Profile mode active while a tool approval is pending", async () => {
    const profileWorkflow: WorkflowTemplate = {
      ...workflow,
      id: "profile-workflow",
      stages: []
    };
    const projectPath = await mkdtemp(path.join(tmpdir(), "ai-coder-profile-approval-"));
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
      await canUseTool("Bash", { command: "node script.js" }, { toolUseID: "profile-tool-approval" });
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Script completed"
      };
    }
    const session: AgentSession = {
      id: "00000000-0000-4000-8000-000000000090",
      project_path: projectPath,
      workflow_id: profileWorkflow.id,
      task_prompt: "Run the script",
      status: "running",
      current_stage: "profile",
      messages: [],
      tool_calls: [],
      file_changes: [],
      approvals: [],
      stage_runs: [],
      rework_requests: [],
      progress_events: [],
      task_tree: {
        goal_restated: "运行脚本",
        strategy: "执行并验证",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        tasks: [
          {
            id: "t1",
            description: "运行脚本",
            dependencies: [],
            status: "completed",
            evidence: "node script.js exited with code 0"
          }
        ]
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const runner = new ClaudeAgentRunner(query);
    const run = runner.run({ session, workflow: profileWorkflow });
    await waitFor(() =>
      session.tool_calls.some(
        (toolCall) => toolCall.id === "profile-tool-approval" && toolCall.status === "pending_approval"
      )
    );

    expect(session.status).toBe("waiting_approval");
    expect(session.error).toBeUndefined();
    expect(session.tool_calls).toContainEqual(expect.objectContaining({
      id: "profile-tool-approval",
      status: "pending_approval"
    }));
    expect(runner.resolveToolApproval(session.id, "profile-tool-approval", "approved")).toBe(true);

    const updated = await run;
    expect(updated.status).toBe("completed");
    expect(updated.tool_calls).toContainEqual(expect.objectContaining({
      id: "profile-tool-approval",
      status: "completed"
    }));
  });

  it("never persists an unanswerable choice question when options are missing", () => {
    const runner = new ClaudeAgentRunner() as unknown as {
      buildHumanQuestion: (session: Pick<AgentSession, "current_stage">, input: Record<string, unknown>, id: string) => unknown;
    };
    expect(runner.buildHumanQuestion(
      { current_stage: "understand" },
      { question: "请选择实现方式", type: "single" },
      "question-1"
    )).toMatchObject({ question_type: "text", options: undefined });

    expect(runner.buildHumanQuestion(
      { current_stage: "understand" },
      { question: "请选择", type: "single", options: ["方案 A", "方案 B"] },
      "question-2"
    )).toMatchObject({
      question_type: "single",
      options: [{ value: "方案 A", label: "方案 A" }, { value: "方案 B", label: "方案 B" }]
    });
  });

  it("rejects questionnaire-style or evidence-free human questions", () => {
    expect(evaluateHumanQuestionRequest({
      question: "1. 开发者标识是什么？\n2. 哪些页面需要支持？\n3. 触发方式是什么？",
      type: "text",
      already_checked: ["用户原始需求"],
      why_needed: "不同回答会改变分支名、范围和运行时实现"
    })).toContain("一次只能询问一个决策");

    expect(evaluateHumanQuestionRequest({
      question: "采用哪种兼容策略？",
      type: "single",
      already_checked: [],
      why_needed: "不同策略会改变旧调用方行为和验收结果"
    })).toContain("already_checked 为空");

    expect(evaluateHumanQuestionRequest({
      question: "采用哪种兼容策略？",
      type: "single",
      already_checked: ["用户未指定；已检查 src/api.ts:42 的旧调用方"],
      why_needed: "保留旧签名与直接迁移会产生不同兼容行为",
      options: [{ value: "compatible", label: "保持兼容" }, { value: "breaking", label: "直接迁移" }]
    })).toBeNull();
  });

  it("associates SDK tool results with their real exit code", () => {
    expect(extractToolExecutionResult({
      type: "user",
      tool_use_result: { exit_code: 0, stdout: "tests passed" },
      message: { content: [{ type: "tool_result", tool_use_id: "bash-1", content: "tests passed" }] }
    })).toMatchObject({ toolUseId: "bash-1", exitCode: 0, outputSummary: expect.stringContaining("tests passed") });

    expect(extractToolExecutionResult({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "bash-2", content: "failed", exit_code: 1 }] }
    })).toMatchObject({ toolUseId: "bash-2", exitCode: 1 });

    expect(extractToolExecutionResult({
      type: "user",
      tool_use_result: { stdout: "42", stderr: "", interrupted: false },
      message: { content: [{ type: "tool_result", tool_use_id: "bash-3", content: "42" }] }
    })).toMatchObject({ toolUseId: "bash-3", executionSucceeded: true });

    expect(extractToolExecutionResult({
      type: "user",
      tool_use_result: { stdout: "", stderr: "boom", interrupted: true },
      message: { content: [{ type: "tool_result", tool_use_id: "bash-4", content: "boom", is_error: true }] }
    })).toMatchObject({ toolUseId: "bash-4", executionSucceeded: false });
  });

  it("shows the rejected command in safety progress", () => {
    expect(describeToolAttempt("Bash", { command: "python3 -c \"print(1)\"" })).toBe("Bash: python3 -c \"print(1)\"");
  });

  it("normalizes a successful SDK Bash result without exit_code to exit_code=0", () => {
    const runner = new ClaudeAgentRunner(async function* () {});
    const toolSession: AgentSession = {
      id: "tool-result-session",
      project_path: "/tmp/project",
      workflow_id: workflow.id,
      task_prompt: "inspect",
      status: "running",
      current_stage: "execute",
      messages: [],
      tool_calls: [{
        id: "bash-success",
        stage_id: "execute",
        tool: "Bash",
        input: { command: "git status" },
        status: "approved",
        created_at: new Date().toISOString()
      }],
      file_changes: [],
      approvals: [],
      stage_runs: [],
      rework_requests: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    (runner as unknown as { recordToolExecutionResult(session: AgentSession, message: unknown): void })
      .recordToolExecutionResult(toolSession, {
        type: "user",
        tool_use_result: { stdout: "clean", stderr: "", interrupted: false },
        message: { content: [{ type: "tool_result", tool_use_id: "bash-success", content: "clean" }] }
      });

    expect(toolSession.tool_calls[0]).toMatchObject({ status: "completed", exit_code: 0 });
  });

  it("reconstructs an audited tool call from SDK tool_use and tool_result messages", () => {
    const runner = new ClaudeAgentRunner(async function* () {});
    const session = {
      id: "sdk-audit", project_path: "/tmp/project", workflow_id: workflow.id, task_prompt: "inspect",
      status: "running", current_stage: "understand", messages: [], tool_calls: [], file_changes: [], approvals: [],
      stage_runs: [], rework_requests: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as AgentSession;
    const toolUseMessage = {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "read-1", name: "Read", input: { file_path: "/tmp/spec.md" } }] }
    };
    expect(extractSdkToolUses(toolUseMessage)).toEqual([
      { id: "read-1", tool: "Read", input: { file_path: "/tmp/spec.md" } }
    ]);

    const privateRunner = runner as unknown as {
      recordSdkToolUses(session: AgentSession, stageId: string, message: unknown): void;
      recordToolExecutionResult(session: AgentSession, message: unknown): void;
    };
    privateRunner.recordSdkToolUses(session, "understand", toolUseMessage);
    privateRunner.recordToolExecutionResult(session, {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "read-1", content: "spec", is_error: false }] }
    });

    expect(session.tool_calls).toHaveLength(1);
    expect(session.tool_calls[0]).toMatchObject({ id: "read-1", stage_id: "understand", tool: "Read", status: "completed" });
  });

  it("marks Task results containing an embedded API error as blocked", () => {
    const runner = new ClaudeAgentRunner(async function* () {});
    const session = {
      id: "task-error", project_path: "/tmp/project", workflow_id: workflow.id, task_prompt: "inspect",
      status: "running", current_stage: "profile", messages: [], tool_calls: [{
        id: "explore-1",
        stage_id: "profile",
        tool: "Task",
        input: { subagent_type: "Explore" },
        status: "requested",
        created_at: new Date().toISOString()
      }], file_changes: [], approvals: [], stage_runs: [], rework_requests: [],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as AgentSession;

    (runner as unknown as { recordToolExecutionResult(session: AgentSession, message: unknown): void })
      .recordToolExecutionResult(session, {
        type: "user",
        tool_use_result: {
          status: "completed",
          prompt: "long planner context ".repeat(300),
          content: [{ type: "text", text: "API Error: 404 Model not found: claude-haiku" }]
        },
        message: { content: [{ type: "tool_result", tool_use_id: "explore-1", is_error: false }] }
      });

    expect(session.tool_calls[0]).toMatchObject({ status: "blocked" });
  });

  it("turns a successful task-planner JSON result into the host task DAG", () => {
    const runner = new ClaudeAgentRunner(async function* () {});
    const session = {
      id: "planner-result", project_path: "/tmp/project", workflow_id: workflow.id, task_prompt: "实现 R1",
      status: "running", current_stage: "profile", messages: [], tool_calls: [{
        id: "planner-1",
        stage_id: "profile",
        tool: "Task",
        input: { subagent_type: "task-planner" },
        status: "requested",
        created_at: new Date().toISOString()
      }], file_changes: [], approvals: [], stage_runs: [], rework_requests: [],
      task_tree: {
        goal_restated: "实现 R1",
        strategy: "宿主根任务",
        current_focus: "host-goal",
        tasks: [{ id: "host-goal", description: "完成用户请求", dependencies: [], status: "in_progress" }],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as AgentSession;
    const plannerJson = {
      requirements: [{ id: "R1", observable_result: "可跳转" }],
      tasks: [
        { id: "t1", description: "R1: 实现跳转", dependencies: [] },
        { id: "t2", description: "R1: 验证跳转", dependencies: ["t1"] }
      ],
      blocking_unknowns: []
    };

    (runner as unknown as { recordToolExecutionResult(session: AgentSession, message: unknown): void })
      .recordToolExecutionResult(session, {
        type: "user",
        tool_use_result: {
          status: "completed",
          content: [{ type: "text", text: `计划如下：\n\`\`\`json\n${JSON.stringify(plannerJson)}\n\`\`\`` }]
        },
        message: { content: [{ type: "tool_result", tool_use_id: "planner-1", is_error: false }] }
      });

    expect(session.tool_calls[0]).toMatchObject({ status: "completed" });
    expect(session.task_tree?.tasks.map((task) => task.id)).toEqual(["t1", "t2", "host-final-audit"]);
    expect(session.task_tree?.current_focus).toBe("t1");
  });

  it("interrupts before querying when a declared file_ref attachment is missing", async () => {
    let queried = false;
    const projectPath = await mkdtemp(path.join(tmpdir(), "ai-coder-missing-attachment-"));
    const profileWorkflow: WorkflowTemplate = { ...workflow, id: "profile-workflow", stages: [] };
    const session = {
      id: "missing-attachment", project_path: projectPath, workflow_id: profileWorkflow.id,
      task_prompt: "实现附件需求", status: "running", current_stage: "profile", messages: [],
      initial_user_message: {
        role: "user",
        content: "实现附件需求",
        created_at: new Date().toISOString(),
        attachments: [{
          type: "file_ref",
          path: ".ai-coder/uploads/spec/page-21.png",
          display_name: "需求.pdf · 第 21 页"
        }]
      },
      tool_calls: [], file_changes: [], approvals: [], stage_runs: [], rework_requests: [],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as AgentSession;

    const updated = await new ClaudeAgentRunner(async function* () {
      queried = true;
    }).run({ session, workflow: profileWorkflow });

    expect(queried).toBe(false);
    expect(updated.status).toBe("interrupted");
    expect(updated.error).toContain("附件完整性检查失败");
    expect(updated.task_tree).toBeUndefined();
  });

  it("denies undeclared subagents and mutating Bash commands while PLAN is active", async () => {
    const decisions: unknown[] = [];
    const profileWorkflow: WorkflowTemplate = {
      ...workflow,
      id: "profile-workflow",
      stages: [],
      agents: {
        "task-planner": { description: "plan", prompt: "plan" }
      }
    };
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
      decisions.push(await canUseTool("Task", {
        subagent_type: "Explore",
        description: "scan"
      }, { toolUseID: "unknown-agent" }));
      decisions.push(await canUseTool("Bash", {
        command: "git -C /tmp/project cherry-pick abc123"
      }, { toolUseID: "mutating-bash" }));
      yield { type: "result", subtype: "success", is_error: false, result: "not done" };
    }
    const session = {
      id: "plan-gates", project_path: "/tmp/project", workflow_id: profileWorkflow.id,
      task_prompt: "implement", status: "running", current_stage: "profile", messages: [],
      tool_calls: [], file_changes: [], approvals: [], stage_runs: [], rework_requests: [],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as AgentSession;

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect(updated.status).toBe("interrupted");
    expect(decisions).not.toHaveLength(0);
    expect(decisions.every((decision) =>
      (decision as { behavior?: string }).behavior === "deny"
    )).toBe(true);
    expect(JSON.stringify(decisions)).toContain("未由当前工作流声明");
    expect(JSON.stringify(decisions)).toContain("禁止通过 Bash 修改");
  });

  it("loads configured local Plugins into the SDK session", async () => {
    let receivedOptions: Record<string, unknown> | undefined;
    async function* query(params: unknown) {
      receivedOptions = (params as { options?: Record<string, unknown> }).options;
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify({ status: "completed", output_summary: "ok" })
      };
    }

    const session: AgentSession = {
      id: "00000000-0000-4000-8000-000000000080",
      project_path: "/tmp/project",
      workflow_id: workflow.id,
      task_prompt: "Check plugin loading",
      status: "running",
      current_stage: "execute",
      messages: [],
      tool_calls: [],
      file_changes: [],
      approvals: [],
      stage_runs: [{
        id: "00000000-0000-4000-8000-000000000081",
        stage_id: "execute",
        attempt: 1,
        status: "running",
        input_summary: "Initial task",
        started_at: new Date().toISOString()
      }],
      rework_requests: [],
      progress_events: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    await new ClaudeAgentRunner({
      queryOverride: query,
      pluginPaths: ["/tmp/careful-coder-plugin"]
    }).run({ session, workflow });

    expect(receivedOptions?.plugins).toEqual([
      { type: "local", path: "/tmp/careful-coder-plugin" }
    ]);
    expect(receivedOptions?.hooks).toBeUndefined();
    expect(receivedOptions?.permissionMode).toBe("default");
    expect(receivedOptions?.allowDangerouslySkipPermissions).toBeUndefined();
  });

  it("injects full Profile Skill bodies as host-enforced contracts", async () => {
    const pluginPath = await mkdtemp(path.join(tmpdir(), "careful-profile-skill-"));
    const skillPath = path.join(pluginPath, "skills", "profile-contract");
    await mkdir(skillPath, { recursive: true });
    const longBody = `${"evidence ".repeat(40)}FULL_CONTRACT_SENTINEL`;
    await writeFile(
      path.join(skillPath, "SKILL.md"),
      `---\nname: profile-contract\ndescription: Profile contract.\n---\n\n${longBody}\n`
    );
    let systemAppend = "";
    async function* query(params: unknown) {
      systemAppend = String((params as {
        options?: { systemPrompt?: { append?: unknown } };
      }).options?.systemPrompt?.append ?? "");
      yield { type: "result", subtype: "success", is_error: false, result: "Done" };
    }
    const profileWorkflow: WorkflowTemplate = {
      ...workflow,
      id: "profile-workflow",
      stages: [],
      skills: ["profile-contract"]
    };
    const session = {
      id: "00000000-0000-4000-8000-000000000075",
      project_path: "/tmp/project",
      workflow_id: profileWorkflow.id,
      task_prompt: "Complete the task",
      status: "running",
      current_stage: "profile",
      messages: [],
      tool_calls: [],
      file_changes: [],
      approvals: [],
      stage_runs: [],
      rework_requests: [],
      progress_events: [],
      task_tree: {
        goal_restated: "完成任务",
        strategy: "已完成",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        tasks: [{
          id: "done",
          description: "完成",
          dependencies: [],
          status: "completed",
          evidence: "tests passed"
        }]
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    } as AgentSession;

    const updated = await new ClaudeAgentRunner({
      queryOverride: query,
      pluginPaths: [pluginPath]
    }).run({ session, workflow: profileWorkflow });

    expect(updated.status).toBe("completed");
    expect(systemAppend).toContain("宿主强制加载的 Skills");
    expect(systemAppend).toContain("FULL_CONTRACT_SENTINEL");
    expect(updated.progress_events?.some((event) =>
      event.message === "宿主强制加载 Skill：careful-coder:profile-contract"
    )).toBe(true);
  });

  it("injects required core Skill content before a stage can run", async () => {
    const pluginPath = await mkdtemp(path.join(tmpdir(), "careful-skill-"));
    const skillPath = path.join(pluginPath, "skills", "test-skill");
    await mkdir(skillPath, { recursive: true });
    await writeFile(skillPath + "/SKILL.md", "---\nname: test-skill\ndescription: Test.\n---\n\n# Required discipline\nFollow evidence.\n");
    let receivedPrompt = "";
    async function* query(params: unknown) {
      receivedPrompt = String((params as { prompt?: unknown }).prompt ?? "");
      yield { type: "result", subtype: "success", is_error: false, result: JSON.stringify({ status: "completed", output_summary: "ok" }) };
    }
    const requiredWorkflow: WorkflowTemplate = {
      ...workflow,
      stages: workflow.stages.map((stage) => stage.id === "execute" ? { ...stage, required_skills: ["test-skill"] } : stage)
    };
    const session: AgentSession = {
      id: "00000000-0000-4000-8000-000000000090", project_path: "/tmp/project", workflow_id: workflow.id,
      task_prompt: "test", status: "running", current_stage: "execute", messages: [], tool_calls: [], file_changes: [], approvals: [],
      stage_runs: [{ id: "00000000-0000-4000-8000-000000000091", stage_id: "execute", attempt: 1, status: "running", input_summary: "test", started_at: new Date().toISOString() }],
      rework_requests: [], progress_events: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    };
    await new ClaudeAgentRunner({ queryOverride: query, pluginPaths: [pluginPath] }).run({ session, workflow: requiredWorkflow });
    expect(receivedPrompt).toContain("宿主强制加载的核心心智");
    expect(receivedPrompt).toContain("Follow evidence.");
    expect(session.messages.some((message) => message.kind === "skill_usage" && message.content.includes("test-skill"))).toBe(true);
  });

  it("gives structured output retries headroom while preserving an explicit override", () => {
    const previous = process.env.MAX_STRUCTURED_OUTPUT_RETRIES;
    try {
      delete process.env.MAX_STRUCTURED_OUTPUT_RETRIES;
      expect(buildClaudeSdkEnv({ TEST_NODE_PATH: "/tmp/node" })).toMatchObject({
        TEST_NODE_PATH: "/tmp/node",
        MAX_STRUCTURED_OUTPUT_RETRIES: "10"
      });

      process.env.MAX_STRUCTURED_OUTPUT_RETRIES = "12";
      expect(buildClaudeSdkEnv().MAX_STRUCTURED_OUTPUT_RETRIES).toBe("12");
    } finally {
      if (previous === undefined) delete process.env.MAX_STRUCTURED_OUTPUT_RETRIES;
      else process.env.MAX_STRUCTURED_OUTPUT_RETRIES = previous;
    }
  });

  it("prefers parseable assistant JSON over SDK no-content result text", () => {
    const parsed = parseBestStageAgentResult(
      "(no content)",
      '{"status":"completed","output_summary":"ok","required_outputs":{"profile_mode":"incremental"}}'
    );

    expect(parsed.parse_diagnostics?.parse_strategy).toBe("single_json_object");
    expect(parsed.required_outputs).toEqual({ profile_mode: "incremental" });
  });

  it("prefers SDK structured output over malformed display text", () => {
    const structuredOutput = {
      status: "completed",
      output_summary: "扫描完成",
      required_outputs: { profile_mode: "incremental" }
    };
    const parsed = parseBestStageAgentResult(
      "(no content)",
      "我已经完成扫描，下面是结果：profile_mode: full",
      structuredOutput
    );

    expect(parsed.parse_diagnostics?.parse_strategy).toBe("single_json_object");
    expect(parsed.required_outputs).toEqual({ profile_mode: "incremental" });
  });

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

  it("does not fail a required-output stage when SDK result is no-content but assistant text contains stage JSON", async () => {
    async function* query() {
      yield {
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: "completed",
                output_summary: "扫描完成",
                required_outputs: { profile_mode: "incremental" }
              })
            }
          ]
        }
      };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "(no content)"
      };
    }

    const wf: WorkflowTemplate = {
      ...workflow,
      stages: [
        { id: "scan_project", name: "扫描项目画像", required_outputs: ["profile_mode"], auto_retry_limit: 1 },
        { id: "plan", name: "Plan" }
      ]
    };
    const session: AgentSession = {
      id: "00000000-0000-4000-8000-000000000030",
      project_path: "/tmp/project",
      workflow_id: wf.id,
      task_prompt: "检查项目",
      status: "running",
      current_stage: "scan_project",
      messages: [],
      tool_calls: [],
      file_changes: [],
      approvals: [],
      stage_runs: [
        {
          id: "00000000-0000-4000-8000-000000000031",
          stage_id: "scan_project",
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

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow: wf });

    expect(updated.status).not.toBe("blocked");
    expect(updated.status).not.toBe("failed");
    expect(updated.error).toBeUndefined();
    expect(updated.stage_runs?.[0]).toMatchObject({
      stage_id: "scan_project",
      status: "completed",
      required_outputs: { profile_mode: "incremental" }
    });
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
    let permissionMode: unknown;
    let allowDangerouslySkipPermissions: unknown;
    async function* query(params: unknown) {
      const options = (params as {
        options: {
          permissionMode?: unknown;
          allowDangerouslySkipPermissions?: unknown;
          canUseTool: (
            toolName: string,
            input: Record<string, unknown>,
            options: { toolUseID: string }
          ) => Promise<unknown>;
        };
      }).options;
      permissionMode = options.permissionMode;
      allowDangerouslySkipPermissions = options.allowDangerouslySkipPermissions;
      const canUseTool = options.canUseTool;
      permissionResult = await canUseTool("Bash", { command: "node script.js" }, { toolUseID: "tool-await" });
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: JSON.stringify({
          status: "completed",
          output_summary: "Executed"
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
    await waitFor(() =>
      session.tool_calls.some(
        (toolCall) => toolCall.id === "tool-await" && toolCall.status === "pending_approval"
      )
    );

    expect(session.status).toBe("waiting_approval");
    expect(runner.resolveToolApproval(session.id, "tool-await", "approved")).toBe(true);
    const updated = await run;

    expect(permissionMode).toBe("default");
    expect(allowDangerouslySkipPermissions).toBeUndefined();
    expect(permissionResult).toMatchObject({ behavior: "allow" });
    expect(updated.tool_calls).toContainEqual(expect.objectContaining({
      id: "tool-await",
      status: "completed"
    }));
    expect(updated.status).toBe("completed");
  });

  it("blocks dangerous commands even when the model requests them", async () => {
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
    expect(updated.tool_calls.find((toolCall) => toolCall.id === "tool-blocked")).toMatchObject({
      status: "blocked"
    });
    expect(updated.status).toBe("completed");
    expect(updated.error).toBeUndefined();
  });

  it("allows direct PDF Read without host-side tool blocking", async () => {
    let permissionResult: unknown;
    const projectPath = await mkdtemp(path.join(tmpdir(), "ai-coder-pdf-"));
    const pdfPath = path.join(projectPath, ".ai-coder", "uploads", "spec.pdf");
    await mkdir(path.dirname(pdfPath), { recursive: true });
    await writeFile(pdfPath, "");
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
      permissionResult = await canUseTool("Read", { file_path: pdfPath }, { toolUseID: "read-pdf" });
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
      project_path: projectPath,
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

    expect(permissionResult).toMatchObject({ behavior: "allow" });
    expect(updated.status).toBe("completed");
  });

  it("does not cap PDF page image reads in the host permission callback", async () => {
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
    expect(permissionResults.every((result) => JSON.stringify(result).includes("\"allow\""))).toBe(true);
    expect(updated.progress_events?.some((event) => event.message.includes("限制 PDF 拆页读取"))).toBe(false);
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

describe("describeSdkMessageSnippet", () => {
  it("assistant 文本 block 提取前 80 字", () => {
    const msg = {
      type: "assistant",
      message: { content: [{ type: "text", text: "正在查看登录模块的实现，确认鉴权逻辑..." }] }
    };
    expect(describeSdkMessageSnippet(msg)).toBe("正在查看登录模块的实现，确认鉴权逻辑...");
  });

  it("assistant 文本超长截断 500 字", () => {
    const long = "x".repeat(600);
    const msg = { type: "assistant", message: { content: [{ type: "text", text: long }] } };
    expect(describeSdkMessageSnippet(msg).length).toBe(500);
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
    expect(describeSdkMessageSnippet({ type: "result", subtype: "success", is_error: false })).toBe("SDK 查询结束：success");
    expect(describeSdkMessageSnippet({ type: "result", subtype: "error_max_turns", is_error: true })).toBe("SDK 查询结束：error_max_turns，错误");
    expect(describeSdkMessageSnippet({ type: "tool_result" })).toBe("工具结果");
    expect(describeSdkMessageSnippet({ type: "system" })).toBe("SDK:system");
  });
});

describe("evaluateProfileCompletion", () => {
  it("rejects a natural SDK stop before a task tree exists", () => {
    expect(evaluateProfileCompletion({ task_tree: undefined } as AgentSession)).toContain("尚未建立任务树");
  });

  it("rejects unfinished nodes and completed nodes without evidence", () => {
    const session = {
      task_tree: {
        goal_restated: "完成修复",
        strategy: "按实现和验证拆分",
        created_at: "t",
        updated_at: "t",
        tasks: [
          { id: "t1", description: "实现", dependencies: [], status: "completed" },
          { id: "t2", description: "验证", dependencies: ["t1"], status: "in_progress" }
        ]
      }
    } as AgentSession;

    expect(evaluateProfileCompletion(session)).toEqual([
      "仍有未完成任务：t2(in_progress)",
      "完成节点缺少证据：t1"
    ]);
  });

  it("accepts only completed or skipped nodes with evidence", () => {
    const session = {
      task_tree: {
        goal_restated: "完成修复",
        strategy: "按实现和验证拆分",
        created_at: "t",
        updated_at: "t",
        tasks: [
          { id: "t1", description: "实现", dependencies: [], status: "completed", evidence: "src/a.ts:10" },
          { id: "t2", description: "无需修改", dependencies: ["t1"], status: "skipped", status_reason: "已有覆盖" }
        ]
      }
    } as AgentSession;

    expect(evaluateProfileCompletion(session)).toEqual([]);
  });
});

describe("formatProfileAttachmentList", () => {
  it("keeps the exact readable path instead of only the display name", () => {
    expect(formatProfileAttachmentList([{
      type: "file_ref",
      path: ".ai-coder/uploads/id/page-21.png",
      display_name: "需求.pdf · 第 21 页 / 共 21 页"
    }])).toContain(".ai-coder/uploads/id/page-21.png");
  });
});

describe("extractSdkTerminalError", () => {
  it("does not treat a successful result as an error", () => {
    expect(extractSdkTerminalError([
      { type: "result", subtype: "success", is_error: false, result: "done" }
    ])).toBeNull();
  });

  it("preserves max-turn termination instead of treating it as completion", () => {
    expect(extractSdkTerminalError([
      { type: "result", subtype: "error_max_turns", is_error: true, result: "Reached max turns" }
    ])).toBe("error_max_turns: Reached max turns");
  });

  it("recognizes only a non-error success as a successful terminal result", () => {
    expect(hasSuccessfulSdkTerminalResult([
      { type: "result", subtype: "success", is_error: false, result: "done" }
    ])).toBe(true);
    expect(hasSuccessfulSdkTerminalResult([
      { type: "result", subtype: "error_during_execution", is_error: true, result: "failed" }
    ])).toBe(false);
  });
});

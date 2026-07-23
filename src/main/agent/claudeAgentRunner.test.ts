import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyExplorationCheckpoint, augmentTaskInputWithExplorationMemory, buildClaudeSdkEnv, buildCompletionContinuationContext, buildExecutionProgressPromptSection, buildExplorationPromptSection, ClaudeAgentRunner, describeSdkMessageSnippet, describeToolAttempt, detectCorruptedToolName, ensureExplorationCheckpoint, evaluateHumanQuestionRequest, evaluateProfileCompletion, extractSdkTerminalError, extractSdkToolUses, extractToolExecutionResult, formatProfileAttachmentList, formatSdkCatalogItem, getExplorationActionGuardError, getHierarchicalProjectPathError, getSimpleDelegationGuardError, getSimpleExecutorPrerequisiteGuardError, getSimpleKnowledgeBoundaryGuardError, getSimplePlannerGuardError, hasSuccessfulSdkTerminalResult, isCheckpointWorthyProfileTranscript, normalizeHierarchicalLeasePath, parseBestStageAgentResult, syncPhaseTaskTreeWithCheckpoint, validateProfileToolInput } from "./claudeAgentRunner.js";
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
    } as unknown as AgentSession;

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
    } as unknown as AgentSession;

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect(attempt).toBe(2);
    expect(updated.status, updated.error).toBe("completed");
    expect(updated.messages.at(-1)?.content).toBe("Recovered");
  });

  it("preserves completed tool observations in the knowledge snowball before retrying a crashed Profile query", async () => {
    const profileWorkflow: WorkflowTemplate = {
      ...workflow,
      id: "profile-workflow",
      stages: [],
      simple_profile_loop: true
    };
    const prompts: string[] = [];
    let attempt = 0;
    let session!: AgentSession;
    async function* query(params: unknown) {
      attempt += 1;
      prompts.push(String((params as { prompt?: unknown }).prompt ?? ""));
      if (attempt === 1) {
        yield {
          type: "assistant",
          message: {
            content: [{
              type: "tool_use",
              id: "read-page-21-before-crash",
              name: "Read",
              input: { file_path: "/tmp/uploads/page-21.png" }
            }]
          }
        };
        yield {
          type: "user",
          message: {
            content: [{
              type: "tool_result",
              tool_use_id: "read-page-21-before-crash",
              content: "image inspected",
              is_error: false
            }]
          }
        };
        yield {
          type: "assistant",
          message: { content: [{ type: "text", text: "已经读取第 21 页并确认这是需求末页。" }] }
        };
        throw new Error("Claude Code process terminated by signal SIGSEGV");
      }
      const latest = session.exploration_checkpoints!.at(-1)!;
      applyExplorationCheckpoint(session, {
        memory: `${latest.text}\n\n## 已确认\n- 第 21 页已经读取，无需重复。`,
        disposition: "complete",
        phase: "complete",
        next_action: "任务已完成"
      });
      yield { type: "result", subtype: "success", is_error: false, result: "Recovered without rereading" };
    }
    session = {
      id: "profile-crash-preserves-tools",
      project_path: "/tmp/project",
      workflow_id: profileWorkflow.id,
      task_prompt: "Inspect attachments",
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

    expect(attempt).toBe(2);
    expect(updated.status, updated.error).toBe("completed");
    expect(updated.tool_calls).toHaveLength(1);
    expect(updated.tool_calls[0]).toMatchObject({
      id: "read-page-21-before-crash",
      status: "completed"
    });
    expect(prompts[1]).toContain("/tmp/uploads/page-21.png");
    expect(prompts[1]).toContain("上述成功调用不得重复");
    expect(updated.exploration_checkpoints?.some((checkpoint) =>
      checkpoint.text.includes("SDK 中断恢复观察")
      && checkpoint.text.includes("/tmp/uploads/page-21.png")
    )).toBe(true);
  });

  it("actively checkpoints key discoveries after a successful query when the model omitted the checkpoint", async () => {
    const profileWorkflow: WorkflowTemplate = {
      ...workflow,
      id: "profile-workflow",
      stages: [],
      simple_profile_loop: true
    };
    const prompts: string[] = [];
    let attempt = 0;
    let checkpointedBeforeTerminalResult = false;
    let session!: AgentSession;
    async function* query(params: unknown) {
      attempt += 1;
      prompts.push(String((params as { prompt?: unknown }).prompt ?? ""));
      if (attempt === 1) {
        yield {
          type: "assistant",
          message: {
            content: [{
              type: "tool_use",
              id: "read-routing-definition",
              name: "Read",
              input: { file_path: "/tmp/project/spec/page-21.png" }
            }]
          }
        };
        yield {
          type: "user",
          message: {
            content: [{
              type: "tool_result",
              tool_use_id: "read-routing-definition",
              content: "image inspected",
              is_error: false
            }]
          }
        };
        yield {
          type: "assistant",
          message: {
            content: [{
              type: "text",
              text: "已经确认第 21 页包含账户安全 ACCTSEC，这是附件最后一项。"
            }]
          }
        };
        checkpointedBeforeTerminalResult = session.exploration_checkpoints?.some((checkpoint) =>
          checkpoint.text.includes("ACCTSEC")
          && checkpoint.text.includes("最新关键观察")
        ) === true;
        yield { type: "result", subtype: "success", is_error: false, result: "Continue" };
        return;
      }
      const latest = session.exploration_checkpoints!.at(-1)!;
      applyExplorationCheckpoint(session, {
        memory: `${latest.text}\n\n## 已确认\n- ACCTSEC 是附件最后一项。`,
        disposition: "complete",
        phase: "complete",
        next_action: "任务已完成"
      });
      yield { type: "result", subtype: "success", is_error: false, result: "Done" };
    }
    session = {
      id: "profile-auto-milestone-checkpoint",
      project_path: "/tmp/project",
      workflow_id: profileWorkflow.id,
      task_prompt: "Inspect routing definitions",
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

    expect(updated.status, updated.error).toBe("completed");
    expect(attempt).toBe(2);
    expect(checkpointedBeforeTerminalResult).toBe(true);
    expect(prompts[1]).toContain("ACCTSEC");
    expect(prompts[1]).toContain("不得重新获取已经成功取得的相同证据");
    expect(updated.progress_events?.some((event) =>
      event.message.includes("宿主已保全本轮结论及最近 1 个证据来源")
    )).toBe(true);
  });

  it("stops retrying after two repeated Profile subprocess crashes", async () => {
    const profileWorkflow: WorkflowTemplate = { ...workflow, id: "profile-workflow", stages: [] };
    let attempts = 0;
    async function* query() {
      attempts += 1;
      throw new Error("Claude Code process terminated by signal SIGABRT");
    }
    const session = {
      id: "profile-crash-limit", project_path: "/tmp/project", workflow_id: profileWorkflow.id,
      task_prompt: "Complete the task", status: "running", current_stage: "profile", messages: [],
      tool_calls: [], file_changes: [], approvals: [], stage_runs: [], rework_requests: [], progress_events: [],
      task_tree: {
        goal_restated: "完成任务", strategy: "实现并验证",
        tasks: [{ id: "t1", description: "实现并验证", dependencies: [], status: "completed", evidence: "tests passed" }],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as unknown as AgentSession;

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect(attempts).toBe(3);
    expect(updated.status).toBe("interrupted");
    expect(updated.error).toContain("SIGABRT");
  });

  it("shares one active run when the same session is started concurrently", async () => {
    const profileWorkflow: WorkflowTemplate = { ...workflow, id: "profile-workflow", stages: [] };
    let attempts = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    async function* query() {
      attempts += 1;
      await gate;
      yield { type: "result", subtype: "success", is_error: false, result: "Done once" };
    }
    const session = {
      id: "profile-single-flight", project_path: "/tmp/project", workflow_id: profileWorkflow.id,
      task_prompt: "Complete the task", status: "running", current_stage: "profile", messages: [],
      tool_calls: [], file_changes: [], approvals: [], stage_runs: [], rework_requests: [], progress_events: [],
      task_tree: {
        goal_restated: "完成任务", strategy: "实现并验证",
        tasks: [{ id: "t1", description: "实现并验证", dependencies: [], status: "completed", evidence: "tests passed" }],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as unknown as AgentSession;
    const runner = new ClaudeAgentRunner(query);

    const first = runner.run({ session, workflow: profileWorkflow });
    const second = runner.run({ session, workflow: profileWorkflow });
    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(attempts).toBe(1);
    expect(secondResult).toBe(firstResult);
  });

  it("injects user follow-ups at the next safe Profile boundary before completing", async () => {
    const profileWorkflow: WorkflowTemplate = { ...workflow, id: "profile-workflow", stages: [] };
    const prompts: string[] = [];
    const queuedMessages: AgentSession["messages"] = [];
    let attempts = 0;
    async function* query(params: unknown) {
      attempts += 1;
      prompts.push(String((params as { prompt?: unknown }).prompt ?? ""));
      if (attempts === 1) {
        queuedMessages.push({
          role: "user",
          content: "补充：不要重新读取 PDF，直接沿用已经确认的页面映射。",
          created_at: "2026-07-20T09:30:00.000Z",
          attachments: [{
            type: "file_ref",
            path: ".ai-coder/uploads/spec/page-21.png",
            display_name: "需求.pdf · 第 21 页"
          }]
        });
      }
      yield { type: "result", subtype: "success", is_error: false, result: `Attempt ${attempts}` };
    }
    const session = {
      id: "profile-runtime-follow-up",
      project_path: "/tmp/project",
      workflow_id: profileWorkflow.id,
      task_prompt: "完成现有任务",
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
        goal_restated: "完成现有任务",
        strategy: "实现并验证",
        tasks: [{ id: "t1", description: "实现并验证", dependencies: [], status: "completed", evidence: "tests passed" }],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    } as unknown as AgentSession;

    const updated = await new ClaudeAgentRunner(query).run({
      session,
      workflow: profileWorkflow,
      takeQueuedUserMessages: () => queuedMessages.splice(0)
    });

    expect(attempts).toBe(2);
    expect(prompts[0]).not.toContain("不要重新读取 PDF");
    expect(prompts[1]).toContain("运行中收到的用户补充消息");
    expect(prompts[1]).toContain("不要重新读取 PDF");
    expect(prompts[1]).toContain(".ai-coder/uploads/spec/page-21.png");
    expect(updated.messages.filter((message) => message.content.includes("不要重新读取 PDF"))).toHaveLength(1);
    expect(updated.progress_events?.some((event) =>
      event.message.includes("安全执行边界接入 1 条用户补充消息")
    )).toBe(true);
    expect(updated.status, updated.error).toBe("completed");
  });

  it("repairs legacy Profile task trees that contain multiple in-progress tasks", async () => {
    const profileWorkflow: WorkflowTemplate = { ...workflow, id: "profile-workflow", stages: [] };
    let receivedPrompt = "";
    async function* query(params: unknown) {
      receivedPrompt = String((params as { prompt?: unknown }).prompt ?? "");
      for (const task of session.task_tree!.tasks) {
        task.status = "completed";
        task.evidence = "test cleanup";
      }
      yield { type: "result", subtype: "success", is_error: false, result: "Continued with one active task" };
    }
    const session = {
      id: "profile-multiple-active-repair", project_path: "/tmp/project", workflow_id: profileWorkflow.id,
      task_prompt: "Continue", status: "running", current_stage: "profile", messages: [],
      tool_calls: [], file_changes: [], approvals: [], stage_runs: [], rework_requests: [], progress_events: [],
      task_tree: {
        goal_restated: "继续", strategy: "串行执行", current_focus: "t2",
        tasks: [
          { id: "t1", description: "需求", dependencies: [], status: "in_progress" },
          { id: "t2", description: "实现", dependencies: [], status: "in_progress" },
          { id: "t3", description: "验证", dependencies: [], status: "in_progress" }
        ],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as unknown as AgentSession;

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect(receivedPrompt.match(/🔄/g)).toHaveLength(1);
    expect(receivedPrompt).toContain("🔄 t2:");
    expect(receivedPrompt).toContain("⏳ t1:");
    expect(receivedPrompt).toContain("⏳ t3:");
    expect(updated.progress_events?.some((event) =>
      event.message.includes("任务树检测到 3 个 in_progress") && event.message.includes("保留 t2")
    )).toBe(true);
  });

  it("repairs an empty task-tree update to the single active task", async () => {
    const profileWorkflow: WorkflowTemplate = { ...workflow, id: "profile-workflow", stages: [] };
    let decision: unknown;
    async function* query(params: unknown) {
      const canUseTool = (params as {
        options: {
          canUseTool: (
            toolName: string,
            input: Record<string, unknown>,
            options: { toolUseID: string }
          ) => Promise<unknown>
        }
      }).options.canUseTool;
      decision = await canUseTool(
        "mcp__ai_coder__update_task_tree",
        {},
        { toolUseID: "tree-empty-active" }
      );
      session.task_tree!.tasks[0]!.status = "completed";
      session.task_tree!.tasks[0]!.evidence = "test cleanup";
      yield { type: "result", subtype: "success", is_error: false, result: "Continued" };
    }
    const session = {
      id: "profile-empty-active-update", project_path: "/tmp/project", workflow_id: profileWorkflow.id,
      task_prompt: "Continue", status: "running", current_stage: "profile", messages: [],
      tool_calls: [], file_changes: [], approvals: [], stage_runs: [], rework_requests: [], progress_events: [],
      task_tree: {
        goal_restated: "继续", strategy: "串行执行", current_focus: "t1",
        tasks: [{ id: "t1", description: "实现", dependencies: [], status: "in_progress" }],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as AgentSession;

    await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect(decision).toMatchObject({
      behavior: "allow",
      updatedInput: expect.objectContaining({
        action: "update_status",
        task_id: "t1",
        new_status: "in_progress"
      })
    });
    expect(session.progress_events?.some((event) => event.message.includes("未知 action"))).toBe(false);
  });

  it("rejects starting a second task while another Profile task is active", async () => {
    const profileWorkflow: WorkflowTemplate = { ...workflow, id: "profile-workflow", stages: [] };
    let decision: unknown;
    async function* query(params: unknown) {
      const canUseTool = (params as {
        options: {
          canUseTool: (
            toolName: string,
            input: Record<string, unknown>,
            options: { toolUseID: string }
          ) => Promise<unknown>
        }
      }).options.canUseTool;
      decision = await canUseTool(
        "mcp__ai_coder__update_task_tree",
        { action: "update_status", task_id: "t2", new_status: "in_progress" },
        { toolUseID: "tree-second-active" }
      );
      for (const task of session.task_tree!.tasks) {
        task.status = "completed";
        task.evidence = "test cleanup";
      }
      yield { type: "result", subtype: "success", is_error: false, result: "Continued" };
    }
    const session = {
      id: "profile-reject-second-active", project_path: "/tmp/project", workflow_id: profileWorkflow.id,
      task_prompt: "Continue", status: "running", current_stage: "profile", messages: [],
      tool_calls: [], file_changes: [], approvals: [], stage_runs: [], rework_requests: [], progress_events: [],
      task_tree: {
        goal_restated: "继续", strategy: "串行执行", current_focus: "t1",
        tasks: [
          { id: "t1", description: "实现", dependencies: [], status: "in_progress" },
          { id: "t2", description: "验证", dependencies: [], status: "pending" }
        ],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as AgentSession;

    await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect(decision).toMatchObject({ behavior: "deny", interrupt: false });
    expect(JSON.stringify(decision)).toContain("当前任务 t1 正在执行");
    expect(JSON.stringify(decision)).toContain("一次只能有一个 in_progress");
  });

  it("retains earlier useful assistant conclusions across multiple Profile continuations", async () => {
    const profileWorkflow: WorkflowTemplate = { ...workflow, id: "profile-workflow", stages: [] };
    const prompts: string[] = [];
    let attempts = 0;
    async function* query(params: unknown) {
      attempts += 1;
      prompts.push(String((params as { prompt?: unknown }).prompt ?? ""));
      if (attempts === 3) {
        session.task_tree!.tasks[0]!.status = "completed";
        session.task_tree!.tasks[0]!.evidence = "test cleanup";
      }
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: attempts === 1
          ? "关键结论：页面 33 到 44 的映射已经从附件确认。"
          : attempts === 2
            ? "接下来继续实现。"
            : "Done"
      };
    }
    const session = {
      id: "profile-rolling-conclusions", project_path: "/tmp/project", workflow_id: profileWorkflow.id,
      task_prompt: "Continue", status: "running", current_stage: "profile", messages: [],
      tool_calls: [], file_changes: [], approvals: [], stage_runs: [], rework_requests: [], progress_events: [],
      task_tree: {
        goal_restated: "继续", strategy: "沿用结论",
        tasks: [{ id: "t1", description: "实现", dependencies: [], status: "in_progress" }],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as AgentSession;

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect(attempts).toBe(3);
    expect(prompts[2]).toContain("页面 33 到 44 的映射已经从附件确认");
    expect(updated.status, updated.error).toBe("completed");
  });

  it("validates corrupted Read protocol and paths before execution", async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), "ai-coder-read-validation-"));
    const pagePath = path.join(projectPath, "page-01.png");
    await writeFile(pagePath, "fixture");

    await expect(validateProfileToolInput("Read", { file_path: pagePath })).resolves.toBeNull();
    await expect(validateProfileToolInput("Read", { file_path: "page-01.png" }, projectPath)).resolves.toBeNull();
    await expect(validateProfileToolInput("Read", { filefile_path: pagePath })).resolves.toContain(
      "缺少必需的 file_path"
    );
    await expect(validateProfileToolInput("Read", { file_path: `${pagePath}.missing` })).resolves.toContain(
      "不存在或不可访问"
    );
    await expect(validateProfileToolInput("Read() </parameter>", {})).resolves.toContain(
      "损坏的协议标记"
    );
    await expect(validateProfileToolInput("mcp__ai_coder____update_task_tree", {})).resolves.toContain(
      "精确工具名 mcp__ai_coder__update_task_tree"
    );
    await expect(validateProfileToolInput("Bash", {
      command: "ls -la /tmp/project\n</parameter"
    })).resolves.toContain("Bash command 包含损坏的工具协议标记 </parameter");
    await expect(validateProfileToolInput("Bash", {
      command: "find /tmp/project -type f -name \".ts\" -o -name \".tsx\""
    })).resolves.toContain("疑似丢失通配符");
    await expect(validateProfileToolInput("Bash", {
      command: "find /tmp/project -type f\n</"
    })).resolves.toContain("损坏的工具协议尾标");
  });

  it("rejects guessed hierarchical project roots with the exact registered root", () => {
    const session = {
      id: "hierarchical-path-root",
      project_path: "/home/user/projects/huaxiafortune",
      workflow_id: "hierarchical",
      task_prompt: "实现页面跳转",
      status: "running",
      current_stage: "R1/implement",
      messages: [],
      tool_calls: [],
      file_changes: [],
      approvals: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    } as AgentSession;

    expect(getHierarchicalProjectPathError(session, "Read", {
      file_path: "lib/views/homepage/utils/homepageRedirection.js"
    })).toBeNull();
    expect(getHierarchicalProjectPathError(session, "Edit", {
      file_path: "/home/user/projects/huaxiafortune/lib/views/homepage/utils/homepageRedirection.js"
    })).toBeNull();
    expect(getHierarchicalProjectPathError(session, "Edit", {
      file_path: "/workspace/lib/views/homepage/utils/homepageRedirection.js"
    })).toContain("唯一项目根目录是 /home/user/projects/huaxiafortune");
    expect(getHierarchicalProjectPathError(session, "Read", {
      file_path: "../../lib/views/homepage/utils/homepageRedirection.js"
    })).toContain("路径越出当前项目");
    expect(getHierarchicalProjectPathError(session, "Bash", {
      command: "cd /workspace && git status"
    })).toContain("Bash cd 路径越出当前项目");
    expect(getHierarchicalProjectPathError(session, "Bash", {
      command: "git status"
    })).toBeNull();
    expect(normalizeHierarchicalLeasePath(
      session.project_path,
      "“lib/Const/RouterDisplayName.js”"
    )).toBe("lib/Const/RouterDisplayName.js");
  });

  it("requires exact host paths for uploaded attachments without restricting ordinary project resources", async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), "ai-coder-resource-registry-"));
    const registeredPath = path.join(projectPath, ".ai-coder", "uploads", "spec", "asset.bin");
    const stalePath = path.join(projectPath, ".ai-coder", "uploads", "stale", "asset.bin");
    await mkdir(path.dirname(registeredPath), { recursive: true });
    await mkdir(path.dirname(stalePath), { recursive: true });
    await writeFile(registeredPath, "registered");
    await writeFile(stalePath, "stale");
    const attachments = [{
      type: "file_ref" as const,
      path: ".ai-coder/uploads/spec/asset.bin",
      display_name: "接口说明附件"
    }];

    await expect(validateProfileToolInput(
      "Read",
      { file_path: registeredPath },
      projectPath,
      attachments
    )).resolves.toBeNull();
    await expect(validateProfileToolInput(
      "Read",
      { file_path: stalePath },
      projectPath,
      attachments
    )).resolves.toContain("附件路径不在宿主精确清单");
    await expect(validateProfileToolInput(
      "Bash",
      { command: `file ${stalePath}` },
      projectPath,
      attachments
    )).resolves.toBeNull();
    await expect(validateProfileToolInput(
      "Bash",
      { command: `file ${registeredPath}` },
      projectPath,
      attachments
    )).resolves.toBeNull();

    const ordinaryProjectAsset = path.join(projectPath, "assets", "asset.bin");
    await mkdir(path.dirname(ordinaryProjectAsset), { recursive: true });
    await writeFile(ordinaryProjectAsset, "ordinary");
    await expect(validateProfileToolInput(
      "Read",
      { file_path: ordinaryProjectAsset },
      projectPath,
      attachments
    )).resolves.toBeNull();
  });

  it("keeps routine progress out of the knowledge snowball and accepts evidence-backed conclusions", () => {
    expect(isCheckpointWorthyProfileTranscript("已经读取三个文件，让我继续读取剩余页面")).toBe(false);
    expect(isCheckpointWorthyProfileTranscript("确认 lib/router.ts:42 的 routeMap 将 LQBInvest 映射为零钱宝组件")).toBe(true);
    expect(isCheckpointWorthyProfileTranscript("根因：simple_profile_loop 允许根线程直接 Edit，绕过 task-executor")).toBe(true);
  });

  it("forces simple-profile workspace mutations through task-executor", () => {
    expect(getSimpleDelegationGuardError("Edit", { file_path: "src/a.ts" })).toContain("task-executor");
    expect(getSimpleDelegationGuardError("Write", { file_path: "src/a.ts" })).toContain("禁止直接修改");
    expect(getSimpleDelegationGuardError("Bash", { command: "git checkout -b feature/test" })).toContain("task-executor");
    expect(getSimpleDelegationGuardError("Read", { file_path: "src/a.ts" })).toBeNull();
    expect(getSimpleDelegationGuardError("Task", { subagent_type: "task-executor" })).toBeNull();
  });

  it("allows minimal root evidence reads before planner but blocks entering execution", () => {
    const session = {
      task_prompt: "读取多个附件并实现所有页面跳转",
      tool_calls: []
    } as unknown as AgentSession;
    const attachments = [
      { type: "file_ref" as const, path: ".ai-coder/uploads/id/page-01.png", display_name: "第 1 页" },
      { type: "file_ref" as const, path: ".ai-coder/uploads/id/page-02.png", display_name: "第 2 页" }
    ];

    expect(getSimplePlannerGuardError(
      session,
      attachments,
      "Read",
      { file_path: attachments[0]!.path }
    )).toBeNull();
    expect(getSimplePlannerGuardError(
      session,
      attachments,
      "Bash",
      { command: "git status" }
    )).toBeNull();
    expect(getSimplePlannerGuardError(
      session,
      attachments,
      "Task",
      { subagent_type: "task-executor" }
    )).toContain("进入实现前必须先委托 task-planner");
    expect(getSimplePlannerGuardError(
      session,
      attachments,
      "Task",
      { subagent_type: "task-planner" }
    )).toBeNull();
  });

  it("requires a non-empty call-contract result to be merged before task-executor", () => {
    const session = {
      task_prompt: "复用已有组件",
      tool_calls: [{
        id: "contract",
        stage_id: "profile",
        tool: "Task",
        input: { subagent_type: "call-contract-investigator" },
        status: "completed",
        output_summary: "确认 src/Panel.tsx:42 的 Panel 组件要求传入 navigator 参数",
        created_at: "t"
      }],
      exploration_checkpoints: [{
        revision: 1,
        text: "## 已确认\n- 仍需调查调用方式。",
        disposition: "continue",
        phase: "investigate",
        observed_tool_call_count: 1,
        source: "agent",
        created_at: "t"
      }]
    } as unknown as AgentSession;

    expect(getSimpleExecutorPrerequisiteGuardError(
      session,
      "Task",
      { subagent_type: "task-executor" }
    )).toContain("checkpoint 必须实际写入调用契约证据");

    session.exploration_checkpoints![0]!.text = "## 已确认\n- 调用契约证据：src/Panel.tsx:42 的 Panel 组件要求 navigator 参数。";
    expect(getSimpleExecutorPrerequisiteGuardError(
      session,
      "Task",
      { subagent_type: "task-executor" }
    )).toBeNull();
  });

  it("enforces the executor prerequisite in PreToolUse even before canUseTool", async () => {
    let preToolDecision: unknown;
    let session!: AgentSession;
    async function* query(params: unknown) {
      const preToolUse = (params as {
        options: { hooks: { PreToolUse: Array<{ hooks: Array<(input: Record<string, unknown>) => Promise<unknown>> }> } }
      }).options.hooks.PreToolUse[0]!.hooks[0]!;
      preToolDecision = await preToolUse({
        tool_name: "Task",
        tool_input: { subagent_type: "task-executor", description: "实现单点修改" },
        tool_use_id: "executor-before-contract"
      });
      applyExplorationCheckpoint(session, {
        memory: "## 已确认\n- 已验证 executor 前置门禁。",
        disposition: "complete",
        phase: "complete",
        next_action: "完成"
      });
      yield { type: "result", subtype: "success", is_error: false, result: "done" };
    }
    const profileWorkflow: WorkflowTemplate = {
      ...workflow,
      id: "simple-executor-hook-guard",
      stages: [],
      simple_profile_loop: true,
      agents: { "task-executor": { description: "execute", prompt: "execute" } }
    };
    session = {
      id: "simple-executor-hook-guard",
      project_path: "/tmp/project",
      workflow_id: profileWorkflow.id,
      task_prompt: "实现单点修改",
      status: "running",
      current_stage: "profile",
      messages: [], tool_calls: [], file_changes: [], approvals: [],
      created_at: "t", updated_at: "t"
    } as AgentSession;

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });
    expect(updated.status, updated.error).toBe("completed");
    expect(preToolDecision).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining("call-contract-investigator")
      }
    });
  });

  it("uses normal file accessibility checks without phase-specific input restrictions", async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), "ai-coder-input-registry-"));
    const registeredPath = path.join(projectPath, ".ai-coder", "uploads", "input-id", "source.png");
    const peerPath = path.join(projectPath, "workspace-assets", "other.png");
    await mkdir(path.dirname(registeredPath), { recursive: true });
    await mkdir(path.dirname(peerPath), { recursive: true });
    await writeFile(registeredPath, "registered input");
    await writeFile(peerPath, "unregistered input");
    const attachments = [{
      type: "file_ref" as const,
      path: ".ai-coder/uploads/input-id/source.png",
      display_name: "uploaded reference"
    }];

    await expect(validateProfileToolInput(
      "Read",
      { file_path: registeredPath },
      projectPath,
      attachments,
      "investigate"
    )).resolves.toBeNull();
    await expect(validateProfileToolInput(
      "Read",
      { file_path: registeredPath.replace(path.basename(projectPath), `${path.basename(projectPath)}-typo`) },
      projectPath,
      attachments,
      "investigate"
    )).resolves.toContain("附件路径不在宿主精确清单");
    await expect(validateProfileToolInput(
      "Read",
      { file_path: peerPath },
      projectPath,
      attachments,
      "investigate"
    )).resolves.toBeNull();
    await expect(validateProfileToolInput(
      "Bash",
      { command: `file ${peerPath}` },
      projectPath,
      attachments,
      "investigate"
    )).resolves.toBeNull();
  });

  it("does not add a host dedupe layer for identical tool requests", async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), "ai-coder-tool-dedupe-"));
    const pagePath = path.join(projectPath, "page-01.png");
    await writeFile(pagePath, "fixture");
    const decisions: unknown[] = [];
    const profileWorkflow: WorkflowTemplate = { ...workflow, id: "profile-workflow", stages: [] };
    async function* query(params: unknown) {
      const preToolUse = (params as {
        options: {
          hooks: {
            PreToolUse: Array<{ hooks: Array<(input: Record<string, unknown>) => Promise<unknown>> }>
          }
        }
      }).options.hooks.PreToolUse[0]!.hooks[0]!;
      decisions.push(...await Promise.all([
        preToolUse({
          tool_name: "Read",
          tool_input: { file_path: pagePath },
          tool_use_id: "read-first"
        }),
        preToolUse({
          tool_name: "Read",
          tool_input: { file_path: pagePath },
          tool_use_id: "read-duplicate"
        })
      ]));
      yield { type: "result", subtype: "success", is_error: false, result: "Done" };
    }
    const session = {
      id: "profile-tool-dedupe", project_path: projectPath, workflow_id: profileWorkflow.id,
      task_prompt: "Inspect one page", status: "running", current_stage: "profile", messages: [],
      tool_calls: [], file_changes: [], approvals: [], stage_runs: [], rework_requests: [], progress_events: [],
      task_tree: {
        goal_restated: "读取页面", strategy: "只读取一次",
        tasks: [{ id: "t1", description: "读取页面", dependencies: [], status: "completed", evidence: "fixture" }],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as AgentSession;

    await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect(decisions[0]).toEqual({ continue: true });
    expect(decisions[1]).toEqual({ continue: true });
  });

  it("does not count or soft-block repeated operations", async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), "ai-coder-tool-loop-"));
    const pagePath = path.join(projectPath, "page-01.png");
    await writeFile(pagePath, "fixture");
    const profileWorkflow: WorkflowTemplate = { ...workflow, id: "profile-workflow", stages: [] };
    async function* query(params: unknown) {
      const preToolUse = (params as {
        options: {
          hooks: {
            PreToolUse: Array<{ hooks: Array<(input: Record<string, unknown>) => Promise<unknown>> }>
          }
        }
      }).options.hooks.PreToolUse[0]!.hooks[0]!;
      await Promise.all(Array.from({ length: 4 }, (_, index) => preToolUse({
        tool_name: "Read",
        tool_input: { file_path: pagePath },
        tool_use_id: `read-loop-${index}`
      })));
      yield { type: "result", subtype: "success", is_error: false, result: "Continued after soft block" };
    }
    const session = {
      id: "profile-tool-loop", project_path: projectPath, workflow_id: profileWorkflow.id,
      task_prompt: "Inspect page", status: "running", current_stage: "profile", messages: [],
      tool_calls: [], file_changes: [], approvals: [], stage_runs: [], rework_requests: [], progress_events: [],
      task_tree: {
        goal_restated: "读取页面", strategy: "读取一次",
        tasks: [{ id: "t1", description: "读取", dependencies: [], status: "completed", evidence: "fixture" }],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as AgentSession;

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect(updated.status, updated.error).toBe("completed");
    expect(updated.progress_events?.some((event) => event.message.includes("同一操作重复"))).toBe(false);
  });

  it("does not count duplicate tool uses across hooks", async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), "ai-coder-tool-hook-count-"));
    const pagePath = path.join(projectPath, "page-01.txt");
    await writeFile(pagePath, "cached text");
    const profileWorkflow: WorkflowTemplate = { ...workflow, id: "profile-workflow", stages: [] };
    async function* query(params: unknown) {
      const typed = params as {
        options: {
          hooks: {
            PreToolUse: Array<{ hooks: Array<(input: Record<string, unknown>) => Promise<unknown>> }>
          };
          canUseTool: (
            toolName: string,
            input: Record<string, unknown>,
            options: { toolUseID: string }
          ) => Promise<unknown>;
        }
      };
      const preToolUse = typed.options.hooks.PreToolUse[0]!.hooks[0]!;
      for (let index = 1; index <= 3; index += 1) {
        const toolUseID = `cached-read-${index}`;
        const toolInput = { file_path: pagePath };
        await preToolUse({ tool_name: "Read", tool_input: toolInput, tool_use_id: toolUseID });
        await typed.options.canUseTool("Read", toolInput, { toolUseID });
      }
      applyExplorationCheckpoint(session, {
        memory: "## 已确认\n- 重复工具请求未被宿主缓存或计数。\n## 仍缺少\n- 无。",
        disposition: "complete"
      });
      yield { type: "result", subtype: "success", is_error: false, result: "Continued" };
    }
    const session = {
      id: "profile-tool-hook-count", project_path: projectPath, workflow_id: profileWorkflow.id,
      task_prompt: "Continue", status: "running", current_stage: "profile", messages: [],
      tool_calls: [{
        id: "cached-read",
        stage_id: "profile",
        tool: "Read",
        input: { file_path: pagePath },
        status: "completed",
        output_summary: "cached text",
        created_at: new Date().toISOString(),
        resolved_at: new Date().toISOString()
      }],
      file_changes: [], approvals: [], stage_runs: [], rework_requests: [], progress_events: [],
      task_tree: {
        goal_restated: "继续", strategy: "使用缓存",
        tasks: [{ id: "t1", description: "完成", dependencies: [], status: "completed", evidence: "done" }],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as AgentSession;

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect(updated.status, updated.error).toBe("completed");
    expect(updated.progress_events?.some((event) => event.message.includes("累计重复"))).toBe(false);
  });

  it("does not maintain counters for previously visited pages", async () => {
    const profileWorkflow: WorkflowTemplate = { ...workflow, id: "profile-workflow", stages: [] };
    const pagePaths = Array.from(
      { length: 10 },
      (_, index) => `/tmp/uploads/page-${String(index + 1).padStart(2, "0")}.png`
    );
    async function* query(params: unknown) {
      const typed = params as {
        options: {
          hooks: {
            PreToolUse: Array<{ hooks: Array<(input: Record<string, unknown>) => Promise<unknown>> }>
          };
          canUseTool: (
            toolName: string,
            input: Record<string, unknown>,
            options: { toolUseID: string }
          ) => Promise<unknown>;
        }
      };
      const preToolUse = typed.options.hooks.PreToolUse[0]!.hooks[0]!;
      for (const [index, filePath] of pagePaths.entries()) {
        const toolUseID = `cached-page-${index + 1}`;
        const toolInput = { file_path: filePath };
        await preToolUse({ tool_name: "Read", tool_input: toolInput, tool_use_id: toolUseID });
        await typed.options.canUseTool("Read", toolInput, { toolUseID });
      }
      yield { type: "result", subtype: "success", is_error: false, result: "Used cached evidence" };
    }
    const session = {
      id: "profile-many-cached-pages", project_path: "/tmp/project", workflow_id: profileWorkflow.id,
      task_prompt: "Continue", status: "running", current_stage: "profile", messages: [],
      tool_calls: pagePaths.map((filePath, index) => ({
        id: `prior-page-${index + 1}`,
        stage_id: "profile",
        tool: "Read",
        input: { file_path: filePath },
        status: "completed" as const,
        output_summary: '{"type":"image","file":{"base64":"omitted"}}',
        created_at: new Date().toISOString(),
        resolved_at: new Date().toISOString()
      })),
      file_changes: [], approvals: [], stage_runs: [], rework_requests: [], progress_events: [],
      task_tree: {
        goal_restated: "继续", strategy: "使用缓存",
        tasks: [{ id: "t1", description: "完成", dependencies: [], status: "completed", evidence: "done" }],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as AgentSession;

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect(updated.status, updated.error).toBe("completed");
    expect(updated.progress_events?.some((event) => event.message.includes("累计命中"))).toBe(false);
  });

  it("allows a later Read without replaying a cached conclusion", async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), "ai-coder-image-evidence-"));
    const imageDir = path.join(projectPath, "pages");
    const imagePath = path.join(imageDir, "page-17.png");
    await mkdir(imageDir, { recursive: true });
    await writeFile(imagePath, "fixture");
    const equivalentPath = `${imageDir}/./page-17.png`;
    const profileWorkflow: WorkflowTemplate = { ...workflow, id: "profile-workflow", stages: [] };
    let attempts = 0;
    let sameQueryDecision: unknown;
    let duplicateDecision: unknown;
    async function* query(params: unknown) {
      attempts += 1;
      if (attempts === 1) {
        yield {
          type: "assistant",
          message: {
            content: [{
              type: "tool_use",
              id: "read-image-once",
              name: "Read",
              input: { file_path: imagePath }
            }]
          }
        };
        yield {
          type: "user",
          message: {
            content: [{
              type: "tool_result",
              tool_use_id: "read-image-once",
              content: `{"type":"image","file":{"base64":"${"A".repeat(500)}"}}`,
              is_error: false
            }]
          }
        };
        const canUseTool = (params as {
          options: {
            canUseTool: (
              toolName: string,
              input: Record<string, unknown>,
              options: { toolUseID: string }
            ) => Promise<unknown>
          }
        }).options.canUseTool;
        sameQueryDecision = await canUseTool(
          "Read",
          { file_path: imagePath },
          { toolUseID: "read-image-same-query" }
        );
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "已读取附件并确认：第 17 页包含序号 33 到 36 的页面映射。"
        };
        return;
      }
      const canUseTool = (params as {
        options: {
          canUseTool: (
            toolName: string,
            input: Record<string, unknown>,
            options: { toolUseID: string }
          ) => Promise<unknown>
        }
      }).options.canUseTool;
      duplicateDecision = await canUseTool(
        "Read",
        { file_path: equivalentPath },
        { toolUseID: "read-image-again" }
      );
      session.task_tree!.tasks[0]!.status = "completed";
      session.task_tree!.tasks[0]!.evidence = "test cleanup";
      yield { type: "result", subtype: "success", is_error: false, result: "Read again when needed" };
      applyExplorationCheckpoint(session, {
        memory: "## 已确认\n已根据当前知识与必要读取完成任务，现有证据足够。",
        disposition: "complete"
      });
    }
    const session = {
      id: "profile-image-evidence", project_path: projectPath, workflow_id: profileWorkflow.id,
      task_prompt: "读取附件后实现", status: "running", current_stage: "profile", messages: [],
      tool_calls: [], file_changes: [], approvals: [], stage_runs: [], rework_requests: [], progress_events: [],
      task_tree: {
        goal_restated: "实现", strategy: "先读取附件",
        tasks: [{ id: "t1", description: "实现", dependencies: [], status: "in_progress" }],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as AgentSession;

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect(attempts).toBe(2);
    expect(sameQueryDecision).toMatchObject({ behavior: "allow" });
    expect(duplicateDecision).toMatchObject({ behavior: "allow" });
    expect(updated.tool_calls.find((toolCall) => toolCall.id === "read-image-once")?.output_summary)
      .toContain("同轮助手结论");
    expect(updated.status, updated.error).toBe("completed");
  });

  it("continues from the knowledge context after a post-result crash", () => {
    const context = buildCompletionContinuationContext(
      ["仍有未完成任务：t1(pending)"],
      "已经确认序号 33-44 的页面和 pageName。",
      true
    );

    expect(context).toContain("这是同一任务的续跑，不是新任务");
    expect(context).toContain("上一轮 SDK 已经返回 success");
    expect(context).toContain("当前知识雪球");
    expect(context).toContain("已经确认序号 33-44");
  });

  it("does not inject prior tool payloads into continuation context", () => {
    const context = buildCompletionContinuationContext(
      ["仍有未完成任务：t1(in_progress)"],
      "继续实现"
    );

    expect(context).not.toContain("已完成的跨轮工具证据");
    expect(context).not.toContain("iVBORw0KGgo");
  });

  it("denies restarting task-planner after a detailed task tree already exists", async () => {
    let plannerDecision: unknown;
    const profileWorkflow: WorkflowTemplate = {
      ...workflow,
      id: "profile-workflow",
      stages: [],
      agents: { "task-planner": { description: "plan", prompt: "plan" } }
    };
    async function* query(params: unknown) {
      const canUseTool = (params as {
        options: {
          canUseTool: (
            toolName: string,
            input: Record<string, unknown>,
            options: { toolUseID: string }
          ) => Promise<unknown>
        }
      }).options.canUseTool;
      plannerDecision = await canUseTool(
        "Task",
        { subagent_type: "task-planner", description: "重新读取需求" },
        { toolUseID: "planner-repeat" }
      );
      yield { type: "result", subtype: "success", is_error: false, result: "Done" };
    }
    const session = {
      id: "profile-no-replan", project_path: "/tmp/project", workflow_id: profileWorkflow.id,
      task_prompt: "Continue", status: "running", current_stage: "profile", messages: [],
      tool_calls: [{
        id: "planner-completed",
        stage_id: "profile",
        tool: "Task",
        input: { subagent_type: "task-planner", description: "首次计划" },
        status: "completed",
        created_at: new Date().toISOString()
      }],
      file_changes: [], approvals: [], stage_runs: [], rework_requests: [], progress_events: [],
      task_tree: {
        goal_restated: "继续实现", strategy: "按既有计划继续",
        tasks: [{ id: "t1", description: "实现", dependencies: [], status: "completed", evidence: "done" }],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as AgentSession;

    await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect(plannerDecision).toMatchObject({ behavior: "deny", interrupt: false });
    expect(JSON.stringify(plannerDecision)).toContain("不得重新规划");
  });

  it("injects persisted knowledge rather than replaying tool cache on resume", async () => {
    let receivedPrompt = "";
    const profileWorkflow: WorkflowTemplate = { ...workflow, id: "profile-workflow", stages: [] };
    async function* query(params: unknown) {
      receivedPrompt = String((params as { prompt?: unknown }).prompt ?? "");
      yield { type: "result", subtype: "success", is_error: false, result: "Resumed" };
    }
    const session = {
      id: "profile-resume-evidence", project_path: "/tmp/project", workflow_id: profileWorkflow.id,
      task_prompt: "Continue implementation", status: "running", current_stage: "profile",
      messages: [{
        role: "assistant",
        content: "上一轮已经确认序号 33-44 的页面映射。",
        created_at: new Date().toISOString()
      }],
      tool_calls: [{
        id: "read-page-17",
        stage_id: "profile",
        tool: "Read",
        input: { file_path: "/tmp/uploads/page-17.png" },
        status: "completed",
        output_summary: "image inspected",
        created_at: new Date().toISOString(),
        resolved_at: new Date().toISOString()
      }],
      file_changes: [], approvals: [], stage_runs: [], rework_requests: [], progress_events: [],
      task_tree: {
        goal_restated: "继续实现", strategy: "沿用既有证据",
        tasks: [{ id: "t1", description: "实现", dependencies: [], status: "completed", evidence: "done" }],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      },
      exploration_checkpoints: [{
        revision: 2,
        text: "## 已确认\n- 附件路径：/tmp/uploads/page-17.png。\n- 上一轮已经确认序号 33-44 的页面映射。\n## 仍缺少\n- 继续实现。",
        disposition: "continue",
        phase: "implement",
        next_action: "继续实现",
        source: "agent",
        observed_tool_call_count: 1,
        created_at: new Date().toISOString()
      }],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as AgentSession;

    await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect(receivedPrompt).toContain("当前探索工作记忆");
    expect(receivedPrompt).toContain("/tmp/uploads/page-17.png");
    expect(receivedPrompt).toContain("上一轮已经确认序号 33-44");
  });

  it("retries a truncated streaming JSON response instead of interrupting the Profile run", async () => {
    const profileWorkflow: WorkflowTemplate = {
      ...workflow,
      id: "profile-workflow",
      stages: []
    };
    let attempt = 0;
    async function* query() {
      attempt += 1;
      if (attempt === 1) {
        yield {
          type: "system",
          subtype: "init",
          model: "Qwen3.5-397B",
          session_id: "sdk-session-truncated"
        };
        throw new SyntaxError("Unterminated string in JSON at position 116000 (line 1 column 116001)");
      }
      yield { type: "result", subtype: "success", is_error: false, result: "Recovered after truncated JSON" };
    }
    const session = {
      id: "00000000-0000-4000-8000-000000000082",
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
    expect(updated.messages.at(-1)?.content).toBe("Recovered after truncated JSON");
    expect(updated.progress_events?.some((event) =>
      event.message.includes("API 调用失败：Unterminated string in JSON")
    )).toBe(true);
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
          t1: { description: "实现并验证", dependencies: [], acceptance: ["可观察断言1", "可观察断言2"] }
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
          id: "planner-completed",
          stage_id: "profile",
          tool: "Task",
          input: { subagent_type: "task-planner", description: "制定任务 DAG" },
          status: "completed",
          created_at: new Date().toISOString()
        },
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
    expect(updated.task_tree?.tasks[0]?.acceptance).toEqual(["可观察断言1", "可观察断言2"]);
    expect(receivedPrompt).toContain(".ai-coder/uploads/spec/page-19.png");
    expect(receivedPrompt).toContain("需求.pdf · 第 19 页 / 共 21 页");
  });

  it("allows exploration checkpoints while keeping full memory out of tool-call audit input", async () => {
    const profileWorkflow: WorkflowTemplate = { ...workflow, id: "profile-workflow", stages: [] };
    const memory = "## 已确认\n实现、验证和最终审查均已完成，所有结论都有当前代码或命令输出作为依据。";
    let decision: unknown;
    async function* query(params: unknown) {
      yield {
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "checkpoint-final",
            name: "mcp__ai_coder__checkpoint_exploration",
            input: { memory, disposition: "complete" }
          }]
        }
      };
      const canUseTool = (params as {
        options: {
          canUseTool: (
            toolName: string,
            input: Record<string, unknown>,
            options: { toolUseID: string }
          ) => Promise<unknown>
        }
      }).options.canUseTool;
      decision = await canUseTool(
        "mcp__ai_coder__checkpoint_exploration",
        { memory, disposition: "complete" },
        { toolUseID: "checkpoint-final" }
      );
      applyExplorationCheckpoint(session, { memory, disposition: "complete" });
      yield {
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "checkpoint-final",
            content: "checkpoint saved",
            is_error: false
          }]
        }
      };
      yield { type: "result", subtype: "success", is_error: false, result: "Done" };
    }
    const session = {
      id: "profile-exploration-checkpoint", project_path: "/tmp/project", workflow_id: profileWorkflow.id,
      task_prompt: "完成实现", status: "running", current_stage: "profile", messages: [],
      tool_calls: [], file_changes: [], approvals: [], stage_runs: [], rework_requests: [], progress_events: [],
      task_tree: {
        goal_restated: "完成实现", strategy: "实现后审查",
        tasks: [{ id: "t1", description: "实现并验证", dependencies: [], status: "completed", evidence: "tests passed" }],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as AgentSession;

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect(updated.status, updated.error).toBe("completed");
    expect(decision).toEqual({
      behavior: "allow",
      updatedInput: { memory, disposition: "complete" }
    });
    expect(updated.tool_calls.find((toolCall) => toolCall.id === "checkpoint-final")?.input).toEqual({
      disposition: "complete",
      memory_chars: memory.length
    });
    expect(updated.exploration_checkpoints?.at(-1)?.text).toContain("实现、验证和最终审查均已完成");
    expect(updated.exploration_checkpoints?.at(-1)?.text).toContain("用户原始目标");
  });

  it("stops the Profile loop when an agent checkpoint explicitly reports a blocker", async () => {
    const profileWorkflow: WorkflowTemplate = { ...workflow, id: "profile-workflow", stages: [] };
    async function* query() {
      yield { type: "result", subtype: "success", is_error: false, result: "Need external input" };
      applyExplorationCheckpoint(session, {
        memory: "## 已确认\n现有代码和附件均未提供必需的外部系统标识。\n## 阻塞\n缺少该标识时无法安全实现或验证。",
        disposition: "blocked"
      });
    }
    const session = {
      id: "profile-exploration-blocked", project_path: "/tmp/project", workflow_id: profileWorkflow.id,
      task_prompt: "完成外部系统接入", status: "running", current_stage: "profile", messages: [],
      tool_calls: [], file_changes: [], approvals: [], stage_runs: [], rework_requests: [], progress_events: [],
      task_tree: {
        goal_restated: "完成外部系统接入", strategy: "先确认标识",
        tasks: [{ id: "t1", description: "接入", dependencies: [], status: "blocked" }],
        created_at: "t", updated_at: "t"
      },
      created_at: "t", updated_at: "t"
    } as AgentSession;

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect(updated.status).toBe("blocked");
    expect(updated.error).toContain("需要外部信息或状态变化");
  });

  it("infers a missing task-tree action and rewrites pending-to-completed as in_progress", async () => {
    let decision: unknown;
    const profileWorkflow: WorkflowTemplate = { ...workflow, id: "profile-workflow", stages: [] };
    const session = {
      id: "profile-task-catchup", project_path: "/tmp/project", workflow_id: profileWorkflow.id,
      task_prompt: "Continue", status: "running", current_stage: "profile", messages: [],
      tool_calls: [], file_changes: [], approvals: [], stage_runs: [], rework_requests: [], progress_events: [],
      task_tree: {
        goal_restated: "继续", strategy: "沿用证据",
        tasks: [{ id: "t1", description: "实现", dependencies: [], status: "pending" }],
        current_focus: "t1",
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as AgentSession;
    async function* query(params: unknown) {
      const canUseTool = (params as {
        options: {
          canUseTool: (
            toolName: string,
            input: Record<string, unknown>,
            options: { toolUseID: string }
          ) => Promise<unknown>
        }
      }).options.canUseTool;
      decision = await canUseTool("mcp__ai_coder__update_task_tree", {
        task_id: "t1",
        new_status: "completed",
        evidence: "上一轮已有证据"
      }, { toolUseID: "tree-catchup" });
      const task = session.task_tree!.tasks[0]!;
      task.status = "completed";
      task.evidence = "test cleanup";
      yield { type: "result", subtype: "success", is_error: false, result: "Continued" };
    }

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect(updated.status, updated.error).toBe("completed");
    expect(decision).toMatchObject({
      behavior: "allow",
      updatedInput: expect.objectContaining({
        action: "update_status",
        task_id: "t1",
        new_status: "in_progress"
      })
    });
  });

  it("repairs an empty update_status call to the only dependency-ready pending task", async () => {
    let decision: unknown;
    const profileWorkflow: WorkflowTemplate = { ...workflow, id: "profile-workflow", stages: [] };
    const session = {
      id: "profile-task-empty-update", project_path: "/tmp/project", workflow_id: profileWorkflow.id,
      task_prompt: "Continue", status: "running", current_stage: "profile", messages: [],
      tool_calls: [], file_changes: [], approvals: [], stage_runs: [], rework_requests: [], progress_events: [],
      task_tree: {
        goal_restated: "继续", strategy: "按依赖执行",
        current_focus: "t1",
        tasks: [
          { id: "t1", description: "准备", dependencies: [], status: "completed", evidence: "done" },
          { id: "t2", description: "读取附件", dependencies: ["t1"], status: "pending" }
        ],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as AgentSession;
    async function* query(params: unknown) {
      const canUseTool = (params as {
        options: {
          canUseTool: (
            toolName: string,
            input: Record<string, unknown>,
            options: { toolUseID: string }
          ) => Promise<unknown>
        }
      }).options.canUseTool;
      decision = await canUseTool(
        "mcp__ai_coder__update_task_tree",
        { action: "update_status" },
        { toolUseID: "tree-empty-update" }
      );
      const task = session.task_tree!.tasks.find((item) => item.id === "t2")!;
      task.status = "completed";
      task.evidence = "test cleanup";
      yield { type: "result", subtype: "success", is_error: false, result: "Continued" };
    }

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect(updated.status, updated.error).toBe("completed");
    expect(decision).toMatchObject({
      behavior: "allow",
      updatedInput: expect.objectContaining({
        action: "update_status",
        task_id: "t2",
        new_status: "in_progress"
      })
    });
    expect(updated.progress_events?.some((event) => event.message.includes("宿主安全补齐"))).toBe(true);
    expect(updated.progress_events?.some((event) => event.message.includes("未兜底"))).toBe(false);
  });

  it("reuses tasks from a prior corrupted-name bootstrap when the retry drops tasks", async () => {
    let decision: unknown;
    const profileWorkflow: WorkflowTemplate = {
      ...workflow, id: "profile-workflow", stages: [],
      agents: {
        "task-planner": { description: "plan", prompt: "plan" },
        "task-executor": { description: "execute", prompt: "execute" }
      }
    };
    const session = {
      id: "profile-bootstrap-reuse", project_path: "/tmp/project", workflow_id: profileWorkflow.id,
      task_prompt: "实现附件需求", status: "running", current_stage: "profile", messages: [],
      file_changes: [], approvals: [], stage_runs: [], rework_requests: [], progress_events: [],
      // 仅 host-goal 占位 -> profileNeedsPlanning=true，允许 bootstrap
      task_tree: {
        goal_restated: "实现附件需求", strategy: "待 planner 细化",
        tasks: [{ id: "host-goal", description: "完成用户请求", dependencies: [], status: "in_progress" }],
        current_focus: "host-goal",
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      },
      tool_calls: [
        // task-planner 已完成 -> 放行 update_task_tree
        {
          id: "planner-done", stage_id: "profile", tool: "Task",
          input: { subagent_type: "task-planner", description: "制定 DAG" },
          status: "completed", created_at: new Date().toISOString()
        },
        // 前序 bootstrap 用了损坏的工具名 mcp__ai_c__update_task_tree 且携带完整 tasks，
        // SDK 回 "No such tool available" 后被记录为 failed，但 input（含 tasks）仍在。
        {
          id: "prior-corrupted-bootstrap", stage_id: "profile", tool: "mcp__ai_c__update_task_tree",
          input: {
            action: "bootstrap",
            goal_restated: "实现附件需求",
            strategy: "按模块边界拆分",
            tasks: [
              { id: "t1", description: "实现 A", dependencies: [] },
              { id: "t2", description: "实现 B", dependencies: ["t1"] }
            ],
            next_focus: "t1",
            next_reason: "从 t1 开始"
          },
          status: "failed", created_at: new Date().toISOString()
        }
      ],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as AgentSession;
    async function* query(params: unknown) {
      const canUseTool = (params as {
        options: {
          canUseTool: (
            toolName: string,
            input: Record<string, unknown>,
            options: { toolUseID: string }
          ) => Promise<unknown>;
        }
      }).options.canUseTool;
      // 重试时模型用了正确工具名，但丢掉了 tasks 参数，且 next_focus 写成了非任务标识。
      decision = await canUseTool("mcp__ai_coder__update_task_tree", {
        action: "bootstrap",
        goal_restated: "实现附件需求",
        strategy: "按模块边界拆分",
        next_focus: "checkout-branch",
        next_reason: "先切分支"
      }, { toolUseID: "tree-retry" });
      // 任务树已由宿主复用建立；标记完成以满足完成闸门
      for (const task of session.task_tree!.tasks) {
        task.status = "completed";
        task.evidence = "test cleanup";
      }
      yield { type: "result", subtype: "success", is_error: false, result: "Done" };
    }

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect(updated.status, updated.error).toBe("completed");
    expect((decision as { behavior?: string }).behavior).toBe("allow");
    // 复用了前序的 t1/t2，且补齐了 host-final-audit
    const ids = updated.task_tree!.tasks.map((task) => task.id);
    expect(ids).toEqual(["t1", "t2", "host-final-audit"]);
    // next_focus="checkout-branch" 不是真实任务 id，应回退到首个任务 t1
    expect(updated.task_tree!.current_focus).toBe("t1");
    expect(updated.progress_events?.some((event) =>
      event.message.includes("宿主复用前序 bootstrap")
    )).toBe(true);
  });

  it("denies a task-less bootstrap with no prior attempt and points back to the planner DAG", async () => {
    let decision: unknown;
    const profileWorkflow: WorkflowTemplate = {
      ...workflow, id: "profile-workflow", stages: [],
      agents: { "task-planner": { description: "plan", prompt: "plan" } }
    };
    const session = {
      id: "profile-bootstrap-empty", project_path: "/tmp/project", workflow_id: profileWorkflow.id,
      task_prompt: "实现附件需求", status: "running", current_stage: "profile", messages: [],
      tool_calls: [
        {
          id: "planner-done", stage_id: "profile", tool: "Task",
          input: { subagent_type: "task-planner", description: "制定 DAG" },
          status: "completed", created_at: new Date().toISOString()
        }
      ],
      file_changes: [], approvals: [], stage_runs: [], rework_requests: [], progress_events: [],
      task_tree: {
        goal_restated: "实现附件需求", strategy: "待细化",
        tasks: [{ id: "host-goal", description: "完成用户请求", dependencies: [], status: "in_progress" }],
        current_focus: "host-goal",
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as AgentSession;
    async function* query(params: unknown) {
      const canUseTool = (params as {
        options: {
          canUseTool: (
            toolName: string,
            input: Record<string, unknown>,
            options: { toolUseID: string }
          ) => Promise<unknown>;
        }
      }).options.canUseTool;
      decision = await canUseTool("mcp__ai_coder__update_task_tree", {
        action: "bootstrap",
        goal_restated: "实现附件需求",
        strategy: "按模块拆分"
      }, { toolUseID: "tree-empty" });
      yield { type: "result", subtype: "success", is_error: false, result: "Done" };
    }

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect((decision as { behavior?: string }).behavior).toBe("deny");
    expect((decision as { message?: string }).message).toContain("请把 task-planner 刚产出的 DAG 作为 tasks 传入");
    // 没有前序可复用时不应误建任务树
    expect(updated.task_tree!.tasks.every((task) => task.id === "host-goal")).toBe(true);
  });

  it("defaults current_focus to the first no-dependency entry task, not tasks[0]", async () => {
    let decision: unknown;
    const profileWorkflow: WorkflowTemplate = {
      ...workflow, id: "profile-workflow", stages: [],
      agents: {
        "task-planner": { description: "plan", prompt: "plan" },
        "task-executor": { description: "execute", prompt: "execute" }
      }
    };
    const session = {
      id: "profile-bootstrap-focus", project_path: "/tmp/project", workflow_id: profileWorkflow.id,
      task_prompt: "实现附件需求", status: "running", current_stage: "profile", messages: [],
      tool_calls: [
        {
          id: "planner-done", stage_id: "profile", tool: "Task",
          input: { subagent_type: "task-planner", description: "制定 DAG" },
          status: "completed", created_at: new Date().toISOString()
        }
      ],
      file_changes: [], approvals: [], stage_runs: [], rework_requests: [], progress_events: [],
      task_tree: {
        goal_restated: "实现附件需求", strategy: "待细化",
        tasks: [{ id: "host-goal", description: "完成用户请求", dependencies: [], status: "in_progress" }],
        current_focus: "host-goal",
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as AgentSession;
    async function* query(params: unknown) {
      const canUseTool = (params as {
        options: {
          canUseTool: (
            toolName: string,
            input: Record<string, unknown>,
            options: { toolUseID: string }
          ) => Promise<unknown>;
        }
      }).options.canUseTool;
      // tasks[0]=t2 有依赖；t1 无依赖是真正的入口。模型没给 next_focus。
      decision = await canUseTool("mcp__ai_coder__update_task_tree", {
        action: "bootstrap",
        goal_restated: "实现附件需求",
        strategy: "按依赖拆分",
        tasks: [
          { id: "t2", description: "实现 B", dependencies: ["t1"] },
          { id: "t1", description: "实现 A", dependencies: [] }
        ]
      }, { toolUseID: "tree-focus" });
      for (const task of session.task_tree!.tasks) {
        task.status = "completed";
        task.evidence = "test cleanup";
      }
      yield { type: "result", subtype: "success", is_error: false, result: "Done" };
    }

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect(updated.status, updated.error).toBe("completed");
    expect((decision as { behavior?: string }).behavior).toBe("allow");
    // current_focus 必须落到无依赖入口 t1，而不是 tasks[0] 的 t2，避免跳过 DAG 顺序
    expect(updated.task_tree!.current_focus).toBe("t1");
  });

  it("detects corrupted tool names the SDK would reject before canUseTool", () => {
    expect(detectCorruptedToolName("mcp__ai_c__update_task_tree")).toContain("mcp__ai_coder__update_task_tree");
    expect(detectCorruptedToolName("mcp__ai_coder__checkpoint_checkpoint_exploration"))
      .toContain("mcp__ai_coder__checkpoint_exploration");
    expect(detectCorruptedToolName('"Bash" <parameter=command')).toContain("损坏的协议标记");
    expect(detectCorruptedToolName("mcp__ai_coder__update_task_tree")).toBeNull();
    expect(detectCorruptedToolName("Read")).toBeNull();
  });

  it("recovers a valid exploration checkpoint that arrived with a corrupted tool name", async () => {
    const profileWorkflow: WorkflowTemplate = { ...workflow, id: "profile-workflow", stages: [] };
    const memory = "## 已确认\n已读取当前代码、测试输出和最终 diff，独立审查没有发现新的待探索问题。";
    const session = {
      id: "profile-corrupted-checkpoint", project_path: "/tmp/project", workflow_id: profileWorkflow.id,
      task_prompt: "Continue", status: "running", current_stage: "profile", messages: [],
      tool_calls: [{
        id: "bad-checkpoint",
        stage_id: "profile",
        tool: "mcp__ai_coder__checkpoint_checkpoint_exploration",
        input: { memory, disposition: "complete" },
        status: "requested",
        created_at: new Date().toISOString()
      }],
      file_changes: [], approvals: [], stage_runs: [], rework_requests: [], progress_events: [],
      task_tree: {
        goal_restated: "继续",
        strategy: "复核后完成",
        tasks: [{ id: "t1", description: "复核", dependencies: [], status: "completed", evidence: "tests passed" }],
        created_at: "t",
        updated_at: "t"
      },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as AgentSession;
    const runner = new ClaudeAgentRunner(async function* () {});
    const repaired = await (runner as unknown as {
      tryApplyCorruptedExplorationCheckpointToolUse(
        input: { session: AgentSession; workflow: WorkflowTemplate },
        toolUse: { id: string; tool: string; input: Record<string, unknown> }
      ): Promise<boolean>
    }).tryApplyCorruptedExplorationCheckpointToolUse(
      { session, workflow: profileWorkflow },
      {
        id: "bad-checkpoint",
        tool: "mcp__ai_coder__checkpoint_checkpoint_exploration",
        input: { memory, disposition: "complete" }
      }
    );

    expect(repaired).toBe(true);
    expect(session.exploration_checkpoints?.at(-1)).toMatchObject({
      text: memory,
      disposition: "complete",
      source: "agent"
    });
    expect(session.tool_calls[0]).toMatchObject({
      tool: "mcp__ai_coder__checkpoint_exploration",
      input: { disposition: "complete", memory_chars: memory.length },
      status: "completed"
    });
    expect(evaluateProfileCompletion(session)).toEqual([]);
  });

  it("applies a valid task-tree mutation that arrived with a corrupted SDK tool name", async () => {
    const profileWorkflow: WorkflowTemplate = { ...workflow, id: "profile-workflow", stages: [] };
    const session = {
      id: "profile-corrupted-task-tree-tool", project_path: "/tmp/project", workflow_id: profileWorkflow.id,
      task_prompt: "Continue", status: "running", current_stage: "profile", messages: [],
      tool_calls: [
        {
          id: "executor-t2", stage_id: "profile", tool: "Task",
          input: { subagent_type: "task-executor", description: "执行 t2" },
          status: "completed", created_at: new Date().toISOString()
        },
        {
          id: "verifier-t2", stage_id: "profile", tool: "Task",
          input: { subagent_type: "task-verifier", description: "验证 t2" },
          status: "completed", created_at: new Date().toISOString()
        }
      ], file_changes: [], approvals: [], stage_runs: [], rework_requests: [], progress_events: [],
      task_tree: {
        goal_restated: "继续", strategy: "按依赖执行",
        current_focus: "t2",
        tasks: [
          { id: "t1", description: "准备", dependencies: [], status: "completed", evidence: "done" },
          { id: "t2", description: "验证映射", dependencies: ["t1"], status: "in_progress" },
          { id: "t3", description: "验证跳转", dependencies: ["t2"], status: "pending" }
        ],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as AgentSession;
    const runner = new ClaudeAgentRunner(async function* () {});
    const privateRunner = runner as unknown as {
      tryApplyCorruptedTaskTreeToolUse(
        input: { session: AgentSession; workflow: WorkflowTemplate },
        toolUse: { id: string; tool: string; input: Record<string, unknown> }
      ): Promise<boolean>;
    };

    const repaired = await privateRunner.tryApplyCorruptedTaskTreeToolUse(
      { session, workflow: profileWorkflow },
      {
        id: "bad-tree-tool",
        tool: "mcp__ai_coder__update_update_task_tree",
        input: {
          action: "update_status",
          task_id: "t2",
          new_status: "completed",
          evidence: "映射已验证",
          next_focus: "t3",
          next_reason: "进入下一项验证"
        }
      }
    );

    expect(repaired).toBe(true);
    expect(session.task_tree!.tasks.find((task) => task.id === "t2")).toMatchObject({
      status: "completed",
      evidence: "映射已验证"
    });
    expect(session.task_tree!.current_focus).toBe("t3");
    expect(session.progress_events?.some((event) =>
      event.message.includes("宿主从损坏工具名恢复")
    )).toBe(true);
  });

  it("does not overwrite a recovered corrupted task-tree call with the later SDK unknown-tool result", () => {
    const runner = new ClaudeAgentRunner(async function* () {});
    const session = {
      id: "profile-corrupted-task-tree-result", project_path: "/tmp/project", workflow_id: workflow.id,
      task_prompt: "Continue", status: "running", current_stage: "profile", messages: [],
      tool_calls: [{
        id: "bad-tree-tool",
        stage_id: "profile",
        tool: "mcp__ai_coder__update_task_tree",
        input: { action: "update_status", task_id: "t2", new_status: "completed" },
        status: "completed",
        output_summary: "t2 → completed",
        created_at: new Date().toISOString(),
        resolved_at: new Date().toISOString()
      }],
      file_changes: [], approvals: [], stage_runs: [], rework_requests: [],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as AgentSession;

    (runner as unknown as { recordToolExecutionResult(session: AgentSession, message: unknown): void })
      .recordToolExecutionResult(session, {
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "bad-tree-tool",
            content: "Error: No such tool available: mcp__ai_coder__update_update_task_tree",
            is_error: true
          }]
        }
      });

    expect(session.tool_calls[0]).toMatchObject({
      status: "completed",
      output_summary: "t2 → completed"
    });
  });

  it("denies an ambiguous empty update_status call with an actionable error", async () => {
    let decision: unknown;
    const profileWorkflow: WorkflowTemplate = { ...workflow, id: "profile-workflow", stages: [] };
    const session = {
      id: "profile-task-ambiguous-update", project_path: "/tmp/project", workflow_id: profileWorkflow.id,
      task_prompt: "Continue", status: "running", current_stage: "profile", messages: [],
      tool_calls: [], file_changes: [], approvals: [], stage_runs: [], rework_requests: [], progress_events: [],
      task_tree: {
        goal_restated: "继续", strategy: "并列任务",
        tasks: [
          { id: "t1", description: "任务一", dependencies: [], status: "pending" },
          { id: "t2", description: "任务二", dependencies: [], status: "pending" }
        ],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as AgentSession;
    async function* query(params: unknown) {
      const canUseTool = (params as {
        options: {
          canUseTool: (
            toolName: string,
            input: Record<string, unknown>,
            options: { toolUseID: string }
          ) => Promise<unknown>
        }
      }).options.canUseTool;
      decision = await canUseTool(
        "mcp__ai_coder__update_task_tree",
        { action: "update_status" },
        { toolUseID: "tree-ambiguous-update" }
      );
      for (const task of session.task_tree!.tasks) {
        task.status = "completed";
        task.evidence = "test cleanup";
      }
      yield { type: "result", subtype: "success", is_error: false, result: "Stopped malformed mutation" };
    }

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect(updated.status, updated.error).toBe("completed");
    expect(decision).toMatchObject({ behavior: "deny", interrupt: false });
    expect(JSON.stringify(decision)).toContain("同时有多个 dependency-ready");
    expect(JSON.stringify(decision)).toContain("请明确提供 task_id 和 new_status");
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

  it("stops after two delayed retries for consecutive Profile service-unavailable errors", async () => {
    const profileWorkflow: WorkflowTemplate = { ...workflow, id: "profile-workflow", stages: [] };
    let attempts = 0;
    async function* query() {
      attempts += 1;
      throw new Error("API Error: 503 No available workers: 0 prefill, 2 decode");
    }
    const session = {
      id: "profile-service-unavailable-limit",
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
        tasks: [{ id: "t1", description: "实现并验证", dependencies: [], status: "completed", evidence: "tests passed" }],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    } as AgentSession;
    const runner = new ClaudeAgentRunner({
      queryOverride: query,
      serviceUnavailableRetryDelaysMs: [0, 0]
    });

    const updated = await runner.run({ session, workflow: profileWorkflow });

    expect(attempts).toBe(3);
    expect(updated.status).toBe("interrupted");
    expect(updated.error).toContain("503 No available workers");
    expect(updated.progress_events?.some((event) =>
      event.message.includes("服务连续 3 次不可用") && event.message.includes("已停止自动重试")
    )).toBe(true);
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
      applyExplorationCheckpoint(session, {
        memory: "## 已确认\n脚本经过用户审批后执行完成，工具结果成功返回，任务树证据与实际执行结果一致。",
        disposition: "complete"
      });
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

  it("repairs a completed update_status call missing task_id to the only active task", async () => {
    let decision: unknown;
    const profileWorkflow: WorkflowTemplate = { ...workflow, id: "profile-workflow", stages: [] };
    const session = {
      id: "profile-task-complete-missing-id", project_path: "/tmp/project", workflow_id: profileWorkflow.id,
      task_prompt: "Continue", status: "running", current_stage: "profile", messages: [],
      tool_calls: [
        {
          id: "executor-t2", stage_id: "profile", tool: "Task",
          input: { subagent_type: "task-executor", description: "执行 t2" },
          status: "completed", created_at: new Date().toISOString()
        },
        {
          id: "verifier-t2", stage_id: "profile", tool: "Task",
          input: { subagent_type: "task-verifier", description: "验证 t2" },
          status: "completed", created_at: new Date().toISOString()
        }
      ], file_changes: [], approvals: [], stage_runs: [], rework_requests: [], progress_events: [],
      task_tree: {
        goal_restated: "继续", strategy: "按依赖执行",
        current_focus: "t2",
        tasks: [
          { id: "t1", description: "准备", dependencies: [], status: "completed", evidence: "done" },
          { id: "t2", description: "验证映射", dependencies: ["t1"], status: "in_progress" },
          { id: "t3", description: "验证跳转", dependencies: ["t2"], status: "pending" }
        ],
        created_at: new Date().toISOString(), updated_at: new Date().toISOString()
      },
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as AgentSession;
    async function* query(params: unknown) {
      const canUseTool = (params as {
        options: {
          canUseTool: (
            toolName: string,
            input: Record<string, unknown>,
            options: { toolUseID: string }
          ) => Promise<unknown>
        }
      }).options.canUseTool;
      decision = await canUseTool(
        "mcp__ai_coder__update_task_tree",
        {
          action: "update_status",
          new_status: "completed",
          evidence: "映射已验证",
          next_focus: "t3",
          next_reason: "进入下一项验证"
        },
        { toolUseID: "tree-complete-missing-id" }
      );
      for (const task of session.task_tree!.tasks) {
        task.status = "completed";
        task.evidence = task.evidence ?? "test cleanup";
      }
      yield { type: "result", subtype: "success", is_error: false, result: "Continued" };
    }

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect(updated.status, updated.error).toBe("completed");
    expect(decision).toMatchObject({
      behavior: "allow",
      updatedInput: expect.objectContaining({
        action: "update_status",
        task_id: "t2",
        new_status: "completed"
      })
    });
    expect(updated.task_tree!.current_focus).toBe("t3");
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

  it("marks Task results containing an embedded API error as failed rather than policy-blocked", () => {
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

    expect(session.tool_calls[0]).toMatchObject({ status: "failed" });
  });

  it("marks verifier and completeness review feedback as failed work that must flow back", () => {
    const runner = new ClaudeAgentRunner(async function* () {});
    const session = {
      id: "review-feedback", project_path: "/tmp/project", workflow_id: workflow.id, task_prompt: "inspect",
      status: "running", current_stage: "profile", messages: [], tool_calls: [
        {
          id: "verify-fail", stage_id: "profile", tool: "Task",
          input: { subagent_type: "task-verifier" }, status: "requested", created_at: "t"
        },
        {
          id: "audit-unclear", stage_id: "profile", tool: "Task",
          input: { subagent_type: "completeness-checker" }, status: "requested", created_at: "t"
        }
      ], file_changes: [], approvals: [], stage_runs: [], rework_requests: [],
      created_at: "t", updated_at: "t"
    } as AgentSession;
    const record = (toolUseId: string, content: string) => {
      (runner as unknown as { recordToolExecutionResult(session: AgentSession, message: unknown): void })
        .recordToolExecutionResult(session, {
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: false }]
          }
        });
    };

    record("verify-fail", '{"verdict":"FAIL","failure_details":"缺少边界验证"}');
    record("audit-unclear", '{"items":[{"covered":"UNCLEAR"}],"summary":{"unclear":1}}');

    expect(session.tool_calls.map((toolCall) => toolCall.status)).toEqual(["failed", "failed"]);
  });

  it("records an errored tool result as failed without duplicate-specific status", () => {
    const runner = new ClaudeAgentRunner(async function* () {});
    const session = {
      id: "duplicate-skipped", project_path: "/tmp/project", workflow_id: workflow.id, task_prompt: "inspect",
      status: "running", current_stage: "profile", messages: [], tool_calls: [{
        id: "read-duplicate",
        stage_id: "profile",
        tool: "Read",
        input: { file_path: "/tmp/spec.md" },
        status: "requested",
        created_at: new Date().toISOString()
      }], file_changes: [], approvals: [], stage_runs: [], rework_requests: [],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as AgentSession;

    (runner as unknown as { recordToolExecutionResult(session: AgentSession, message: unknown): void })
      .recordToolExecutionResult(session, {
        type: "user",
        message: {
          content: [{
            type: "tool_result",
            tool_use_id: "read-duplicate",
            is_error: true,
            content: "此操作已在本会话中成功完成，无需重复执行。请基于该结果继续。"
          }]
        }
      });

    expect(session.tool_calls[0]).toMatchObject({ status: "failed" });
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

  it("redirects premature Task calls to task-planner and still denies mutating Bash while PLAN is active", async () => {
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
      decisions.push(await canUseTool("Read", {
        file_path: "/tmp/project/.ai-coder/uploads/spec/page-01.png"
      }, { toolUseID: "premature-read" }));
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
    expect(decisions[0]).toMatchObject({ behavior: "deny" });
    expect(JSON.stringify(decisions[0])).toContain("根 Agent 不得直接读取附件或代码");
    expect(decisions[1]).toMatchObject({
      behavior: "allow",
      updatedInput: {
        subagent_type: "task-planner",
        description: "制定计划：scan"
      }
    });
    expect(decisions[2]).toMatchObject({ behavior: "deny" });
    expect(JSON.stringify(decisions[2])).toContain("根 Agent 不得直接读取附件或代码");
    expect(updated.progress_events?.some((event) =>
      event.message === "PLAN 阶段将 Explore 自动纠正为 task-planner"
    )).toBe(true);
  });

  it("injects the exact attachment manifest into task-planner assignments without replaying tool outputs", async () => {
    const projectPath = await mkdtemp(path.join(tmpdir(), "ai-coder-planner-attachments-"));
    const relativePagePath = ".ai-coder/uploads/spec/page-01.png";
    const followUpPath = ".ai-coder/uploads/follow-up/contract.txt";
    await mkdir(path.join(projectPath, ".ai-coder/uploads/spec"), { recursive: true });
    await mkdir(path.join(projectPath, ".ai-coder/uploads/follow-up"), { recursive: true });
    await writeFile(path.join(projectPath, relativePagePath), "fixture");
    await writeFile(path.join(projectPath, followUpPath), "compatibility");
    const profileWorkflow: WorkflowTemplate = {
      ...workflow,
      id: "profile-workflow",
      stages: [],
      agents: { "task-planner": { description: "plan", prompt: "plan" } }
    };
    let decision: unknown;
    async function* query(params: unknown) {
      const canUseTool = (params as {
        options: {
          canUseTool: (
            toolName: string,
            input: Record<string, unknown>,
            options: { toolUseID: string }
          ) => Promise<unknown>
        }
      }).options.canUseTool;
      decision = await canUseTool(
        "Task",
        { subagent_type: "task-planner", description: "读取需求并规划", prompt: "制定任务计划" },
        { toolUseID: "planner-with-manifest" }
      );
      const rootTask = session.task_tree!.tasks[0]!;
      rootTask.status = "completed";
      rootTask.evidence = "test cleanup";
      yield { type: "result", subtype: "success", is_error: false, result: "Planned" };
    }
    const firstMessage = {
      role: "user" as const,
      content: "实现附件需求",
      created_at: new Date().toISOString(),
      attachments: [{
        type: "file_ref" as const,
        path: relativePagePath,
        display_name: "需求.pdf · 第 1 页 / 共 21 页"
      }]
    };
    const session = {
      id: "profile-planner-attachment-manifest",
      project_path: projectPath,
      workflow_id: profileWorkflow.id,
      task_prompt: "实现附件需求",
      initial_user_message: firstMessage,
      status: "running",
      current_stage: "profile",
      messages: [
        firstMessage,
        {
          role: "user",
          content: "补充兼容性要求",
          created_at: new Date().toISOString(),
          attachments: [{
            type: "file_ref",
            path: followUpPath,
            display_name: "补充契约"
          }]
        }
      ],
      tool_calls: [
        {
          id: "prior-resource-read",
          stage_id: "profile",
          tool: "Read",
          input: { file_path: path.join(projectPath, relativePagePath) },
          status: "completed",
          exit_code: 0,
          output_summary: `{"type":"image","base64":"${"A".repeat(400)}"}`,
          created_at: new Date().toISOString()
        },
        {
          id: "prior-context-agent",
          stage_id: "profile",
          tool: "Task",
          input: { subagent_type: "context-reader" },
          status: "completed",
          exit_code: 0,
          output_summary: "已确认附件要求：公开调用契约必须保持兼容。",
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

    expect(decision).toMatchObject({
      behavior: "allow",
      updatedInput: expect.objectContaining({
        prompt: expect.stringContaining(relativePagePath)
      })
    });
    expect(JSON.stringify(decision)).toContain("只能逐字复制");
    expect(JSON.stringify(decision)).toContain(followUpPath);
    expect(JSON.stringify(decision)).not.toContain("宿主可复用证据");
    expect(JSON.stringify(decision)).not.toContain("公开调用契约必须保持兼容");
    expect(updated.status, updated.error).toBe("completed");
  });

  it("records a PLAN Task rewrite so the planner result can bootstrap the task tree", async () => {
    const profileWorkflow: WorkflowTemplate = {
      ...workflow,
      id: "profile-workflow",
      stages: [],
      agents: {
        "task-planner": { description: "plan", prompt: "plan" }
      }
    };
    const plannerJson = {
      requirements: [{ id: "R1", observable_result: "完成跳转支持" }],
      tasks: [{ id: "t1", description: "R1: 实现并验证跳转", dependencies: [] }],
      blocking_unknowns: []
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
      const decision = await canUseTool("Task", {
        subagent_type: "Explore",
        description: "探索页面跳转需求"
      }, { toolUseID: "planner-alias" });
      expect(decision).toMatchObject({
        behavior: "allow",
        updatedInput: { subagent_type: "task-planner" }
      });
      yield {
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "planner-alias",
            name: "Task",
            input: { subagent_type: "Explore", description: "探索页面跳转需求" }
          }]
        }
      };
      yield {
        type: "user",
        tool_use_result: {
          status: "completed",
          content: [{ type: "text", text: JSON.stringify(plannerJson) }]
        },
        message: {
          content: [{ type: "tool_result", tool_use_id: "planner-alias", is_error: false }]
        }
      };
      yield { type: "result", subtype: "success", is_error: false, result: "planned" };
    }
    const session = {
      id: "plan-task-rewrite", project_path: "/tmp/project", workflow_id: profileWorkflow.id,
      task_prompt: "实现页面跳转", status: "running", current_stage: "profile", messages: [],
      tool_calls: [],
      file_changes: [], approvals: [], stage_runs: [], rework_requests: [],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as AgentSession;

    const updated = await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect(updated.tool_calls[0]?.input).toMatchObject({ subagent_type: "task-planner" });
    expect(updated.task_tree?.tasks.map((task) => task.id)).toEqual(["t1", "host-final-audit"]);
  });

  it("uses PreToolUse hooks to block auto-allowed root reads while preserving planner reads", async () => {
    const decisions: unknown[] = [];
    const projectPath = await mkdtemp(path.join(tmpdir(), "ai-coder-plan-hook-"));
    const pagePath = path.join(projectPath, ".ai-coder", "uploads", "spec", "page-21.png");
    await mkdir(path.dirname(pagePath), { recursive: true });
    await writeFile(pagePath, "fixture");
    const profileWorkflow: WorkflowTemplate = {
      ...workflow,
      id: "profile-workflow",
      stages: [],
      agents: {
        "task-planner": { description: "plan", prompt: "plan" }
      }
    };
    async function* query(params: unknown) {
      const hooks = (params as {
        options: {
          hooks: Record<string, Array<{
            hooks: Array<(input: Record<string, unknown>) => Promise<unknown>>
          }>>;
        };
      }).options.hooks;
      const preToolUse = hooks.PreToolUse[0]!.hooks[0]!;
      const subagentStart = hooks.SubagentStart[0]!.hooks[0]!;
      const subagentStop = hooks.SubagentStop[0]!.hooks[0]!;

      decisions.push(await preToolUse({
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: path.join(projectPath, ".ai-coder", "uploads", "spec", "page-01.png") },
        tool_use_id: "root-read"
      }));
      decisions.push(await preToolUse({
        hook_event_name: "PreToolUse",
        tool_name: "Task",
        tool_input: { subagent_type: "Explore", description: "scan attachments" },
        tool_use_id: "root-task"
      }));
      await subagentStart({
        hook_event_name: "SubagentStart",
        agent_id: "planner-agent",
        agent_type: "task-planner"
      });
      decisions.push(await preToolUse({
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: pagePath },
        tool_use_id: "planner-read"
      }));
      await subagentStop({
        hook_event_name: "SubagentStop",
        agent_id: "planner-agent"
      });
      yield { type: "result", subtype: "success", is_error: false, result: "not done" };
    }
    const session = {
      id: "plan-pre-tool-hook", project_path: projectPath, workflow_id: profileWorkflow.id,
      task_prompt: "implement", status: "running", current_stage: "profile", messages: [],
      initial_user_message: {
        role: "user",
        content: "implement",
        created_at: new Date().toISOString(),
        attachments: [{
          type: "file_ref",
          path: ".ai-coder/uploads/spec/page-21.png",
          display_name: "需求附件"
        }]
      },
      tool_calls: [], file_changes: [], approvals: [], stage_runs: [], rework_requests: [],
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    } as AgentSession;

    await new ClaudeAgentRunner(query).run({ session, workflow: profileWorkflow });

    expect(decisions[0]).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny"
      }
    });
    expect(decisions[1]).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "allow",
        updatedInput: { subagent_type: "task-planner" }
      }
    });
    expect(decisions[2]).toEqual({ continue: true });
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
    expect(systemAppend).toContain("宿主按当前阶段注入的 Skills");
    expect(systemAppend).toContain("FULL_CONTRACT_SENTINEL");
    expect(updated.progress_events?.some((event) =>
      event.message.includes("宿主已按当前阶段注入")
      && event.message.includes("careful-coder:profile-contract")
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

  it("runs the simple profile loop with a checkpoint-derived phase task tree", async () => {
    const profileWorkflow: WorkflowTemplate = {
      ...workflow,
      id: "simple-profile-workflow",
      stages: [],
      simple_profile_loop: true,
      skills: ["exploring-codebase"],
      agents: {
        "task-verifier": { description: "独立验证当前阶段结果", prompt: "只读验证" }
      }
    };
    let injectedPrompt = "";
    let systemAppend = "";
    async function* query(params: unknown) {
      const typed = params as { prompt?: string; options?: { systemPrompt?: { append?: unknown } } };
      injectedPrompt = String(typed.prompt ?? "");
      systemAppend = String(typed.options?.systemPrompt?.append ?? "");
      applyExplorationCheckpoint(session, {
        memory: "## 已确认\n- 用户目标已经实现。\n- 相关验证已经通过。\n## 仍缺少\n- 无。",
        disposition: "complete",
        phase: "complete"
      });
      yield { type: "result", subtype: "success", is_error: false, result: "Done" };
    }
    const session = {
      id: "simple-profile-session",
      project_path: "/tmp/project",
      workflow_id: profileWorkflow.id,
      task_prompt: "完成一个简单任务",
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

    const updated = await new ClaudeAgentRunner({
      queryOverride: query,
      pluginPaths: [path.resolve(__dirname, "../../../plugins/careful-coder")]
    }).run({ session, workflow: profileWorkflow });

    expect(updated.status, updated.error).toBe("completed");
    expect(updated.task_tree?.strategy).toContain("阶段性任务树");
    expect(updated.task_tree?.tasks).toHaveLength(1);
    expect(updated.task_tree?.tasks[0]?.status).toBe("completed");
    expect(updated.exploration_checkpoints?.at(-1)?.disposition).toBe("complete");
    expect(injectedPrompt).toContain("当前可用能力");
    expect(injectedPrompt).toContain("careful-coder:exploring-codebase");
    expect(injectedPrompt).toContain("task-verifier");
    expect(injectedPrompt).toContain("Edit: 精确修改现有文件");
    expect(injectedPrompt).toContain("把选择理由写回知识雪球");
    expect(injectedPrompt.indexOf("用户原始目标与输入")).toBeLessThan(injectedPrompt.indexOf("当前探索工作记忆"));
    expect(injectedPrompt.indexOf("当前探索工作记忆")).toBeLessThan(injectedPrompt.indexOf("当前阶段任务"));
    expect(injectedPrompt.indexOf("当前阶段任务")).toBeLessThan(injectedPrompt.indexOf("当前执行观察"));
    expect(injectedPrompt.indexOf("当前执行观察")).toBeLessThan(injectedPrompt.indexOf("当前可用能力"));
    expect(systemAppend).toContain("宿主按当前阶段注入的 Skills");
    expect(systemAppend).toContain("What invokes this code at runtime");
    expect(systemAppend).toContain("优先委托");
    expect(systemAppend).toContain("第一次相关修改前必须通过 Task 使用 call-contract-investigator");
    expect(systemAppend).toContain("提示词装配顺序");
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
    expect(describeSdkMessageSnippet(msg)).toBe("请求 Read(src/auth.ts)");
  });

  it("assistant tool_use 提取 command 片段", () => {
    const msg = {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git log --oneline -5" } }] }
    };
    expect(describeSdkMessageSnippet(msg)).toBe("请求 Bash(git log --oneline -5)");
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
    expect(describeSdkMessageSnippet(msg)).toBe("先看一下历史。 | 请求 Bash(git log)");
  });

  it("assistant 无 content", () => {
    expect(describeSdkMessageSnippet({ type: "assistant", message: { content: [] } })).toBe("助手消息（无文本）");
    expect(describeSdkMessageSnippet({
      type: "assistant",
      message: { content: [{ type: "text", text: "(no content)" }] }
    })).toBe("助手消息（无文本）");
  });

  it("result / tool_result / 其他类型", () => {
    expect(describeSdkMessageSnippet({ type: "result", subtype: "success", is_error: false })).toBe("SDK 查询结束：success");
    expect(describeSdkMessageSnippet({ type: "result", subtype: "error_max_turns", is_error: true })).toBe("SDK 查询结束：error_max_turns，错误");
    expect(describeSdkMessageSnippet({ type: "tool_result" })).toBe("工具结果");
    expect(describeSdkMessageSnippet({ type: "system" })).toBe("SDK:system");
  });

  it("filters SDK user tool-result envelopes and formats plugin objects", () => {
    expect(describeSdkMessageSnippet({ type: "user", message: { content: [] } })).toBe("");
    expect(formatSdkCatalogItem({ type: "local", path: "/plugins/careful-coder" })).toBe("/plugins/careful-coder");
  });
});

describe("evaluateProfileCompletion", () => {
  it("rejects a natural SDK stop before a task tree exists", () => {
    expect(evaluateProfileCompletion({ task_tree: undefined } as AgentSession)).toContain("尚未建立任务树");
  });

  it("simple profile mode ignores task trees but still requires an agent-complete checkpoint", () => {
    const session = {
      tool_calls: [],
      exploration_checkpoints: [{
        revision: 1,
        text: "## 当前目标\n完成用户请求。\n## 已确认\n- 尚未开始取证。",
        disposition: "continue",
        next_action: "查看缺失信息",
        source: "host",
        observed_tool_call_count: 0,
        created_at: "t"
      }]
    } as unknown as AgentSession;

    expect(evaluateProfileCompletion(session, false)).toEqual([
      "探索工作记忆尚未声明完成：revision 1 为 continue"
    ]);
    session.exploration_checkpoints![0]!.source = "agent";
    session.exploration_checkpoints![0]!.disposition = "complete";
    expect(evaluateProfileCompletion(session, false)).toEqual([]);
  });

  it("requires real validation and an independent final audit before completing code changes", () => {
    const session = {
      tool_calls: [{
        id: "edit-1", stage_id: "profile", tool: "Edit", input: { file_path: "src/a.ts" },
        status: "completed", created_at: "t"
      }],
      file_changes: [{ path: "src/a.ts", operation: "modified" }],
      exploration_checkpoints: [{
        revision: 2,
        text: "## 已确认\n- 模型声明实现完成。",
        disposition: "complete",
        phase: "complete",
        source: "agent",
        observed_tool_call_count: 1,
        created_at: "t"
      }]
    } as unknown as AgentSession;

    expect(evaluateProfileCompletion(session, false)).toEqual(expect.arrayContaining([
      expect.stringContaining("没有成功的测试"),
      expect.stringContaining("completeness-checker")
    ]));

    session.tool_calls.push({
      id: "verify-1", stage_id: "profile", tool: "Task",
      input: { subagent_type: "task-verifier", prompt: "独立核对改动" },
      status: "completed", output_summary: '{"status":"PASS"}', created_at: "t"
    }, {
      id: "test-1", stage_id: "profile", tool: "Bash", input: { command: "npm test" },
      status: "completed", exit_code: 0, created_at: "t"
    }, {
      id: "audit-1", stage_id: "profile", tool: "Task",
      input: { subagent_type: "completeness-checker", prompt: "核对原始需求和最终 diff" },
      status: "completed", output_summary: '{"summary":{"covered":1,"uncovered":0,"unclear":0}}', created_at: "t"
    });
    session.exploration_checkpoints![0]!.observed_tool_call_count = 4;
    expect(evaluateProfileCompletion(session, false)).toContain(
      "代码已修改，但修改后尚未由 task-verifier 独立核对，或 verifier 结果尚未归并进知识雪球"
    );
    session.exploration_checkpoints![0]!.text = [
      "## 已确认",
      "- task-verifier 独立核对 PASS；证据：npm test 通过，未发现回归。",
      "- completeness-checker 已覆盖原始需求和最终 diff。"
    ].join("\n");
    expect(evaluateProfileCompletion(session, false)).toEqual([]);
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
      "完成节点缺少证据：t1",
      "尚未建立探索工作记忆 checkpoint"
    ]);
  });

  it("requires the latest exploration checkpoint to declare completion", () => {
    const session = {
      tool_calls: [],
      task_tree: {
        goal_restated: "完成修复",
        strategy: "按实现和验证拆分",
        created_at: "t",
        updated_at: "t",
        tasks: [
          { id: "t1", description: "实现", dependencies: [], status: "completed", evidence: "src/a.ts:10" },
          { id: "t2", description: "无需修改", dependencies: ["t1"], status: "skipped", status_reason: "已有覆盖" }
        ]
      },
      exploration_checkpoints: [{
        revision: 1,
        text: "## 已确认\n实现和验证均已完成，并且最终审查没有发现新的待探索问题。",
        disposition: "continue",
        next_action: "执行最终审查",
        observed_tool_call_count: 0,
        created_at: "t"
      }]
    } as unknown as AgentSession;

    expect(evaluateProfileCompletion(session)).toEqual([
      "探索工作记忆尚未声明完成：revision 1 为 continue"
    ]);

    session.exploration_checkpoints![0]!.disposition = "complete";
    expect(evaluateProfileCompletion(session)).toEqual([]);
  });

  it("rejects a complete checkpoint when later tool results were not reconciled", () => {
    const session = {
      tool_calls: [{
        id: "verify-after-checkpoint",
        stage_id: "profile",
        tool: "Bash",
        input: { command: "npm test" },
        status: "completed",
        exit_code: 0,
        created_at: "t"
      }],
      task_tree: {
        goal_restated: "完成修复",
        strategy: "实现后验证",
        created_at: "t",
        updated_at: "t",
        tasks: [
          { id: "t1", description: "实现并验证", dependencies: [], status: "completed", evidence: "npm test passed" }
        ]
      },
      exploration_checkpoints: [{
        revision: 2,
        text: "## 已确认\n实现已完成，但还没有吸收随后执行的测试输出。",
        disposition: "complete",
        observed_tool_call_count: 0,
        created_at: "t"
      }]
    } as unknown as AgentSession;

    expect(evaluateProfileCompletion(session)).toEqual([
      "checkpoint 后仍有未归并的工具结果或状态变化"
    ]);
  });
});

describe("exploration checkpoints", () => {
  it("bootstraps plain-text working memory and injects it into the prompt", () => {
    const session = {
      task_prompt: "修复全部页面跳转",
      tool_calls: []
    } as unknown as AgentSession;

    expect(ensureExplorationCheckpoint(session)).toBe(true);
    expect(ensureExplorationCheckpoint(session)).toBe(false);
    expect(session.exploration_checkpoints).toHaveLength(1);
    expect(buildExplorationPromptSection(session)).toContain("修复全部页面跳转");
    expect(buildExplorationPromptSection(session)).toContain("checkpoint_exploration");

    const baseline = session.exploration_checkpoints![0]!;
    applyExplorationCheckpoint(session, {
      memory: baseline.text,
      disposition: baseline.disposition,
      next_action: baseline.next_action
    });
    expect(session.exploration_checkpoints![0]!.source).toBe("agent");
  });

  it("injects bounded execution observations after knowledge without treating them as confirmed facts", () => {
    const session = {
      status: "running",
      current_stage: "profile",
      tool_calls: [{
        id: "read-after-checkpoint",
        stage_id: "profile",
        tool: "Read",
        input: { file_path: "src/router.ts" },
        status: "completed",
        output_summary: "发现一个新的调用方",
        created_at: "t"
      }],
      file_changes: [{ path: "src/router.ts", operation: "update", approved: true, created_at: "t" }],
      exploration_checkpoints: [{
        revision: 1,
        text: "## 已确认\n- 当前目标是修复路由。",
        disposition: "continue",
        observed_tool_call_count: 0,
        created_at: "t"
      }]
    } as unknown as AgentSession;

    const section = buildExecutionProgressPromptSection(session);
    expect(section).toContain("原始状态，不代替知识雪球");
    expect(section).toContain("Read: src/router.ts → completed");
    expect(section).toContain("发现一个新的调用方");
    expect(section).toContain("核对目标、实际结果、验证证据和新未知");
  });

  it("seeds exact attachment paths into confirmed knowledge and projects one phase task", () => {
    const session = {
      task_prompt: "按附件实现页面跳转",
      tool_calls: [],
      messages: [{
        role: "user",
        content: "见附件",
        created_at: "t",
        attachments: [{
          type: "file_ref",
          path: "/tmp/uploads/run-1/page-14.png",
          display_name: "page-14.png"
        }]
      }]
    } as unknown as AgentSession;

    ensureExplorationCheckpoint(session);
    expect(session.exploration_checkpoints?.[0]?.text).toContain("/tmp/uploads/run-1/page-14.png");
    expect(session.exploration_checkpoints?.[0]?.text).toContain("## 最相似既有实现");
    expect(session.exploration_checkpoints?.[0]?.next_action).toContain("寻找最相似功能的既有实现");
    expect(session.exploration_checkpoints?.[0]?.phase).toBe("investigate");
    expect(syncPhaseTaskTreeWithCheckpoint(session)).toBe(true);
    expect(session.task_tree?.strategy).toContain("阶段性任务树");
    expect(session.task_tree?.tasks).toHaveLength(1);
    expect(session.task_tree?.tasks[0]?.id).toBe("knowledge-r1");
  });

  it("treats phase as an advisory progress label and accepts concise checkpoint updates", () => {
    const session = {
      task_prompt: "调查后修复",
      tool_calls: []
    } as unknown as AgentSession;
    ensureExplorationCheckpoint(session);

    expect(() => applyExplorationCheckpoint(session, {
      memory: "已找到根因，继续实现。",
      disposition: "continue",
      phase: "implement",
    })).not.toThrow();
    expect(session.exploration_checkpoints?.at(-1)?.phase).toBe("implement");
    expect(session.exploration_checkpoints?.at(-1)?.text).toContain("## 最新补充");
    expect(session.exploration_checkpoints?.at(-1)?.next_action).toBeTruthy();
  });

  it("keeps the text free-form while versioning control metadata", () => {
    const session = {
      tool_calls: [
        {
          id: "read-1",
          stage_id: "profile",
          tool: "Read",
          input: { file_path: "src/router.ts" },
          status: "completed",
          created_at: "t"
        }
      ],
      exploration_checkpoints: []
    } as unknown as AgentSession;
    const memory = [
      "现在知道路由入口位于 src/router.ts:42。",
      "尚未确认详情页是否复用同一入口。",
      "下一步读取详情页调用方。"
    ].join("\n");

    expect(applyExplorationCheckpoint(session, {
      memory,
      disposition: "continue",
      next_action: "读取详情页调用方"
    })).toContain("revision 1");
    expect(session.exploration_checkpoints?.[0]).toMatchObject({
      revision: 1,
      text: memory,
      disposition: "continue",
      observed_tool_call_count: 1
    });

    session.tool_calls.push({
      id: "grep-2",
      stage_id: "profile",
      tool: "Grep",
      input: { pattern: "navigate" },
      status: "completed",
      created_at: "t"
    });
    expect(applyExplorationCheckpoint(session, {
      memory,
      disposition: "continue",
      next_action: "读取详情页调用方"
    })).toContain("刷新工具观察边界");
    expect(session.exploration_checkpoints).toHaveLength(1);
    expect(session.exploration_checkpoints?.[0]?.observed_tool_call_count).toBe(2);
  });

  it("automatically restores confirmed knowledge omitted by a later checkpoint", () => {
    const session = {
      tool_calls: [],
      exploration_checkpoints: [{
        revision: 1,
        text: [
          "## 已确认",
          "- 序号 33 对应 /example/list。",
          "- 路由入口位于 src/router.ts:42。",
          "## 仍需探索",
          "- 核对详情页。"
        ].join("\n"),
        disposition: "continue",
        next_action: "核对详情页",
        source: "agent",
        observed_tool_call_count: 0,
        created_at: "t"
      }]
    } as unknown as AgentSession;

    const result = applyExplorationCheckpoint(session, {
      memory: [
        "## 已确认",
        "- 路由入口位于 src/router.ts:42。",
        "- 详情页复用统一入口。",
        "## 下一步",
        "- 运行测试。"
      ].join("\n"),
      disposition: "verify",
      next_action: "运行测试"
    });

    expect(result).toContain("补回 1 条");
    expect(session.exploration_checkpoints?.at(-1)?.text).toContain("- 序号 33 对应 /example/list。");
    expect(session.exploration_checkpoints?.at(-1)?.text).toContain("- 详情页复用统一入口。");
  });

  it("keeps the old fact when a later checkpoint adds an evidenced correction", () => {
    const session = {
      tool_calls: [],
      exploration_checkpoints: [{
        revision: 1,
        text: "## 已确认\n- 序号 33 对应 /old/list。\n## 下一步\n- 核对附件。",
        disposition: "continue",
        next_action: "核对附件",
        source: "agent",
        observed_tool_call_count: 0,
        created_at: "t"
      }]
    } as unknown as AgentSession;
    applyExplorationCheckpoint(session, {
      memory: [
        "## 已确认",
        "- 校正：序号 33 对应 /old/list → /example/list；证据：需求附件第 19 页与 src/router.ts:42。",
        "## 下一步",
        "- 运行测试。"
      ].join("\n"),
      disposition: "verify",
      next_action: "运行测试"
    });

    const latest = session.exploration_checkpoints?.at(-1);
    expect(latest?.text).toContain("- 序号 33 对应 /old/list。");
    expect(latest?.text).toContain("- 校正：序号 33 对应 /old/list → /example/list");
  });

  it("requires knowledge reconciliation before the first mutation but not between edits in one batch", () => {
    const session = {
      task_prompt: "读取附件后实现路由",
      tool_calls: []
    } as unknown as AgentSession;
    ensureExplorationCheckpoint(session);
    session.tool_calls.push({
      id: "read-requirement",
      stage_id: "profile",
      tool: "Read",
      input: { file_path: "/tmp/page-19.png" },
      status: "completed",
      output_summary: "确认序号 33 的定义",
      created_at: "t"
    });

    expect(getSimpleKnowledgeBoundaryGuardError(
      session,
      "Edit",
      { file_path: "src/router.ts" }
    )).toContain("尚未归并进知识雪球");
    expect(getSimpleKnowledgeBoundaryGuardError(
      session,
      "Bash",
      { command: "git checkout -b feature/example" }
    )).toContain("checkpoint_exploration");
    expect(getSimpleKnowledgeBoundaryGuardError(
      session,
      "Bash",
      { command: "git status" }
    )).toBeNull();

    applyExplorationCheckpoint(session, {
      memory: "## 已确认\n- 附件第 19 页确认了序号 33 的页面定义。\n## 仍缺少\n- 实现后验证。",
      disposition: "continue",
      next_action: "按既有路由模式实现序号 33"
    });
    expect(getSimpleKnowledgeBoundaryGuardError(
      session,
      "Edit",
      { file_path: "src/router.ts" }
    )).toBeNull();

    session.tool_calls.push({
      id: "first-edit",
      stage_id: "profile",
      tool: "Edit",
      input: { file_path: "src/router.ts" },
      status: "completed",
      output_summary: "加入路由映射",
      created_at: "t"
    });
    session.tool_calls.push({
      id: "read-after-edit",
      stage_id: "profile",
      tool: "Read",
      input: { file_path: "src/router.ts" },
      status: "completed",
      output_summary: "检查刚完成的编辑",
      created_at: "t"
    });
    expect(getSimpleKnowledgeBoundaryGuardError(
      session,
      "Edit",
      { file_path: "src/router.ts" }
    )).toBeNull();
  });

  it("requires stale knowledge to be reconciled before the next high-level action", () => {
    const session = {
      task_prompt: "实现并验证路由",
      tool_calls: [],
      task_tree: {
        goal_restated: "实现并验证路由",
        strategy: "逐项执行",
        tasks: [{ id: "t1", description: "实现", dependencies: [], status: "in_progress" }],
        created_at: "t",
        updated_at: "t"
      }
    } as unknown as AgentSession;
    ensureExplorationCheckpoint(session);
    session.tool_calls.push({
      id: "executor-t1",
      stage_id: "profile",
      tool: "Task",
      input: { subagent_type: "task-executor", description: "执行 t1" },
      status: "completed",
      output_summary: "实现完成，新增了路由映射",
      created_at: "t"
    });

    expect(getExplorationActionGuardError(
      session,
      "Task",
      { subagent_type: "task-verifier", description: "验证 t1" }
    )).toContain("工作记忆落后");
    expect(getExplorationActionGuardError(session, "Bash", { command: "npm test" }))
      .toContain("checkpoint_exploration");
    expect(getExplorationActionGuardError(session, "Read", { file_path: "src/router.ts" })).toBeNull();

    applyExplorationCheckpoint(session, {
      memory: "## 已确认\nexecutor 已新增路由映射，但该实现仍需独立验证。\n## 下一步\n调用 verifier 核对 t1。",
      disposition: "continue",
      next_action: "调用 verifier 核对 t1"
    });
    expect(getExplorationActionGuardError(
      session,
      "Task",
      { subagent_type: "task-verifier", description: "验证 t1" }
    )).toBeNull();

    session.tool_calls.push({
      id: "verifier-request",
      stage_id: "profile",
      tool: "Task",
      input: { subagent_type: "task-verifier", description: "验证 t1" },
      status: "requested",
      created_at: "t"
    });
    expect(getExplorationActionGuardError(
      session,
      "Task",
      { subagent_type: "task-verifier", description: "验证 t1" },
      "verifier-request"
    )).toBeNull();
  });

  it("requires planner evidence to enter working memory before bootstrapping the task projection", () => {
    const session = {
      task_prompt: "实现页面跳转",
      tool_calls: [],
      task_tree: {
        goal_restated: "实现页面跳转",
        strategy: "宿主根任务",
        tasks: [{ id: "host-goal", description: "完成请求", dependencies: [], status: "in_progress" }],
        created_at: "t",
        updated_at: "t"
      }
    } as unknown as AgentSession;
    ensureExplorationCheckpoint(session);
    session.tool_calls.push({
      id: "planner",
      stage_id: "profile",
      tool: "Task",
      input: { subagent_type: "task-planner" },
      status: "completed",
      output_summary: "已确认需求与任务 DAG",
      created_at: "t"
    });

    expect(getExplorationActionGuardError(
      session,
      "mcp__ai_coder__update_task_tree",
      { action: "bootstrap", tasks: [] }
    )).toContain("工作记忆落后");
  });

  it("injects current textual knowledge into non-planner subagents", () => {
    const session = {
      tool_calls: [],
      exploration_checkpoints: [{
        revision: 4,
        text: "## 已确认\n序号 33 对应 /example/list。\n## 仍需探索\n需要验证详情页入口。",
        disposition: "continue",
        next_action: "验证详情页入口",
        source: "agent",
        observed_tool_call_count: 0,
        created_at: "t"
      }],
      task_tree: {
        goal_restated: "验证详情页入口",
        strategy: "阶段性任务树：只落实当前知识雪球的 next_action；checkpoint 更新后由宿主自动替换。",
        tasks: [{ id: "knowledge-r4", description: "验证详情页入口", dependencies: [], status: "in_progress" }],
        created_at: "t",
        updated_at: "t"
      }
    } as unknown as AgentSession;

    const verifierInput = augmentTaskInputWithExplorationMemory({
      subagent_type: "task-verifier",
      prompt: "验证 t1"
    }, session, "## 当前可用能力\n- task-verifier");
    expect(verifierInput.prompt).toContain("revision 4");
    expect(verifierInput.prompt).toContain("careful-coder:verification-before-completion");
    expect(verifierInput.prompt).toContain("序号 33 对应 /example/list");
    expect(verifierInput.prompt).toContain("发现冲突、失效结论、新未知或验证失败");
    const verifierPrompt = String(verifierInput.prompt);
    expect(verifierPrompt.indexOf("宿主当前探索工作记忆")).toBeLessThan(verifierPrompt.indexOf("当前阶段任务"));
    expect(verifierPrompt.indexOf("当前阶段任务")).toBeLessThan(verifierPrompt.indexOf("当前执行观察"));
    expect(verifierPrompt.indexOf("当前执行观察")).toBeLessThan(verifierPrompt.indexOf("当前可用能力"));

    const plannerInput = { subagent_type: "task-planner", prompt: "规划" };
    expect(augmentTaskInputWithExplorationMemory(plannerInput, session).prompt).toContain("revision 4");
    expect(augmentTaskInputWithExplorationMemory(plannerInput, session).prompt).toContain("careful-coder:task-decomposition");
  });

});

describe("formatProfileAttachmentList", () => {
  it("keeps the exact readable path instead of only the display name", () => {
    const manifest = formatProfileAttachmentList([{
      type: "file_ref",
      path: ".ai-coder/uploads/id/page-21.png",
      display_name: "需求.pdf · 第 21 页 / 共 21 页"
    }]);
    expect(manifest).toContain(".ai-coder/uploads/id/page-21.png");
    expect(manifest).toContain("只能逐字复制");
    expect(manifest).toContain("禁止猜测、缩写");
  });

  it("resolves attachment paths against the exact project root before injection", () => {
    const manifest = formatProfileAttachmentList([{
      type: "file_ref",
      path: ".ai-coder/uploads/id/page-01.png",
      display_name: "uploaded reference"
    }], "/workspace/project");

    expect(manifest).toContain("/workspace/project/.ai-coder/uploads/id/page-01.png");
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

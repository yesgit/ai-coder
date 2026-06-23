import { randomUUID } from "node:crypto";
import type { AgentSession, HumanQuestion, HumanQuestionOption, SessionProgressEvent, WorkflowStage, WorkflowTemplate } from "../../shared/types.js";
import {
  approveOrDenyToolUse,
  buildAllowedClaudeTools,
  buildDisallowedClaudeTools,
} from "../security/projectPolicy.js";
import { WorkflowEngine } from "../workflows/workflowEngine.js";
import { buildStageInstructions } from "./workflowPrompt.js";
import { buildStageAgentInput, createMockStageAgentResult, parseStageAgentResult } from "./stageAgentProtocol.js";
import { extractClaudeStageOutput, formatClaudeTranscript } from "./claudeMessageAdapter.js";
import { resolveNodeExecutable, shouldUseClaudeSdk } from "./claudeRuntime.js";

export interface AgentRunInput {
  session: AgentSession;
  workflow: WorkflowTemplate;
  onProgress?: (session: AgentSession) => Promise<void>;
}

type ClaudeQuery = (params: unknown) => AsyncIterable<unknown>;

export class ClaudeAgentRunner {
  private readonly workflowEngine = new WorkflowEngine();
  private readonly maxStageIterations = 50;
  private readonly abortControllers = new Map<string, AbortController>();
  private mcpServerCache: unknown | null = null;

  constructor(private readonly queryOverride?: ClaudeQuery) {}

  abort(sessionId: string): boolean {
    const controller = this.abortControllers.get(sessionId);
    if (!controller) {
      return false;
    }
    this.abortControllers.delete(sessionId);
    controller.abort();
    return true;
  }

  async run(input: AgentRunInput): Promise<AgentSession> {
    for (let iteration = 0; iteration < this.maxStageIterations; iteration += 1) {
      const updated = await this.runCurrentStage(input);
      if (updated.status !== "running") {
        return updated;
      }
      if (!this.workflowEngine.getActiveStageRun(updated)) {
        return updated;
      }
    }

    input.session.status = "failed";
    input.session.error = `Workflow exceeded ${this.maxStageIterations} automatic stage iterations.`;
    await this.recordProgress(input, "status", input.session.error, "milestone");
    return input.session;
  }

  private async runCurrentStage(input: AgentRunInput): Promise<AgentSession> {
    this.workflowEngine.ensureState(input.session, input.workflow);
    if (this.waitForApprovalIfNeeded(input)) {
      return input.session;
    }

    const currentStage = input.workflow.stages.find((stage) => stage.id === input.session.current_stage);
    if (!currentStage) {
      input.session.status = "failed";
      input.session.error = `Workflow stage not found: ${input.session.current_stage}`;
      return input.session;
    }

    // 检查阶段是否需要预先授权（仅针对需要写权限的阶段，如 write_memory）
    // 只有当阶段配置了 approval_required 且包含 edit_file 工具时，才需要在开始前授权
    if (currentStage.approval_required && currentStage.allowed_tools?.includes("edit_file") && !this.hasStageApproval(input.session, currentStage.id)) {
      return this.requestStageApprovalIfNeeded(input, currentStage);
    }

    const stageAgentInput = buildStageAgentInput(input.session, input.workflow, currentStage);

    if (!(await shouldUseClaudeSdk())) {
      await this.recordProgress(input, "runner", "使用 Mock 模式生成阶段结果。", "milestone");
      return this.runMock(input, stageAgentInput);
    }

    const sdkMessages: unknown[] = [];
    const abortController = new AbortController();
    this.abortControllers.set(input.session.id, abortController);
    try {
      const query = await this.resolveQuery();
      const mcpServer = await this.resolveMcpServer();

      const instructions = buildStageInstructions(stageAgentInput);
      await this.recordProgress(input, "runner", `开始执行阶段：${currentStage.name || currentStage.id}`, "milestone");
      const nodeInfo = await resolveNodeExecutable();
      const sdkEnv = nodeInfo?.env ? { ...process.env, ...nodeInfo.env } : undefined;
      for await (const message of query({
        prompt: `${instructions}\n\n任务：\n${input.session.task_prompt}`,
        options: {
          cwd: input.session.project_path,
          executable: nodeInfo?.command ?? undefined,
          env: sdkEnv,
          abortController,
          mcpServers: mcpServer ? { ai_coder: mcpServer } : undefined,
          tools: buildAllowedClaudeTools(input.workflow, currentStage),
          disallowedTools: buildDisallowedClaudeTools(input.workflow),
          permissionMode: "dontAsk",
          settingSources: ["user", "project", "local"],
          canUseTool: async (toolName: string, toolInput: Record<string, unknown>, options: { toolUseID: string }) => {
            // 拦截 ask_human：作为 HumanQuestion 挂起，等待用户回答后继续
            if (toolName === "mcp__ai_coder__ask_human") {
              const question = this.buildHumanQuestion(input.session, toolInput, options.toolUseID);
              if (question) {
                input.session.pending_human_questions = [
                  ...(input.session.pending_human_questions ?? []),
                  question
                ];
                await this.recordProgress(input, "tool_policy", `等待用户回答：${question.question.slice(0, 60)}`, "milestone");
                return { behavior: "deny", message: "等待用户回答，已暂停执行", interrupt: true };
              }
              // 工具输入非法：明确标记会话失败，避免被当作正常完成
              input.session.status = "failed";
              input.session.error = "ask_human 工具输入格式错误（缺少 question / type / options）";
              await this.recordProgress(input, "status", input.session.error, "milestone");
              return { behavior: "deny", message: input.session.error, interrupt: true };
            }
            const decision = await approveOrDenyToolUse(input.session, input.workflow, toolName, toolInput, options.toolUseID);
            await this.recordProgress(input, "tool_policy", this.describeToolDecision(toolName, decision.allow), "milestone");
            if (decision.allow) {
              return { behavior: "allow", updatedInput: decision.updatedInput };
            }
            return { behavior: "deny", message: decision.message, interrupt: decision.interrupt };
          }
        }
      } as never) as AsyncIterable<unknown>) {
        sdkMessages.push(message);
        await this.recordProgress(input, "sdk_message", this.describeSdkMessage(message), "transient");
      }

      // 若 abort 信号触发但 SDK 是优雅退出而不抛错，仍需走中止路径
      if (abortController.signal.aborted) {
        if (sdkMessages.length > 0) {
          const transcript = formatClaudeTranscript(sdkMessages);
          // 仅当 transcript 非空时才写入消息，避免 (no content) 占位内容
          if (transcript.trim() && transcript !== "(no content)" && !transcript.startsWith("收到 Claude SDK 消息：")) {
            input.session.messages.push({
              role: "assistant",
              content: transcript,
              created_at: new Date().toISOString()
            });
          }
        }
        input.session.status = this.resolveInterruptedStatus(input.session);
        if (input.session.status === "completed") input.session.status = "interrupted";
        await this.recordProgress(input, "status", "已由用户手动中止。", "milestone");
        return input.session;
      }

      const stageOutput = extractClaudeStageOutput(sdkMessages);
      const transcript = formatClaudeTranscript(sdkMessages);
      // 仅当 transcript 非空时才写入消息，避免 (no content) 占位内容
      if (transcript.trim() && transcript !== "(no content)" && !transcript.startsWith("收到 Claude SDK 消息：")) {
        input.session.messages.push({
          role: "assistant",
          content: transcript,
          created_at: new Date().toISOString()
        });
      }
      if (this.hasPendingToolCall(input.session) || this.hasBlockedToolCall(input.session) || this.hasPendingHumanQuestion(input.session)) {
        input.session.status = this.resolveInterruptedStatus(input.session);
        await this.recordProgress(input, "status", `阶段已中断：${input.session.status}`, "milestone");
        return input.session;
      }
      if (stageOutput.error) {
        input.session.status = "failed";
        input.session.error = stageOutput.error;
        await this.recordProgress(input, "status", "阶段执行失败。", "milestone");
        return input.session;
      }
      this.workflowEngine.applyStageResult(input.session, input.workflow, parseStageAgentResult(stageOutput.resultText || transcript));
      // 如果阶段完成后需要审批（waiting_approval），则立即返回，让前端显示审批弹窗
      if (input.session.status === "waiting_approval") {
        await this.recordProgress(input, "status", `阶段已完成，等待审批：${currentStage.name || currentStage.id}`, "milestone");
        return input.session;
      }
      await this.recordProgress(input, "status", `阶段已完成：${currentStage.name || currentStage.id}`, "milestone");
      return input.session;
    } catch (error) {
      // 用户主动中止：保留已写入的消息和工具调用，根据是否有未决问题决定终态
      if (abortController.signal.aborted || isAbortError(error)) {
        if (sdkMessages.length > 0) {
          const transcript = formatClaudeTranscript(sdkMessages);
          // 仅当 transcript 非空时才写入消息，避免 (no content) 占位内容
          if (transcript.trim() && transcript !== "(no content)" && !transcript.startsWith("收到 Claude SDK 消息：")) {
            input.session.messages.push({
              role: "assistant",
              content: transcript,
              created_at: new Date().toISOString()
            });
          }
        }
        const resolved = this.resolveInterruptedStatus(input.session);
        input.session.status = resolved === "completed" ? "interrupted" : resolved;
        await this.recordProgress(input, "status", "已由用户手动中止。", "milestone");
        return input.session;
      }
      const failed = this.failFromSdkError(input, sdkMessages, error);
      await this.recordProgress(input, "status", "Claude Agent SDK 调用失败。", "milestone");
      return failed;
    } finally {
      // 仅当 map 中的 controller 仍是本次创建的才删除，避免竞争条件
      if (this.abortControllers.get(input.session.id) === abortController) {
        this.abortControllers.delete(input.session.id);
      }
    }
  }

  private runMock(input: AgentRunInput, stageAgentInput: ReturnType<typeof buildStageAgentInput>): AgentSession {
    const result = createMockStageAgentResult(stageAgentInput);
    const content = JSON.stringify(result, null, 2);
    // Mock 模式下写入阶段结果摘要，而不是原始 JSON
    input.session.messages.push({
      role: "assistant",
      content: result.output_summary,
      created_at: new Date().toISOString()
    });
    this.workflowEngine.applyStageResult(input.session, input.workflow, result);
    return input.session;
  }

  private waitForApprovalIfNeeded(input: AgentRunInput): boolean {
    const approval = input.session.approvals.find(
      (item) => item.kind === "stage" && item.status === "pending" && item.stage_id === input.session.current_stage
    );
    if (!approval) {
      return false;
    }

    const stage = input.workflow.stages.find((item) => item.id === approval?.stage_id);
    input.session.status = "waiting_approval";
    input.session.current_stage = approval?.stage_id ?? input.session.current_stage;
    const content = `已为"${input.session.task_prompt}"准备工作流计划。等待审批后继续执行${stage?.name ?? "下一阶段"}。`;
    if (!input.session.messages.some((message) => message.role === "assistant" && message.content === content)) {
      input.session.messages.push({
        role: "assistant",
        content,
        created_at: new Date().toISOString()
      });
    }
    return true;
  }

  private hasStageApproval(session: AgentSession, stageId: string): boolean {
    return session.approvals.some(
      (approval) => approval.kind === "stage" && approval.stage_id === stageId && approval.status === "approved"
    );
  }

  private requestStageApprovalIfNeeded(input: AgentRunInput, stage: WorkflowStage): AgentSession {
    const existing = input.session.approvals.find(
      (approval) => approval.kind === "stage" && approval.stage_id === stage.id && approval.status === "pending"
    );
    if (existing) {
      input.session.status = "waiting_approval";
      return input.session;
    }

    const approval = {
      id: randomUUID(),
      stage_id: stage.id,
      kind: "stage" as const,
      status: "pending" as const,
      message: `阶段"${stage.name}"需要授权才能继续执行。该阶段需要使用文件编辑工具，请确认是否允许。`,
      created_at: new Date().toISOString()
    };
    input.session.approvals.push(approval);
    input.session.status = "waiting_approval";

    const content = `阶段"${stage.name}"需要授权才能继续执行。该阶段将使用文件编辑工具写入项目文件，请审批。`;
    input.session.messages.push({
      role: "assistant",
      content,
      created_at: new Date().toISOString()
    });

    return input.session;
  }

  private async recordProgress(
    input: AgentRunInput,
    type: SessionProgressEvent["type"],
    message: string,
    visibility: SessionProgressEvent["visibility"]
  ): Promise<void> {
    const progress = input.session.progress_events ?? [];
    progress.push({
      id: randomUUID(),
      type,
      message,
      visibility,
      created_at: new Date().toISOString()
    });
    input.session.progress_events = progress.slice(-80);
    await input.onProgress?.(input.session);
  }

  private describeToolDecision(toolName: string, allowed: boolean): string {
    return allowed ? `工具已允许：${toolName}` : `工具需要审批或已被拦截：${toolName}`;
  }

  private describeSdkMessage(message: unknown): string {
    if (typeof message === "object" && message !== null && "type" in message && typeof message.type === "string") {
      return `收到 Claude SDK 消息：${message.type}`;
    }
    return "收到 Claude SDK 消息。";
  }

  private hasBlockedToolCall(session: AgentSession): boolean {
    return session.tool_calls.some((toolCall) => toolCall.status === "blocked" || toolCall.status === "denied");
  }

  private hasPendingToolCall(session: AgentSession): boolean {
    return session.tool_calls.some((toolCall) => toolCall.status === "pending_approval");
  }

  private buildHumanQuestion(session: AgentSession, toolInput: Record<string, unknown>, toolUseID: string): HumanQuestion | null {
    const question = typeof toolInput.question === "string" ? toolInput.question.trim() : "";
    const type = toolInput.type;
    if (!question || (type !== "single" && type !== "multi" && type !== "text")) {
      return null;
    }
    let options: HumanQuestionOption[] | undefined;
    if ((type === "single" || type === "multi") && Array.isArray(toolInput.options)) {
      options = toolInput.options
        .map((item) => {
          if (item && typeof item === "object" && "value" in item && "label" in item) {
            const value = String((item as { value: unknown }).value);
            const label = String((item as { label: unknown }).label);
            return value && label ? { value, label } : null;
          }
          return null;
        })
        .filter((item): item is HumanQuestionOption => item !== null);
      if (!options || options.length === 0) return null;
    }
    return {
      id: toolUseID,
      stage_id: session.current_stage,
      question,
      question_type: type,
      options,
      status: "pending",
      created_at: new Date().toISOString()
    };
  }

  private hasPendingHumanQuestion(session: AgentSession): boolean {
    return (session.pending_human_questions ?? []).some((q) => q.status === "pending");
  }

  private resolveInterruptedStatus(session: AgentSession): AgentSession["status"] {
    if (this.hasPendingToolCall(session) || this.hasPendingHumanQuestion(session)) {
      return "waiting_approval";
    }
    if (this.hasBlockedToolCall(session)) {
      return "blocked";
    }
    return "completed";
  }

  private failFromSdkError(input: AgentRunInput, sdkMessages: unknown[], error: unknown): AgentSession {
    const fallbackError = error instanceof Error ? error.message : String(error);
    if (sdkMessages.length > 0) {
      const stageOutput = extractClaudeStageOutput(sdkMessages);
      const transcript = formatClaudeTranscript(sdkMessages);
      // 仅当 transcript 非空时才写入消息，避免 (no content) 占位内容
      if (transcript.trim() && transcript !== "(no content)" && !transcript.startsWith("收到 Claude SDK 消息：")) {
        input.session.messages.push({
          role: "assistant",
          content: transcript,
          created_at: new Date().toISOString()
        });
      }
      this.workflowEngine.applyStageResult(input.session, input.workflow, {
        status: "failed",
        output_summary: stageOutput.error ?? fallbackError,
        error: stageOutput.error ?? fallbackError
      });
      return input.session;
    }

    this.workflowEngine.applyStageResult(input.session, input.workflow, {
      status: "failed",
      output_summary: fallbackError,
      error: fallbackError
    });
    return input.session;
  }

  private async resolveQuery(): Promise<ClaudeQuery> {
    if (this.queryOverride) {
      return this.queryOverride;
    }

    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const query = (sdk as { query?: unknown }).query;
    if (typeof query !== "function") {
      throw new Error("Claude Agent SDK does not expose query()");
    }
    return query as ClaudeQuery;
  }

  private async resolveMcpServer(): Promise<unknown | null> {
    if (this.mcpServerCache) return this.mcpServerCache;
    try {
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      const createSdkMcpServer = (sdk as { createSdkMcpServer?: unknown }).createSdkMcpServer;
      const tool = (sdk as { tool?: unknown }).tool;
      const { z } = await import("zod");
      if (typeof createSdkMcpServer !== "function" || typeof tool !== "function") {
        return null;
      }
      const askHumanTool = (tool as (
        name: string,
        description: string,
        schema: Record<string, unknown>,
        handler: (...args: unknown[]) => Promise<unknown>
      ) => unknown)(
        "ask_human",
        "向用户提问并暂停执行等待回答。type=single 单选、multi 多选、text 自由文本。options 仅 single/multi 时必填。提问后工作流会暂停；用户回答会通过下一轮指令以问答历史的形式返回。",
        {
          question: z.string().describe("问题文本，支持 Markdown"),
          type: z.enum(["single", "multi", "text"]).describe("问题类型"),
          options: z.array(z.object({ value: z.string(), label: z.string() })).optional().describe("single/multi 时必填")
        },
        async () => ({ content: [{ type: "text", text: "(intercepted by host)" }] })
      );
      this.mcpServerCache = (createSdkMcpServer as (opts: { name: string; tools: unknown[] }) => unknown)({
        name: "ai_coder",
        tools: [askHumanTool]
      });
      return this.mcpServerCache;
    } catch {
      return null;
    }
  }
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError";
}

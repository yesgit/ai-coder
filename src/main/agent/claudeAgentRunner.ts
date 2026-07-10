import { randomUUID } from "node:crypto";
import type { AgentSession, HumanQuestion, HumanQuestionOption, SessionProgressEvent, WorkflowStage, WorkflowTemplate } from "../../shared/types.js";
import { isMeaningfulAgentText } from "../../shared/agentMessages.js";
import {
  approveOrDenyToolUse,
  buildAllowedClaudeTools,
  buildDisallowedClaudeTools,
} from "../security/projectPolicy.js";
import { WorkflowEngine } from "../workflows/workflowEngine.js";
import { buildStageInstructions } from "./workflowPrompt.js";
import { evaluateHook } from "./stageHookEnforcer.js";
import { buildStageAgentInput, createMockStageAgentResult, parseStageAgentResult } from "./stageAgentProtocol.js";
import { extractClaudeStageOutput, formatClaudeTranscript } from "./claudeMessageAdapter.js";
import { resolveNodeExecutable, shouldUseClaudeSdk } from "./claudeRuntime.js";

export interface AgentRunInput {
  session: AgentSession;
  workflow: WorkflowTemplate;
  onProgress?: (session: AgentSession) => Promise<void>;
}

type ClaudeQuery = (params: unknown) => AsyncIterable<unknown>;
type ToolApprovalResolution = "approved" | "denied";

interface PendingToolApproval {
  session: AgentSession;
  resolve: (status: ToolApprovalResolution) => void;
}

export class ClaudeAgentRunner {
  private readonly workflowEngine = new WorkflowEngine();
  private readonly maxStageIterations = 50;
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly pendingToolApprovals = new Map<string, Map<string, PendingToolApproval>>();
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

  resolveToolApproval(sessionId: string, toolCallId: string, status: ToolApprovalResolution): boolean {
    const pendingForSession = this.pendingToolApprovals.get(sessionId);
    const pending = pendingForSession?.get(toolCallId);
    if (!pending) {
      return false;
    }
    const toolCall = pending.session.tool_calls.find((item) => item.id === toolCallId && item.status === "pending_approval");
    if (toolCall) {
      toolCall.status = status;
      toolCall.resolved_at = new Date().toISOString();
      pending.session.status = status === "approved" ? "running" : "blocked";
    }
    pendingForSession?.delete(toolCallId);
    if (pendingForSession?.size === 0) {
      this.pendingToolApprovals.delete(sessionId);
    }
    pending.resolve(status);
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

      // 构建 SDK agents 配置：将 YAML 中定义的 sub-agent 映射为 SDK AgentDefinition
      const sdkAgents: Record<string, { description: string; tools?: string[]; prompt: string; model?: string }> = {};
      if (currentStage.agents) {
        for (const [name, def] of Object.entries(currentStage.agents)) {
          sdkAgents[name] = {
            description: def.description,
            prompt: def.prompt,
            ...(def.tools && def.tools.length > 0 ? { tools: def.tools } : {}),
            ...(def.model ? { model: def.model } : {})
          };
        }
      }

      for await (const message of query({
        prompt: instructions,
        options: {
          cwd: input.session.project_path,
          executable: nodeInfo?.command ?? undefined,
          env: sdkEnv,
          abortController,
          mcpServers: mcpServer ? { ai_coder: mcpServer } : undefined,
          tools: buildAllowedClaudeTools(input.workflow, currentStage),
          disallowedTools: buildDisallowedClaudeTools(input.workflow),
          // permissionMode 不设置，使用 SDK 默认行为。工具调用的审批逻辑在 canUseTool 回调中实现
          settingSources: ["user", "project", "local"],
          ...(Object.keys(sdkAgents).length > 0 ? { agents: sdkAgents } : {}),
          canUseTool: async (toolName: string, toolInput: Record<string, unknown>, options: { toolUseID: string }) => {
            // SDK 原生 Task 工具：sub-agent 调用由 SDK 内部管理，直接放行
            if (toolName === "Task") {
              await this.recordProgress(input, "tool_policy", "允许 Task（sub-agent）调用", "transient");
              return { behavior: "allow" };
            }

            if (isUnsupportedDocumentRead(toolName, toolInput)) {
              await this.recordProgress(input, "tool_policy", "拦截 PDF Read：请读取已拆页 PNG 或用 shell 文本工具查看，不要直接 Read PDF。", "milestone");
              return {
                behavior: "deny",
                message: "当前后端不支持 PDF document content block。PDF 上传时已拆成 .ai-coder/uploads/.../page-*.png，请改用 Read 读取对应 PNG 页面，或用只读 shell 工具提取文本后继续。",
                interrupt: false
              };
            }
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
            // 阶段级工序闸门：仅当 stage.hooks 显式声明时生效；与 approveOrDenyToolUse（策略层）解耦。
            // 失败时 interrupt:false——让模型读到拒绝原因后自行补齐前置步骤，不打断整个会话。
            if (currentStage.hooks) {
              const hookDecision = evaluateHook(currentStage, input.session, toolName, toolInput);
              if (!hookDecision.allow) {
                await this.recordProgress(input, "tool_policy", `工序闸门：${hookDecision.message}`, "milestone");
                return { behavior: "deny", message: hookDecision.message, interrupt: false };
              }
            }
            const decision = await approveOrDenyToolUse(input.session, input.workflow, toolName, toolInput, options.toolUseID);
            if (decision.allow) {
              await this.recordProgress(input, "tool_policy", this.describeToolDecision(toolName, true), "milestone");
              return { behavior: "allow", updatedInput: decision.updatedInput };
            }
            if (this.hasPendingToolCall(input.session, options.toolUseID)) {
              const approvalPromise = this.waitForToolApproval(input.session, options.toolUseID, abortController.signal);
              await this.recordProgress(input, "tool_policy", this.describeToolDecision(toolName, false), "milestone");
              const resolved = await approvalPromise;
              if (resolved === "approved") {
                const approvedDecision = await approveOrDenyToolUse(input.session, input.workflow, toolName, toolInput, options.toolUseID);
                await this.recordProgress(input, "tool_policy", this.describeToolDecision(toolName, approvedDecision.allow), "milestone");
                if (approvedDecision.allow) {
                  input.session.status = "running";
                  return { behavior: "allow", updatedInput: approvedDecision.updatedInput };
                }
                return { behavior: "deny", message: approvedDecision.message, interrupt: approvedDecision.interrupt };
              }
              input.session.status = "running";
              return { behavior: "deny", message: "Tool call was denied by the user. Continue without this tool or choose an allowed alternative.", interrupt: false };
            }
            await this.recordProgress(input, "tool_policy", this.describeToolDecision(toolName, false), "milestone");
            return { behavior: "deny", message: decision.message, interrupt: decision.interrupt };
          }
        }
      } as never) as AsyncIterable<unknown>) {
        sdkMessages.push(message);
        const snippet = this.describeSdkMessage(message);
        if (isMeaningfulSdkProgress(snippet)) {
          await this.recordProgress(input, "sdk_message", snippet, "transient");
        }
      }

      // 若 abort 信号触发但 SDK 是优雅退出而不抛错，仍需走中止路径
      if (abortController.signal.aborted) {
        if (sdkMessages.length > 0) {
          const transcript = formatClaudeTranscript(sdkMessages);
          // 仅当 transcript 含有真正内容时才写入消息，避免 (no content) / SDK 内部 transcript 污染
          if (isMeaningfulAgentText(transcript)) {
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
      // 仅当 transcript 含有真正内容时才写入消息，避免 (no content) / SDK 内部 transcript 污染
      if (isMeaningfulAgentText(transcript)) {
        input.session.messages.push({
          role: "assistant",
          content: transcript,
          created_at: new Date().toISOString()
        });
      }
      if (this.hasPendingToolCall(input.session) || this.hasPendingHumanQuestion(input.session)) {
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
      // 阶段终态决定 milestone 文案：completed / waiting_approval 是正向终态；
      // blocked / failed 是异常终态（断言挡回、超过 retry 限、缺必填等），需要明确告诉用户。
      // running 是 retry 中——只是无声继续到下一轮，无需 milestone。
      const stageName = currentStage.name || currentStage.id;
      const status = input.session.status;
      const error = input.session.error;
      if (status === "waiting_approval") {
        await this.recordProgress(input, "status", `阶段已完成，等待审批：${stageName}`, "milestone");
      } else if (status === "blocked") {
        await this.recordProgress(input, "status", `阶段被拦截：${stageName}${error ? `（${error}）` : ""}`, "milestone");
      } else if (status === "failed") {
        await this.recordProgress(input, "status", `阶段失败：${stageName}${error ? `（${error}）` : ""}`, "milestone");
      } else if (status === "running") {
        await this.recordProgress(input, "status", `阶段重试中：${stageName}${error ? `（${error}）` : ""}`, "transient");
      } else {
        await this.recordProgress(input, "status", `阶段已完成：${stageName}`, "milestone");
      }
      return input.session;
    } catch (error) {
      // 用户主动中止：保留已写入的消息和工具调用，根据是否有未决问题决定终态
      if (abortController.signal.aborted || isAbortError(error)) {
        if (sdkMessages.length > 0) {
          const transcript = formatClaudeTranscript(sdkMessages);
          // 仅当 transcript 含有真正内容时才写入消息，避免 (no content) / SDK 内部 transcript 污染
          if (isMeaningfulAgentText(transcript)) {
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
    return describeSdkMessageSnippet(message);
  }

  private hasBlockedToolCall(session: AgentSession): boolean {
    return session.tool_calls.some((toolCall) => toolCall.status === "blocked" || toolCall.status === "denied");
  }

  private hasPendingToolCall(session: AgentSession, toolCallId?: string): boolean {
    return session.tool_calls.some(
      (toolCall) => toolCall.status === "pending_approval" && (!toolCallId || toolCall.id === toolCallId)
    );
  }

  private async waitForToolApproval(
    session: AgentSession,
    toolCallId: string,
    signal: AbortSignal
  ): Promise<ToolApprovalResolution> {
    return new Promise<ToolApprovalResolution>((resolve) => {
      if (signal.aborted) {
        resolve("denied");
        return;
      }
      const pendingForSession = this.pendingToolApprovals.get(session.id) ?? new Map<string, PendingToolApproval>();
      pendingForSession.set(toolCallId, { session, resolve });
      this.pendingToolApprovals.set(session.id, pendingForSession);
      signal.addEventListener(
        "abort",
        () => {
          const toolCall = session.tool_calls.find((item) => item.id === toolCallId && item.status === "pending_approval");
          if (toolCall) {
            toolCall.status = "cancelled";
            toolCall.resolved_at = new Date().toISOString();
          }
          session.status = "interrupted";
          pendingForSession.delete(toolCallId);
          if (pendingForSession.size === 0) {
            this.pendingToolApprovals.delete(session.id);
          }
          resolve("denied");
        },
        { once: true }
      );
    });
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
    return "completed";
  }

  private failFromSdkError(input: AgentRunInput, sdkMessages: unknown[], error: unknown): AgentSession {
    const fallbackError = error instanceof Error ? error.message : String(error);
    const errorName = error instanceof Error ? error.name : typeof error;
    // 诊断信息：仅保留可追溯但不含敏感内容的字段（不要 stringify input —— 会泄露 task_prompt / 附件路径）。
    const errorDetails = [
      `错误：${fallbackError}`,
      `错误类型：${errorName}`,
      `SDK 消息数：${sdkMessages.length}`,
      `会话 ID: ${input.session.id}`,
      `阶段：${input.session.current_stage}`,
      `工作流：${input.workflow.id}`
    ].join('\n');

    if (sdkMessages.length > 0) {
      const stageOutput = extractClaudeStageOutput(sdkMessages);
      const transcript = formatClaudeTranscript(sdkMessages);
      // 仅当 transcript 含有真正内容时才写入消息，避免 (no content) / SDK 内部 transcript 污染
      if (isMeaningfulAgentText(transcript)) {
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
    } else {
      // SDK 调用失败且没有消息，记录详细错误
      this.workflowEngine.applyStageResult(input.session, input.workflow, {
        status: "failed",
        output_summary: `Claude SDK 调用失败：${fallbackError}`,
        error: errorDetails
      });
    }
    // 记录详细错误到进度事件
    void this.recordProgress(input, "status", errorDetails, "milestone");
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
      // 注意：ask_human 是"宿主拦截工具"——SDK 看到的工具 handler 永远返回占位符 `(intercepted by host)`，
      // 因为真正的拦截发生在 canUseTool（本文件 canUseTool 回调内 `toolName === "mcp__ai_coder__ask_human"` 分支）：
      //   1. 模型尝试调用 ask_human → canUseTool 命中该分支
      //   2. 解析 toolInput 构造 HumanQuestion，挂到 session.pending_human_questions
      //   3. 返回 { behavior: "deny", interrupt: true } 暂停 SDK 循环
      //   4. 用户在前端回答后 IPC 写回 session，下一轮以问答历史形式注入 prompt
      // 为什么仍然要在 MCP 注册：SDK 只允许模型调用"已声明"的工具；不注册的话模型无法发起调用。
      // 暴露面：MCP 工具走 `mcpServers` 通道独立注册，**不**经过 buildAllowedClaudeTools 过滤
      // （后者只控制 Read/Edit/Bash 等标准工具）。所以 ask_human 对所有阶段永远可见，唯一守门人是 canUseTool。
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

function isUnsupportedDocumentRead(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (toolName !== "Read") return false;
  const filePath = String(toolInput.file_path ?? toolInput.path ?? "");
  return /\.pdf(?:$|[?#])/i.test(filePath);
}

/**
 * 把一条 SDK 消息摘要成活动流可读的片段——assistant 文本前 80 字 / tool_use 工具名+关键参数，
 * 让实时活动流能看出"在干嘛"，而非只显示"收到 Claude SDK 消息：assistant"。
 *
 * SDK 消息结构假设与 extractClaudeStageOutput 一致：assistant message 的内容在
 * `message.message.content`（content blocks：text / tool_use）。
 */
export function describeSdkMessageSnippet(message: unknown): string {
  if (typeof message !== "object" || message === null) return "收到 Claude SDK 消息。";
  const msg = message as Record<string, unknown>;
  const type = typeof msg.type === "string" ? msg.type : "";

  if (type === "assistant") {
    const inner = isPlainObject(msg.message) ? (msg.message as Record<string, unknown>) : undefined;
    const content = Array.isArray(inner?.content) ? inner!.content : [];
    const parts: string[] = [];
    for (const block of content) {
      if (!isPlainObject(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        const snippet = block.text.replace(/\s+/g, " ").trim().slice(0, 80);
        if (snippet) parts.push(snippet);
      } else if (block.type === "tool_use") {
        const name = String(block.name ?? "unknown");
        parts.push(`调用 ${name}${describeToolInputSnippet(block.input)}`);
      }
    }
    return parts.length > 0 ? parts.join(" | ") : "助手消息（无文本）";
  }
  if (type === "tool_result") return "工具结果";
  if (type === "result") return "阶段结果";
  return type ? `SDK:${type}` : "收到 Claude SDK 消息。";
}

function describeToolInputSnippet(input: unknown): string {
  if (!isPlainObject(input)) return "";
  const filePath = input.file_path ?? input.path;
  if (typeof filePath === "string") return `(${filePath})`;
  const cmd = input.command;
  if (typeof cmd === "string") return `(${cmd.replace(/\s+/g, " ").trim().slice(0, 60)})`;
  return "";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMeaningfulSdkProgress(snippet: string): boolean {
  const trimmed = snippet.trim();
  if (!trimmed) return false;
  if (trimmed === "助手消息（无文本）") return false;
  if (trimmed === "收到 Claude SDK 消息。") return false;
  return true;
}

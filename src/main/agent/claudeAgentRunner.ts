import { randomUUID } from "node:crypto";
import type { AgentSession, SessionProgressEvent, WorkflowTemplate } from "../../shared/types.js";
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

  constructor(private readonly queryOverride?: ClaudeQuery) {}

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
    const stageAgentInput = buildStageAgentInput(input.session, input.workflow, currentStage);

    if (!(await shouldUseClaudeSdk())) {
      await this.recordProgress(input, "runner", "使用 Mock 模式生成阶段结果。", "milestone");
      return this.runMock(input, stageAgentInput);
    }

    const sdkMessages: unknown[] = [];
    try {
      const query = await this.resolveQuery();

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
          tools: buildAllowedClaudeTools(input.workflow, currentStage),
          disallowedTools: buildDisallowedClaudeTools(input.workflow),
          permissionMode: "dontAsk",
          settingSources: ["user", "project", "local"],
          canUseTool: async (toolName: string, toolInput: Record<string, unknown>, options: { toolUseID: string }) => {
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

      const stageOutput = extractClaudeStageOutput(sdkMessages);
      const transcript = formatClaudeTranscript(sdkMessages);
      input.session.messages.push({
        role: "assistant",
        content: transcript,
        created_at: new Date().toISOString()
      });
      if (this.hasPendingToolCall(input.session) || this.hasBlockedToolCall(input.session)) {
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
      await this.recordProgress(input, "status", `阶段已完成：${currentStage.name || currentStage.id}`, "milestone");
      return input.session;
    } catch (error) {
      const failed = this.failFromSdkError(input, sdkMessages, error);
      await this.recordProgress(input, "status", "Claude Agent SDK 调用失败。", "milestone");
      return failed;
    }
  }

  private runMock(input: AgentRunInput, stageAgentInput: ReturnType<typeof buildStageAgentInput>): AgentSession {
    const result = createMockStageAgentResult(stageAgentInput);
    const content = JSON.stringify(result, null, 2);
    input.session.messages.push({
      role: "assistant",
      content,
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
    const content = `已为“${input.session.task_prompt}”准备工作流计划。等待审批后继续执行${stage?.name ?? "下一阶段"}。`;
    if (!input.session.messages.some((message) => message.role === "assistant" && message.content === content)) {
      input.session.messages.push({
        role: "assistant",
        content,
        created_at: new Date().toISOString()
      });
    }
    return true;
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

  private resolveInterruptedStatus(session: AgentSession): AgentSession["status"] {
    if (this.hasPendingToolCall(session)) {
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
      input.session.messages.push({
        role: "assistant",
        content: transcript,
        created_at: new Date().toISOString()
      });
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
}

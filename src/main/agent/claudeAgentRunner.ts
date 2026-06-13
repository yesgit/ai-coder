import type { AgentSession, WorkflowTemplate } from "../../shared/types.js";
import {
  approveOrDenyToolUse,
  buildAllowedClaudeTools,
  buildDisallowedClaudeTools,
} from "../security/projectPolicy.js";
import { WorkflowEngine } from "../workflows/workflowEngine.js";
import { buildStageInstructions } from "./workflowPrompt.js";
import { buildStageAgentInput, createMockStageAgentResult, parseStageAgentResult } from "./stageAgentProtocol.js";
import { extractClaudeStageOutput, formatClaudeTranscript } from "./claudeMessageAdapter.js";
import { shouldUseClaudeSdk } from "./claudeRuntime.js";

export interface AgentRunInput {
  session: AgentSession;
  workflow: WorkflowTemplate;
}

type ClaudeQuery = (params: unknown) => AsyncIterable<unknown>;

export class ClaudeAgentRunner {
  private readonly workflowEngine = new WorkflowEngine();

  constructor(private readonly queryOverride?: ClaudeQuery) {}

  async run(input: AgentRunInput): Promise<AgentSession> {
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
      return this.runMock(input, stageAgentInput);
    }

    const sdkMessages: unknown[] = [];
    try {
      const query = await this.resolveQuery();

      const instructions = buildStageInstructions(stageAgentInput);
      for await (const message of query({
        prompt: `${instructions}\n\nTask:\n${input.session.task_prompt}`,
        options: {
          cwd: input.session.project_path,
          tools: buildAllowedClaudeTools(input.workflow, currentStage),
          disallowedTools: buildDisallowedClaudeTools(input.workflow),
          permissionMode: "dontAsk",
          settingSources: ["user", "project", "local"],
          canUseTool: async (toolName: string, toolInput: Record<string, unknown>, options: { toolUseID: string }) => {
            const decision = await approveOrDenyToolUse(input.session, input.workflow, toolName, toolInput, options.toolUseID);
            if (decision.allow) {
              return { behavior: "allow", updatedInput: decision.updatedInput };
            }
            return { behavior: "deny", message: decision.message, interrupt: decision.interrupt };
          }
        }
      } as never) as AsyncIterable<unknown>) {
        sdkMessages.push(message);
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
        return input.session;
      }
      if (stageOutput.error) {
        input.session.status = "failed";
        input.session.error = stageOutput.error;
        return input.session;
      }
      this.workflowEngine.applyStageResult(input.session, input.workflow, parseStageAgentResult(stageOutput.resultText || transcript));
      return input.session;
    } catch (error) {
      return this.failFromSdkError(input, sdkMessages, error);
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
    const content = `Prepared workflow plan for "${input.session.task_prompt}". Waiting for approval before ${stage?.name ?? "next stage"}.`;
    if (!input.session.messages.some((message) => message.role === "assistant" && message.content === content)) {
      input.session.messages.push({
        role: "assistant",
        content,
        created_at: new Date().toISOString()
      });
    }
    return true;
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

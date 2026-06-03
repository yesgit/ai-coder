import type { AgentSession, WorkflowTemplate } from "../../shared/types.js";
import {
  approveOrDenyToolUse,
  buildAllowedClaudeTools,
  buildDisallowedClaudeTools,
} from "../security/projectPolicy.js";
import { WorkflowEngine } from "../workflows/workflowEngine.js";
import { buildStageInstructions } from "./workflowPrompt.js";

export interface AgentRunInput {
  session: AgentSession;
  workflow: WorkflowTemplate;
}

export class ClaudeAgentRunner {
  private readonly workflowEngine = new WorkflowEngine();

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

    if (!process.env.ANTHROPIC_API_KEY) {
      return this.runMock(input, currentStage.name);
    }

    try {
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      const query = (sdk as { query?: unknown }).query;
      if (typeof query !== "function") {
        throw new Error("Claude Agent SDK does not expose query()");
      }

      const instructions = buildStageInstructions(input.session, input.workflow, currentStage);
      const chunks: string[] = [];
      for await (const message of query({
        prompt: `${instructions}\n\nTask:\n${input.session.task_prompt}`,
        options: {
          cwd: input.session.project_path,
          tools: buildAllowedClaudeTools(input.workflow, currentStage),
          disallowedTools: buildDisallowedClaudeTools(input.workflow),
          permissionMode: "dontAsk",
          settingSources: [],
          canUseTool: async (toolName: string, toolInput: Record<string, unknown>, options: { toolUseID: string }) => {
            const decision = await approveOrDenyToolUse(input.session, input.workflow, toolName, toolInput, options.toolUseID);
            if (decision.allow) {
              return { behavior: "allow", updatedInput: decision.updatedInput };
            }
            return { behavior: "deny", message: decision.message, interrupt: false };
          }
        }
      } as never) as AsyncIterable<unknown>) {
        chunks.push(JSON.stringify(message));
      }

      input.session.messages.push({
        role: "assistant",
        content: chunks.join("\n"),
        created_at: new Date().toISOString()
      });
      if (this.hasPendingToolCall(input.session) || this.hasBlockedToolCall(input.session)) {
        input.session.status = this.resolveInterruptedStatus(input.session);
        return input.session;
      }
      this.workflowEngine.completeCurrentStage(input.session, input.workflow, summarizeStageOutput(chunks.join("\n")));
      return input.session;
    } catch (error) {
      input.session.status = "failed";
      input.session.error = error instanceof Error ? error.message : String(error);
      return input.session;
    }
  }

  private runMock(input: AgentRunInput, stageName: string): AgentSession {
    const content = `Mock stage "${stageName}" completed. Set ANTHROPIC_API_KEY to use Claude Agent SDK.`;
    input.session.messages.push({
      role: "assistant",
      content,
      created_at: new Date().toISOString()
    });
    this.workflowEngine.completeCurrentStage(input.session, input.workflow, content);
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
}

function summarizeStageOutput(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= 240) {
    return normalized;
  }
  return `${normalized.slice(0, 237)}...`;
}

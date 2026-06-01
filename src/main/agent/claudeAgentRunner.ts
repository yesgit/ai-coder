import type { AgentSession, WorkflowTemplate } from "../../shared/types.js";
import {
  approveOrDenyToolUse,
  buildAllowedClaudeTools,
  buildDisallowedClaudeTools,
  hasPendingStageApproval
} from "../security/projectPolicy.js";
import { buildWorkflowInstructions } from "./workflowPrompt.js";

export interface AgentRunInput {
  session: AgentSession;
  workflow: WorkflowTemplate;
}

export class ClaudeAgentRunner {
  async run(input: AgentRunInput): Promise<AgentSession> {
    if (this.waitForApprovalIfNeeded(input)) {
      return input.session;
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return this.runMock(input);
    }

    try {
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      const query = (sdk as { query?: unknown }).query;
      if (typeof query !== "function") {
        throw new Error("Claude Agent SDK does not expose query()");
      }

      const instructions = buildWorkflowInstructions(input.workflow);
      const chunks: string[] = [];
      for await (const message of query({
        prompt: `${instructions}\n\nTask:\n${input.session.task_prompt}`,
        options: {
          cwd: input.session.project_path,
          tools: buildAllowedClaudeTools(input.workflow),
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
      input.session.status = this.hasBlockedToolCall(input.session) ? "blocked" : "completed";
      input.session.current_stage = input.workflow.stages.at(-1)?.id ?? input.session.current_stage;
      return input.session;
    } catch (error) {
      input.session.status = "failed";
      input.session.error = error instanceof Error ? error.message : String(error);
      return input.session;
    }
  }

  private runMock(input: AgentRunInput): AgentSession {
    input.session.status = "completed";
    input.session.current_stage = input.workflow.stages.at(-1)?.id ?? input.session.current_stage;
    input.session.messages.push({
      role: "assistant",
      content: `Mock run completed with workflow "${input.workflow.name}". Set ANTHROPIC_API_KEY to use Claude Agent SDK.`,
      created_at: new Date().toISOString()
    });
    return input.session;
  }

  private waitForApprovalIfNeeded(input: AgentRunInput): boolean {
    if (!hasPendingStageApproval(input.session)) {
      return false;
    }

    const approval = input.session.approvals.find((item) => item.kind === "stage" && item.status === "pending");
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
}

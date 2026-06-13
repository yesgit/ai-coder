import { describe, expect, it } from "vitest";
import { ClaudeAgentRunner } from "./claudeAgentRunner.js";
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

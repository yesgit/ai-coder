import { describe, expect, it } from "vitest";
import { buildStageAgentInput, createMockStageAgentResult, parseStageAgentResult } from "./stageAgentProtocol.js";
import type { AgentSession, WorkflowTemplate } from "../../shared/types.js";

const workflow: WorkflowTemplate = {
  id: "software-engineering",
  name: "Software Engineering",
  version: "1.0.0",
  description: "Test workflow",
  source: { type: "builtin", id: "software-engineering", version: "1.0.0" },
  permissions: { filesystem: { mode: "project-only" }, shell: { approval_required: true } },
  rework: { enabled: true, allowed_targets: ["plan"], approval_required: true, invalidate_downstream: true },
  stages: [
    { id: "plan", name: "Plan", required_outputs: ["implementation_plan"] },
    { id: "execute", name: "Execute", allowed_tools: ["read_file", "edit_file"], gates: ["authorized_files_only"] }
  ]
};

const session: AgentSession = {
  id: "00000000-0000-4000-8000-000000000000",
  project_path: "/tmp/project",
  workflow_id: workflow.id,
  task_prompt: "Fix checkout bug",
  status: "running",
  current_stage: "execute",
  messages: [],
  tool_calls: [],
  file_changes: [],
  approvals: [],
  stage_runs: [
    {
      id: "stage-run-1",
      stage_id: "plan",
      attempt: 1,
      status: "completed",
      input_summary: "Initial task",
      output_summary: "Use a narrow renderer change",
      started_at: new Date().toISOString(),
      completed_at: new Date().toISOString()
    }
  ],
  rework_requests: [],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
};

describe("stage agent protocol", () => {
  it("builds stage input with workflow overview and previous summaries", () => {
    const input = buildStageAgentInput(session, workflow, workflow.stages[1]);

    expect(input.workflow.stages).toHaveLength(2);
    expect(input.previous_stage_summaries[0]).toMatchObject({ stage_id: "plan", output_summary: "Use a narrow renderer change" });
    expect(input.current_stage.id).toBe("execute");
    expect(input.allowed_tools).toEqual(["read_file", "edit_file"]);
  });

  it("parses structured JSON stage results", () => {
    const result = parseStageAgentResult(
      JSON.stringify({
        status: "needs_rework",
        output_summary: "Implementation found a missing design decision",
        rework_target_stage_id: "plan",
        rework_reason: "Need to choose storage format"
      })
    );

    expect(result).toMatchObject({
      status: "needs_rework",
      rework_target_stage_id: "plan",
      rework_reason: "Need to choose storage format"
    });
  });

  it("falls back to completed summary when the result is plain text", () => {
    const result = parseStageAgentResult("Plain assistant response");

    expect(result).toEqual({ status: "completed", output_summary: "Plain assistant response" });
  });

  it("creates mock required outputs for required fields", () => {
    const input = buildStageAgentInput(session, workflow, workflow.stages[0]);

    expect(createMockStageAgentResult(input).required_outputs).toEqual({
      implementation_plan: "Mock output for implementation_plan"
    });
  });
});

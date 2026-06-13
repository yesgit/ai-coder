import { describe, expect, it } from "vitest";
import type { AgentSession, WorkflowStage } from "../../shared/types.js";
import { buildWorkflowStageDisplays } from "./workflowStageStatus.js";

const stages: WorkflowStage[] = [
  { id: "plan", name: "Plan" },
  { id: "execute", name: "Execute" },
  { id: "verify", name: "Verify" }
];

const session: AgentSession = {
  id: "session-1",
  project_path: "/tmp/project",
  workflow_id: "software-engineering",
  task_prompt: "Fix checkout bug",
  status: "running",
  current_stage: "execute",
  created_at: "2026-06-03T01:00:00.000Z",
  updated_at: "2026-06-03T01:05:00.000Z",
  messages: [],
  approvals: [],
  tool_calls: [],
  file_changes: [],
  stage_runs: [
    {
      id: "stage-run-1",
      stage_id: "plan",
      attempt: 1,
      status: "completed",
      input_summary: "Initial task",
      output_summary: "Plan ready",
      started_at: "2026-06-03T01:00:00.000Z",
      completed_at: "2026-06-03T01:02:00.000Z"
    },
    {
      id: "stage-run-2",
      stage_id: "execute",
      attempt: 1,
      status: "running",
      input_summary: "Plan ready",
      started_at: "2026-06-03T01:02:00.000Z"
    }
  ],
  rework_requests: []
};

describe("buildWorkflowStageDisplays", () => {
  it("maps workflow stages to the latest session run status", () => {
    const displays = buildWorkflowStageDisplays(stages, session, "software-engineering");

    expect(displays.map((display) => [display.stage.id, display.status, display.isCurrent])).toEqual([
      ["plan", "completed", false],
      ["execute", "running", true],
      ["verify", "not_started", false]
    ]);
  });

  it("uses the latest attempt after rework", () => {
    const displays = buildWorkflowStageDisplays(
      stages,
      {
        ...session,
        current_stage: "plan",
        stage_runs: [
          ...session.stage_runs!,
          {
            id: "stage-run-3",
            stage_id: "plan",
            attempt: 2,
            status: "running",
            input_summary: "Rework requested from execute: Missing constraint",
            started_at: "2026-06-03T01:06:00.000Z"
          }
        ]
      },
      "software-engineering"
    );

    expect(displays[0]).toMatchObject({ status: "running", attempt: 2, isCurrent: true });
  });

  it("does not leak status from another workflow session", () => {
    const displays = buildWorkflowStageDisplays(stages, session, "code-review");

    expect(displays.map((display) => display.status)).toEqual(["not_started", "not_started", "not_started"]);
  });
});

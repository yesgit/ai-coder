import { describe, expect, it } from "vitest";
import { buildStageInstructions } from "./workflowPrompt.js";
import type { StageAgentInput } from "../../shared/types.js";

describe("buildStageInstructions", () => {
  it("includes current stage instructions", () => {
    const input: StageAgentInput = {
      workflow: {
        id: "project-onboarding",
        name: "Project Onboarding",
        description: "Create project memory",
        stages: [
          {
            id: "draft_memory",
            name: "Draft CLAUDE.md",
            approval_required: true,
            required_outputs: ["claude_md_draft"],
            required_checks: [],
            gates: []
          }
        ]
      },
      previous_stage_summaries: [],
      current_stage: {
        id: "draft_memory",
        name: "Draft CLAUDE.md",
        instructions: "If CLAUDE.md exists, preserve valuable team rules and produce an incremental update plan.",
        approval_required: true,
        required_outputs: ["claude_md_draft"]
      },
      task_prompt: "Onboard this project",
      project_path: "/tmp/project",
      allowed_tools: [],
      required_outputs: ["claude_md_draft"],
      gates: []
    };

    const prompt = buildStageInstructions(input);

    expect(prompt).toContain("preserve valuable team rules");
    expect(prompt).toContain("Final JSON protocol");
  });
});

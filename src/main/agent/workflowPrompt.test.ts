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
        instructions: "如果 CLAUDE.md 已存在，请保留有价值的团队规则并生成增量更新计划。",
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

    expect(prompt).toContain("保留有价值的团队规则");
    expect(prompt).toContain("请始终使用简体中文回答");
    expect(prompt).toContain("宿主应用会拦截工具调用、创建审批项并暂停执行");
    expect(prompt).toContain("不要用文字审批请求代替工具调用");
    expect(prompt).toContain("最终 JSON 协议");
  });
});

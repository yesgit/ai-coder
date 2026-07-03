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
      gates: [],
      recent_messages: [],
      human_qa_history: []
    };

    const prompt = buildStageInstructions(input);

    expect(prompt).toContain("保留有价值的团队规则");
    expect(prompt).toContain("请始终使用简体中文回答");
    expect(prompt).toContain("宿主应用会拦截工具调用、创建审批项并暂停执行");
    expect(prompt).toContain("不要用文字审批请求代替工具调用");
    expect(prompt).toContain("最终 JSON 协议");
  });

  it("hook sections: pre_tool_use 与 post_output_assertions 分别使用各自的 header（不混淆 deny/retry 语义）", () => {
    const input: StageAgentInput = {
      workflow: {
        id: "test",
        name: "Test",
        description: "",
        stages: [{ id: "s", name: "S", approval_required: false, required_outputs: [], required_checks: [], gates: [] }]
      },
      previous_stage_summaries: [],
      current_stage: {
        id: "s",
        name: "S",
        instructions: "do it",
        approval_required: false,
        hooks: {
          pre_tool_use: [
            {
              when: { tool: "Edit" },
              require: { same_file_reads_min: 3 },
              on_fail: "请先 Read"
            }
          ],
          post_output_assertions: ["review_self_consistency"]
        }
      },
      task_prompt: "",
      project_path: "/tmp",
      allowed_tools: [],
      required_outputs: [],
      gates: [],
      recent_messages: [],
      human_qa_history: []
    };

    const prompt = buildStageInstructions(input);

    // pre_tool_use header 必须强调"工具调用前 / deny"
    expect(prompt).toContain("本阶段工序闸门（在工具调用前由宿主校验，未满足会被 deny 并要求补齐）");
    expect(prompt).toContain("请先 Read");

    // post_output_assertions header 必须强调"输出后 / retry / blocked"
    expect(prompt).toContain("本阶段产物校验（输出落地后由宿主评估：自洽性断言扫产出文本、行为校验按 tool_calls 核对真动作；未通过按 auto_retry_limit 重试，超限走 blocked）");
    expect(prompt).toContain("review_self_consistency");

    // 两段 header 在 prompt 中按出现顺序排列，pre 在前
    const preIdx = prompt.indexOf("本阶段工序闸门");
    const postIdx = prompt.indexOf("本阶段产物校验");
    expect(preIdx).toBeGreaterThan(0);
    expect(postIdx).toBeGreaterThan(preIdx);
  });

  it("hook sections: 只声明 post_output_assertions 时，不渲染 pre_tool_use header", () => {
    const input: StageAgentInput = {
      workflow: {
        id: "test",
        name: "Test",
        description: "",
        stages: [{ id: "s", name: "S", approval_required: false, required_outputs: [], required_checks: [], gates: [] }]
      },
      previous_stage_summaries: [],
      current_stage: {
        id: "s",
        name: "S",
        approval_required: false,
        hooks: { post_output_assertions: ["unknowns_present"] }
      },
      task_prompt: "",
      project_path: "/tmp",
      allowed_tools: [],
      required_outputs: [],
      gates: [],
      recent_messages: [],
      human_qa_history: []
    };

    const prompt = buildStageInstructions(input);
    expect(prompt).not.toContain("本阶段工序闸门");
    expect(prompt).toContain("本阶段产物校验");
    expect(prompt).toContain("unknowns_present");
  });

  it("renders rework_context section when present", () => {
    const input: StageAgentInput = {
      workflow: { id: "test", name: "Test", description: "", stages: [{ id: "s", name: "S", approval_required: false, required_outputs: [], required_checks: [], gates: [] }] },
      previous_stage_summaries: [],
      current_stage: { id: "s", name: "S", instructions: "do it", approval_required: false },
      task_prompt: "",
      project_path: "/tmp",
      allowed_tools: [],
      required_outputs: [],
      gates: [],
      rework_context: {
        from_stage: "implement",
        reason: "investigate 调用方清单缺失",
        previous_output_summary: "上一版 investigate 产出"
      },
      recent_messages: [],
      human_qa_history: []
    };

    const prompt = buildStageInstructions(input);

    expect(prompt).toContain("被下游阶段退回重做");
    expect(prompt).toContain("退回方：implement");
    expect(prompt).toContain("investigate 调用方清单缺失");
    expect(prompt).toContain("你上一版产出：上一版 investigate 产出");
  });

  it("renders rework_context without previous_output_summary line when that field is absent", () => {
    const input: StageAgentInput = {
      workflow: { id: "test", name: "Test", description: "", stages: [{ id: "s", name: "S", approval_required: false, required_outputs: [], required_checks: [], gates: [] }] },
      previous_stage_summaries: [],
      current_stage: { id: "s", name: "S", instructions: "do it", approval_required: false },
      task_prompt: "",
      project_path: "/tmp",
      allowed_tools: [],
      required_outputs: [],
      gates: [],
      rework_context: { from_stage: "implement", reason: "缺口" },
      recent_messages: [],
      human_qa_history: []
    };

    const prompt = buildStageInstructions(input);

    expect(prompt).toContain("退回方：implement");
    expect(prompt).not.toContain("你上一版产出");
  });

  it("omits rework section when rework_context absent", () => {
    const input: StageAgentInput = {
      workflow: { id: "test", name: "Test", description: "", stages: [{ id: "s", name: "S", approval_required: false, required_outputs: [], required_checks: [], gates: [] }] },
      previous_stage_summaries: [],
      current_stage: { id: "s", name: "S", instructions: "do it", approval_required: false },
      task_prompt: "",
      project_path: "/tmp",
      allowed_tools: [],
      required_outputs: [],
      gates: [],
      recent_messages: [],
      human_qa_history: []
    };

    const prompt = buildStageInstructions(input);

    expect(prompt).not.toContain("被下游阶段退回重做");
  });
});

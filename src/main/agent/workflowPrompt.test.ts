import { describe, expect, it } from "vitest";
import { buildStageInstructions } from "./workflowPrompt.js";
import type { StageAgentInput } from "../../shared/types.js";

describe("buildStageInstructions", () => {
  it("keeps the original task and human answers above previous-stage summaries", () => {
    const prompt = buildStageInstructions({
      workflow: { id: "w", name: "w", description: "", stages: [] },
      task_prompt: "用户要实际跳转，不只是加配置",
      current_stage: { id: "implement", name: "Implement" },
      previous_stage_summaries: [{ stage_id: "decompose", attempt: 1, status: "completed", output_summary: "只改常量" }],
      human_qa_history: [{
        id: "q1", stage_id: "understand", question: "是否需要真实导航", question_type: "text",
        status: "answered", answer: "需要真实导航", created_at: "t", resolved_at: "t"
      }],
      project_path: "/tmp/project",
      allowed_tools: [],
      required_outputs: [],
      gates: [],
      recent_messages: []
    });
    expect(prompt).toContain("初始用户任务与后续人类问答始终是最高优先级的验收来源");
    expect(prompt).not.toContain("原始任务描述只是背景");
  });
  it("includes current stage instructions", () => {
    const input: StageAgentInput = {
      workflow: {
        id: "careful-coder",
        name: "谨慎程序员",
        description: "基本人设：谨慎程序员先保护既有行为。\n- 事实优先\n- 克制交付",
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
    expect(prompt).toContain("## 工作流人设与原则");
    expect(prompt).toContain("基本人设：谨慎程序员先保护既有行为");
    expect(prompt).toContain("事实优先");
    expect(prompt).toContain("克制交付");
    expect(prompt).toContain("请始终使用简体中文回答");
    expect(prompt).toContain("宿主应用会拦截工具调用、创建审批项并暂停执行");
    expect(prompt).toContain("不要用文字审批请求代替工具调用");
    expect(prompt).toContain("最终 JSON 协议");
    expect(prompt).toContain("禁止输出“先解释一下”");
  });

  it("places the strict final JSON protocol at the end of the prompt", () => {
    const input: StageAgentInput = {
      workflow: {
        id: "careful-coder",
        name: "谨慎程序员",
        description: "",
        stages: [
          {
            id: "scan_project",
            name: "扫描项目画像",
            approval_required: false,
            required_outputs: ["profile_mode", "project_facts"],
            required_checks: [],
            gates: []
          }
        ]
      },
      previous_stage_summaries: [],
      current_stage: {
        id: "scan_project",
        name: "扫描项目画像",
        instructions: "输出当前阶段结果。",
        approval_required: false,
        required_outputs: ["profile_mode", "project_facts"]
      },
      task_prompt: "优化画像流程",
      project_path: "/tmp/project",
      allowed_tools: [],
      required_outputs: ["profile_mode", "project_facts"],
      gates: [],
      recent_messages: [],
      human_qa_history: []
    };

    const prompt = buildStageInstructions(input);
    const finalProtocolIndex = prompt.lastIndexOf("最终 JSON 协议（最后一条消息必须只包含这个 JSON 对象）");

    expect(finalProtocolIndex).toBeGreaterThan(0);
    expect(prompt.slice(finalProtocolIndex)).toContain("\"required_outputs\": {");
    expect(prompt.slice(finalProtocolIndex)).toContain("\"profile_mode\": \"<profile_mode>\"");
    expect(prompt.slice(finalProtocolIndex)).toContain("不要输出 Markdown、代码块、标题、列表或解释文字");
    expect(prompt.slice(finalProtocolIndex)).toContain("不要主动把 JSON 放进 ```json 代码块");
    expect(prompt.slice(finalProtocolIndex)).toContain("宿主能完整恢复对象时仍会接受");
    expect(prompt.slice(finalProtocolIndex)).toContain("首选让第一个非空字符为 `{`");
    expect(prompt.slice(finalProtocolIndex)).toContain("不要只输出 required_outputs 内部字段");
    expect(prompt.slice(finalProtocolIndex)).toContain("sub-agent prompt 中的 JSON 示例只用于说明子任务返回格式");
    expect(prompt.trim().endsWith("如果你需要在 output_summary 或 required_outputs 字符串中包含 Markdown，请把它作为 JSON 字符串值转义后放入对象内部。")).toBe(true);
  });

  it("adds strict JSON retry guidance when the previous attempt failed on parse or missing outputs", () => {
    const input: StageAgentInput = {
      workflow: {
        id: "careful-coder",
        name: "谨慎程序员 v2",
        description: "",
        stages: [{ id: "design", name: "方案", approval_required: false, required_outputs: ["selected_plan"], required_checks: [], gates: [] }]
      },
      previous_stage_summaries: [],
      current_stage: {
        id: "design",
        name: "方案",
        instructions: "输出方案 JSON",
        approval_required: false,
        required_outputs: ["selected_plan"]
      },
      task_prompt: "修一个问题",
      project_path: "/tmp/project",
      allowed_tools: [],
      required_outputs: ["selected_plan"],
      gates: [],
      retry_context: {
        previous_attempt: 2,
        output_summary: "Missing required outputs: selected_plan (JSON parse 失败诊断：bracket_balance=1)"
      },
      recent_messages: [],
      human_qa_history: []
    };

    const prompt = buildStageInstructions(input);

    expect(prompt).toContain("这次重试命中过 JSON/必填字段问题");
    expect(prompt).toContain("请先在脑内组装完整对象");
  });

  it("treats plan as initial task understanding instead of consuming profile stage outputs", () => {
    const input: StageAgentInput = {
      workflow: {
        id: "careful-coder",
        name: "谨慎程序员",
        description: "",
        stages: [
          { id: "scan_project", name: "扫描项目画像", approval_required: false, required_outputs: ["project_facts"], required_checks: [], gates: [] },
          { id: "update_project_profile", name: "建立或调整项目画像", approval_required: false, required_outputs: ["profile_changes"], required_checks: [], gates: [] },
          { id: "plan", name: "理解与拆分", approval_required: false, required_outputs: ["user_goal_restated", "task_items"], required_checks: [], gates: [] }
        ]
      },
      previous_stage_summaries: [],
      current_stage: {
        id: "plan",
        name: "理解与拆分",
        instructions: "理解用户任务并拆分。",
        approval_required: false,
        required_outputs: ["user_goal_restated", "task_items"]
      },
      task_prompt: "修复登录页跳转问题",
      project_path: "/tmp/project",
      allowed_tools: ["read_file"],
      required_outputs: ["user_goal_restated", "task_items"],
      gates: [],
      recent_messages: [
        {
          role: "user",
          content: "修复登录页跳转问题",
          created_at: "2026-01-01T00:00:00.000Z"
        }
      ],
      human_qa_history: []
    };

    const prompt = buildStageInstructions(input);

    expect(prompt).toContain("当前是 plan 阶段");
    expect(prompt).toContain("用户本次提交的原始任务");
    expect(prompt).toContain("maintain_project_profile 是独立的项目背景预处理");
    expect(prompt).toContain("画像阶段摘要不是本阶段输入");
    expect(prompt).not.toContain("前序阶段的 required_outputs 是你最重要的输入");
  });

  it("describes JSON-safe shapes for structured required outputs", () => {
    const input: StageAgentInput = {
      workflow: {
        id: "careful-coder",
        name: "谨慎程序员 v2",
        description: "",
        stages: [{ id: "align", name: "对齐", approval_required: false, required_outputs: ["lateral_constraints"], required_checks: [], gates: [] }]
      },
      previous_stage_summaries: [],
      current_stage: {
        id: "align",
        name: "对齐",
        instructions: "列出横向约束",
        approval_required: false,
        required_outputs: ["lateral_constraints"]
      },
      task_prompt: "修一个问题",
      project_path: "/tmp/project",
      allowed_tools: [],
      required_outputs: ["lateral_constraints"],
      gates: [],
      recent_messages: [],
      human_qa_history: []
    };

    const prompt = buildStageInstructions(input);

    expect(prompt).toContain("required_outputs 字段形状提示");
    expect(prompt).toContain("lateral_constraints: JSON 数组");
    expect(prompt).toContain("{\"constraint\":\"约束\",\"evidence\":\"证据来源/同类位置\",\"implication\":\"对本次改动的含义\"}");
    expect(prompt).toContain("不要输出裸 key/value 清单");
  });

  it("describes JSON-safe shapes for implement required outputs", () => {
    const input: StageAgentInput = {
      workflow: {
        id: "careful-coder",
        name: "谨慎程序员 v2",
        description: "",
        stages: [{ id: "implement", name: "实施", approval_required: false, required_outputs: ["changed_files", "delta_checks", "validation_run"], required_checks: [], gates: [] }]
      },
      previous_stage_summaries: [],
      current_stage: {
        id: "implement",
        name: "实施",
        instructions: "实施改动",
        approval_required: false,
        required_outputs: ["changed_files", "delta_checks", "validation_run"]
      },
      task_prompt: "修一个问题",
      project_path: "/tmp/project",
      allowed_tools: [],
      required_outputs: ["changed_files", "delta_checks", "validation_run"],
      gates: [],
      retry_context: {
        previous_attempt: 2,
        output_summary: "Missing required outputs: changed_files, delta_checks, validation_run (JSON parse 失败诊断：bracket_balance=1)"
      },
      recent_messages: [],
      human_qa_history: []
    };

    const prompt = buildStageInstructions(input);

    expect(prompt).toContain("changed_files: JSON 数组");
    expect(prompt).toContain("delta_checks: JSON 数组");
    expect(prompt).toContain("validation_run: JSON 对象");
    expect(prompt).toContain("不要写成 \"required_outputs\": {{ ... }}");
  });

  it("renders current stage output_schema as the authoritative required_outputs contract", () => {
    const input: StageAgentInput = {
      workflow: {
        id: "careful-coder",
        name: "谨慎程序员 v2",
        description: "",
        stages: [
          {
            id: "implement",
            name: "实施",
            approval_required: false,
            required_outputs: ["changed_files"],
            output_schema: {
              changed_files: {
                type: "array",
                items: { type: "object", properties: { file: "string", changes: "array<string>" } }
              }
            },
            required_checks: [],
            gates: []
          }
        ]
      },
      previous_stage_summaries: [],
      current_stage: {
        id: "implement",
        name: "实施",
        instructions: "实施改动",
        approval_required: false,
        required_outputs: ["changed_files"],
        output_schema: {
          changed_files: {
            type: "array",
            items: { type: "object", properties: { file: "string", changes: "array<string>" } }
          }
        }
      },
      task_prompt: "修一个问题",
      project_path: "/tmp/project",
      allowed_tools: [],
      required_outputs: ["changed_files"],
      gates: [],
      recent_messages: [],
      human_qa_history: []
    };

    const prompt = buildStageInstructions(input);

    expect(prompt).toContain("当前阶段 required_outputs JSON Schema");
    expect(prompt).toContain("\"changed_files\"");
    expect(prompt).toContain("\"array\"");
    expect(prompt).toContain("## 阶段启动契约（先读这里，再开始行动）");
    expect(prompt).toContain("- 当前阶段任务：实施改动");
    expect(prompt).toContain("- 阶段结束时只能输出一个 JSON object");
    expect(prompt).toContain("不要主动添加 ```json 代码块");
    expect(prompt).toContain("- 最外层 JSON object 必须包含：status、output_summary、required_outputs");
    expect(prompt).toContain("\"changed_files\": []");
    expect(prompt).toContain("- required_outputs 字段说明 / JSON Schema：");
    // schema 不再内联在阶段概览行中，而是在 outputShapeHints 区域以 JSON Schema 形式呈现
    expect(prompt).toContain("required_outputs 字段形状提示");
  });

  it("renders enum output_schema values in the stage start contract", () => {
    const input: StageAgentInput = {
      workflow: {
        id: "careful-coder",
        name: "谨慎程序员 v2",
        description: "",
        stages: [
          {
            id: "scan_project",
            name: "扫描项目画像",
            approval_required: false,
            required_outputs: ["profile_mode"],
            output_schema: {
              profile_mode: { type: "string", enum: ["full", "incremental", "none"] }
            },
            required_checks: [],
            gates: []
          }
        ]
      },
      previous_stage_summaries: [],
      current_stage: {
        id: "scan_project",
        name: "扫描项目画像",
        instructions: "扫描项目画像",
        approval_required: false,
        required_outputs: ["profile_mode"],
        output_schema: {
          profile_mode: { type: "string", enum: ["full", "incremental", "none"] }
        }
      },
      task_prompt: "修一个问题",
      project_path: "/tmp/project",
      allowed_tools: [],
      required_outputs: ["profile_mode"],
      gates: [],
      recent_messages: [],
      human_qa_history: []
    };

    const prompt = buildStageInstructions(input);

    expect(prompt).toContain("\"profile_mode\": \"full | incremental | none\"");
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
    expect(prompt).toContain("本阶段产物校验（输出落地后由宿主评估：自洽性断言扫产出文本、行为校验按 tool_calls 核对真动作；未通过会带原因打回重试");
    expect(prompt).toContain("review_self_consistency");

    // 两段 header 在 prompt 中按出现顺序排列，pre 在前
    const preIdx = prompt.indexOf("本阶段工序闸门");
    const postIdx = prompt.indexOf("本阶段产物校验");
    expect(preIdx).toBeGreaterThan(0);
    expect(postIdx).toBeGreaterThan(preIdx);
  });

  it("renders previous required_outputs as reusable stage state", () => {
    const input: StageAgentInput = {
      workflow: {
        id: "careful-coder",
        name: "谨慎程序员 v2",
        description: "",
        stages: [
          { id: "design", name: "方案", approval_required: false, required_outputs: ["success_criteria"], required_checks: [], gates: [] },
          { id: "implement", name: "实施", approval_required: false, required_outputs: ["delta_checks"], required_checks: [], gates: [] }
        ]
      },
      previous_stage_summaries: [
        {
          stage_id: "design",
          attempt: 1,
          status: "completed",
          output_summary: "采用最小改动",
          required_outputs: {
            success_criteria: ["修复崩溃", "测试覆盖未登录路径"],
            test_plan: ["npm test"]
          }
        }
      ],
      current_stage: {
        id: "implement",
        name: "实施",
        instructions: "按方案实施",
        approval_required: false,
        required_outputs: ["delta_checks"]
      },
      task_prompt: "",
      project_path: "/tmp",
      allowed_tools: [],
      required_outputs: ["delta_checks"],
      gates: [],
      recent_messages: [],
      human_qa_history: []
    };

    const prompt = buildStageInstructions(input);

    expect(prompt).toContain("required_outputs:");
    expect(prompt).toContain("\"success_criteria\":[\"修复崩溃\",\"测试覆盖未登录路径\"]");
    expect(prompt).toContain("优先消费前序阶段 required_outputs 中的结构化状态");
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

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
      required_outputs: {
        implementation_plan: ["Change renderer only"]
      },
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
    expect(input.previous_stage_summaries[0]).toMatchObject({
      stage_id: "plan",
      output_summary: "Use a narrow renderer change",
      required_outputs: { implementation_plan: ["Change renderer only"] }
    });
    expect(input.current_stage.id).toBe("execute");
    expect(input.allowed_tools).toEqual(["read_file", "edit_file"]);
  });

  it("keeps the initial user message with attachments when recent message history is long", () => {
    const startedAt = "2026-01-01T00:00:00.000Z";
    const longSession: AgentSession = {
      ...session,
      messages: [
        {
          role: "user",
          content: "最初任务，包含附件上下文",
          created_at: startedAt,
          attachments: [{ type: "file_ref", path: ".ai-coder/uploads/page-001.png", display_name: "需求截图" }]
        },
        ...Array.from({ length: 25 }, (_, index) => ({
          role: "assistant" as const,
          content: `后续消息 ${index + 1}`,
          created_at: `2026-01-01T00:00:${String(index + 1).padStart(2, "0")}.000Z`
        }))
      ]
    };

    const input = buildStageAgentInput(longSession, workflow, workflow.stages[1]);

    expect(input.recent_messages[0]).toMatchObject({
      role: "user",
      content: "最初任务，包含附件上下文",
      attachments: [{ type: "file_ref", path: ".ai-coder/uploads/page-001.png", display_name: "需求截图" }]
    });
    expect(input.recent_messages).toHaveLength(21);
    expect(input.recent_messages.at(-1)?.content).toBe("后续消息 25");
  });

  it("prefers the persisted initial user message snapshot over later message mutations", () => {
    const mutatedSession: AgentSession = {
      ...session,
      initial_user_message: {
        role: "user",
        content: "最初任务快照",
        created_at: "2026-01-01T00:00:00.000Z",
        attachments: [{ type: "file_ref", path: ".ai-coder/uploads/original.png", display_name: "原始附件" }]
      },
      messages: [
        {
          role: "assistant",
          content: "后来被改写的历史消息",
          created_at: "2026-01-01T00:01:00.000Z"
        }
      ]
    };

    const input = buildStageAgentInput(mutatedSession, workflow, workflow.stages[1]);

    expect(input.recent_messages[0]).toMatchObject({
      role: "user",
      content: "最初任务快照",
      attachments: [{ type: "file_ref", path: ".ai-coder/uploads/original.png", display_name: "原始附件" }]
    });
  });

  it("isolates understand stage from project profile stage outputs and assistant history", () => {
    const profileWorkflow: WorkflowTemplate = {
      ...workflow,
      stages: [
        { id: "scan_project", name: "扫描项目画像", required_outputs: ["project_facts"] },
        { id: "update_project_profile", name: "建立或调整项目画像", required_outputs: ["profile_changes"] },
        { id: "understand", name: "理解", required_outputs: ["user_goal_restated"] },
        { id: "decompose", name: "拆分", required_outputs: ["task_items"] }
      ]
    };
    const profileSession: AgentSession = {
      ...session,
      current_stage: "understand",
      initial_user_message: {
        role: "user",
        content: "修复登录页跳转问题",
        created_at: "2026-01-01T00:00:00.000Z",
        attachments: [{ type: "file_ref", path: ".ai-coder/uploads/spec/page-01.png", display_name: "需求.pdf · 第 1 页 / 共 2 页" }]
      },
      messages: [
        {
          role: "user",
          content: "修复登录页跳转问题",
          created_at: "2026-01-01T00:00:00.000Z",
          attachments: [{ type: "file_ref", path: ".ai-coder/uploads/spec/page-01.png", display_name: "需求.pdf · 第 1 页 / 共 2 页" }]
        },
        {
          role: "assistant",
          content: "扫描项目画像完成：这是画像阶段总结，不应成为理解阶段任务目标。",
          created_at: "2026-01-01T00:01:00.000Z"
        },
        {
          role: "assistant",
          content: "画像已更新：这是项目背景维护输出，不是用户需求。",
          created_at: "2026-01-01T00:02:00.000Z"
        }
      ],
      stage_runs: [
        {
          id: "scan-run-1",
          stage_id: "scan_project",
          attempt: 1,
          status: "completed",
          input_summary: "Profile scan",
          output_summary: "画像扫描完成",
          required_outputs: { project_facts: ["项目是 Electron 应用"] },
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString()
        },
        {
          id: "profile-run-1",
          stage_id: "update_project_profile",
          attempt: 1,
          status: "completed",
          input_summary: "Profile update",
          output_summary: "画像更新完成",
          required_outputs: { profile_changes: ["更新 CLAUDE.md"] },
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString()
        },
        {
          id: "understand-run-1",
          stage_id: "understand",
          attempt: 1,
          status: "running",
          input_summary: "Initial task",
          started_at: new Date().toISOString()
        }
      ]
    };

    const input = buildStageAgentInput(profileSession, profileWorkflow, profileWorkflow.stages[2]);

    expect(input.previous_stage_summaries).toEqual([]);
    expect(input.recent_messages).toHaveLength(1);
    expect(input.recent_messages[0]).toMatchObject({
      role: "user",
      content: "修复登录页跳转问题",
      attachments: [{ type: "file_ref", path: ".ai-coder/uploads/spec/page-01.png", display_name: "需求.pdf · 第 1 页 / 共 2 页" }]
    });
  });

  it("sanitizes non-string history message content before injecting it into prompts", () => {
    const weirdContent = [
      { type: "tool_result", content: "PDF file read: /tmp/spec.pdf", tool_use_id: "call-1" },
      { type: "document", source: { media_type: "application/pdf", data: "JVBERi0=" } }
    ] as unknown as string;
    const weirdSession: AgentSession = {
      ...session,
      initial_user_message: {
        role: "user",
        content: weirdContent,
        created_at: "2024-01-01T00:00:00.000Z",
        attachments: [
          { type: "file_ref", path: ".ai-coder/uploads/page-001.png", display_name: "第 1 页" },
          { type: "image", data_base64: "abc", media_type: "image/png", display_name: "raw image" }
        ]
      },
      messages: [
        {
          role: "user",
          content: weirdContent,
          created_at: "2024-01-01T00:00:00.000Z",
          attachments: [
            { type: "file_ref", path: ".ai-coder/uploads/page-001.png", display_name: "第 1 页" },
            { type: "image", data_base64: "abc", media_type: "image/png", display_name: "raw image" }
          ]
        }
      ]
    };

    const input = buildStageAgentInput(weirdSession, workflow, workflow.stages[0]);

    expect(typeof input.recent_messages[0].content).toBe("string");
    expect(input.recent_messages[0].content).toContain("PDF file read");
    expect(input.recent_messages[0].content).toContain("document block omitted");
    expect(input.recent_messages[0].attachments).toEqual([
      { type: "file_ref", path: ".ai-coder/uploads/page-001.png", display_name: "第 1 页" }
    ]);
  });

  it("builds rework_context when an approved rework_request targets the current stage", () => {
    // execute 发现 plan 产出有缺口 → 回 needs_rework 指向 plan → applyRework 把 plan 旧 run 置 superseded、execute 置 needs_rework → 重做 plan
    const reworkSession: AgentSession = {
      ...session,
      stage_runs: [
        {
          id: "plan-run-1",
          stage_id: "plan",
          attempt: 1,
          status: "superseded",
          input_summary: "Initial task",
          output_summary: "上一版 plan 产出，有缺口",
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString()
        },
        {
          id: "plan-run-2",
          stage_id: "plan",
          attempt: 2,
          status: "running",
          input_summary: "Rework requested from execute: plan 未确定存储格式，execute 无法推进",
          started_at: new Date().toISOString()
        },
        {
          id: "execute-run-1",
          stage_id: "execute",
          attempt: 1,
          status: "needs_rework",
          input_summary: "Continue after plan",
          output_summary: "发现 plan 缺存储格式决策",
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          rework_reason: "Need to choose storage format"
        }
      ],
      rework_requests: [
        {
          id: "rework-1",
          from_stage_id: "execute",
          target_stage_id: "plan",
          status: "approved",
          reason: "plan 未确定存储格式，execute 无法推进",
          created_at: new Date().toISOString(),
          resolved_at: new Date().toISOString()
        }
      ]
    };

    const input = buildStageAgentInput(reworkSession, workflow, workflow.stages[0]);

    expect(input.rework_context).toEqual({
      from_stage: "execute",
      reason: "plan 未确定存储格式，execute 无法推进",
      previous_output_summary: "上一版 plan 产出，有缺口"
    });
  });

  it("prefers retry_context over stale rework_context on assertion retry after rework", () => {
    const retryAfterReworkSession: AgentSession = {
      ...session,
      stage_runs: [
        {
          id: "plan-run-1",
          stage_id: "plan",
          attempt: 1,
          status: "superseded",
          input_summary: "Initial task",
          output_summary: "上一版 plan 产出，有缺口",
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString()
        },
        {
          id: "plan-run-2",
          stage_id: "plan",
          attempt: 2,
          status: "running",
          input_summary: "Rework requested from execute",
          retry_reason: "断言失败：缺少候选方案",
          started_at: new Date().toISOString()
        }
      ],
      rework_requests: [
        {
          id: "rework-1",
          from_stage_id: "execute",
          target_stage_id: "plan",
          status: "approved",
          reason: "plan 未确定存储格式，execute 无法推进",
          created_at: new Date().toISOString(),
          resolved_at: new Date().toISOString()
        }
      ]
    };

    const input = buildStageAgentInput(retryAfterReworkSession, workflow, workflow.stages[0]);

    expect(input.retry_context).toMatchObject({ previous_attempt: 2, output_summary: "断言失败：缺少候选方案" });
    expect(input.rework_context).toBeUndefined();
  });

  it("does not inject stale rework_context on a plain resume run", () => {
    const resumedSession: AgentSession = {
      ...session,
      stage_runs: [
        {
          id: "plan-run-1",
          stage_id: "plan",
          attempt: 1,
          status: "superseded",
          input_summary: "Initial task",
          output_summary: "旧的返工前 plan 产出",
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString()
        },
        {
          id: "plan-run-2",
          stage_id: "plan",
          attempt: 2,
          status: "running",
          input_summary: "Resume from failed stage",
          started_at: new Date().toISOString()
        }
      ],
      rework_requests: [
        {
          id: "rework-1",
          from_stage_id: "execute",
          target_stage_id: "plan",
          status: "approved",
          reason: "旧的返工原因",
          created_at: new Date().toISOString(),
          resolved_at: new Date().toISOString()
        }
      ]
    };

    const input = buildStageAgentInput(resumedSession, workflow, workflow.stages[0]);
    expect(input.rework_context).toBeUndefined();
  });

  it("leaves rework_context undefined when the rework_request targets a different stage", () => {
    const reworkSession: AgentSession = {
      ...session,
      rework_requests: [
        {
          id: "rework-1",
          from_stage_id: "execute",
          target_stage_id: "plan",
          status: "approved",
          reason: "plan 缺口",
          created_at: new Date().toISOString()
        }
      ]
    };

    // 当前 stage 是 execute，但 rework_request 指向 plan → 不应注入给 execute
    const input = buildStageAgentInput(reworkSession, workflow, workflow.stages[1]);
    expect(input.rework_context).toBeUndefined();
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

    expect(result).toMatchObject({ status: "completed", output_summary: "Plain assistant response" });
    expect(result.parse_diagnostics?.had_unparsed_tail).toBe(false);
    expect(result.parse_diagnostics?.candidate_count).toBe(0);
    expect(result.parse_diagnostics?.parse_strategy).toBe("none");
    expect(result.parse_diagnostics?.protocol_violation).toBe(true);
  });

  it("flags trailing unparsed JSON as a diagnostic (so the assertion can retry)", () => {
    // 模拟本次失误样本：先一段合法 JSON，再粘一段未闭合 JSON 草稿。
    const raw = [
      '{"status":"completed","output_summary":"x","required_outputs":{"a":1}}',
      "\n\n",
      // 多余引号 + 空 key + 未闭合
      '{",\n  "status": "completed",\n  " "output_summary": ""\n}{\n'
    ].join("");
    const result = parseStageAgentResult(raw);

    expect(result.status).toBe("completed");
    expect(result.required_outputs).toEqual({ a: 1 });
    expect(result.parse_diagnostics).toBeDefined();
    expect(result.parse_diagnostics!.had_unparsed_tail).toBe(true);
    expect(result.parse_diagnostics!.parse_strategy).toBe("embedded_json");
    expect(result.parse_diagnostics!.protocol_violation).toBe(true);
    // 起码包括 raw 末尾的未闭合 `{`
    expect(result.parse_diagnostics!.bracket_balance).toBeGreaterThan(0);
  });

  it("repairs a duplicated opening brace after required_outputs", () => {
    const result = parseStageAgentResult(`{
  "status": "completed",
  "output_summary": "done",
  "required_outputs": {{
    "changed_files": [
      {"file": "src/a.ts", "changes": ["updated redirect"]}
    ],
    "delta_checks": [],
    "validation_run": {
      "commands_executed": [],
      "results": "not run",
      "skipped_validations": ["no node"],
      "residual_risks": "compile not verified"
    }
  }
}`);

    expect(result.status).toBe("completed");
    expect(result.required_outputs).toEqual({
      changed_files: [{ file: "src/a.ts", changes: ["updated redirect"] }],
      delta_checks: [],
      validation_run: {
        commands_executed: [],
        results: "not run",
        skipped_validations: ["no node"],
        residual_risks: "compile not verified"
      }
    });
    expect(result.parse_diagnostics?.had_unparsed_tail).toBe(false);
    expect(result.parse_diagnostics?.parse_strategy).toBe("repaired_single_json_object");
    expect(result.parse_diagnostics?.protocol_violation).toBe(true);
  });

  it("parses relaxed pseudo-structured stage output when JSON was omitted", () => {
    const result = parseStageAgentResult(`
status
:
completed
output_summary
:
"理解阶段完成。用户诉求：基于 develop/aiAgent 创建新 feature 分支。"
required_outputs
:
user_goal_restated
:
基于 develop/aiAgent 创建新 feature 分支，重新实现页面跳转。
definition_of_done
:
创建分支；实现跳转；完成验证。
assumptions
:
使用现有登录校验模式。
`);

    expect(result.status).toBe("completed");
    expect(result.output_summary).toContain("理解阶段完成");
    expect(result.required_outputs).toMatchObject({
      user_goal_restated: expect.stringContaining("develop/aiAgent"),
      definition_of_done: expect.stringContaining("创建分支"),
      assumptions: expect.stringContaining("登录校验")
    });
    expect(result.parse_diagnostics?.parse_strategy).toBe("relaxed_fields");
    expect(result.parse_diagnostics?.protocol_violation).toBe(true);
  });

  it("clean single-object JSON: had_unparsed_tail=false", () => {
    const result = parseStageAgentResult('{"status":"completed","output_summary":"ok"}');
    expect(result.parse_diagnostics?.had_unparsed_tail).toBe(false);
    expect(result.parse_diagnostics?.bracket_balance).toBe(0);
    expect(result.parse_diagnostics?.parse_strategy).toBe("single_json_object");
    expect(result.parse_diagnostics?.protocol_violation).toBe(false);
  });

  it("parses stage JSON from assistant prose with embedded markdown fences", () => {
    const result = parseStageAgentResult(`已读取项目文件，现在可以起草方案。

\`\`\`json
{
  "status": "completed",
  "output_summary": "起草阶段完成。",
  "required_outputs": {
    "compact_summary": "简要摘要",
    "claude_md_draft": "# 标题\\n\\n\`\`\`\\n目录树\\n\`\`\`\\n",
    "preservation_plan": "保留原有规则"
  }
}
\`\`\`

已读取项目文件，现在可以起草方案。

\`\`\`json
{
  "status": "completed",
  "output_summary": "起草阶段完成。",
  "required_outputs": {
    "compact_summary": "最终简要摘要",
    "claude_md_draft": "# 标题\\n\\n\`\`\`\\n目录树\\n\`\`\`\\n",
    "preservation_plan": "最终保留计划"
  }
}
\`\`\``);

    expect(result).toMatchObject({
      status: "completed",
      output_summary: "起草阶段完成。",
      required_outputs: {
        compact_summary: "最终简要摘要",
        preservation_plan: "最终保留计划"
      }
    });
    expect(result.parse_diagnostics?.parse_strategy).toBe("embedded_json");
    expect(result.parse_diagnostics?.protocol_violation).toBe(true);
  });

  it("creates mock required outputs for required fields", () => {
    const input = buildStageAgentInput(session, workflow, workflow.stages[0]);

    expect(createMockStageAgentResult(input).required_outputs).toEqual({
      implementation_plan: "implementation_plan 的 Mock 输出"
    });
  });
});

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
    // 起码包括 raw 末尾的未闭合 `{`
    expect(result.parse_diagnostics!.bracket_balance).toBeGreaterThan(0);
  });

  it("clean single-object JSON: had_unparsed_tail=false", () => {
    const result = parseStageAgentResult('{"status":"completed","output_summary":"ok"}');
    expect(result.parse_diagnostics?.had_unparsed_tail).toBe(false);
    expect(result.parse_diagnostics?.bracket_balance).toBe(0);
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
  });

  it("creates mock required outputs for required fields", () => {
    const input = buildStageAgentInput(session, workflow, workflow.stages[0]);

    expect(createMockStageAgentResult(input).required_outputs).toEqual({
      implementation_plan: "implementation_plan 的 Mock 输出"
    });
  });
});

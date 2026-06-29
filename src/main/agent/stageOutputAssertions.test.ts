import { describe, expect, it } from "vitest";
import { evaluateOutputAssertions } from "./stageOutputAssertions.js";
import type { StageAgentResult, WorkflowStage } from "../../shared/types.js";

function stage(post_output_assertions?: WorkflowStage["hooks"] extends infer H ? H : never): WorkflowStage {
  return {
    id: "self_review",
    name: "Self Review",
    hooks: post_output_assertions
      ? (post_output_assertions as WorkflowStage["hooks"])
      : undefined
  };
}

function result(partial: Partial<StageAgentResult> & Pick<StageAgentResult, "status" | "output_summary">): StageAgentResult {
  return { ...partial };
}

describe("evaluateOutputAssertions", () => {
  it("透传：未声明 post_output_assertions 直接返回空", () => {
    const out = evaluateOutputAssertions(stage(), result({ status: "completed", output_summary: "全部通过" }));
    expect(out).toEqual([]);
  });

  describe("review_self_consistency", () => {
    const s = stage({ post_output_assertions: ["review_self_consistency"] });

    it("findings 含 blocker + decision=pass → 失败", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "发现 1 个 blocker：登录校验缺失",
          required_outputs: { rework_decision: "pass", review_findings: "见上" }
        })
      );
      expect(out).toHaveLength(1);
      expect(out[0].assertion).toBe("review_self_consistency");
      expect(out[0].message).toContain("阻塞类问题信号");
    });

    it("中文'严重不一致' + pass → 失败", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "通过",
          required_outputs: {
            rework_decision: "pass",
            review_findings: "Setting 与 ACCTSEC 存在严重不一致"
          }
        })
      );
      expect(out).toHaveLength(1);
    });

    it("'安全问题' + pass → 失败（本案直接病灶）", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "对比完成",
          required_outputs: {
            rework_decision: "pass",
            review_findings: "可能导致未登录用户访问敏感页面的安全问题",
            residual_risks: "登录校验策略需确认"
          }
        })
      );
      expect(out).toHaveLength(1);
    });

    it("高优先级 + 问题（同句）+ pass → 失败", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "",
          required_outputs: {
            rework_decision: "pass",
            review_findings: "高优先级问题：MIA 实现不一致"
          }
        })
      );
      expect(out).toHaveLength(1);
    });

    it("高优先级 + 中性描述（不同句）→ 不误挡", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "已逐项核对全部约束。",
          required_outputs: {
            rework_decision: "pass",
            review_findings: "高优先级建议：未来可复用现有工具函数。本次未发现遗漏。"
          }
        })
      );
      expect(out).toEqual([]);
    });

    it("单独提及'安全'（中性，无阻塞修饰）→ 不误挡", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "已检查安全相关分支均通过。",
          required_outputs: { rework_decision: "pass", review_findings: "—" }
        })
      );
      expect(out).toEqual([]);
    });

    it("否定语境：'未发现 blocker' / '无安全问题' → 不误挡（最常见的假阳性源）", () => {
      const phrases = [
        "本次未发现 blocker 级问题",
        "已确认无安全问题",
        "不存在严重不一致",
        "经核查未存在安全漏洞",
        "no blocker found"
      ];
      for (const phrase of phrases) {
        const out = evaluateOutputAssertions(
          s,
          result({
            status: "completed",
            output_summary: phrase,
            required_outputs: { rework_decision: "pass", review_findings: phrase }
          })
        );
        expect(out, `应当放行：${phrase}`).toEqual([]);
      }
    });

    it("词边界：'non-blocking'/'critical path'/'critical section' 是中性术语 → 不误挡", () => {
      const phrases = [
        "采用 non-blocking 写法",
        "logic correctly handles critical path",
        "guarded by a critical section lock",
        "non-blocking I/O 已就绪"
      ];
      for (const phrase of phrases) {
        const out = evaluateOutputAssertions(
          s,
          result({
            status: "completed",
            output_summary: phrase,
            required_outputs: { rework_decision: "pass", review_findings: phrase }
          })
        );
        expect(out, `应当放行：${phrase}`).toEqual([]);
      }
    });

    it("否定语境：'未发现高优先级问题' → 不误挡", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "全部通过",
          required_outputs: {
            rework_decision: "pass",
            review_findings: "未发现高优先级问题"
          }
        })
      );
      expect(out).toEqual([]);
    });

    it("英文长句标点：'High priority finding: missing coverage' → 仍能命中阻塞", () => {
      // 即便用英文逗号长句叙述，high priority + missing coverage 共现也属于阻塞自洽问题
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "",
          required_outputs: {
            rework_decision: "pass",
            review_findings: "High priority issue: coverage gap in auth flow"
          }
        })
      );
      expect(out).toHaveLength(1);
    });

    it("decision=needs_rework → 不挡（即使含阻塞词）", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "needs_rework",
          output_summary: "存在 blocker",
          required_outputs: { rework_decision: "needs_rework" },
          rework_target_stage_id: "implement",
          rework_reason: "x"
        })
      );
      expect(out).toEqual([]);
    });

    it("required_outputs 为空 / rework_decision 缺失 → 不挡（无表态视作未声明 pass）", () => {
      const out = evaluateOutputAssertions(
        s,
        result({ status: "completed", output_summary: "出现 critical 错误，待处理" })
      );
      expect(out).toEqual([]);
    });
  });

  describe("needs_rework_target_required", () => {
    const s = stage({ post_output_assertions: ["needs_rework_target_required"] });

    it("needs_rework 但未带 target → 失败", () => {
      const out = evaluateOutputAssertions(
        s,
        result({ status: "needs_rework", output_summary: "回炉" })
      );
      expect(out).toHaveLength(1);
      expect(out[0].assertion).toBe("needs_rework_target_required");
    });

    it("needs_rework 且带 target → 通过", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "needs_rework",
          output_summary: "回炉",
          rework_target_stage_id: "implement"
        })
      );
      expect(out).toEqual([]);
    });

    it("completed 不触发", () => {
      const out = evaluateOutputAssertions(
        s,
        result({ status: "completed", output_summary: "ok" })
      );
      expect(out).toEqual([]);
    });
  });

  describe("unknowns_present", () => {
    const s = stage({ post_output_assertions: ["unknowns_present"] });

    it("unknowns 缺失 → 失败", () => {
      const out = evaluateOutputAssertions(
        s,
        result({ status: "completed", output_summary: "x", required_outputs: {} })
      );
      expect(out).toHaveLength(1);
    });

    it("unknowns 为'无' → 失败（不允许沉默）", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: { unknowns: "无" }
        })
      );
      expect(out).toHaveLength(1);
      expect(out[0].message).toContain("无/none/n/a");
    });

    it("unknowns 含真实内容 → 通过", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: { unknowns: "我搜过 productType 默认值但未找到，将在 align 阶段询问" }
        })
      );
      expect(out).toEqual([]);
    });

    it("unknowns 为数组（多项）→ 通过", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: {
            unknowns: ["onPressOnlineService 与 ConmmonlyUsedFunctions 等价性未验证", "ACCTSEC 鉴权策略未确认"]
          }
        })
      );
      expect(out).toEqual([]);
    });
  });

  describe("item_matrix_when_multi", () => {
    const s = stage({ post_output_assertions: ["item_matrix_when_multi"] });

    it("任务含数字范围且缺矩阵 → 失败", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "为 33-42 号页面实现跳转",
          required_outputs: { design_summary: "..." }
        })
      );
      expect(out).toHaveLength(1);
      expect(out[0].assertion).toBe("item_matrix_when_multi");
    });

    it("任务含'批量' + 提供 markdown 矩阵 → 通过", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "批量处理 11 个页面",
          required_outputs: {
            item_matrix: "| 条目 | 鉴权 | 参数 |\n| --- | --- | --- |\n| LQB | 否 | productType |"
          }
        })
      );
      expect(out).toEqual([]);
    });

    it("单条目任务（无枚举提示） → 透传", () => {
      const out = evaluateOutputAssertions(
        s,
        result({ status: "completed", output_summary: "修复一个登录 bug" })
      );
      expect(out).toEqual([]);
    });

    it("浮点数字（3.5-4.0 / 2.0-3.5）不应触发数字范围假阳", () => {
      // P0 回归：旧实现 \b\d+\s*-\s*\d+\b 会把 "3.5-4.0" 切出 "5-4" 触发矩阵要求。
      const phrases = [
        "把浮点容差从 3.5-4.0 调整为 2.0-3.5",
        "时延从 1.0-2.0s 降到 0.5-1.5s",
        "学习率 0.001-0.01 之间扫描"
      ];
      for (const phrase of phrases) {
        const out = evaluateOutputAssertions(
          s,
          result({ status: "completed", output_summary: phrase })
        );
        expect(out, `应当放行（不算多条目）：${phrase}`).toEqual([]);
      }
    });

    it("逗号列表 ≥3 项 → 触发；矩阵不是表则失败", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "处理 LQB、ESCTR、MIA、Setting",
          required_outputs: { item_matrix: "见上文" }
        })
      );
      expect(out).toHaveLength(1);
    });

    it("矩阵缺分隔线 → 不当作合法表（失败）", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "批量处理多个页面",
          required_outputs: {
            item_matrix: "| 条目 | 鉴权 |\n| LQB | 否 |"
          }
        })
      );
      expect(out).toHaveLength(1);
    });
  });

  it("多条断言并存：各自独立失败", () => {
    const s = stage({
      post_output_assertions: ["review_self_consistency", "needs_rework_target_required"]
    });
    const out = evaluateOutputAssertions(
      s,
      result({
        status: "needs_rework",
        output_summary: "blocker found",
        required_outputs: { rework_decision: "pass" }
        // 故意不写 rework_target_stage_id
      })
    );
    // status=needs_rework 时 rework_decision=pass 不在 review_self_consistency 命中（只查 decision），
    // 但 needs_rework_target_required 会失败
    expect(out.map((f) => f.assertion)).toContain("needs_rework_target_required");
  });

  describe("all_tasks_resolved", () => {
    const s = stage({ post_output_assertions: ["all_tasks_resolved"] });

    it("有 pending task → 失败", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: {
            investigation_tasks: [
              { id: "t1", question: "查 productType 是否必传", status: "done", verdict: "confirmed" },
              { id: "t2", question: "查 LQB 上下游", status: "pending" }
            ]
          }
        })
      );
      expect(out).toHaveLength(1);
      expect(out[0].assertion).toBe("all_tasks_resolved");
      expect(out[0].message).toContain("t2");
    });

    it("deferred 但缺 defer_reason → 失败", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: {
            investigation_tasks: [{ id: "t1", question: "x", status: "deferred" }]
          }
        })
      );
      expect(out).toHaveLength(1);
      expect(out[0].message).toContain("defer_reason");
    });

    it("全部 done/deferred + defer_reason 完备 → 通过", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: {
            investigation_tasks: [
              { id: "t1", question: "q1", status: "done", verdict: "confirmed" },
              { id: "t2", question: "q2", status: "deferred", defer_reason: "依赖 align 阶段决策" }
            ]
          }
        })
      );
      expect(out).toEqual([]);
    });

    it("字段缺失 → 透传（required_outputs 校验另负责）", () => {
      const out = evaluateOutputAssertions(s, result({ status: "completed", output_summary: "x" }));
      expect(out).toEqual([]);
    });
  });

  describe("findings_traceable_to_probes", () => {
    const s = stage({ post_output_assertions: ["findings_traceable_to_probes"] });

    it("finding 缺 from_hypothesis → 失败", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: {
            findings: [{ id: "f1", claim: "OLS 漏改", path_anchor: "Index.tsx:748" }]
          }
        })
      );
      expect(out).toHaveLength(1);
      expect(out[0].message).toContain("缺 from_hypothesis");
    });

    it("from_hypothesis 在 hypotheses 找不到 → 失败", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: {
            findings: [{ id: "f1", from_hypothesis: "h99", claim: "x" }],
            hypotheses: [{ id: "h1", claim: "y", linked_task_id: "t1" }]
          }
        })
      );
      expect(out).toHaveLength(1);
      expect(out[0].message).toContain("h99");
    });

    it("linked task verdict=inconclusive → 失败（应回 unknowns）", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: {
            findings: [{ id: "f1", from_hypothesis: "h1", claim: "x" }],
            hypotheses: [{ id: "h1", claim: "y", linked_task_id: "t1" }],
            investigation_tasks: [{ id: "t1", question: "q", status: "done", verdict: "inconclusive" }]
          }
        })
      );
      expect(out).toHaveLength(1);
      expect(out[0].message).toContain("inconclusive");
    });

    it("verdict=confirmed → 通过", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: {
            findings: [{ id: "f1", from_hypothesis: "h1", claim: "x" }],
            hypotheses: [{ id: "h1", claim: "y", linked_task_id: "t1" }],
            investigation_tasks: [{ id: "t1", question: "q", status: "done", verdict: "confirmed" }]
          }
        })
      );
      expect(out).toEqual([]);
    });

    it("findings 为空 → 透传", () => {
      const out = evaluateOutputAssertions(
        s,
        result({ status: "completed", output_summary: "x", required_outputs: { findings: [] } })
      );
      expect(out).toEqual([]);
    });
  });

  describe("hedged_findings_demoted", () => {
    const s = stage({ post_output_assertions: ["hedged_findings_demoted"] });

    it("finding.claim 含'可能' → 失败", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: {
            findings: [{ id: "f1", claim: "productType 缺失可能导致页面异常", from_hypothesis: "h1" }]
          }
        })
      );
      expect(out).toHaveLength(1);
      expect(out[0].assertion).toBe("hedged_findings_demoted");
      expect(out[0].message).toContain("可能");
    });

    it("finding.description 含 'maybe' → 失败", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: {
            findings: [{ id: "f1", description: "this might be a regression", from_hypothesis: "h1" }]
          }
        })
      );
      expect(out).toHaveLength(1);
    });

    it("否定语境：'未发现 likely 风险' → 不误挡", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: {
            findings: [{ id: "f1", claim: "未发现 likely 的回归风险", from_hypothesis: "h1" }]
          }
        })
      );
      expect(out).toEqual([]);
    });

    it("肯定结论无 hedge → 通过", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: {
            findings: [{ id: "f1", claim: "OLS 处缺少 goLogin 包裹，应 cherry-pick", from_hypothesis: "h1" }]
          }
        })
      );
      expect(out).toEqual([]);
    });
  });

  describe("plan_readiness_honest", () => {
    const s = stage({ post_output_assertions: ["plan_readiness_honest"] });

    it("sufficient=false 且 unknowns/pending/missing 都空 → 失败", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: {
            plan_readiness: { sufficient: false },
            unknowns: "",
            investigation_tasks: [{ id: "t1", status: "done", verdict: "confirmed" }]
          }
        })
      );
      expect(out).toHaveLength(1);
      expect(out[0].assertion).toBe("plan_readiness_honest");
    });

    it("sufficient=false 且 unknowns 有内容 → 通过", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: {
            plan_readiness: { sufficient: false, missing_evidence_for: [] },
            unknowns: "productType 默认值未确认"
          }
        })
      );
      expect(out).toEqual([]);
    });

    it("sufficient=false 但有 pending task → 通过", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: {
            plan_readiness: { sufficient: false },
            unknowns: "",
            investigation_tasks: [{ id: "t2", status: "pending", question: "查 X" }]
          }
        })
      );
      expect(out).toEqual([]);
    });

    it("sufficient=true → 透传（pass 门槛由其他断言负责）", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: {
            plan_readiness: { sufficient: true },
            unknowns: ""
          }
        })
      );
      expect(out).toEqual([]);
    });
  });

  describe("no_trailing_unparsed_payload", () => {
    const s = stage({ post_output_assertions: ["no_trailing_unparsed_payload"] });

    it("had_unparsed_tail=true → 失败", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          parse_diagnostics: {
            had_unparsed_tail: true,
            tail_length: 320,
            last_open_brace_index: 1200,
            bracket_balance: 2,
            candidate_count: 1
          }
        })
      );
      expect(out).toHaveLength(1);
      expect(out[0].message).toContain("bracket_balance=2");
    });

    it("had_unparsed_tail=false → 通过", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          parse_diagnostics: {
            had_unparsed_tail: false,
            tail_length: 0,
            last_open_brace_index: 5,
            bracket_balance: 0,
            candidate_count: 1
          }
        })
      );
      expect(out).toEqual([]);
    });

    it("parse_diagnostics 缺失 → 透传（向后兼容）", () => {
      const out = evaluateOutputAssertions(s, result({ status: "completed", output_summary: "x" }));
      expect(out).toEqual([]);
    });
  });

  describe("plan_steps_grounded", () => {
    const s = stage({ post_output_assertions: ["plan_steps_grounded"] });

    it("supporting_finding_ids 空 → 失败", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: {
            plan_steps: [{ id: "p1", action: "do X", supporting_finding_ids: [] }]
          }
        }),
        { investigate: { findings: [{ id: "f1" }] } }
      );
      expect(out).toHaveLength(1);
      expect(out[0].message).toContain("supporting_finding_ids 为空");
    });

    it("引用了不存在的 finding id → 失败", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: {
            plan_steps: [{ id: "p1", action: "do X", supporting_finding_ids: ["f99"] }]
          }
        }),
        { investigate: { findings: [{ id: "f1" }] } }
      );
      expect(out).toHaveLength(1);
      expect(out[0].message).toContain("f99");
    });

    it("所有 step 都挂到合法 finding → 通过", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: {
            plan_steps: [
              { id: "p1", action: "do X", supporting_finding_ids: ["f1"] },
              { id: "p2", action: "do Y", supporting_finding_ids: ["f1", "f2"] }
            ]
          }
        }),
        { investigate: { findings: [{ id: "f1" }, { id: "f2" }] } }
      );
      expect(out).toEqual([]);
    });

    it("拿不到 findings 集合时退化到'非空'校验（非空通过）", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: {
            plan_steps: [{ id: "p1", action: "do X", supporting_finding_ids: ["f1"] }]
          }
        }),
        {} // 完全无前序产物
      );
      expect(out).toEqual([]);
    });

    it("plan_steps 缺失 → 透传（required_outputs 校验另负责）", () => {
      const out = evaluateOutputAssertions(s, result({ status: "completed", output_summary: "x" }));
      expect(out).toEqual([]);
    });
  });

  describe("deviations_must_be_revised", () => {
    const s = stage({ post_output_assertions: ["deviations_must_be_revised"] });

    it("有 deviations 但 plan_revisions 数量不足 → 失败", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: {
            deviations_from_plan: [
              { step_id: "p1", what_changed: "x" },
              { step_id: "p2", what_changed: "y" }
            ],
            plan_revisions: [{ trigger: "x", new_or_modified_steps: "..." }]
          }
        })
      );
      expect(out).toHaveLength(1);
      expect(out[0].message).toContain("plan_revisions 只有 1 条");
    });

    it("deviations 与 revisions 数量匹配 → 通过", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: {
            deviations_from_plan: [{ step_id: "p1", what_changed: "x" }],
            plan_revisions: [{ trigger: "x", new_or_modified_steps: "..." }]
          }
        })
      );
      expect(out).toEqual([]);
    });

    it("没有 deviations → 透传", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: { deviations_from_plan: [], plan_revisions: [] }
        })
      );
      expect(out).toEqual([]);
    });
  });

  describe("deviation_severity_must_rework", () => {
    const s = stage({ post_output_assertions: ["deviation_severity_must_rework"] });

    it("有 out_of_scope=true 的 deviation 但 status=completed → 失败", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: {
            deviations_from_plan: [
              { step_id: "p1", what_changed: "前提推翻", out_of_scope: true }
            ]
          }
        })
      );
      expect(out).toHaveLength(1);
      expect(out[0].message).toContain("out_of_scope=true");
    });

    it("有 out_of_scope=true 且 status=needs_rework + 有 target → 通过", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "needs_rework",
          output_summary: "回炉",
          rework_target_stage_id: "design",
          required_outputs: {
            deviations_from_plan: [{ step_id: "p1", what_changed: "x", out_of_scope: true }]
          }
        })
      );
      expect(out).toEqual([]);
    });

    it("deviations 全为 out_of_scope=false → 透传", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: {
            deviations_from_plan: [{ step_id: "p1", what_changed: "x", out_of_scope: false }]
          }
        })
      );
      expect(out).toEqual([]);
    });
  });

  describe("pass_requires_all_validated", () => {
    const s = stage({ post_output_assertions: ["pass_requires_all_validated"] });

    function basePassing(): Record<string, unknown> {
      return {
        rework_decision: "pass",
        phase_1_self_check: [{ criterion: "C1", status: "met", evidence_path_anchor: "a.ts:1" }],
        phase_2_tests: { commands_run: ["pnpm test"], green: true, stdout_summary: "ok" },
        phase_3_adversarial_review: { perf_findings: [], security_findings: [], extensibility_findings: [] },
        residual_risks: ""
      };
    }

    it("phase_1 含 missing 项 → 失败", () => {
      const ro = basePassing();
      ro.phase_1_self_check = [{ criterion: "C1", status: "missing" }];
      const out = evaluateOutputAssertions(s, result({ status: "completed", output_summary: "x", required_outputs: ro }));
      expect(out).toHaveLength(1);
      expect(out[0].message).toContain("status=missing");
    });

    it("phase_1 partial 缺 mitigation → 失败", () => {
      const ro = basePassing();
      ro.phase_1_self_check = [{ criterion: "C1", status: "partial" }];
      const out = evaluateOutputAssertions(s, result({ status: "completed", output_summary: "x", required_outputs: ro }));
      expect(out).toHaveLength(1);
      expect(out[0].message).toContain("缺 mitigation");
    });

    it("phase_2.green=false → 失败", () => {
      const ro = basePassing();
      ro.phase_2_tests = { commands_run: ["pnpm test"], green: false, stdout_summary: "x failed" };
      const out = evaluateOutputAssertions(s, result({ status: "completed", output_summary: "x", required_outputs: ro }));
      expect(out).toHaveLength(1);
      expect(out[0].message).toContain("phase_2_tests.green");
    });

    it("phase_3 含 severity=high → 失败", () => {
      const ro = basePassing();
      ro.phase_3_adversarial_review = {
        perf_findings: [],
        security_findings: [{ path_anchor: "a.ts:1", concern: "X", severity: "high" }],
        extensibility_findings: []
      };
      const out = evaluateOutputAssertions(s, result({ status: "completed", output_summary: "x", required_outputs: ro }));
      expect(out).toHaveLength(1);
      expect(out[0].message).toContain("security_findings");
    });

    it("residual_risks 非空 → 失败", () => {
      const ro = basePassing();
      ro.residual_risks = "登录策略仍需确认";
      const out = evaluateOutputAssertions(s, result({ status: "completed", output_summary: "x", required_outputs: ro }));
      expect(out).toHaveLength(1);
      expect(out[0].message).toContain("residual_risks 非空");
    });

    it("investigate.unknowns 非空 → 失败", () => {
      const ro = basePassing();
      const out = evaluateOutputAssertions(
        s,
        result({ status: "completed", output_summary: "x", required_outputs: ro }),
        { investigate: { unknowns: "productType 默认值未确认" } }
      );
      expect(out).toHaveLength(1);
      expect(out[0].message).toContain("investigate.unknowns");
    });

    it("rework_decision != 'pass' → 透传", () => {
      const ro = basePassing();
      ro.rework_decision = "pass_with_followups";
      ro.residual_risks = "X";
      const out = evaluateOutputAssertions(s, result({ status: "completed", output_summary: "x", required_outputs: ro }));
      expect(out).toEqual([]);
    });

    it("全部满足 → 通过", () => {
      const out = evaluateOutputAssertions(
        s,
        result({ status: "completed", output_summary: "x", required_outputs: basePassing() }),
        { investigate: { unknowns: "" } }
      );
      expect(out).toEqual([]);
    });
  });

  describe("design_considerations_filled", () => {
    const s = stage({ post_output_assertions: ["design_considerations_filled"] });

    it("三栏全空 → 失败", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: {
            plan_steps: [{ id: "p1", action: "do X" }]
          }
        })
      );
      expect(out).toHaveLength(1);
      expect(out[0].message).toContain("p1");
      expect(out[0].message).toContain("perf_consideration");
    });

    it("只写'无' → 失败（trivial 否定不算填）", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: {
            plan_steps: [
              {
                id: "p1",
                action: "do X",
                perf_consideration: "无",
                security_consideration: "none",
                extensibility_consideration: "n/a"
              }
            ]
          }
        })
      );
      expect(out).toHaveLength(1);
    });

    it("写'不适用：<原因>' → 通过", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: {
            plan_steps: [
              {
                id: "p1",
                action: "改注释 typo",
                perf_consideration: "不适用：仅注释改动",
                security_consideration: "不适用：仅注释改动",
                extensibility_consideration: "不适用：仅注释改动"
              }
            ]
          }
        })
      );
      expect(out).toEqual([]);
    });

    it("正常填写 → 通过", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "x",
          required_outputs: {
            plan_steps: [
              {
                id: "p1",
                action: "新增 hedged 断言",
                perf_consideration: "O(N) 扫描数组，量级几十条可接受",
                security_consideration: "不适用：纯本地校验",
                extensibility_consideration: "新断言遵循 AssertionImpl 接口，与现有 4 个解耦"
              }
            ]
          }
        })
      );
      expect(out).toEqual([]);
    });

    it("plan_steps 缺失 → 透传", () => {
      const out = evaluateOutputAssertions(s, result({ status: "completed", output_summary: "x" }));
      expect(out).toEqual([]);
    });
  });
});

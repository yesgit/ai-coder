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

  describe("investigate_structure_present（v1.2 结构化自然语言）", () => {
    const s = stage({ post_output_assertions: ["investigate_structure_present"] });

    it("4 个 markdown 标题全有 → 通过", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: `
## 调查任务清单
1. [ ] task_1: 查 X → [已查]

## 假设与验证
- H1: 可能是 Y → [证实]

## 已证实的结论
1. f1: 结论（证据：\`file.ts:42\`）

## 仍未确定的事项
- 无
`
        })
      );
      expect(out).toEqual([]);
    });

    it("缺'## 假设与验证' → 失败", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: `
## 调查任务清单
1. [ ] task_1: 查 X → [已查]

## 已证实的结论
1. f1: 结论

## 仍未确定的事项
- 无
`
        })
      );
      expect(out).toHaveLength(1);
      expect(out[0].assertion).toBe("investigate_structure_present");
      expect(out[0].message).toContain("假设与验证");
    });

    it("标题都有但拼写不完全一致（如少#） → 失败", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: `
调查任务清单
1. [ ] task_1

假设与验证
- H1

已证实的结论
1. f1

仍未确定的事项
- 无
`
        })
      );
      expect(out).toHaveLength(1);
      expect(out[0].message).toContain("markdown 标题");
    });

    it("output_summary 为空 → 失败", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: ""
        })
      );
      expect(out).toHaveLength(1);
    });
  });

  describe("hedged_findings_demoted（v1.2 证据锚点升级版）", () => {
    const s = stage({ post_output_assertions: ["hedged_findings_demoted"] });

    it("output_summary 含 'X 可能存在 Y 问题' 且无 path:line 证据 → 失败", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "productType 缺失可能导致页面显示异常",
          required_outputs: { unknowns: "无" }
        })
      );
      expect(out).toHaveLength(1);
      expect(out[0].assertion).toBe("hedged_findings_demoted");
    });

    it("英文 'might be a regression' + 无证据 → 失败", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "this change might be a regression in auth"
        })
      );
      expect(out).toHaveLength(1);
    });

    it("hedge + 负面词 + 含 path:line 证据 → 通过（视为已取证）", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "src/auth/login.ts:42 处 productType 缺失可能导致 LQB 页面显示异常（已读源码确认）"
        })
      );
      expect(out).toEqual([]);
    });

    it("否定语境：'未发现 likely 风险' → 不误挡", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "已检查全部分支，未发现 likely 的回归风险"
        })
      );
      expect(out).toEqual([]);
    });

    it("远距离否定：'我没有发现任何可能存在的风险' → 不误挡", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "我没有发现任何可能存在的风险"
        })
      );
      expect(out).toEqual([]);
    });

    it("仅 hedge 词无负面词共现 → 不触发（'maybe later' 不是结论）", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "需求 maybe 之后再扩展，目前先实现 33-42"
        })
      );
      expect(out).toEqual([]);
    });

    it("含 commit hash 引用 → 视为已取证、不挡", () => {
      const out = evaluateOutputAssertions(
        s,
        result({
          status: "completed",
          output_summary: "commit b5043e8 引入的逻辑可能存在边界 bug（已 git log 确认）"
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
});

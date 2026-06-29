import { describe, expect, it } from "vitest";
import path from "node:path";
import { WorkflowRegistry } from "./workflowRegistry.js";

/**
 * v1.1 careful-coder yaml 接线快照——硬结构约束已经放弃，断言收敛到 6 个文本/结构扫描类。
 * 这些测试只校验 yaml 解析通过 + 关键阶段接线正确，不再覆盖被删的 8 个断言。
 */
describe("careful-coder.yaml v1.1 (软化版)", () => {
  it("parses cleanly with hooks", async () => {
    const r = new WorkflowRegistry(path.resolve(__dirname, "../../../workflows"));
    const result = await r.listWithIssues();
    const ccIssues = result.issues.filter((i) => i.path.includes("careful-coder"));
    expect(ccIssues, JSON.stringify(ccIssues)).toEqual([]);
    const cc = result.workflows.find((w) => w.id === "careful-coder");
    expect(cc).toBeDefined();
    expect(cc?.version).toBe("1.1.0");

    const implement = cc!.stages.find((s) => s.id === "implement");
    // implement 阶段的 pre_tool_use 闸门保留（这层与 LLM 输出复杂度无关，确实有用）
    expect(implement?.hooks?.pre_tool_use?.[0].require.same_file_reads_min).toBe(3);
    expect(implement?.hooks?.pre_tool_use?.[1].require.ask_human_consent).toBe(true);
    expect(implement?.hooks?.post_output_assertions).toContain("no_trailing_unparsed_payload");

    const sr = cc!.stages.find((s) => s.id === "self_review");
    expect(sr?.allowed_tools).not.toContain("edit_file");
    expect(sr?.hooks?.post_output_assertions).toEqual([
      "review_self_consistency",
      "needs_rework_target_required",
      "hedged_findings_demoted",
      "no_trailing_unparsed_payload"
    ]);
  });

  it("investigate stage 软化：required_outputs 只保留 3 个简单字段 + 文本扫描断言", async () => {
    const r = new WorkflowRegistry(path.resolve(__dirname, "../../../workflows"));
    const result = await r.listWithIssues();
    const cc = result.workflows.find((w) => w.id === "careful-coder");
    const investigate = cc!.stages.find((s) => s.id === "investigate");
    expect(investigate?.required_outputs).toEqual([
      "similar_callsites",
      "git_history_summary",
      "unknowns"
    ]);
    const assertions = investigate?.hooks?.post_output_assertions ?? [];
    for (const name of ["unknowns_present", "hedged_findings_demoted", "no_trailing_unparsed_payload"]) {
      expect(assertions, `investigate 应挂 ${name}`).toContain(name);
    }
  });

  it("every stage carries the JSON-integrity assertion", async () => {
    const r = new WorkflowRegistry(path.resolve(__dirname, "../../../workflows"));
    const result = await r.listWithIssues();
    const cc = result.workflows.find((w) => w.id === "careful-coder");
    for (const stage of cc!.stages) {
      expect(
        stage.hooks?.post_output_assertions ?? [],
        `${stage.id} 应挂 no_trailing_unparsed_payload`
      ).toContain("no_trailing_unparsed_payload");
    }
  });
});

import { describe, expect, it } from "vitest";
import path from "node:path";
import { WorkflowRegistry } from "./workflowRegistry.js";

/**
 * v1.2 careful-coder yaml 接线快照——人类谨慎思维工程化（11 条例程 + 9 个新断言）。
 * 仍守软约束：不新增 required_outputs，断言只做扫标题/扫词存在性。
 */
describe("careful-coder.yaml v1.2 (人类谨慎思维工程化)", () => {
  it("parses cleanly with hooks", async () => {
    const r = new WorkflowRegistry(path.resolve(__dirname, "../../../workflows"));
    const result = await r.listWithIssues();
    const ccIssues = result.issues.filter((i) => i.path.includes("careful-coder"));
    expect(ccIssues, JSON.stringify(ccIssues)).toEqual([]);
    const cc = result.workflows.find((w) => w.id === "careful-coder");
    expect(cc).toBeDefined();
    expect(cc?.version).toBe("1.2.0");

    const implement = cc!.stages.find((s) => s.id === "implement");
    // implement 阶段的 pre_tool_use 闸门保留（这层与 LLM 输出复杂度无关，确实有用）
    expect(implement?.hooks?.pre_tool_use?.[0].require.same_file_reads_min).toBe(3);
    expect(implement?.hooks?.pre_tool_use?.[1].require.ask_human_consent).toBe(true);
    // v1.2：implement 新增 delta_check + rollback 两个断言
    const implementAssertions = implement?.hooks?.post_output_assertions ?? [];
    for (const name of ["implement_delta_check_present", "rollback_plan_when_irreversible", "needs_rework_target_required", "no_trailing_unparsed_payload"]) {
      expect(implementAssertions, `implement 应挂 ${name}`).toContain(name);
    }

    const sr = cc!.stages.find((s) => s.id === "self_review");
    expect(sr?.allowed_tools).not.toContain("edit_file");
    expect(sr?.hooks?.post_output_assertions).toEqual([
      "review_self_consistency",
      "needs_rework_target_required",
      "hedged_findings_demoted",
      "no_trailing_unparsed_payload"
    ]);
  });

  it("investigate stage v1.2：7 标题模板 + 3 个新断言", async () => {
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
    for (const name of [
      "investigate_structure_present",
      "callsites_inventory_present",
      "boundary_enumeration_present",
      "confidence_levels_present",
      "needs_rework_target_required",
      "hedged_findings_demoted",
      "unknowns_present",
      "no_trailing_unparsed_payload"
    ]) {
      expect(assertions, `investigate 应挂 ${name}`).toContain(name);
    }
  });

  it("design stage v1.2：必写核心 3 断言 + required_outputs 保持空", async () => {
    const r = new WorkflowRegistry(path.resolve(__dirname, "../../../workflows"));
    const result = await r.listWithIssues();
    const cc = result.workflows.find((w) => w.id === "careful-coder");
    const design = cc!.stages.find((s) => s.id === "design");
    expect(design?.required_outputs).toEqual([]);
    const assertions = design?.hooks?.post_output_assertions ?? [];
    for (const name of ["design_alternatives_present", "design_quadrant_eval_present", "preflight_risks_present", "needs_rework_target_required", "no_trailing_unparsed_payload"]) {
      expect(assertions, `design 应挂 ${name}`).toContain(name);
    }
  });

  it("non-first stages retry malformed needs_rework outputs instead of blocking immediately", async () => {
    const r = new WorkflowRegistry(path.resolve(__dirname, "../../../workflows"));
    const result = await r.listWithIssues();
    const cc = result.workflows.find((w) => w.id === "careful-coder");
    const [, ...nonFirstStages] = cc!.stages;
    for (const stage of nonFirstStages) {
      expect(
        stage.hooks?.post_output_assertions ?? [],
        `${stage.id} 应挂 needs_rework_target_required`
      ).toContain("needs_rework_target_required");
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

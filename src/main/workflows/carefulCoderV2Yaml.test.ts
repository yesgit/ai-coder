import { describe, expect, it } from "vitest";
import path from "node:path";
import { WorkflowRegistry } from "./workflowRegistry.js";

/**
 * careful-coder-v2 yaml 快照——减架构方向：
 * L3 扫标题断言全退场、L1 behavior 门控（git log/git diff 的 retry/block）降为 prompt 提示，
 * 只留结构性 + L2 自洽性 + 安全门（不可逆操作 ask_human / rollback）。
 * 与 v1.3 并存作对比基线，routing.auto_start=false（手动选）。
 */
describe("careful-coder-v2.yaml (减架构)", () => {
  const workflowsDir = path.resolve(__dirname, "../../../workflows");

  async function loadV2() {
    const r = new WorkflowRegistry(workflowsDir);
    const result = await r.listWithIssues();
    const issues = result.issues.filter((i) => i.path.includes("careful-coder-v2"));
    expect(issues, JSON.stringify(issues)).toEqual([]);
    const v2 = result.workflows.find((w) => w.id === "careful-coder-v2");
    expect(v2).toBeDefined();
    return v2!;
  }

  it("parses cleanly and does not auto-start", async () => {
    const v2 = await loadV2();
    expect(v2.version).toBe("2.0.0");
    expect(v2.routing?.auto_start).toBe(false);
  });

  it("rework 覆盖所有前置阶段（任意层回溯）", async () => {
    const v2 = await loadV2();
    expect(v2.rework?.enabled).toBe(true);
    expect(v2.rework?.allowed_targets).toEqual([
      "understand",
      "investigate",
      "align",
      "design",
      "implement"
    ]);
  });

  it("design 阶段只留结构性断言（L3 扫标题全退场）", async () => {
    const v2 = await loadV2();
    const design = v2.stages.find((s) => s.id === "design")!;
    expect(design.hooks?.post_output_assertions).toEqual([
      "needs_rework_target_required",
      "no_trailing_unparsed_payload"
    ]);
    for (const name of ["design_alternatives_present", "design_quadrant_eval_present", "preflight_risks_present"]) {
      expect(design.hooks?.post_output_assertions, `design 不应再挂 ${name}`).not.toContain(name);
    }
  });

  it("investigate 去 behavior git log 门控，保留 unknowns 诚实暴露", async () => {
    const v2 = await loadV2();
    const inv = v2.stages.find((s) => s.id === "investigate")!;
    // L1 门控降为 prompt——不再 post_output_checks
    expect(inv.hooks?.post_output_checks ?? []).toEqual([]);
    expect(inv.hooks?.post_output_assertions).toEqual([
      "needs_rework_target_required",
      "unknowns_present",
      "no_trailing_unparsed_payload"
    ]);
    // required_outputs 精简：去 git_history_summary（改为 prompt 提示跑 git log）
    expect(inv.required_outputs).toEqual(["similar_callsites", "unknowns"]);
  });

  it("implement 只留不可逆操作安全门(去掉读≥3次硬门控,避免刷次数)", async () => {
    const v2 = await loadV2();
    const impl = v2.stages.find((s) => s.id === "implement")!;
    // v2.1：去掉 same_file_reads_min + shell_must_have_run（Goodhart 源：模型为凑次数刷 Read），
    // 只留不可逆操作 ask_human consent（安全门，非谨慎门）。读几次改由 prompt 自检引导。
    const preToolUse = impl.hooks?.pre_tool_use ?? [];
    expect(preToolUse).toHaveLength(1);
    expect(preToolUse[0].require.ask_human_consent).toBe(true);
    expect(preToolUse[0].require.same_file_reads_min).toBeUndefined();
    expect(preToolUse[0].require.shell_must_have_run).toBeUndefined();
    const assertions = impl.hooks?.post_output_assertions ?? [];
    expect(assertions).toContain("rollback_plan_when_irreversible");
    expect(assertions).toContain("needs_rework_target_required");
    expect(assertions).toContain("no_trailing_unparsed_payload");
    expect(assertions).not.toContain("implement_delta_check_present");
  });

  it("self_review 保留自洽性断言，去 behavior git diff 门控", async () => {
    const v2 = await loadV2();
    const sr = v2.stages.find((s) => s.id === "self_review")!;
    expect(sr.allowed_tools).not.toContain("edit_file");
    // L1 门控降为 prompt
    expect(sr.hooks?.post_output_checks ?? []).toEqual([]);
    expect(sr.hooks?.post_output_assertions).toEqual([
      "review_self_consistency",
      "needs_rework_target_required",
      "hedged_findings_demoted",
      "no_trailing_unparsed_payload"
    ]);
  });

  it("understand / align 只留结构性断言", async () => {
    const v2 = await loadV2();
    expect(v2.stages.find((s) => s.id === "understand")!.hooks?.post_output_assertions).toEqual([
      "no_trailing_unparsed_payload"
    ]);
    expect(v2.stages.find((s) => s.id === "align")!.hooks?.post_output_assertions).toEqual([
      "needs_rework_target_required",
      "no_trailing_unparsed_payload"
    ]);
  });
});

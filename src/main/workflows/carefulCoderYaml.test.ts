import { describe, expect, it } from "vitest";
import path from "node:path";
import { WorkflowRegistry } from "./workflowRegistry.js";

describe("careful-coder.yaml validates", () => {
  it("parses cleanly with hooks", async () => {
    const r = new WorkflowRegistry(path.resolve(__dirname, "../../../workflows"));
    const result = await r.listWithIssues();
    const ccIssues = result.issues.filter(i => i.path.includes("careful-coder"));
    expect(ccIssues, JSON.stringify(ccIssues)).toEqual([]);
    const cc = result.workflows.find(w => w.id === "careful-coder");
    expect(cc).toBeDefined();
    const implement = cc!.stages.find(s => s.id === "implement");
    expect(implement?.hooks?.pre_tool_use?.[0].require.same_file_reads_min).toBe(3);
    expect(implement?.hooks?.pre_tool_use?.[1].require.ask_human_consent).toBe(true);
    expect(implement?.hooks?.post_output_assertions).toContain("no_trailing_unparsed_payload");

    const sr = cc!.stages.find(s => s.id === "self_review");
    expect(sr?.allowed_tools).not.toContain("edit_file");
    expect(sr?.hooks?.post_output_assertions).toEqual([
      "review_self_consistency",
      "needs_rework_target_required",
      "pass_requires_all_validated",
      "no_trailing_unparsed_payload"
    ]);
  });

  it("design stage wires the plan_steps blood-line assertions", async () => {
    const r = new WorkflowRegistry(path.resolve(__dirname, "../../../workflows"));
    const result = await r.listWithIssues();
    const cc = result.workflows.find(w => w.id === "careful-coder");
    const design = cc!.stages.find(s => s.id === "design");
    expect(design?.required_outputs).toEqual(
      expect.arrayContaining([
        "plan_steps",
        "success_criteria",
        "adversarial_critique",
        "consistency_audit",
        "risks_carried_into_implement"
      ])
    );
    expect(design?.hooks?.post_output_assertions).toContain("plan_steps_grounded");
  });

  it("implement stage wires the deviation assertions and goal_alignment_check", async () => {
    const r = new WorkflowRegistry(path.resolve(__dirname, "../../../workflows"));
    const result = await r.listWithIssues();
    const cc = result.workflows.find(w => w.id === "careful-coder");
    const impl = cc!.stages.find(s => s.id === "implement");
    expect(impl?.required_outputs).toEqual(
      expect.arrayContaining(["files_changed", "deviations_from_plan", "plan_revisions", "goal_alignment_check"])
    );
    const assertions = impl?.hooks?.post_output_assertions ?? [];
    for (const name of ["deviations_must_be_revised", "deviation_severity_must_rework", "no_trailing_unparsed_payload"]) {
      expect(assertions, `implement 应挂 ${name}`).toContain(name);
    }
    // pre_tool_use 规则保持不动
    expect(impl?.hooks?.pre_tool_use?.[0].require.same_file_reads_min).toBe(3);
  });

  it("self_review stage requires the three-phase validation outputs", async () => {
    const r = new WorkflowRegistry(path.resolve(__dirname, "../../../workflows"));
    const result = await r.listWithIssues();
    const cc = result.workflows.find(w => w.id === "careful-coder");
    const sr = cc!.stages.find(s => s.id === "self_review");
    expect(sr?.required_outputs).toEqual(
      expect.arrayContaining([
        "phase_1_self_check",
        "phase_2_tests",
        "phase_3_adversarial_review",
        "review_findings",
        "rework_decision",
        "residual_risks"
      ])
    );
  });

  it("investigate stage wires the Plan loop assertions", async () => {
    const r = new WorkflowRegistry(path.resolve(__dirname, "../../../workflows"));
    const result = await r.listWithIssues();
    const cc = result.workflows.find(w => w.id === "careful-coder");
    const investigate = cc!.stages.find(s => s.id === "investigate");
    expect(investigate, "investigate 阶段必须存在").toBeDefined();
    // required_outputs 必须覆盖 Plan loop 的五个键
    expect(investigate?.required_outputs).toEqual(
      expect.arrayContaining(["investigation_tasks", "hypotheses", "findings", "unknowns", "plan_readiness"])
    );
    // 五个 Plan loop 断言 + 既有 unknowns_present + 通用 no_trailing_unparsed_payload
    const assertions = investigate?.hooks?.post_output_assertions ?? [];
    for (const name of [
      "all_tasks_resolved",
      "findings_traceable_to_probes",
      "hedged_findings_demoted",
      "plan_readiness_honest",
      "unknowns_present",
      "no_trailing_unparsed_payload"
    ]) {
      expect(assertions, `investigate 应挂 ${name}`).toContain(name);
    }
  });

  it("every stage carries the JSON-integrity assertion", async () => {
    const r = new WorkflowRegistry(path.resolve(__dirname, "../../../workflows"));
    const result = await r.listWithIssues();
    const cc = result.workflows.find(w => w.id === "careful-coder");
    for (const stage of cc!.stages) {
      expect(
        stage.hooks?.post_output_assertions ?? [],
        `${stage.id} 应挂 no_trailing_unparsed_payload`
      ).toContain("no_trailing_unparsed_payload");
    }
  });
});

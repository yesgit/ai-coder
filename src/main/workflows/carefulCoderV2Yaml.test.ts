import { describe, expect, it } from "vitest";
import path from "node:path";
import { WorkflowRegistry } from "./workflowRegistry.js";

/**
 * 谨慎程序员 yaml v4.0 快照验证。
 *
 * v4.0 根本架构变更（v3.0 执行日志驱动）：
 * - 砍掉 investigate/align/design/self_review 四个阶段
 * - 新增 decompose（原子级任务拆分，每个 task 含 pre_behavior 行为快照）
 * - implement 改为 task-loop 协调者（每 task fresh sub-agent + 机械核对）
 * - 不再靠"让 LLM 更谨慎"，靠"让任务小到不可能错"
 * - 引擎层 Bash 安全拦截（> 重定向在只读阶段硬拒绝、sed -i 全局硬拒绝）
 */
describe("careful-coder.yaml latest", () => {
  const workflowsDir = path.resolve(__dirname, "../../../workflows");

  async function loadV4() {
    const r = new WorkflowRegistry(workflowsDir);
    const result = await r.listWithIssues();
    const issues = result.issues.filter((i) => i.path.includes("careful-coder"));
    expect(issues, JSON.stringify(issues)).toEqual([]);
    const v4 = result.workflows.find((w) => w.id === "careful-coder");
    expect(v4).toBeDefined();
    return v4!;
  }

  it("parses cleanly and auto-starts as the only cautious workflow", async () => {
    const registry = new WorkflowRegistry(workflowsDir);
    const listed = await registry.list();
    expect(listed.map((workflow) => workflow.id)).toEqual(["careful-coder"]);

    const v4 = await loadV4();
    expect(v4.version).toBe("4.0.0");
    expect(v4.name).toBe("谨慎程序员");
    expect(v4.routing?.auto_start).toBe(true);
  });

  it("description includes the cautious programmer persona and human-engineering traits", async () => {
    const v4 = await loadV4();
    expect(v4.description).toContain("基本人设");
    expect(v4.description).toContain("事实优先");
    expect(v4.description).toContain("尊重既有系统");
    expect(v4.description).toContain("小步闭环");
    expect(v4.description).toContain("风险敏感");
    expect(v4.description).toContain("可回溯");
    expect(v4.description).toContain("不确定性诚实");
    expect(v4.description).toContain("克制交付");
  });

  it("pipeline: profile maintenance → plan → implement → verify", async () => {
    const v4 = await loadV4();
    expect(v4.stages.map((s) => s.id)).toEqual([
      "maintain_project_profile",
      "plan",
      "implement",
      "verify"
    ]);
  });

  it("rework covers all stages", async () => {
    const v4 = await loadV4();
    expect(v4.rework?.enabled).toBe(true);
    expect(v4.rework?.allowed_targets).toEqual([
      "maintain_project_profile",
      "plan",
      "implement",
      "verify"
    ]);
  });

  it("plan 产出 task_items——含 pre_behavior 行为快照", async () => {
    const v4 = await loadV4();
    const plan = v4.stages.find((s) => s.id === "plan")!;
    expect(plan.required_outputs).toContain("task_items");
    const schema = plan.output_schema ?? {};
    expect(schema).toHaveProperty("task_items");
    // pre_behavior 子字段存在（验证行为快照结构）
    const props = (schema.task_items as any)?.items?.properties;
    expect(props).toHaveProperty("pre_behavior");
    expect(props).toHaveProperty("acceptance_criteria");
  });

  it("implement 是 task-loop 协调者，含 task-implementer 和 task-verifier sub-agents", async () => {
    const v4 = await loadV4();
    const impl = v4.stages.find((s) => s.id === "implement")!;
    expect(impl.required_outputs).toContain("task_results");
    expect(impl.required_outputs).toContain("summary");
    expect(impl.agents).toBeDefined();
    expect(impl.agents).toHaveProperty("task-implementer");
    expect(impl.agents).toHaveProperty("task-verifier");
    // task-verifier 是只读的
    expect(impl.agents!["task-verifier"].tools).not.toContain("edit_file");
  });

  it("implement 不可逆操作安全门保留", async () => {
    const v4 = await loadV4();
    const impl = v4.stages.find((s) => s.id === "implement")!;
    const preToolUse = impl.hooks?.pre_tool_use ?? [];
    expect(preToolUse).toHaveLength(1);
    expect(preToolUse[0].require.ask_human_consent).toBe(true);
    const assertions = impl.hooks?.post_output_assertions ?? [];
    expect(assertions).toContain("rollback_plan_when_irreversible");
  });

  it("prompt mechanics: 入境验收 / 施工图 / 单任务工作台 / diff 证据 / 红灯停 已落实", async () => {
    const v4 = await loadV4();
    const plan = v4.stages.find((s) => s.id === "plan")!;
    const impl = v4.stages.find((s) => s.id === "implement")!;
    const verify = v4.stages.find((s) => s.id === "verify")!;

    expect(plan.instructions).toContain("基线与红灯停");
    expect(plan.instructions).toContain("不要把当前工作区已有代码当作完成证据");
    expect(plan.instructions).toContain("施工图制度");
    expect(plan.instructions).toContain("task_items 是 implement 的施工图，但原始需求和人类回答始终是最高验收来源");
    expect(plan.instructions).toContain("没有 task_id 的工作后续不得执行");

    expect(impl.instructions).toContain("入境验收（必须先做）");
    expect(impl.instructions).toContain("单任务工作台");
    expect(impl.instructions).toContain("差异约束与红灯停");
    expect(impl.instructions).toContain("git diff 是唯一施工证据");

    expect(verify.instructions).toContain("反向核对最终需求");
    expect(verify.instructions).toContain("结论必须有证据");
    expect(verify.instructions).toContain("不接受 output_summary 中的自然语言任务清单替代 task_items");
  });

  it("每个 required_outputs 都有同名 output_schema", async () => {
    const v4 = await loadV4();
    for (const stage of v4.stages) {
      const schema = stage.output_schema ?? {};
      for (const field of stage.required_outputs ?? []) {
        expect(schema, `${stage.id}.${field} 缺少 output_schema`).toHaveProperty(field);
      }
    }
  });

  it("已删除的旧阶段不存在（v3.0→v4.0 重构证明 + understand/decompose 合并为 plan）", async () => {
    const v4 = await loadV4();
    const removedIds = ["investigate", "align", "design", "self_review", "understand", "decompose"];
    for (const id of removedIds) {
      expect(
        v4.stages.find((s) => s.id === id),
        `${id} 应在 v4.0 中已删除`
      ).toBeUndefined();
    }
  });

  it("plan 阶段具有需求理解与拆分的技能和输出字段", async () => {
    const v4 = await loadV4();
    const plan = v4.stages.find((s) => s.id === "plan")!;
    expect(plan.required_skills).toEqual(["clarifying-requirements", "exploring-codebase", "planning-complex-changes"]);
    expect(plan.required_outputs).toEqual(expect.arrayContaining(["task_items", "baseline_context", "scope_matrix"]));
    // plan 阶段不再使用正则断言——工具边界（allowed_tools 无 Edit）已防住实施行为
    expect(plan.hooks?.post_output_assertions).toBeUndefined();
    expect(v4.stages.find((s) => s.id === "implement")!.required_skills).toEqual(["preserving-existing-behavior", "safe-git-operations"]);
    expect(v4.stages.find((s) => s.id === "verify")!.required_skills).toEqual(["verification-before-completion"]);
  });

  it("verify 阶段全局核对 task_items 实施结果", async () => {
    const v4 = await loadV4();
    const verify = v4.stages.find((s) => s.id === "verify")!;
    expect(verify).toBeDefined();
    expect(verify.allowed_tools).not.toContain("edit_file");
    expect(verify.required_outputs).toContain("verification_results");
    expect(verify.required_outputs).toContain("summary");
    const schema = verify.output_schema ?? {};
    expect(schema).toHaveProperty("verification_results");
    expect(schema).toHaveProperty("summary");
  });

  it("uses exactly one project profile stage", async () => {
    const v4 = await loadV4();
    expect(v4.stages.slice(0, 2).map((s) => s.id)).toEqual(["maintain_project_profile", "plan"]);
    expect(v4.stages.filter((s) => s.id.includes("project_profile"))).toHaveLength(1);
  });

  it("project profile maintenance short-circuits and excludes task semantics", async () => {
    const v4 = await loadV4();
    const profile = v4.stages.find((s) => s.id === "maintain_project_profile")!;

    expect(profile.name).toBe("维护项目画像");
    expect(profile.instructions).toContain("判断 → 必要取证 → 必要更新");
    expect(profile.instructions).toContain("`none`：没有长期事实变化迹象，立即结束");
    expect(profile.instructions).toContain("不得猜测、复述或评价");
    expect(profile.instructions).toContain("不判断本次任务是否可行");
    expect(profile.agents).toBeUndefined();
    expect(profile.hooks?.post_output_assertions).toContain("profile_maintenance_scope_only");
  });
});

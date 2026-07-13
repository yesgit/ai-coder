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

  it("pipeline: scan → profile → understand → decompose → implement（5 阶段）", async () => {
    const v4 = await loadV4();
    expect(v4.stages.map((s) => s.id)).toEqual([
      "scan_project",
      "update_project_profile",
      "understand",
      "decompose",
      "implement"
    ]);
  });

  it("rework covers all stages", async () => {
    const v4 = await loadV4();
    expect(v4.rework?.enabled).toBe(true);
    expect(v4.rework?.allowed_targets).toEqual([
      "scan_project",
      "update_project_profile",
      "understand",
      "decompose",
      "implement"
    ]);
  });

  it("decompose 产出 task_items——含 pre_behavior 行为快照", async () => {
    const v4 = await loadV4();
    const decompose = v4.stages.find((s) => s.id === "decompose")!;
    expect(decompose.required_outputs).toEqual(["task_items"]);
    const schema = decompose.output_schema ?? {};
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
    expect(assertions).toContain("no_trailing_unparsed_payload");
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

  it("已删除的旧阶段不存在（v3.0→v4.0 重构证明）", async () => {
    const v4 = await loadV4();
    const removedIds = ["investigate", "align", "design", "self_review"];
    for (const id of removedIds) {
      expect(
        v4.stages.find((s) => s.id === id),
        `${id} 应在 v4.0 中已删除`
      ).toBeUndefined();
    }
  });

  it("understand 只留结构性断言（no_trailing_unparsed_payload）", async () => {
    const v4 = await loadV4();
    expect(v4.stages.find((s) => s.id === "understand")!.hooks?.post_output_assertions).toEqual([
      "no_trailing_unparsed_payload"
    ]);
  });

  it("project profile stages preserved", async () => {
    const v4 = await loadV4();
    expect(v4.stages.slice(0, 2).map((s) => s.id)).toEqual(["scan_project", "update_project_profile"]);
    expect(v4.stages[2].id).toBe("understand");
  });
});

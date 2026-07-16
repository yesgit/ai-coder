import { describe, expect, it } from "vitest";
import path from "node:path";
import { WorkflowRegistry } from "./workflowRegistry.js";

/**
 * 谨慎程序员 yaml v5.0 快照验证。
 *
 * v5.0 根本架构变更（v4.0 阶段引擎 → Profile 模式）：
 * - 砍掉所有阶段管线（maintain_project_profile / plan / implement / verify）
 * - 改为 system_prompt（人设注入）+ skills（技能摘要）+ agents（sub-agent 注册）
 * - 外层循环完全交给 SDK 原生推理线程
 * - 心智落地靠：Prompt（塑造思维）+ Sub-agent（独立核对）+ Engine（硬约束）
 */
describe("careful-coder.yaml latest", () => {
  const workflowsDir = path.resolve(__dirname, "../../../workflows");

  async function loadV5() {
    const r = new WorkflowRegistry(workflowsDir);
    const result = await r.listWithIssues();
    const issues = result.issues.filter((i) => i.path.includes("careful-coder"));
    expect(issues, JSON.stringify(issues)).toEqual([]);
    const v5 = result.workflows.find((w) => w.id === "careful-coder");
    expect(v5).toBeDefined();
    return v5!;
  }

  it("parses cleanly and auto-starts as the only cautious workflow", async () => {
    const registry = new WorkflowRegistry(workflowsDir);
    const listed = await registry.list();
    expect(listed.map((workflow) => workflow.id)).toEqual(["careful-coder"]);

    const v5 = await loadV5();
    expect(v5.version).toBe("5.0.0");
    expect(v5.name).toBe("谨慎程序员");
    expect(v5.routing?.auto_start).toBe(true);
  });

  it("description includes the cautious programmer persona and human-engineering traits", async () => {
    const v5 = await loadV5();
    expect(v5.description).toContain("事实优先");
    expect(v5.description).toContain("尊重既有系统");
    expect(v5.description).toContain("小步闭环");
    expect(v5.description).toContain("风险敏感");
    expect(v5.description).toContain("不确定性诚实");
  });

  it("v5.0 has no stages — profile mode with system_prompt + skills + agents", async () => {
    const v5 = await loadV5();
    expect(v5.stages).toEqual([]);
    expect(v5.system_prompt).toBeDefined();
    expect(v5.system_prompt).toContain("谨慎程序员");
    expect(v5.system_prompt).toContain("先读代码取证");
    expect(v5.system_prompt).toContain("最小改动");
    expect(v5.system_prompt).toContain("pre_behavior");
    expect(v5.system_prompt).toContain("git diff 逐行核对");
    expect(v5.system_prompt).toContain("验证命令");
    expect(v5.system_prompt).toContain("unknown");
    expect(v5.system_prompt).toContain("重新阅读用户原始请求");
  });

  it("has all 8 skills configured", async () => {
    const v5 = await loadV5();
    expect(v5.skills).toEqual([
      "clarifying-requirements",
      "exploring-codebase",
      "planning-complex-changes",
      "preserving-existing-behavior",
      "safe-git-operations",
      "task-decomposition",
      "verification-before-completion",
      "systematic-debugging"
    ]);
  });

  it("registers 3 top-level sub-agents for independent verification", async () => {
    const v5 = await loadV5();
    expect(v5.agents).toBeDefined();
    expect(Object.keys(v5.agents!)).toHaveLength(3);
    expect(v5.agents).toHaveProperty("task-verifier");
    expect(v5.agents).toHaveProperty("pre-behavior-snapshot");
    expect(v5.agents).toHaveProperty("completeness-checker");

    // task-verifier is read-only
    expect(v5.agents!["task-verifier"].tools).not.toContain("edit_file");
    // pre-behavior-snapshot is read-only
    expect(v5.agents!["pre-behavior-snapshot"].tools).not.toContain("edit_file");
    // completeness-checker is read-only
    expect(v5.agents!["completeness-checker"].tools).not.toContain("edit_file");
  });

  it("shell approval is required (engine-level safety unchanged)", async () => {
    const v5 = await loadV5();
    expect(v5.permissions.shell?.approval_required).toBe(true);
    expect(v5.permissions.filesystem?.mode).toBe("project-only");
    expect(v5.permissions.network?.enabled).toBe(false);
  });
});

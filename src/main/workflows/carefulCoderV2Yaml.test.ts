import { describe, expect, it } from "vitest";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { WorkflowRegistry } from "./workflowRegistry.js";

/**
 * 谨慎程序员 yaml v6.0 快照验证。
 *
 * v6.0 根本架构变更（自由 Profile 循环 → 宿主分层循环）：
 * - Goal / Requirement / Phase / Action 分层持久化
 * - 宿主直接启动当前叶子角色，不再让根 Agent 自行反复 Task 委托
 * - 知识雪球是带作用域、证据和替代关系的认知状态，不再充当任务 ID
 * - 心智落地靠：宿主状态机 + 阶段角色 + 强制 Skill 契约 + 完成闸门
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
    expect(v5.version).toBe("6.0.0");
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

  it("uses the host-owned hierarchical loop while retaining the cautious persona", async () => {
    const v5 = await loadV5();
    expect(v5.stages).toEqual([]);
    expect(v5.execution_mode).toBe("hierarchical");
    expect(v5.simple_profile_loop).toBe(false);
    expect(v5.system_prompt).toBeDefined();
    expect(v5.system_prompt).toContain("谨慎程序员");
    expect(v5.system_prompt).toContain("已经确认了什么");
    expect(v5.system_prompt).toContain("第一优先级是找到仓库中最相似功能的实现");
    expect(v5.system_prompt).toContain("边界前最近的已完成项");
    expect(v5.system_prompt).toContain("最相似既有实现（位置、可复用模式、与本需求的差异）");
    expect(v5.system_prompt).toContain("Skill 或工具");
    expect(v5.system_prompt).toContain("核心 Skills 由宿主按知识雪球的当前阶段选择");
    expect(v5.system_prompt).toContain("checkpoint_exploration");
    expect(v5.system_prompt).toContain("单节点阶段任务树");
    expect(v5.system_prompt).toContain("phase 只是");
    expect(v5.system_prompt).toContain("输入资源路径及派生关系");
    expect(v5.system_prompt).toContain("尊重既有系统");
    expect(v5.system_prompt).toContain("最小实现并验证");
    expect(v5.system_prompt).not.toContain("EXECUTE_ONE");
  });

  it("loads the core careful-coder skills as execution contracts", async () => {
    const v5 = await loadV5();
    expect(v5.skills).toEqual([
      "clarifying-requirements",
      "exploring-codebase",
      "planning-complex-changes",
      "preserving-existing-behavior",
      "safe-git-operations",
      "task-decomposition",
      "verification-before-completion",
      "systematic-debugging",
      "cautious-calling",
      "investigating-call-contracts"
    ]);
  });

  it("teaches the relevant skills to split and close independent requirements sequentially", async () => {
    const skillRoot = path.resolve(__dirname, "../../../plugins/careful-coder/skills");
    const [decomposition, planning, verification] = await Promise.all([
      readFile(path.join(skillRoot, "task-decomposition/SKILL.md"), "utf8"),
      readFile(path.join(skillRoot, "planning-complex-changes/SKILL.md"), "utf8"),
      readFile(path.join(skillRoot, "verification-before-completion/SKILL.md"), "utf8")
    ]);
    expect(decomposition).toContain("一次只把一个 dependency-ready 节点");
    expect(decomposition).toContain("实现 → 验证 → 证据归并 → completed");
    expect(planning).toContain("Execute the steps sequentially");
    expect(verification).toContain("separate implementation result, verification oracle, and evidence row");
  });

  it("registers the planner/executor/verifier/auditor roles and contract investigator", async () => {
    const v5 = await loadV5();
    expect(v5.agents).toBeDefined();
    expect(Object.keys(v5.agents!)).toHaveLength(6);
    expect(v5.agents).toHaveProperty("task-planner");
    expect(v5.agents).toHaveProperty("task-verifier");
    expect(v5.agents).toHaveProperty("pre-behavior-snapshot");
    expect(v5.agents).toHaveProperty("completeness-checker");
    expect(v5.agents).toHaveProperty("call-contract-investigator");
    expect(v5.agents).toHaveProperty("task-executor");

    // verification agents are read-only
    expect(v5.agents!["task-verifier"].tools).not.toContain("edit_file");
    expect(v5.agents!["task-planner"].tools).not.toContain("Edit");
    expect(v5.agents!["pre-behavior-snapshot"].tools).not.toContain("edit_file");
    expect(v5.agents!["completeness-checker"].tools).not.toContain("edit_file");
    expect(v5.agents!["call-contract-investigator"].tools).not.toContain("Edit");
    expect(v5.agents!["call-contract-investigator"].tools).toContain("mcp__ai_coder__analyze_symbol_contract");
    // task-executor can write
    expect(v5.agents!["task-executor"].tools).toContain("Edit");
  });

  it("requires independent requirement points to be implemented and verified one by one", async () => {
    const v5 = await loadV5();
    expect(v5.system_prompt).toContain("独立需求逐项闭环");
    expect(v5.system_prompt).toContain("一次只推进一个");
    expect(v5.system_prompt).toContain("next_action` 只能指向其中一个需求点");
    expect(v5.system_prompt).toContain("完成即核对");
    expect(v5.system_prompt).toContain("用户原始目标与输入 → 当前知识雪球 → 当前阶段任务 → 当前执行观察");
    expect(v5.agents!["task-planner"].prompt).toContain("独立 task");
    expect(v5.agents!["task-executor"].prompt).toContain("一个 R-ID / 一个独立需求点");
    expect(v5.agents!["task-executor"].prompt).toContain("返回 completed 前执行完成核对");
    expect(v5.agents!["task-verifier"].prompt).toContain("一次只验证一个独立需求点");
    expect(v5.agents!["task-verifier"].prompt).toContain("原目标、实际结果、验证证据和新未知");
    expect(v5.agents!["completeness-checker"].prompt).toContain("独立实现、独立验证和知识归并");
  });

  it("teaches sub-agents to resolve domestic mixed naming without speculative renames", async () => {
    const v5 = await loadV5();
    expect(v5.agents!["task-planner"].prompt).toContain("业务术语 → 别名 → path:line");
    expect(v5.agents!["pre-behavior-snapshot"].prompt).toContain("缩写多义时保留 unknown");
    expect(v5.agents!["call-contract-investigator"].prompt).toContain("历史错拼别名");
    expect(v5.system_prompt).toContain("调用契约硬规则");
    expect(v5.system_prompt).toContain("第一次相关修改前");
    expect(v5.agents!["call-contract-investigator"].description).toContain("必须用于任何会调用");
    expect(v5.agents!["task-executor"].prompt).toContain("没有就返回 blocked");
    expect(v5.agents!["completeness-checker"].prompt).toContain("缺少时对应需求标记 NO");
    expect(v5.agents!["completeness-checker"].prompt).toContain("只搜中文原词不构成完整证据");
    expect(v5.agents!["task-executor"].prompt).toContain("不得为了统一风格而重命名");
    expect(v5.agents!["task-verifier"].prompt).toContain("擅自统一既有拼音");
  });

  it("shell approval is required (engine-level safety unchanged)", async () => {
    const v5 = await loadV5();
    expect(v5.permissions.shell?.approval_required).toBe(true);
    expect(v5.permissions.filesystem?.mode).toBe("project-only");
    expect(v5.permissions.network?.enabled).toBe(false);
  });
});

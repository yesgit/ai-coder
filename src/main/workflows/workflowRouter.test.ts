import { describe, expect, it } from "vitest";
import type { WorkflowTemplate } from "../../shared/types.js";
import { WorkflowRouter } from "./workflowRouter.js";

function workflow(id: string, keywords: string[] = [], autoStart = true, enabled = true): WorkflowTemplate {
  return {
    id,
    name: id,
    version: "1.0.0",
    description: `${id} workflow`,
    source: { type: "builtin", id },
    permissions: {},
    rework: { enabled: false, allowed_targets: [], approval_required: true, invalidate_downstream: true },
    routing: { enabled, auto_start: autoStart, keywords, examples: [] },
    stages: [{ id: "run", name: "Run" }]
  };
}

describe("WorkflowRouter", () => {
  it("directly selects a unique keyword match", async () => {
    const router = new WorkflowRouter(async () => { throw new Error("model should not run"); });
    const result = await router.resolve("请审查代码", [workflow("review", ["审查代码"]), workflow("build")], "/tmp");
    expect(result).toMatchObject({ status: "selected", method: "rule", recommended_workflow_id: "review" });
  });

  it("does not directly match keywords embedded in a broader request", async () => {
    const router = new WorkflowRouter(async () => ({
      candidates: [{ workflow_id: "build", score: 0.9 }, { workflow_id: "chat", score: 0.4 }],
      reason: "主要意图是修改代码"
    }));
    const result = await router.resolve("你好，请处理登录崩溃", [workflow("chat", ["你好"]), workflow("build")], "/tmp");
    expect(result).toMatchObject({ method: "model", recommended_workflow_id: "build" });
  });

  it("requires confirmation before auto-starting a project workflow", async () => {
    const projectWorkflow = workflow("project-task", ["执行项目任务"]);
    projectWorkflow.source.type = "project";
    const result = await new WorkflowRouter().resolve("执行项目任务", [projectWorkflow], "/tmp");
    expect(result.status).toBe("needs_confirmation");
  });

  it("asks for confirmation when a rule match cannot auto start", async () => {
    const result = await new WorkflowRouter().resolve("部署生产", [workflow("deploy", ["部署生产"], false)], "/tmp");
    expect(result.status).toBe("needs_confirmation");
  });

  it("uses a decisive model ranking", async () => {
    const router = new WorkflowRouter(async () => ({
      candidates: [{ workflow_id: "build", score: 0.92 }, { workflow_id: "review", score: 0.5 }],
      reason: "需要修改代码"
    }));
    const result = await router.resolve("处理这个问题", [workflow("review"), workflow("build")], "/tmp");
    expect(result).toMatchObject({ status: "selected", method: "model", recommended_workflow_id: "build" });
  });

  it("asks for confirmation when model candidates are close", async () => {
    const router = new WorkflowRouter(async () => ({
      candidates: [{ workflow_id: "build", score: 0.9 }, { workflow_id: "review", score: 0.75 }],
      reason: "意图有重叠"
    }));
    const result = await router.resolve("检查并修复", [workflow("review"), workflow("build")], "/tmp");
    expect(result.status).toBe("needs_confirmation");
  });

  it("requires a runner-up when several workflows are available", async () => {
    const router = new WorkflowRouter(async () => ({
      candidates: [{ workflow_id: "build", score: 0.95 }],
      reason: "只返回了一个候选"
    }));
    const result = await router.resolve("处理问题", [workflow("review"), workflow("build")], "/tmp");
    expect(result.status).toBe("needs_confirmation");
  });

  it("falls back to confirmation when model output is invalid", async () => {
    const router = new WorkflowRouter(async () => "not json");
    const result = await router.resolve("未知任务", [workflow("careful-coder")], "/tmp");
    expect(result).toMatchObject({ status: "needs_confirmation", recommended_workflow_id: "careful-coder" });
  });

  it("reports when no workflows opt into routing", async () => {
    const result = await new WorkflowRouter().resolve("任务", [workflow("manual", [], true, false)], "/tmp");
    expect(result.status).toBe("no_candidates");
  });
});

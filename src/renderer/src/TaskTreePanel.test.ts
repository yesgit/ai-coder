import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TaskTree } from "../../shared/types.js";
import TaskTreePanel from "./TaskTreePanel.js";

describe("TaskTreePanel", () => {
  it("keeps the task-tree view visible before the agent initializes data", () => {
    const html = renderToStaticMarkup(createElement(TaskTreePanel));

    expect(html).toContain("任务树");
    expect(html).toContain("等待 Agent 初始化任务树");
    expect(html).toContain("0 项");
  });

  it("renders task progress after the tree is initialized", () => {
    const tree: TaskTree = {
      goal_restated: "修复任务树视图",
      strategy: "定位、修复、验证",
      current_focus: "t2",
      focus_reason: "正在实现",
      created_at: "2026-07-17T00:00:00.000Z",
      updated_at: "2026-07-17T00:01:00.000Z",
      tasks: [
        {
          id: "t1",
          description: "定位原因",
          dependencies: [],
          status: "completed",
          evidence: "App.tsx"
        },
        {
          id: "t2",
          description: "修复视图",
          dependencies: ["t1"],
          status: "in_progress"
        }
      ]
    };

    const html = renderToStaticMarkup(createElement(TaskTreePanel, { taskTree: tree }));

    expect(html).toContain("1/2");
    expect(html).toContain("修复任务树视图");
    expect(html).toContain("修复视图");
    expect(html).toContain("当前聚焦");
  });
});

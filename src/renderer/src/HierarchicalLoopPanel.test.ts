import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createHierarchicalExecutionState, applyHierarchicalEvent } from "../../main/workflows/hierarchicalWorkflowEngine.js";
import HierarchicalLoopPanel from "./HierarchicalLoopPanel.js";

describe("HierarchicalLoopPanel", () => {
  it("shows the attachment ingestion inner loop before stable requirements exist", () => {
    let state = createHierarchicalExecutionState("读取 21 页附件");
    state = applyHierarchicalEvent(state, {
      type: "alignment_sources_registered",
      batches: [
        { id: "A1", source_refs: ["page-01.png", "page-02.png", "page-03.png"] },
        { id: "A2", source_refs: ["page-04.png"] }
      ]
    });
    state = applyHierarchicalEvent(state, { type: "alignment_batch_started", batch_id: "A1" });

    const html = renderToStaticMarkup(createElement(HierarchicalLoopPanel, { state }));

    expect(html).toContain("附件摄取内循环");
    expect(html).toContain("A1 · 3 个来源 · 第 1 次");
    expect(html).toContain("附件批次 0/2");
  });

  it("renders the nested loop breadcrumb and stable requirement ledger", () => {
    let state = createHierarchicalExecutionState("实现所有页面跳转");
    state = applyHierarchicalEvent(state, {
      type: "plan_accepted",
      requirements: [{
        id: "R33",
        source_anchor: "attachment:page-33",
        observable_result: "第 33 页跳转可用",
        acceptance: ["点击后进入目标页"],
        dependencies: []
      }]
    });
    state = applyHierarchicalEvent(state, { type: "requirement_activated", requirement_id: "R33" });

    const html = renderToStaticMarkup(createElement(HierarchicalLoopPanel, { state }));

    expect(html).toContain("外循环");
    expect(html).toContain("需求循环");
    expect(html).toContain("阶段循环");
    expect(html).toContain("动作循环");
    expect(html).toContain("R33");
    expect(html).toContain("code-investigator");
  });
});

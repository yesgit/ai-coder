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

    const html = renderToStaticMarkup(createElement(HierarchicalLoopPanel, {
      state,
      defaultView: "loop"
    }));

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

    const html = renderToStaticMarkup(createElement(HierarchicalLoopPanel, {
      state,
      defaultView: "loop"
    }));

    expect(html).toContain("外循环");
    expect(html).toContain("需求循环");
    expect(html).toContain("阶段循环");
    expect(html).toContain("动作循环");
    expect(html).toContain("R33");
    expect(html).toContain("code-investigator");
  });

  it("defaults to a graph projection with dynamic capability leaves and dependencies", () => {
    let state = createHierarchicalExecutionState("调查并复用真实调用契约");
    state = applyHierarchicalEvent(state, {
      type: "plan_accepted",
      requirements: [{
        id: "R1",
        source_anchor: "user:R1",
        observable_result: "入口行为保持一致",
        acceptance: ["参数与 guard 保持一致"],
        dependencies: []
      }]
    });
    state = applyHierarchicalEvent(state, { type: "requirement_activated", requirement_id: "R1" });
    const symbolNodeId = "cap:R1:symbol-contract:target";
    state.capability_nodes.push({
      id: symbolNodeId,
      capability: "symbol-contract-analysis",
      requirement_id: "R1",
      parent_phase: "prepare",
      dependencies: [],
      status: "passed",
      attempt: 1,
      input: { target_file: "src/target.ts", symbol: "target" },
      output: { status: "complete" },
      evidence_refs: ["src/target.ts:1"],
      consecutive_failure_count: 0,
      created_at: state.created_at,
      updated_at: state.updated_at
    });
    state.capability_nodes.push({
      id: "cap:R1:callsite-review:entry",
      capability: "callsite-semantic-review",
      requirement_id: "R1",
      parent_phase: "prepare",
      dependencies: [symbolNodeId],
      status: "passed",
      attempt: 1,
      input: {
        target_file: "src/target.ts",
        symbol: "target",
        callsite_id: "ref:entry",
        peer_symbol: "entry->target",
        evidence_ref: "src/entry.ts:8"
      },
      output: { disposition: "relevant" },
      evidence_refs: ["src/entry.ts:8"],
      consecutive_failure_count: 0,
      created_at: state.created_at,
      updated_at: state.updated_at
    });

    const html = renderToStaticMarkup(createElement(HierarchicalLoopPanel, { state }));

    expect(html).toContain("执行工作图");
    expect(html).toContain("状态投影");
    expect(html).toContain("符号契约 · target");
    expect(html).toContain("调用点语义 · entry-&gt;target");
    expect(html).toContain("symbol-contract-analysis");
    expect(html).toContain("src/entry.ts:8");
    expect(html).toContain("可运行");
    expect(html).not.toContain("此会话未保存动态 capability 节点");
  });

  it("marks historical projections that do not contain capability nodes", () => {
    let state = createHierarchicalExecutionState("恢复旧会话");
    state = applyHierarchicalEvent(state, {
      type: "plan_accepted",
      requirements: [{
        id: "R1",
        source_anchor: "legacy:R1",
        observable_result: "旧需求",
        acceptance: ["旧验收"],
        dependencies: []
      }]
    });

    const html = renderToStaticMarkup(createElement(HierarchicalLoopPanel, { state }));

    expect(html).toContain("不会回放或补造历史 capability");
    expect(html).toContain("此会话未保存动态 capability 节点");
  });
});

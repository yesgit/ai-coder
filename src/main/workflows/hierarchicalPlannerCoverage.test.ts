import { describe, expect, it } from "vitest";
import type { HierarchicalExecutionState } from "../../shared/types.js";
import { buildHierarchicalPlannerCoverageContract } from "./hierarchicalPlannerCoverage.js";

function stateWithFindings(
  findings: Array<{ source_anchor: string; observable_result: string }>
): Pick<HierarchicalExecutionState, "alignment_batches"> {
  return {
    alignment_batches: [{
      id: "A1",
      source_refs: ["requirements.png"],
      status: "completed",
      attempt: 1,
      consecutive_failure_count: 0,
      findings: findings.map((finding) => ({
        ...finding,
        acceptance: ["目标可验证"]
      })),
      evidence_refs: ["requirements.png"]
    }]
  };
}

describe("hierarchical planner coverage contract", () => {
  it("derives a non-contiguous sequence contract from the user scope and ingested evidence", () => {
    const state = stateWithFindings([
      { source_anchor: "序号 3", observable_result: "范围外上下文" },
      { source_anchor: "序号 7", observable_result: "第一个目标" },
      { source_anchor: "序号 9", observable_result: "第二个目标" },
      { source_anchor: "序号 12", observable_result: "第三个目标" }
    ]);

    expect(buildHierarchicalPlannerCoverageContract("请从序号 7 开始处理清单", state)).toEqual({
      scope_start: 7,
      required_sequences: [7, 9, 12]
    });
  });

  it("supports English item scopes and hash-style evidence without task-specific IDs", () => {
    const state = stateWithFindings([
      { source_anchor: "item 5", observable_result: "first target" },
      { source_anchor: "supplement #8", observable_result: "second target" }
    ]);

    expect(buildHierarchicalPlannerCoverageContract("Implement from item 5 onward", state)).toEqual({
      scope_start: 5,
      required_sequences: [5, 8]
    });
  });
});

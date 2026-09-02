import { describe, expect, it } from "vitest";
import {
  deriveRunnableWorkGraphNodes,
  deriveWorkGraphInvalidationSet,
  evaluateWorkGraphFailure,
  validateWorkGraph,
  type WorkGraph
} from "./workGraph.js";

function graph(): WorkGraph<{ operation?: string }> {
  return {
    nodes: [
      { id: "plan", kind: "planning", label: "plan", status: "passed" },
      { id: "investigate", kind: "capability", label: "investigate", status: "ready", payload: { operation: "investigate" } },
      { id: "prepare", kind: "phase", label: "prepare", status: "pending", payload: { operation: "prepare" } },
      { id: "implement", kind: "phase", label: "implement", status: "pending", payload: { operation: "implement" } },
      { id: "unrelated", kind: "requirement", label: "unrelated", status: "ready", priority: -1 }
    ],
    edges: [
      { from: "plan", to: "investigate", kind: "depends_on" },
      { from: "investigate", to: "prepare", kind: "depends_on" },
      { from: "prepare", to: "implement", kind: "depends_on" }
    ]
  };
}

describe("work graph", () => {
  it("selects only dependency-ready nodes in stable priority order", () => {
    const runnable = deriveRunnableWorkGraphNodes(graph());
    expect(runnable.map((node) => node.id)).toEqual(["investigate", "unrelated"]);
  });

  it("resumes a running node before starting another ready node", () => {
    const state = graph();
    state.nodes[1]!.status = "running";
    state.nodes[4]!.priority = 100;
    expect(deriveRunnableWorkGraphNodes(state).map((node) => node.id)).toEqual([
      "investigate",
      "unrelated"
    ]);
  });

  it("does not implicitly retry a failed node", () => {
    const state = graph();
    state.nodes[1]!.status = "failed";
    expect(deriveRunnableWorkGraphNodes(state).map((node) => node.id)).toEqual(["unrelated"]);
  });

  it("invalidates only the stale node and its dependency descendants", () => {
    expect(deriveWorkGraphInvalidationSet(graph(), "investigate")).toEqual([
      "investigate",
      "prepare",
      "implement"
    ]);
  });

  it("rejects missing endpoints and dependency cycles", () => {
    const missing = graph();
    missing.edges.push({ from: "missing", to: "prepare", kind: "depends_on" });
    expect(() => validateWorkGraph(missing)).toThrow("不存在的起点");

    const cyclic = graph();
    cyclic.edges.push({ from: "implement", to: "investigate", kind: "depends_on" });
    expect(() => validateWorkGraph(cyclic)).toThrow("存在循环");
  });

  it("changes strategy on repeated no-progress failures and blocks at the node budget", () => {
    const policy = { max_attempts: 5, max_same_error_attempts: 3 };
    expect(evaluateWorkGraphFailure([], "schema", policy)).toBe("retry");
    expect(evaluateWorkGraphFailure([
      { fingerprint: "schema", attempt: 1 },
      { fingerprint: "schema", attempt: 2 }
    ], "schema", policy)).toBe("replan");
    expect(evaluateWorkGraphFailure([
      { fingerprint: "schema", attempt: 1 },
      { fingerprint: "schema", attempt: 2 },
      { fingerprint: "evidence", attempt: 3 },
      { fingerprint: "evidence", attempt: 4 }
    ], "schema", policy)).toBe("blocked");
  });
});

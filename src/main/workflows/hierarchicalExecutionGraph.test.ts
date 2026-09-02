import { describe, expect, it } from "vitest";
import type { HierarchicalExecutionState } from "../../shared/types.js";
import {
  applyHierarchicalEvent,
  createHierarchicalExecutionState,
  deriveHierarchicalLoopStack
} from "./hierarchicalWorkflowEngine.js";
import {
  deriveHierarchicalExecutionGraph,
  deriveHierarchicalGraphOperation
} from "./hierarchicalExecutionGraph.js";

const NOW = "2026-09-01T00:00:00.000Z";

function plannedState(): HierarchicalExecutionState {
  return applyHierarchicalEvent(createHierarchicalExecutionState("实现两个独立需求", { now: NOW }), {
    type: "plan_accepted",
    requirements: [{
      id: "R1",
      source_anchor: "user:R1",
      observable_result: "R1 可用",
      acceptance: ["R1 有证据"],
      dependencies: []
    }, {
      id: "R2",
      source_anchor: "user:R2",
      observable_result: "R2 可用",
      acceptance: ["R2 有证据"],
      dependencies: ["R1"]
    }],
    occurred_at: NOW
  });
}

function passCurrentPhase(
  state: HierarchicalExecutionState,
  options: { allowed_files?: string[]; handoff?: Record<string, unknown> } = {}
): HierarchicalExecutionState {
  const workUnit = state.active_work_unit!;
  const started = applyHierarchicalEvent(state, {
    type: "phase_started",
    work_unit_id: workUnit.id,
    occurred_at: NOW
  });
  return applyHierarchicalEvent(started, {
    type: "phase_passed",
    work_unit_id: workUnit.id,
    evidence_refs: [`E-${workUnit.phase}`],
    allowed_files: options.allowed_files,
    handoff: options.handoff,
    occurred_at: NOW
  });
}

describe("hierarchical execution graph adapter", () => {
  it("materializes requirement, phase, acceptance and integration relationships", () => {
    const graph = deriveHierarchicalExecutionGraph(plannedState());

    expect(graph.nodes.map((node) => node.id)).toContain("phase:R1:investigate");
    expect(graph.nodes.map((node) => node.id)).toContain("acceptance:R1-A1");
    expect(graph.edges).toContainEqual({
      from: "phase:R1:close",
      to: "requirement:R2",
      kind: "depends_on"
    });
    expect(graph.edges).toContainEqual({
      from: "acceptance:R1-A1",
      to: "phase:R1:close",
      kind: "depends_on"
    });
    expect(graph.edges).toContainEqual({
      from: "phase:R2:close",
      to: "integration",
      kind: "depends_on"
    });
  });

  it("selects the first dependency-ready requirement from the graph", () => {
    expect(deriveHierarchicalGraphOperation(plannedState())).toEqual({
      kind: "activate_requirement",
      requirement_id: "R1"
    });
  });

  it("resumes the running leaf instead of starting another graph node", () => {
    let state = applyHierarchicalEvent(plannedState(), {
      type: "requirement_activated",
      requirement_id: "R1",
      occurred_at: NOW
    });
    state = applyHierarchicalEvent(state, {
      type: "phase_started",
      work_unit_id: state.active_work_unit!.id,
      occurred_at: NOW
    });

    expect(deriveHierarchicalGraphOperation(state)).toMatchObject({
      kind: "run_phase",
      requirement_id: "R1",
      phase: "investigate"
    });
  });

  it("finishes the active leaf before activating another independent requirement", () => {
    let state = applyHierarchicalEvent(createHierarchicalExecutionState("实现两个独立需求", { now: NOW }), {
      type: "plan_accepted",
      requirements: [{
        id: "R1",
        source_anchor: "user:R1",
        observable_result: "R1 可用",
        acceptance: ["R1 有证据"],
        dependencies: []
      }, {
        id: "R2",
        source_anchor: "user:R2",
        observable_result: "R2 可用",
        acceptance: ["R2 有证据"],
        dependencies: []
      }],
      occurred_at: NOW
    });
    state = applyHierarchicalEvent(state, {
      type: "requirement_activated",
      requirement_id: "R1",
      occurred_at: NOW
    });

    expect(deriveHierarchicalGraphOperation(state)).toMatchObject({
      kind: "run_phase",
      requirement_id: "R1",
      phase: "investigate"
    });
  });

  it("does not escape a blocked active leaf by activating unrelated work", () => {
    let state = applyHierarchicalEvent(createHierarchicalExecutionState("实现两个独立需求", { now: NOW }), {
      type: "plan_accepted",
      requirements: [{
        id: "R1",
        source_anchor: "user:R1",
        observable_result: "R1 可用",
        acceptance: ["R1 有证据"],
        dependencies: []
      }, {
        id: "R2",
        source_anchor: "user:R2",
        observable_result: "R2 可用",
        acceptance: ["R2 有证据"],
        dependencies: []
      }],
      occurred_at: NOW
    });
    state = applyHierarchicalEvent(state, {
      type: "requirement_activated",
      requirement_id: "R1",
      occurred_at: NOW
    });
    state = applyHierarchicalEvent(state, {
      type: "phase_started",
      work_unit_id: state.active_work_unit!.id,
      occurred_at: NOW
    });
    state = applyHierarchicalEvent(state, {
      type: "phase_failed",
      work_unit_id: state.active_work_unit!.id,
      reason: "缺少外部证据",
      route: "blocked",
      occurred_at: NOW
    });

    expect(deriveHierarchicalGraphOperation(state)).toBeUndefined();
  });

  it("represents an already-satisfied implementation as skipped", () => {
    let state = applyHierarchicalEvent(plannedState(), {
      type: "requirement_activated",
      requirement_id: "R1",
      occurred_at: NOW
    });
    state = passCurrentPhase(state);
    state = passCurrentPhase(state, {
      allowed_files: [],
      handoff: { change_disposition: "already_satisfied" }
    });

    const graph = deriveHierarchicalExecutionGraph(state);
    expect(graph.nodes.find((node) => node.id === "phase:R1:implement")?.status).toBe("skipped");
    expect(deriveHierarchicalGraphOperation(state)).toMatchObject({
      kind: "run_phase",
      phase: "verify"
    });
  });

  it("schedules capability leaves independently and gates their parent phase", () => {
    let state = applyHierarchicalEvent(plannedState(), {
      type: "requirement_activated",
      requirement_id: "R1",
      occurred_at: NOW
    });
    state = passCurrentPhase(state);
    state = applyHierarchicalEvent(state, {
      type: "capability_graph_synchronized",
      requirement_id: "R1",
      parent_phase: "prepare",
      requests: [{
        id: "cap:R1:symbol:a",
        capability: "symbol-contract-analysis",
        input: { target_file: "src/a.ts", symbol: "a" }
      }, {
        id: "cap:R1:symbol:b",
        capability: "symbol-contract-analysis",
        input: { target_file: "src/b.ts", symbol: "b" }
      }],
      occurred_at: NOW
    });

    expect(deriveHierarchicalGraphOperation(state)).toMatchObject({
      kind: "run_capability",
      node_id: "cap:R1:symbol:a"
    });
    expect(deriveHierarchicalLoopStack(state).at(-1)).toMatchObject({
      kind: "action",
      id: "cap:R1:symbol:a",
      status: "pending · attempt 1"
    });
    state = applyHierarchicalEvent(state, {
      type: "capability_started",
      node_id: "cap:R1:symbol:a",
      occurred_at: NOW
    });
    state = applyHierarchicalEvent(state, {
      type: "capability_failed",
      node_id: "cap:R1:symbol:a",
      reason: "temporary analyzer failure",
      route: "retry",
      error_fingerprint: "analyzer",
      occurred_at: NOW
    });

    expect(state.capability_nodes).toEqual([
      expect.objectContaining({ id: "cap:R1:symbol:a", status: "pending", attempt: 2 }),
      expect.objectContaining({ id: "cap:R1:symbol:b", status: "pending", attempt: 1 })
    ]);
    expect(deriveHierarchicalGraphOperation(state)).toMatchObject({
      kind: "run_capability",
      node_id: "cap:R1:symbol:a",
      attempt: 2
    });

    state = applyHierarchicalEvent(state, {
      type: "capability_started",
      node_id: "cap:R1:symbol:a",
      occurred_at: NOW
    });
    state = applyHierarchicalEvent(state, {
      type: "capability_passed",
      node_id: "cap:R1:symbol:a",
      output: { digest: "a" },
      evidence_refs: ["src/a.ts:1"],
      occurred_at: NOW
    });
    expect(deriveHierarchicalGraphOperation(state)).toMatchObject({
      kind: "run_capability",
      node_id: "cap:R1:symbol:b"
    });
  });
});

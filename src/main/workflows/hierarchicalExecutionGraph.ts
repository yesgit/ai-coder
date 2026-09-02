import type {
  HierarchicalExecutionState,
  HierarchicalRequirement,
  HierarchicalWorkPhase
} from "../../shared/types.js";
import type { HierarchicalNextOperation } from "./hierarchicalWorkflowEngine.js";
import {
  deriveRunnableWorkGraphNodes,
  type WorkGraph,
  type WorkGraphNode,
  type WorkGraphNodeStatus
} from "./workGraph.js";

export interface HierarchicalGraphPayload {
  operation?: HierarchicalNextOperation;
  phase?: HierarchicalWorkPhase;
  acceptance_id?: string;
}

const PHASES: HierarchicalWorkPhase[] = ["investigate", "prepare", "implement", "verify", "close"];

/**
 * Compatibility adapter used while the persisted hierarchical state is being
 * migrated to graph-native storage. The projection is deterministic: sessions
 * can be resumed without serialising a second, potentially divergent state.
 */
export function deriveHierarchicalExecutionGraph(
  state: HierarchicalExecutionState
): WorkGraph<HierarchicalGraphPayload> {
  const nodes: Array<WorkGraphNode<HierarchicalGraphPayload>> = [];
  const edges: WorkGraph<HierarchicalGraphPayload>["edges"] = [];

  state.alignment_batches.forEach((batch, index) => {
    const nodeId = alignmentNodeId(batch.id);
    nodes.push({
      id: nodeId,
      kind: "alignment",
      label: `摄取来源批次 ${batch.id}`,
      status: alignmentStatus(batch.status),
      attempt: batch.attempt,
      priority: 100,
      scope: { goal_id: state.goal.id, capability: "source-alignment" },
      payload: {
        operation: {
          kind: "run_alignment_batch",
          batch_id: batch.id,
          source_refs: [...batch.source_refs],
          attempt: batch.attempt
        }
      }
    });
    const predecessor = state.alignment_batches[index - 1];
    if (predecessor) {
      edges.push({ from: alignmentNodeId(predecessor.id), to: nodeId, kind: "depends_on" });
    }
  });

  nodes.push({
    id: "planning",
    kind: "planning",
    label: "建立稳定需求账本",
    status: state.requirements.length > 0 ? "passed" : "ready",
    attempt: state.planner_retry?.attempt ?? 1,
    priority: 90,
    scope: { goal_id: state.goal.id, capability: "requirements-planning" },
    payload: { operation: { kind: "run_planner" } }
  });
  for (const batch of state.alignment_batches) {
    edges.push({ from: alignmentNodeId(batch.id), to: "planning", kind: "depends_on" });
  }

  for (const requirement of state.requirements) {
    addRequirementSubgraph(state, requirement, nodes, edges);
  }

  for (const capability of state.capability_nodes ?? []) {
    addCapabilityNode(state, capability, nodes, edges);
  }

  const integrationStatus: WorkGraphNodeStatus = state.integration_status === "passed"
    ? "passed"
    : state.integration_status === "running"
      ? "running"
      : state.integration_status === "failed"
        // integration_failed without a targeted rework route is the legacy
        // runner's explicit local-retry state, so expose it as ready. Generic
        // failed graph nodes themselves are never scheduled implicitly.
        ? "ready"
        : "pending";
  nodes.push({
    id: "integration",
    kind: "integration",
    label: "审计最终工作区与全部验收证据",
    status: integrationStatus,
    priority: 10,
    scope: { goal_id: state.goal.id, capability: "final-workspace-review" },
    payload: { operation: { kind: "run_integrator" } }
  });
  for (const requirement of state.requirements) {
    edges.push({ from: phaseNodeId(requirement.id, "close"), to: "integration", kind: "depends_on" });
  }

  return { nodes, edges };
}

function addCapabilityNode(
  state: HierarchicalExecutionState,
  capability: HierarchicalExecutionState["capability_nodes"][number],
  nodes: Array<WorkGraphNode<HierarchicalGraphPayload>>,
  edges: WorkGraph<HierarchicalGraphPayload>["edges"]
): void {
  const status: WorkGraphNodeStatus = capability.status === "superseded"
    ? "skipped"
    : capability.status;
  nodes.push({
    id: capability.id,
    kind: "capability",
    label: `${capability.capability}: ${capability.id}`,
    status,
    priority: 90,
    attempt: capability.attempt,
    scope: {
      goal_id: state.goal.id,
      requirement_id: capability.requirement_id,
      capability: capability.capability
    },
    payload: {
      operation: capability.status === "pending" || capability.status === "running"
        ? {
            kind: "run_capability",
            node_id: capability.id,
            requirement_id: capability.requirement_id,
            parent_phase: capability.parent_phase,
            capability: capability.capability,
            input: structuredClone(capability.input),
            attempt: capability.attempt
          }
        : undefined
    }
  });
  edges.push({
    from: capabilityParentNodeId(capability.requirement_id, capability.parent_phase),
    to: capability.id,
    kind: "depends_on"
  });
  for (const dependency of capability.dependencies) {
    edges.push({ from: dependency, to: capability.id, kind: "depends_on" });
  }
  edges.push({
    from: capability.id,
    to: phaseNodeId(capability.requirement_id, capability.parent_phase),
    kind: "depends_on"
  });
}

/** Select the next executable node; relationship-only evidence nodes are ignored. */
export function deriveHierarchicalGraphOperation(
  state: HierarchicalExecutionState
): HierarchicalNextOperation | undefined {
  const graph = deriveHierarchicalExecutionGraph(state);
  const runnable = deriveRunnableWorkGraphNodes(graph);
  // The graph intentionally exposes all dependency-ready work. During the
  // compatibility window the runner still has a singleton active_work_unit,
  // so it may only execute nodes in that active requirement's scope.
  const candidates = state.active_requirement_id
    ? runnable.filter((node) => node.scope?.requirement_id === state.active_requirement_id)
    : runnable;
  return candidates.find((node) => node.payload?.operation)
    ?.payload?.operation;
}

function addRequirementSubgraph(
  state: HierarchicalExecutionState,
  requirement: HierarchicalRequirement,
  nodes: Array<WorkGraphNode<HierarchicalGraphPayload>>,
  edges: WorkGraph<HierarchicalGraphPayload>["edges"]
): void {
  const activationId = requirementNodeId(requirement.id);
  const activationStatus: WorkGraphNodeStatus = requirement.status === "pending"
    ? "pending"
    : requirement.status === "skipped"
      ? "skipped"
      : "passed";
  nodes.push({
    id: activationId,
    kind: "requirement",
    label: requirement.observable_result,
    status: activationStatus,
    priority: 50,
    scope: { goal_id: state.goal.id, requirement_id: requirement.id },
    payload: {
      operation: requirement.status === "pending"
        ? { kind: "activate_requirement", requirement_id: requirement.id }
        : undefined
    }
  });
  edges.push({ from: "planning", to: activationId, kind: "depends_on" });
  for (const dependencyId of requirement.dependencies) {
    edges.push({ from: phaseNodeId(dependencyId, "close"), to: activationId, kind: "depends_on" });
  }

  PHASES.forEach((phase, index) => {
    const id = phaseNodeId(requirement.id, phase);
    const operation = phaseOperation(state, requirement, phase);
    nodes.push({
      id,
      kind: phase === "investigate" ? "capability" : "phase",
      label: `${requirement.id}/${phase}`,
      status: phaseStatus(state, requirement, phase),
      // The graph may expose several dependency-ready requirements, while the
      // compatibility runner still owns one active_work_unit. Keep the active
      // vertical leaf ahead of new activations until the runner itself becomes
      // multi-node; graph-native parallelism can later remove this priority.
      priority: operation ? 80 - index : 40 - index,
      attempt: operation?.kind === "run_phase" ? state.active_work_unit?.attempt : undefined,
      scope: {
        goal_id: state.goal.id,
        requirement_id: requirement.id,
        ...(phase === "investigate" ? { capability: "code-investigation" } : {})
      },
      payload: { phase, operation }
    });
    edges.push({
      from: index === 0 ? activationId : phaseNodeId(requirement.id, PHASES[index - 1]!),
      to: id,
      kind: "depends_on"
    });
  });

  for (const acceptance of requirement.acceptance) {
    const acceptanceId = acceptanceNodeId(acceptance.id);
    nodes.push({
      id: acceptanceId,
      kind: "acceptance",
      label: acceptance.criterion,
      status: acceptance.status === "pass" ? "passed" : acceptance.status === "fail" ? "failed" : "pending",
      scope: { goal_id: state.goal.id, requirement_id: requirement.id },
      payload: { acceptance_id: acceptance.id }
    });
    edges.push({ from: phaseNodeId(requirement.id, "verify"), to: acceptanceId, kind: "validates" });
    edges.push({ from: acceptanceId, to: phaseNodeId(requirement.id, "close"), kind: "depends_on" });
  }
}

function phaseOperation(
  state: HierarchicalExecutionState,
  requirement: HierarchicalRequirement,
  phase: HierarchicalWorkPhase
): HierarchicalNextOperation | undefined {
  if (state.active_requirement_id !== requirement.id || requirement.current_phase !== phase) return undefined;
  if (phase === "close") return { kind: "close_requirement", requirement_id: requirement.id };
  const workUnit = state.active_work_unit;
  if (!workUnit || workUnit.requirement_id !== requirement.id || workUnit.phase !== phase) return undefined;
  return {
    kind: "run_phase",
    requirement_id: requirement.id,
    work_unit_id: workUnit.id,
    phase,
    role: workUnit.assigned_role
  };
}

function phaseStatus(
  state: HierarchicalExecutionState,
  requirement: HierarchicalRequirement,
  phase: HierarchicalWorkPhase
): WorkGraphNodeStatus {
  if (requirement.status === "skipped") return "skipped";
  if (requirement.status === "pending") return "pending";
  if (requirement.status === "completed") return phase === "implement" && latestPrepareSkipsImplement(state, requirement.id)
    ? "skipped"
    : "passed";

  const currentPhase = requirement.current_phase;
  if (!currentPhase) return "pending";
  const currentIndex = PHASES.indexOf(currentPhase);
  const phaseIndex = PHASES.indexOf(phase);
  if (phaseIndex < currentIndex) {
    return phase === "implement" && latestPrepareSkipsImplement(state, requirement.id) ? "skipped" : "passed";
  }
  if (phaseIndex > currentIndex) return "pending";
  if (phase === "close") return requirement.status === "blocked" ? "blocked" : "ready";
  const workUnit = state.active_work_unit;
  if (!workUnit || workUnit.requirement_id !== requirement.id || workUnit.phase !== phase) return "pending";
  return workUnit.status;
}

function latestPrepareSkipsImplement(state: HierarchicalExecutionState, requirementId: string): boolean {
  const prepare = [...state.phase_artifacts].reverse().find((artifact) =>
    artifact.requirement_id === requirementId && artifact.phase === "prepare"
  );
  return prepare?.handoff.change_disposition === "already_satisfied";
}

function alignmentStatus(
  status: HierarchicalExecutionState["alignment_batches"][number]["status"]
): WorkGraphNodeStatus {
  if (status === "completed") return "passed";
  if (status === "blocked") return "blocked";
  return status;
}

function alignmentNodeId(batchId: string): string {
  return `alignment:${batchId}`;
}

function requirementNodeId(requirementId: string): string {
  return `requirement:${requirementId}`;
}

function phaseNodeId(requirementId: string, phase: HierarchicalWorkPhase): string {
  return `phase:${requirementId}:${phase}`;
}

function acceptanceNodeId(acceptanceId: string): string {
  return `acceptance:${acceptanceId}`;
}

function capabilityParentNodeId(
  requirementId: string,
  phase: Exclude<HierarchicalWorkPhase, "close">
): string {
  const index = PHASES.indexOf(phase);
  return index <= 0
    ? requirementNodeId(requirementId)
    : phaseNodeId(requirementId, PHASES[index - 1]!);
}

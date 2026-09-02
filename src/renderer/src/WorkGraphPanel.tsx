import { useMemo } from "react";
import type {
  HierarchicalCapabilityNode,
  HierarchicalExecutionState,
  HierarchicalRequirement,
  HierarchicalWorkPhase
} from "../../shared/types.js";
import {
  deriveHierarchicalExecutionGraph,
  type HierarchicalGraphPayload
} from "../../main/workflows/hierarchicalExecutionGraph.js";
import {
  deriveRunnableWorkGraphNodes,
  type WorkGraph,
  type WorkGraphNode,
  type WorkGraphNodeStatus
} from "../../main/workflows/workGraph.js";

interface WorkGraphPanelProps {
  state?: HierarchicalExecutionState;
  onShowLoop(): void;
}

const PHASE_LABELS: Record<HierarchicalWorkPhase, string> = {
  investigate: "调查",
  prepare: "准备",
  implement: "实现",
  verify: "验证",
  close: "关闭"
};

const STATUS_LABELS: Record<WorkGraphNodeStatus, string> = {
  pending: "等待依赖",
  ready: "可执行",
  running: "执行中",
  passed: "已通过",
  failed: "失败",
  blocked: "阻塞",
  skipped: "已跳过"
};

const KIND_LABELS: Record<string, string> = {
  alignment: "输入",
  planning: "计划",
  requirement: "需求",
  phase: "阶段",
  capability: "能力",
  acceptance: "验收",
  integration: "审计"
};

type Graph = WorkGraph<HierarchicalGraphPayload>;
type GraphNode = WorkGraphNode<HierarchicalGraphPayload>;

interface GraphProjection {
  graph?: Graph;
  runnableIds: Set<string>;
  error?: string;
}

export default function WorkGraphPanel({ state, onShowLoop }: WorkGraphPanelProps) {
  const projection = useMemo(() => projectGraph(state), [state]);
  if (!state) {
    return (
      <section className="stages-panel hierarchical-loop-panel work-graph-panel" aria-live="polite">
        <div className="task-tree-heading">
          <h3>执行工作图</h3>
          <span className="task-tree-count">初始化</span>
        </div>
        <div className="task-tree-empty">
          <strong>等待宿主建立目标契约</strong>
          <small>目标、需求、能力与验收节点会由宿主状态机投影为执行图。</small>
        </div>
      </section>
    );
  }

  const passedNodes = projection.graph?.nodes.filter((node) => (
    node.status === "passed" || node.status === "skipped"
  )).length ?? 0;
  const totalNodes = projection.graph?.nodes.length ?? 0;

  return (
    <section className="stages-panel hierarchical-loop-panel work-graph-panel" aria-live="polite">
      <div className="task-tree-heading work-graph-heading">
        <h3>执行工作图</h3>
        <span className="task-tree-count">{passedNodes}/{totalNodes}</span>
      </div>
      <ViewSwitch graph onShowLoop={onShowLoop} />
      <GraphView state={state} projection={projection} />
    </section>
  );
}

export function ViewSwitch({
  graph,
  onShowGraph,
  onShowLoop
}: {
  graph: boolean;
  onShowGraph?: () => void;
  onShowLoop?: () => void;
}) {
  return (
    <div className="work-graph-view-switch" role="group" aria-label="执行状态视图">
      <button
        type="button"
        className={graph ? "active" : ""}
        aria-pressed={graph}
        onClick={onShowGraph}
      >图视图</button>
      <button
        type="button"
        className={!graph ? "active" : ""}
        aria-pressed={!graph}
        onClick={onShowLoop}
      >循环视图</button>
    </div>
  );
}

function GraphView({ state, projection }: {
  state: HierarchicalExecutionState;
  projection: GraphProjection;
}) {
  if (!projection.graph) {
    return (
      <div className="task-tree-empty work-graph-error">
        <strong>工作图投影失败</strong>
        <small>{projection.error ?? "未知投影错误"}</small>
      </div>
    );
  }

  const graph = projection.graph;
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const dependencies = dependencyIndex(graph);
  const capabilityById = new Map((state.capability_nodes ?? []).map((node) => [node.id, node]));
  const ordered = [...graph.nodes].sort((left, right) => (
    graphNodeOrder(left, capabilityById.get(left.id))
    - graphNodeOrder(right, capabilityById.get(right.id))
  ));
  const globalNodes = ordered.filter((node) => !node.scope?.requirement_id && node.kind !== "integration");
  const integrationNodes = ordered.filter((node) => node.kind === "integration");
  const openBlockers = state.blockers.filter((blocker) => blocker.status === "open");
  const counts = graphStatusCounts(graph.nodes);

  return (
    <>
      <div className="hierarchical-goal work-graph-goal">
        <small>目标 {state.goal.id} · rev {state.goal.revision}</small>
        <strong>{state.goal.statement}</strong>
      </div>

      <div className="work-graph-projection-note">
        <span>状态投影</span>
        <small>只展示会话实际保存的节点；不会回放或补造历史 capability。</small>
      </div>

      <div className="work-graph-summary" aria-label="工作图状态汇总">
        <span className="passed">{counts.passed} 已通过</span>
        <span className="active">{counts.active} 活跃</span>
        <span className="pending">{counts.pending} 等待</span>
        {counts.problem > 0 && <span className="problem">{counts.problem} 异常</span>}
      </div>

      {projection.error && (
        <div className="work-graph-warning">图完整性诊断：{projection.error}</div>
      )}

      <div className="work-graph-groups">
        {globalNodes.length > 0 && (
          <GraphGroup
            id="goal"
            label="目标级准备"
            nodes={globalNodes}
            state={state}
            nodeById={nodeById}
            dependencies={dependencies}
            runnableIds={projection.runnableIds}
            capabilityById={capabilityById}
            defaultOpen
          />
        )}

        {state.requirements.map((requirement) => (
          <GraphGroup
            key={requirement.id}
            id={requirement.id}
            label={`${requirement.id} · ${requirement.observable_result}`}
            nodes={ordered.filter((node) => node.scope?.requirement_id === requirement.id)}
            state={state}
            requirement={requirement}
            nodeById={nodeById}
            dependencies={dependencies}
            runnableIds={projection.runnableIds}
            capabilityById={capabilityById}
            defaultOpen={
              requirement.id === state.active_requirement_id
              || !["completed", "skipped"].includes(requirement.status)
            }
          />
        ))}

        {integrationNodes.length > 0 && (
          <GraphGroup
            id="integration"
            label="最终工作区审计"
            nodes={integrationNodes}
            state={state}
            nodeById={nodeById}
            dependencies={dependencies}
            runnableIds={projection.runnableIds}
            capabilityById={capabilityById}
            defaultOpen={state.integration_status !== "passed"}
          />
        )}
      </div>

      {state.requirements.length > 0 && (state.capability_nodes ?? []).length === 0 && (
        <div className="work-graph-history-note">
          此会话未保存动态 capability 节点；历史任务不会因升级而被自动重算。
        </div>
      )}

      {openBlockers.length > 0 && (
        <div className="hierarchical-blockers">
          <small>开放阻塞</small>
          {openBlockers.map((blocker) => (
            <span key={blocker.id}>{blocker.kind} · {blocker.owner}：{blocker.message}</span>
          ))}
        </div>
      )}
    </>
  );
}

function GraphGroup({
  id,
  label,
  nodes,
  state,
  requirement,
  nodeById,
  dependencies,
  runnableIds,
  capabilityById,
  defaultOpen
}: {
  id: string;
  label: string;
  nodes: GraphNode[];
  state: HierarchicalExecutionState;
  requirement?: HierarchicalRequirement;
  nodeById: Map<string, GraphNode>;
  dependencies: Map<string, string[]>;
  runnableIds: Set<string>;
  capabilityById: Map<string, HierarchicalCapabilityNode>;
  defaultOpen: boolean;
}) {
  const completed = nodes.filter((node) => node.status === "passed" || node.status === "skipped").length;
  return (
    <details className="work-graph-group" open={defaultOpen} data-group-id={id}>
      <summary>
        <span>{label}</span>
        <small>{completed}/{nodes.length}</small>
      </summary>
      {requirement?.status_reason && (
        <div className="work-graph-group-reason">{requirement.status_reason}</div>
      )}
      <div className="work-graph-lane">
        {nodes.map((node) => (
          <GraphNodeRow
            key={node.id}
            node={node}
            state={state}
            requirement={requirement}
            dependencies={(dependencies.get(node.id) ?? []).map((dependency) => (
              nodeById.get(dependency)?.label ?? dependency
            ))}
            runnable={runnableIds.has(node.id)}
            capability={capabilityById.get(node.id)}
          />
        ))}
      </div>
    </details>
  );
}

function GraphNodeRow({
  node,
  state,
  requirement,
  dependencies,
  runnable,
  capability
}: {
  node: GraphNode;
  state: HierarchicalExecutionState;
  requirement?: HierarchicalRequirement;
  dependencies: string[];
  runnable: boolean;
  capability?: HierarchicalCapabilityNode;
}) {
  const evidence = graphNodeEvidence(state, node, requirement, capability);
  const failureReason = capability?.failure_reason
    ?? (node.status === "failed" || node.status === "blocked" ? requirement?.status_reason : undefined);
  return (
    <details
      className={`work-graph-node status-${node.status}${runnable ? " runnable" : ""}`}
      open={node.status === "running" || node.status === "failed" || node.status === "blocked"}
    >
      <summary>
        <span className="work-graph-node-dot" aria-hidden="true" />
        <span className="work-graph-node-main">
          <span className="work-graph-node-label">{displayNodeLabel(node, capability)}</span>
          <small>
            <span className="work-graph-kind">{KIND_LABELS[node.kind] ?? node.kind}</span>
            {node.attempt ? ` · 第 ${node.attempt} 次` : ""}
          </small>
        </span>
        <span className={`work-graph-status status-${node.status}`}>
          {node.status === "running" ? "当前运行" : runnable ? "可运行" : STATUS_LABELS[node.status]}
        </span>
      </summary>
      <div className="work-graph-node-details">
        <small><strong>ID</strong> {node.id}</small>
        {dependencies.length > 0 && <small><strong>依赖</strong> {dependencies.join("；")}</small>}
        {capability && (
          <>
            <small><strong>能力</strong> {capability.capability}</small>
            <small><strong>调查对象</strong> {capabilitySubject(capability)}</small>
          </>
        )}
        {evidence.length > 0 && (
          <small><strong>证据</strong> {evidence.slice(0, 5).join("；")}{evidence.length > 5 ? `；另 ${evidence.length - 5} 项` : ""}</small>
        )}
        {failureReason && <small className="work-graph-node-error"><strong>错误</strong> {failureReason}</small>}
      </div>
    </details>
  );
}

function projectGraph(state?: HierarchicalExecutionState): GraphProjection {
  if (!state) return { runnableIds: new Set() };
  try {
    const compatibleState: HierarchicalExecutionState = {
      ...state,
      alignment_batches: state.alignment_batches ?? [],
      capability_nodes: state.capability_nodes ?? []
    };
    const graph = deriveHierarchicalExecutionGraph(compatibleState);
    try {
      return {
        graph,
        runnableIds: new Set(deriveRunnableWorkGraphNodes(graph).map((node) => node.id))
      };
    } catch (error) {
      return {
        graph,
        runnableIds: new Set(),
        error: error instanceof Error ? error.message : String(error)
      };
    }
  } catch (error) {
    return {
      runnableIds: new Set(),
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function dependencyIndex(graph: Graph): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== "depends_on") continue;
    const current = values.get(edge.to) ?? [];
    current.push(edge.from);
    values.set(edge.to, current);
  }
  return values;
}

function graphNodeOrder(node: GraphNode, capability?: HierarchicalCapabilityNode): number {
  if (node.kind === "alignment") return 0;
  if (node.kind === "planning") return 5;
  if (node.kind === "requirement") return 10;
  if (node.kind === "integration") return 100;
  if (node.kind === "acceptance") return 75;
  if (capability) return phaseOrder(capability.parent_phase) - 5;
  const phase = node.payload?.phase;
  return phase ? phaseOrder(phase) : 90;
}

function phaseOrder(phase: HierarchicalWorkPhase): number {
  return ({ investigate: 20, prepare: 40, implement: 55, verify: 70, close: 85 })[phase];
}

function displayNodeLabel(node: GraphNode, capability?: HierarchicalCapabilityNode): string {
  if (capability?.capability === "symbol-contract-analysis") {
    return `符号契约 · ${textValue(capability.input.symbol) ?? "未知符号"}`;
  }
  if (capability?.capability === "callsite-semantic-review") {
    return `调用点语义 · ${textValue(capability.input.peer_symbol)
      ?? textValue(capability.input.callsite_id)
      ?? "未知调用点"}`;
  }
  if (node.kind === "phase" || node.payload?.phase) {
    const requirementId = node.scope?.requirement_id ?? "";
    const phase = node.payload?.phase;
    return `${requirementId} · ${phase ? PHASE_LABELS[phase] : node.label}`;
  }
  if (node.kind === "acceptance") return `验收 · ${node.label}`;
  return node.label;
}

function capabilitySubject(capability: HierarchicalCapabilityNode): string {
  const targetFile = textValue(capability.input.target_file);
  const symbol = textValue(capability.input.symbol);
  const evidenceRef = textValue(capability.input.evidence_ref);
  if (symbol && targetFile) return `${symbol}@${targetFile}`;
  return evidenceRef ?? textValue(capability.input.callsite_id) ?? "未提供";
}

function graphNodeEvidence(
  state: HierarchicalExecutionState,
  node: GraphNode,
  requirement?: HierarchicalRequirement,
  capability?: HierarchicalCapabilityNode
): string[] {
  if (capability) return capability.evidence_refs ?? [];
  if (node.kind === "integration") return state.integration_evidence_refs ?? [];
  if (node.kind === "alignment") {
    const batchId = node.id.replace(/^alignment:/, "");
    return state.alignment_batches.find((batch) => batch.id === batchId)?.evidence_refs ?? [];
  }
  if (node.kind === "acceptance") {
    const acceptanceId = node.payload?.acceptance_id;
    return requirement?.acceptance.find((item) => item.id === acceptanceId)?.evidence_refs ?? [];
  }
  const phase = node.payload?.phase;
  if (phase && requirement) {
    return [...state.phase_artifacts].reverse().find((artifact) => (
      artifact.requirement_id === requirement.id && artifact.phase === phase
    ))?.evidence_refs ?? [];
  }
  return [];
}

function graphStatusCounts(nodes: GraphNode[]) {
  return {
    passed: nodes.filter((node) => node.status === "passed" || node.status === "skipped").length,
    active: nodes.filter((node) => node.status === "ready" || node.status === "running").length,
    pending: nodes.filter((node) => node.status === "pending").length,
    problem: nodes.filter((node) => node.status === "failed" || node.status === "blocked").length
  };
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

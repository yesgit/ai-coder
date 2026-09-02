/**
 * Language- and capability-neutral execution graph primitives.
 *
 * The graph deliberately knows nothing about coding phases, symbols, tests or
 * providers.  A workflow adapter owns those meanings and stores its executable
 * operation in `payload`.  This keeps orchestration reusable while allowing a
 * capability (for example call-contract analysis) to expand one node into a
 * finer subgraph without changing the global scheduler.
 */
export type WorkGraphNodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "passed"
  | "failed"
  | "blocked"
  | "skipped";

export type WorkGraphEdgeKind =
  | "depends_on"
  | "produces"
  | "validates"
  | "invalidates";

export interface WorkGraphNode<TPayload = unknown> {
  id: string;
  kind: string;
  label: string;
  status: WorkGraphNodeStatus;
  /** Higher priority nodes are selected first. Equal priorities keep insertion order. */
  priority?: number;
  attempt?: number;
  scope?: {
    goal_id?: string;
    requirement_id?: string;
    capability?: string;
  };
  payload?: TPayload;
}

export interface WorkGraphEdge {
  from: string;
  to: string;
  kind: WorkGraphEdgeKind;
}

export interface WorkGraph<TPayload = unknown> {
  nodes: Array<WorkGraphNode<TPayload>>;
  edges: WorkGraphEdge[];
}

export interface WorkGraphRetryPolicy {
  max_attempts: number;
  max_same_error_attempts: number;
}

export interface WorkGraphFailureRecord {
  fingerprint: string;
  attempt: number;
  occurred_at?: string;
}

export type WorkGraphFailureDisposition = "retry" | "replan" | "blocked";

const SATISFIED_DEPENDENCY_STATUSES = new Set<WorkGraphNodeStatus>(["passed", "skipped"]);

/**
 * Reject malformed graphs before scheduling. Only `depends_on` participates in
 * cycle detection: evidence and invalidation edges describe relationships, not
 * execution ordering.
 */
export function validateWorkGraph<TPayload>(graph: WorkGraph<TPayload>): void {
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (!node.id.trim()) throw new Error("工作图节点 ID 不能为空");
    if (ids.has(node.id)) throw new Error(`工作图节点 ID 重复：${node.id}`);
    ids.add(node.id);
  }

  const edgeKeys = new Set<string>();
  for (const edge of graph.edges) {
    if (!ids.has(edge.from)) throw new Error(`工作图边引用不存在的起点：${edge.from}`);
    if (!ids.has(edge.to)) throw new Error(`工作图边引用不存在的终点：${edge.to}`);
    if (edge.from === edge.to) throw new Error(`工作图节点不能依赖自身：${edge.from}`);
    const key = `${edge.kind}\u0000${edge.from}\u0000${edge.to}`;
    if (edgeKeys.has(key)) throw new Error(`工作图边重复：${edge.from} -> ${edge.to} (${edge.kind})`);
    edgeKeys.add(key);
  }

  const dependencies = graph.edges.filter((edge) => edge.kind === "depends_on");
  const inDegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  const dependents = new Map(graph.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of dependencies) {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    dependents.get(edge.from)?.push(edge.to);
  }
  const queue = graph.nodes.filter((node) => inDegree.get(node.id) === 0).map((node) => node.id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    visited += 1;
    for (const dependent of dependents.get(id) ?? []) {
      const nextDegree = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, nextDegree);
      if (nextDegree === 0) queue.push(dependent);
    }
  }
  if (visited !== graph.nodes.length) throw new Error("工作图 depends_on 关系存在循环");
}

/** Return runnable or resumable nodes without mutating the graph. */
export function deriveRunnableWorkGraphNodes<TPayload>(
  graph: WorkGraph<TPayload>
): Array<WorkGraphNode<TPayload>> {
  validateWorkGraph(graph);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const dependenciesByNode = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== "depends_on") continue;
    const dependencies = dependenciesByNode.get(edge.to) ?? [];
    dependencies.push(edge.from);
    dependenciesByNode.set(edge.to, dependencies);
  }

  return graph.nodes
    .map((node, index) => ({ node, index }))
    .filter(({ node }) => {
      if (node.status === "running") return true;
      // A failed node is terminal until its owner applies a retry/replan policy
      // and explicitly moves it back to ready. This prevents the scheduler from
      // silently turning every failure into an unbounded retry loop.
      if (node.status !== "pending" && node.status !== "ready") return false;
      return (dependenciesByNode.get(node.id) ?? []).every((dependencyId) => {
        const dependency = nodeById.get(dependencyId);
        return dependency ? SATISFIED_DEPENDENCY_STATUSES.has(dependency.status) : false;
      });
    })
    .sort((left, right) => {
      const runningDelta = Number(right.node.status === "running") - Number(left.node.status === "running");
      if (runningDelta !== 0) return runningDelta;
      const priorityDelta = (right.node.priority ?? 0) - (left.node.priority ?? 0);
      return priorityDelta !== 0 ? priorityDelta : left.index - right.index;
    })
    .map(({ node }) => node);
}

/**
 * Calculate the smallest invalidation set after a node becomes stale.  Only
 * execution dependencies are traversed. Validation/evidence neighbours stay
 * untouched unless they also depend on the stale node.
 */
export function deriveWorkGraphInvalidationSet<TPayload>(
  graph: WorkGraph<TPayload>,
  staleNodeId: string
): string[] {
  validateWorkGraph(graph);
  if (!graph.nodes.some((node) => node.id === staleNodeId)) {
    throw new Error(`待失效工作图节点不存在：${staleNodeId}`);
  }
  const dependents = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== "depends_on") continue;
    const values = dependents.get(edge.from) ?? [];
    values.push(edge.to);
    dependents.set(edge.from, values);
  }
  const invalidated: string[] = [];
  const seen = new Set([staleNodeId]);
  const queue = [staleNodeId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    invalidated.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      if (seen.has(dependent)) continue;
      seen.add(dependent);
      queue.push(dependent);
    }
  }
  return invalidated;
}

/**
 * Local retry policy for a single node. Repeating the same failure requests a
 * strategy change before the total attempt budget is exhausted; it never asks
 * the global scheduler to replay unrelated nodes.
 */
export function evaluateWorkGraphFailure(
  history: WorkGraphFailureRecord[],
  fingerprint: string,
  policy: WorkGraphRetryPolicy
): WorkGraphFailureDisposition {
  if (
    !Number.isInteger(policy.max_attempts)
    || !Number.isInteger(policy.max_same_error_attempts)
    || policy.max_attempts < 1
    || policy.max_same_error_attempts < 1
  ) {
    throw new Error("工作图重试上限必须为正整数");
  }
  const totalAttempts = history.length + 1;
  if (totalAttempts >= policy.max_attempts) return "blocked";

  let consecutiveSameError = 1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.fingerprint !== fingerprint) break;
    consecutiveSameError += 1;
  }
  return consecutiveSameError >= policy.max_same_error_attempts ? "replan" : "retry";
}

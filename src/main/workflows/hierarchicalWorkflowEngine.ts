import type {
  GoalContract,
  HierarchicalAlignmentFinding,
  HierarchicalBlocker,
  HierarchicalExecutionState,
  HierarchicalLoopFrame,
  HierarchicalRequirement,
  HierarchicalWorkPhase,
  HierarchicalWorkUnit,
  KnowledgeFact,
  KnowledgeScope,
  KnowledgeUnknown,
  RequirementAcceptance
} from "../../shared/types.js";

export interface PlannedRequirement {
  id: string;
  source_anchor: string;
  observable_result: string;
  acceptance: string[];
  dependencies: string[];
}

export interface KnowledgeDelta {
  add_facts?: Array<{
    id: string;
    scope: KnowledgeScope;
    claim: string;
    evidence_refs: string[];
    supersedes_fact_ids?: string[];
  }>;
  dispute_fact_ids?: string[];
  add_unknowns?: Array<{
    id: string;
    scope: KnowledgeScope;
    question: string;
    blocks_phase?: HierarchicalWorkPhase;
  }>;
  resolve_unknowns?: Array<{
    id: string;
    resolution_fact_ids: string[];
  }>;
}

export type HierarchicalNextOperation =
  | { kind: "run_alignment_batch"; batch_id: string; source_refs: string[]; attempt: number }
  | { kind: "run_planner" }
  | { kind: "activate_requirement"; requirement_id: string }
  | {
      kind: "run_phase";
      requirement_id: string;
      work_unit_id: string;
      phase: Exclude<HierarchicalWorkPhase, "close">;
      role: string;
    }
  | { kind: "close_requirement"; requirement_id: string }
  | { kind: "run_integrator" }
  | { kind: "wait_for_user"; blocker_id: string }
  | { kind: "blocked"; blocker_id: string }
  | { kind: "system_fault"; blocker_id: string }
  | { kind: "complete" };

export type HierarchicalEvent =
  | {
      type: "alignment_sources_registered";
      batches: Array<{ id: string; source_refs: string[] }>;
      occurred_at?: string;
    }
  | { type: "alignment_batch_started"; batch_id: string; occurred_at?: string }
  | {
      type: "alignment_batch_passed";
      batch_id: string;
      summary: string;
      findings: HierarchicalAlignmentFinding[];
      evidence_refs: string[];
      occurred_at?: string;
    }
  | {
      type: "alignment_batch_failed";
      batch_id: string;
      reason: string;
      route: "retry" | "blocked";
      error_fingerprint?: string;
      occurred_at?: string;
    }
  | {
      type: "planner_failed";
      reason: string;
      error_fingerprint?: string;
      occurred_at?: string;
    }
  | {
      type: "plan_accepted";
      requirements: PlannedRequirement[];
      definition_of_done?: string[];
      occurred_at?: string;
    }
  | { type: "requirements_appended"; requirements: PlannedRequirement[]; occurred_at?: string }
  | { type: "requirement_activated"; requirement_id: string; occurred_at?: string }
  | { type: "phase_started"; work_unit_id: string; occurred_at?: string }
  | {
      type: "phase_passed";
      work_unit_id: string;
      summary?: string;
      handoff?: Record<string, unknown>;
      evidence_refs: string[];
      allowed_files?: string[];
      acceptance_results?: Array<{
        acceptance_id: string;
        status: "pass" | "fail";
        evidence_refs: string[];
      }>;
      occurred_at?: string;
    }
  | {
      type: "phase_failed";
      work_unit_id: string;
      reason: string;
      route: "retry" | "investigate" | "prepare" | "implement" | "blocked";
      error_fingerprint?: string;
      rejected_output?: string;
      occurred_at?: string;
    }
  | { type: "requirement_closed"; requirement_id: string; occurred_at?: string }
  | { type: "integration_started"; occurred_at?: string }
  | {
      type: "integration_passed";
      evidence_refs: string[];
      contract_results: Array<{
        requirement_id: string;
        obligation_id: string;
        status: "pass" | "fail";
        observed_behavior: string;
        evidence_refs: string[];
      }>;
      occurred_at?: string;
    }
  | {
      type: "integration_failed";
      reason: string;
      requirement_id?: string;
      route?: "investigate" | "prepare";
      occurred_at?: string;
    }
  | { type: "blocker_raised"; blocker: HierarchicalBlocker; occurred_at?: string }
  | { type: "blocker_resolved"; blocker_id: string; occurred_at?: string }
  | { type: "knowledge_delta_committed"; delta: KnowledgeDelta; occurred_at?: string };

const ROLE_BY_PHASE: Record<Exclude<HierarchicalWorkPhase, "close">, string> = {
  investigate: "code-investigator",
  prepare: "implementation-preparer",
  implement: "task-executor",
  verify: "task-verifier"
};

const NEXT_PHASE: Record<Exclude<HierarchicalWorkPhase, "close">, HierarchicalWorkPhase> = {
  investigate: "prepare",
  prepare: "implement",
  implement: "verify",
  verify: "close"
};

export function createHierarchicalExecutionState(
  taskPrompt: string,
  options: {
    now?: string;
    source_refs?: string[];
    definition_of_done?: string[];
  } = {}
): HierarchicalExecutionState {
  const now = options.now ?? new Date().toISOString();
  const statement = taskPrompt.trim() || "完成用户请求";
  return {
    version: 1,
    goal: {
      id: "G1",
      statement,
      source_refs: options.source_refs ?? ["initial_user_message"],
      definition_of_done: options.definition_of_done ?? [],
      revision: 1
    },
    macro_phase: "align",
    alignment_batches: [],
    requirements: [],
    knowledge: {
      revision: 0,
      facts: [],
      unknowns: []
    },
    blockers: [],
    phase_runs: [],
    phase_artifacts: [],
    workspace_revision: 0,
    integration_status: "pending",
    integration_evidence_refs: [],
    created_at: now,
    updated_at: now
  };
}

export function applyHierarchicalEvent(
  state: HierarchicalExecutionState,
  event: HierarchicalEvent
): HierarchicalExecutionState {
  const next = structuredClone(state);
  const now = event.occurred_at ?? new Date().toISOString();

  switch (event.type) {
    case "alignment_sources_registered":
      registerAlignmentSources(next, event.batches);
      break;
    case "alignment_batch_started":
      startAlignmentBatch(next, event.batch_id);
      break;
    case "alignment_batch_passed":
      passAlignmentBatch(next, event.batch_id, event.summary, event.findings, event.evidence_refs);
      break;
    case "alignment_batch_failed":
      failAlignmentBatch(next, event.batch_id, event.reason, event.route, event.error_fingerprint);
      break;
    case "planner_failed":
      recordPlannerFailure(next, event.reason, event.error_fingerprint);
      break;
    case "plan_accepted":
      applyAcceptedPlan(next, event.requirements, event.definition_of_done);
      break;
    case "requirements_appended":
      appendDiscoveredRequirements(next, event.requirements);
      break;
    case "requirement_activated":
      activateRequirement(next, event.requirement_id);
      break;
    case "phase_started":
      startPhase(next, event.work_unit_id, now);
      break;
    case "phase_passed":
      passPhase(next, event, now);
      break;
    case "phase_failed":
      failPhase(next, event, now);
      break;
    case "requirement_closed":
      closeRequirement(next, event.requirement_id);
      break;
    case "integration_started":
      if (!allRequirementsClosed(next)) {
        throw new Error("仍有未关闭需求，不能开始全局集成审计");
      }
      next.macro_phase = "integrate";
      next.integration_status = "running";
      next.integration_evidence_refs = [];
      break;
    case "integration_passed":
      if (event.evidence_refs.length === 0) {
        throw new Error("全局集成审计通过必须包含证据引用");
      }
      if (next.integration_status !== "running") {
        throw new Error("全局集成审计尚未开始");
      }
      next.integration_status = "passed";
      next.integration_evidence_refs = unique(event.evidence_refs);
      next.macro_phase = "complete";
      break;
    case "integration_failed":
      if (next.integration_status !== "running") {
        throw new Error("全局集成审计尚未开始");
      }
      next.integration_status = "failed";
      next.macro_phase = "integrate";
      if (event.requirement_id || event.route) {
        if (!event.requirement_id || !event.route) {
          throw new Error("全局审计返工必须同时指定 requirement_id 和 route");
        }
        reopenRequirementFromIntegration(next, event.requirement_id, event.route, event.reason);
      }
      break;
    case "blocker_raised":
      validateBlocker(event.blocker);
      if (next.blockers.some((blocker) => blocker.id === event.blocker.id)) {
        throw new Error(`阻塞项 ID 重复：${event.blocker.id}`);
      }
      next.blockers.push({ ...event.blocker, created_at: event.blocker.created_at || now });
      break;
    case "blocker_resolved": {
      const blocker = next.blockers.find((item) => item.id === event.blocker_id);
      if (!blocker) throw new Error(`阻塞项不存在：${event.blocker_id}`);
      blocker.status = "resolved";
      blocker.resolved_at = now;
      if (blocker.requirement_id) {
        const requirement = next.requirements.find((item) => item.id === blocker.requirement_id);
        if (requirement?.status === "blocked") {
          requirement.status = "active";
          requirement.status_reason = "阻塞项已解决，恢复原阶段";
        }
      }
      if (blocker.alignment_batch_id) {
        const batch = next.alignment_batches.find((item) => item.id === blocker.alignment_batch_id);
        if (batch?.status === "blocked") {
          batch.status = "pending";
          batch.attempt += 1;
          batch.failure_reason = undefined;
        }
      }
      if (blocker.work_unit_id && next.active_work_unit?.id === blocker.work_unit_id) {
        if (next.active_work_unit.status === "blocked") {
          next.active_work_unit.status = "ready";
          next.active_work_unit.attempt += 1;
          next.active_work_unit.failure_reason = undefined;
          next.active_work_unit.completed_at = undefined;
        }
      }
      break;
    }
    case "knowledge_delta_committed":
      applyKnowledgeDelta(next, event.delta, now);
      break;
  }

  next.updated_at = now;
  return next;
}

export function deriveHierarchicalNextOperation(
  state: HierarchicalExecutionState
): HierarchicalNextOperation {
  const openBlockers = state.blockers.filter((blocker) => blocker.status === "open");
  const hostFault = openBlockers.find((blocker) =>
    blocker.kind === "orchestration_fault"
    || blocker.kind === "agent_failed"
    || blocker.kind === "service_interrupted"
  );
  if (hostFault) return { kind: "system_fault", blocker_id: hostFault.id };

  const userBlocker = openBlockers.find(mayAskHumanForBlocker);
  if (userBlocker) return { kind: "wait_for_user", blocker_id: userBlocker.id };

  const internalBlocker = openBlockers[0];
  if (internalBlocker) return { kind: "blocked", blocker_id: internalBlocker.id };

  if (state.macro_phase === "complete") return { kind: "complete" };
  if (state.requirements.length === 0) {
    const batch = state.alignment_batches.find((item) => item.status === "running")
      ?? state.alignment_batches.find((item) => item.status === "pending");
    if (batch) {
      return {
        kind: "run_alignment_batch",
        batch_id: batch.id,
        source_refs: [...batch.source_refs],
        attempt: batch.attempt
      };
    }
    return { kind: "run_planner" };
  }

  const active = state.requirements.find((requirement) => requirement.id === state.active_requirement_id);
  if (!active) {
    const ready = selectReadyRequirement(state);
    if (ready) return { kind: "activate_requirement", requirement_id: ready.id };
    if (allRequirementsClosed(state)) return { kind: "run_integrator" };
    const blocked = state.requirements.filter((requirement) => requirement.status === "blocked");
    throw new Error(
      blocked.length > 0
        ? `没有可执行需求；阻塞项：${blocked.map((requirement) => requirement.id).join(", ")}`
        : "没有 dependency-ready 的需求；请检查依赖关系"
    );
  }

  const phase = active.current_phase;
  if (!phase) throw new Error(`活动需求 ${active.id} 缺少当前阶段`);
  if (phase === "close") return { kind: "close_requirement", requirement_id: active.id };

  const workUnit = state.active_work_unit;
  if (!workUnit || workUnit.requirement_id !== active.id || workUnit.phase !== phase) {
    throw new Error(`活动需求 ${active.id} 的工作单元与阶段不一致`);
  }
  if (workUnit.status === "blocked") {
    throw new Error(`当前工作单元 ${workUnit.id} 已阻塞`);
  }
  return {
    kind: "run_phase",
    requirement_id: active.id,
    work_unit_id: workUnit.id,
    phase,
    role: ROLE_BY_PHASE[phase]
  };
}

export function deriveHierarchicalLoopStack(
  state: HierarchicalExecutionState
): HierarchicalLoopFrame[] {
  const completedRequirements = state.requirements.filter(isRequirementClosed).length;
  const frames: HierarchicalLoopFrame[] = [{
    kind: "goal",
    id: state.goal.id,
    objective: state.goal.statement,
    status: `${state.macro_phase} · ${completedRequirements}/${state.requirements.length}`
  }];
  if (state.requirements.length === 0) {
    const batch = state.alignment_batches.find((item) => item.status === "running")
      ?? state.alignment_batches.find((item) => item.status === "pending");
    if (batch) {
      frames.push({
        kind: "phase",
        id: batch.id,
        objective: `分批摄取 ${batch.source_refs.length} 个附件来源`,
        status: `${batch.status} · attempt ${batch.attempt}`
      });
    }
    return frames;
  }
  const requirement = state.requirements.find((item) => item.id === state.active_requirement_id);
  if (!requirement) return frames;
  frames.push({
    kind: "requirement",
    id: requirement.id,
    objective: requirement.observable_result,
    status: requirement.status
  });
  if (!state.active_work_unit) return frames;
  frames.push({
    kind: "phase",
    id: state.active_work_unit.phase,
    objective: phaseObjective(state.active_work_unit.phase),
    status: state.active_work_unit.status
  });
  frames.push({
    kind: "action",
    id: state.active_work_unit.id,
    objective: `${state.active_work_unit.assigned_role} 完成当前阶段出口契约`,
    status: `attempt ${state.active_work_unit.attempt}`
  });
  return frames;
}

export function evaluateHierarchicalCompletion(
  state: HierarchicalExecutionState
): string[] {
  const reasons: string[] = [];
  if (state.requirements.length === 0) reasons.push("尚未建立稳定需求账本");
  const unfinished = state.requirements.filter((requirement) => !isRequirementClosed(requirement));
  if (unfinished.length > 0) {
    reasons.push(`仍有未关闭需求：${unfinished.map((requirement) => `${requirement.id}(${requirement.status})`).join(", ")}`);
  }
  const incompleteAcceptance = state.requirements.flatMap((requirement) =>
    requirement.status === "skipped"
      ? []
      : requirement.acceptance
          .filter((acceptance) => acceptance.status !== "pass")
          .map((acceptance) => `${requirement.id}/${acceptance.id}(${acceptance.status})`)
  );
  if (incompleteAcceptance.length > 0) {
    reasons.push(`仍有验收项未通过：${incompleteAcceptance.join(", ")}`);
  }
  if (state.blockers.some((blocker) => blocker.status === "open")) {
    reasons.push("仍有未解决阻塞项");
  }
  if (state.integration_status !== "passed") reasons.push("全局集成审计尚未通过");
  if (state.macro_phase !== "complete") reasons.push(`总体循环尚未完成：${state.macro_phase}`);
  return reasons;
}

export function mayAskHumanForBlocker(blocker: HierarchicalBlocker): boolean {
  return blocker.status === "open"
    && blocker.owner === "user"
    && blocker.user_input_required === true
    && (blocker.kind === "user_decision" || blocker.kind === "external_resource_missing");
}

function registerAlignmentSources(
  state: HierarchicalExecutionState,
  batches: Array<{ id: string; source_refs: string[] }>
): void {
  if (state.requirements.length > 0 || state.macro_phase !== "align") {
    throw new Error("需求账本建立后不能再注册附件摄取批次");
  }
  if (batches.length === 0) return;
  const knownIds = new Set(state.alignment_batches.map((batch) => batch.id));
  const knownSources = new Set(state.alignment_batches.flatMap((batch) => batch.source_refs));
  for (const batch of batches) {
    if (!/^A[1-9]\d*$/.test(batch.id)) throw new Error(`附件摄取批次 ID 非法：${batch.id}`);
    if (knownIds.has(batch.id)) throw new Error(`附件摄取批次 ID 重复：${batch.id}`);
    if (batch.source_refs.length === 0) throw new Error(`附件摄取批次 ${batch.id} 没有来源`);
    const sources = unique(batch.source_refs.map((source) => source.trim()).filter(Boolean));
    if (sources.length !== batch.source_refs.length) throw new Error(`附件摄取批次 ${batch.id} 含空值或重复来源`);
    const duplicateSource = sources.find((source) => knownSources.has(source));
    if (duplicateSource) throw new Error(`附件来源被重复注册：${duplicateSource}`);
    state.alignment_batches.push({
      id: batch.id,
      source_refs: sources,
      status: "pending",
      attempt: 1,
      consecutive_failure_count: 0,
      findings: [],
      evidence_refs: []
    });
    knownIds.add(batch.id);
    for (const source of sources) knownSources.add(source);
  }
}

function requireAlignmentBatch(state: HierarchicalExecutionState, batchId: string) {
  const batch = state.alignment_batches.find((item) => item.id === batchId);
  if (!batch) throw new Error(`附件摄取批次不存在：${batchId}`);
  return batch;
}

function startAlignmentBatch(state: HierarchicalExecutionState, batchId: string): void {
  const batch = requireAlignmentBatch(state, batchId);
  if (batch.status !== "pending") throw new Error(`附件摄取批次 ${batchId} 当前不能启动：${batch.status}`);
  batch.status = "running";
  batch.failure_reason = undefined;
}

function passAlignmentBatch(
  state: HierarchicalExecutionState,
  batchId: string,
  summary: string,
  findings: HierarchicalAlignmentFinding[],
  evidenceRefs: string[]
): void {
  const batch = requireAlignmentBatch(state, batchId);
  if (batch.status !== "running") throw new Error(`附件摄取批次 ${batchId} 尚未启动`);
  if (!summary.trim()) throw new Error(`附件摄取批次 ${batchId} 缺少摘要`);
  if (evidenceRefs.length === 0) throw new Error(`附件摄取批次 ${batchId} 缺少来源证据`);
  for (const [index, finding] of findings.entries()) {
    if (!finding.source_anchor.trim()) throw new Error(`${batchId}.findings[${index}] 缺少来源锚点`);
    if (!finding.observable_result.trim()) throw new Error(`${batchId}.findings[${index}] 缺少可观察结果`);
    if (finding.acceptance.length === 0 || finding.acceptance.some((item) => !item.trim())) {
      throw new Error(`${batchId}.findings[${index}] 缺少验收标准`);
    }
  }
  batch.status = "completed";
  batch.summary = summary.trim();
  batch.findings = structuredClone(findings);
  batch.evidence_refs = unique(evidenceRefs);
  batch.failure_reason = undefined;
  batch.error_fingerprint = undefined;
  batch.consecutive_failure_count = 0;
}

function failAlignmentBatch(
  state: HierarchicalExecutionState,
  batchId: string,
  reason: string,
  route: "retry" | "blocked",
  errorFingerprint?: string
): void {
  const batch = requireAlignmentBatch(state, batchId);
  if (batch.status !== "running") throw new Error(`附件摄取批次 ${batchId} 尚未启动`);
  if (!reason.trim()) throw new Error(`附件摄取批次 ${batchId} 缺少失败原因`);
  batch.failure_reason = reason.trim();
  batch.consecutive_failure_count = errorFingerprint && batch.error_fingerprint === errorFingerprint
    ? batch.consecutive_failure_count + 1
    : 1;
  batch.error_fingerprint = errorFingerprint;
  batch.status = route === "retry" ? "pending" : "blocked";
  if (route === "retry") batch.attempt += 1;
}

function applyAcceptedPlan(
  state: HierarchicalExecutionState,
  requirements: PlannedRequirement[],
  definitionOfDone?: string[]
): void {
  if (state.requirements.length > 0) throw new Error("需求账本已建立，不能重复接管计划");
  const incompleteBatches = state.alignment_batches.filter((batch) => batch.status !== "completed");
  if (incompleteBatches.length > 0) {
    throw new Error(`附件摄取尚未完成：${incompleteBatches.map((batch) => batch.id).join(", ")}`);
  }
  validatePlannedRequirements(requirements);
  state.requirements = requirements.map(toRequirement);
  if (definitionOfDone && definitionOfDone.length > 0) {
    state.goal.definition_of_done = [...definitionOfDone];
  }
  state.planner_retry = undefined;
  state.macro_phase = "deliver";
}

function recordPlannerFailure(
  state: HierarchicalExecutionState,
  reason: string,
  errorFingerprint?: string
): void {
  if (state.requirements.length > 0 || state.macro_phase !== "align") {
    throw new Error("需求账本建立后不能记录 planner 失败");
  }
  const failureReason = reason.trim();
  if (!failureReason) throw new Error("planner 失败原因不能为空");
  const previous = state.planner_retry;
  state.planner_retry = {
    attempt: (previous?.attempt ?? 1) + 1,
    failure_reason: failureReason,
    error_fingerprint: errorFingerprint,
    consecutive_failure_count: errorFingerprint && previous?.error_fingerprint === errorFingerprint
      ? previous.consecutive_failure_count + 1
      : 1
  };
}

function appendDiscoveredRequirements(
  state: HierarchicalExecutionState,
  requirements: PlannedRequirement[]
): void {
  if (state.requirements.length === 0) throw new Error("尚未建立初始需求账本，不能追加需求");
  if (state.macro_phase !== "deliver") throw new Error(`当前宏阶段不能追加需求：${state.macro_phase}`);
  if (requirements.length === 0) throw new Error("追加需求列表不能为空");
  const combined: PlannedRequirement[] = [
    ...state.requirements.map((requirement) => ({
      id: requirement.id,
      source_anchor: requirement.source_anchor,
      observable_result: requirement.observable_result,
      acceptance: requirement.acceptance.map((item) => item.criterion),
      dependencies: [...requirement.dependencies]
    })),
    ...requirements
  ];
  validatePlannedRequirements(combined);
  state.requirements.push(...requirements.map(toRequirement));
}

function validatePlannedRequirements(requirements: PlannedRequirement[]): void {
  if (requirements.length === 0) throw new Error("计划必须包含至少一个需求点");
  const ids = requirements.map((requirement) => requirement.id.trim());
  if (ids.some((id) => !id)) throw new Error("需求 ID 不能为空");
  if (ids.some((id) => !/^R[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))) {
    throw new Error("需求 ID 必须是稳定 R-ID（例如 R1、R33-login），不得使用 knowledge revision 或过程动作命名");
  }
  if (new Set(ids).size !== ids.length) throw new Error("需求 ID 重复");
  const known = new Set(ids);
  for (const requirement of requirements) {
    if (!requirement.source_anchor.trim()) throw new Error(`需求 ${requirement.id} 缺少来源锚点`);
    if (!requirement.observable_result.trim()) throw new Error(`需求 ${requirement.id} 缺少可观察结果`);
    if (requirement.acceptance.length === 0) throw new Error(`需求 ${requirement.id} 缺少验收标准`);
    for (const dependency of requirement.dependencies) {
      if (!known.has(dependency)) throw new Error(`需求 ${requirement.id} 依赖不存在的需求 ${dependency}`);
      if (dependency === requirement.id) throw new Error(`需求 ${requirement.id} 不能依赖自身`);
    }
  }
  if (!hasValidRequirementOrder(requirements)) throw new Error("需求依赖存在循环");
}

function toRequirement(requirement: PlannedRequirement): HierarchicalRequirement {
  return {
    id: requirement.id,
    source_anchor: requirement.source_anchor,
    observable_result: requirement.observable_result,
    acceptance: requirement.acceptance.map((criterion, index): RequirementAcceptance => ({
      id: `${requirement.id}-A${index + 1}`,
      criterion,
      status: "pending",
      evidence_refs: []
    })),
    dependencies: [...requirement.dependencies],
    status: "pending",
    evidence_refs: []
  };
}

function activateRequirement(state: HierarchicalExecutionState, requirementId: string): void {
  if (state.active_requirement_id) throw new Error(`已有活动需求：${state.active_requirement_id}`);
  const requirement = requireRequirement(state, requirementId);
  if (requirement.status !== "pending") throw new Error(`需求 ${requirementId} 当前不是 pending`);
  const unmet = requirement.dependencies.filter((dependencyId) =>
    state.requirements.find((item) => item.id === dependencyId)?.status !== "completed"
  );
  if (unmet.length > 0) throw new Error(`需求 ${requirementId} 仍有未完成依赖：${unmet.join(", ")}`);
  requirement.status = "active";
  requirement.current_phase = "investigate";
  state.active_requirement_id = requirement.id;
  state.active_work_unit = createWorkUnit(state, requirement.id, "investigate", 1, []);
  state.macro_phase = "deliver";
}

function startPhase(state: HierarchicalExecutionState, workUnitId: string, now: string): void {
  const workUnit = requireWorkUnit(state, workUnitId);
  if (workUnit.status !== "ready" && workUnit.status !== "failed") {
    throw new Error(`工作单元 ${workUnitId} 当前不能启动：${workUnit.status}`);
  }
  workUnit.status = "running";
  workUnit.started_at = now;
  workUnit.completed_at = undefined;
  state.phase_runs.push({
    id: `${workUnit.id}:attempt-${workUnit.attempt}`,
    work_unit_id: workUnit.id,
    requirement_id: workUnit.requirement_id,
    phase: workUnit.phase,
    role: workUnit.assigned_role,
    attempt: workUnit.attempt,
    status: "running",
    evidence_refs: [],
    started_at: now
  });
}

function passPhase(
  state: HierarchicalExecutionState,
  event: Extract<HierarchicalEvent, { type: "phase_passed" }>,
  now: string
): void {
  const workUnit = requireWorkUnit(state, event.work_unit_id);
  if (workUnit.status !== "running") throw new Error(`工作单元 ${workUnit.id} 尚未运行`);
  if (event.evidence_refs.length === 0) throw new Error(`阶段 ${workUnit.phase} 通过必须包含证据引用`);
  const requirement = requireRequirement(state, workUnit.requirement_id);

  if (workUnit.phase === "verify") {
    applyAcceptanceResults(requirement, event.acceptance_results ?? []);
    const notPassed = requirement.acceptance.filter((acceptance) => acceptance.status !== "pass");
    if (notPassed.length > 0) {
      throw new Error(`验证阶段不能通过；未 PASS：${notPassed.map((item) => item.id).join(", ")}`);
    }
  }
  const changeDisposition = workUnit.phase === "prepare"
    && event.handoff
    && typeof event.handoff.change_disposition === "string"
    ? event.handoff.change_disposition
    : undefined;
  if (
    workUnit.phase === "prepare"
    && changeDisposition !== "already_satisfied"
    && (!event.allowed_files || event.allowed_files.length === 0)
  ) {
    throw new Error("prepare 判定需要修改时必须签发非空 allowed_files 写权限租约");
  }
  if (
    workUnit.phase === "prepare"
    && changeDisposition === "already_satisfied"
    && (event.allowed_files?.length ?? 0) > 0
  ) {
    throw new Error("prepare 的 already_satisfied 路径不得签发写权限租约");
  }

  workUnit.status = "passed";
  workUnit.completed_at = now;
  requirement.evidence_refs = unique([...requirement.evidence_refs, ...event.evidence_refs]);
  settleCurrentPhaseRun(state, workUnit.id, "passed", now, event.evidence_refs);
  if (workUnit.phase === "implement") state.workspace_revision += 1;
  const artifactId = `${workUnit.id}:attempt-${workUnit.attempt}:artifact`;
  state.phase_artifacts.push({
    id: artifactId,
    work_unit_id: workUnit.id,
    requirement_id: requirement.id,
    phase: workUnit.phase as Exclude<HierarchicalWorkPhase, "close">,
    attempt: workUnit.attempt,
    summary: event.summary?.trim() || `${workUnit.phase} 阶段已通过`,
    handoff: event.handoff ?? {},
    evidence_refs: unique(event.evidence_refs),
    knowledge_revision: state.knowledge.revision,
    workspace_revision: state.workspace_revision,
    created_at: now
  });
  const settledRun = [...state.phase_runs].reverse().find((run) =>
    run.work_unit_id === workUnit.id && run.attempt === workUnit.attempt && run.status === "passed"
  );
  if (settledRun) settledRun.artifact_id = artifactId;

  const nextPhase = workUnit.phase === "prepare" && changeDisposition === "already_satisfied"
    ? "verify"
    : NEXT_PHASE[workUnit.phase as Exclude<HierarchicalWorkPhase, "close">];
  requirement.current_phase = nextPhase;
  if (nextPhase === "close") {
    state.active_work_unit = undefined;
    return;
  }
  const allowedFiles = event.allowed_files ?? workUnit.allowed_files;
  state.active_work_unit = createWorkUnit(state, requirement.id, nextPhase, 1, allowedFiles);
}

function failPhase(
  state: HierarchicalExecutionState,
  event: Extract<HierarchicalEvent, { type: "phase_failed" }>,
  now: string
): void {
  const workUnit = requireWorkUnit(state, event.work_unit_id);
  if (workUnit.status !== "running") throw new Error(`工作单元 ${workUnit.id} 尚未运行`);
  const requirement = requireRequirement(state, workUnit.requirement_id);
  workUnit.status = event.route === "blocked" ? "blocked" : "failed";
  workUnit.completed_at = now;
  workUnit.failure_reason = event.reason;
  workUnit.correction_history = unique([
    ...(workUnit.correction_history ?? []),
    event.reason
  ]).slice(-4);
  if (event.rejected_output) workUnit.last_rejected_output = event.rejected_output;
  settleCurrentPhaseRun(state, workUnit.id, "failed", now, [], event.error_fingerprint, event.reason);

  if (event.route === "blocked") {
    requirement.status = "blocked";
    requirement.status_reason = event.reason;
    return;
  }
  if (event.route === "retry") {
    workUnit.status = "ready";
    workUnit.attempt += 1;
    return;
  }
  if (workUnit.phase === "verify") {
    for (const acceptance of requirement.acceptance) {
      acceptance.status = "pending";
      acceptance.evidence_refs = [];
    }
  }
  requirement.current_phase = event.route;
  const recoveryWorkUnit = createWorkUnit(
    state,
    requirement.id,
    event.route,
    1,
    event.route === "implement" ? workUnit.allowed_files : []
  );
  recoveryWorkUnit.failure_reason = `下游 ${workUnit.phase} 未通过：${event.reason}`;
  recoveryWorkUnit.correction_history = [...(workUnit.correction_history ?? [])];
  recoveryWorkUnit.last_rejected_output = workUnit.last_rejected_output;
  state.active_work_unit = recoveryWorkUnit;
}

function closeRequirement(state: HierarchicalExecutionState, requirementId: string): void {
  if (state.active_requirement_id !== requirementId) throw new Error(`需求 ${requirementId} 不是当前活动需求`);
  const requirement = requireRequirement(state, requirementId);
  if (requirement.current_phase !== "close") throw new Error(`需求 ${requirementId} 尚未进入 close`);
  const notPassed = requirement.acceptance.filter((acceptance) => acceptance.status !== "pass");
  if (notPassed.length > 0) throw new Error(`需求 ${requirementId} 仍有未通过验收项`);
  requirement.status = "completed";
  requirement.current_phase = undefined;
  requirement.status_reason = "所有验收项已由独立验证证据关闭";
  state.active_requirement_id = undefined;
  state.active_work_unit = undefined;
  state.macro_phase = allRequirementsClosed(state) ? "integrate" : "deliver";
}

function reopenRequirementFromIntegration(
  state: HierarchicalExecutionState,
  requirementId: string,
  route: "investigate" | "prepare",
  reason: string
): void {
  if (state.active_requirement_id) throw new Error(`已有活动需求：${state.active_requirement_id}`);
  const requirement = requireRequirement(state, requirementId);
  if (requirement.status !== "completed") {
    throw new Error(`全局审计只能重开已完成需求：${requirementId}(${requirement.status})`);
  }
  requirement.status = "active";
  requirement.current_phase = route;
  requirement.status_reason = `全局审计退回：${reason}`;
  requirement.evidence_refs = [];
  for (const acceptance of requirement.acceptance) {
    acceptance.status = "pending";
    acceptance.evidence_refs = [];
  }
  state.active_requirement_id = requirement.id;
  state.active_work_unit = createWorkUnit(state, requirement.id, route, 1, []);
  state.macro_phase = "deliver";

  const invalidated = new Set([requirementId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const dependent of state.requirements) {
      if (invalidated.has(dependent.id)) continue;
      if (!dependent.dependencies.some((dependency) => invalidated.has(dependency))) continue;
      invalidated.add(dependent.id);
      changed = true;
      if (dependent.status === "completed") {
        dependent.status = "pending";
        dependent.current_phase = undefined;
        dependent.status_reason = `依赖 ${requirementId} 被全局审计重开，原验收证据失效`;
        dependent.evidence_refs = [];
        for (const acceptance of dependent.acceptance) {
          acceptance.status = "pending";
          acceptance.evidence_refs = [];
        }
      }
    }
  }
}

function applyAcceptanceResults(
  requirement: HierarchicalRequirement,
  results: NonNullable<Extract<HierarchicalEvent, { type: "phase_passed" }>["acceptance_results"]>
): void {
  const seen = new Set<string>();
  for (const result of results) {
    if (seen.has(result.acceptance_id)) throw new Error(`验收结果重复：${result.acceptance_id}`);
    seen.add(result.acceptance_id);
    const acceptance = requirement.acceptance.find((item) => item.id === result.acceptance_id);
    if (!acceptance) throw new Error(`验收项不存在：${result.acceptance_id}`);
    if (result.evidence_refs.length === 0) throw new Error(`验收项 ${result.acceptance_id} 缺少证据`);
    acceptance.status = result.status;
    acceptance.evidence_refs = unique([...acceptance.evidence_refs, ...result.evidence_refs]);
  }
}

function applyKnowledgeDelta(state: HierarchicalExecutionState, delta: KnowledgeDelta, now: string): void {
  const factIds = new Set(state.knowledge.facts.map((fact) => fact.id));
  const newFactIds = new Set<string>();
  for (const addition of delta.add_facts ?? []) {
    if (factIds.has(addition.id) || newFactIds.has(addition.id)) throw new Error(`知识事实 ID 重复：${addition.id}`);
    if (!addition.claim.trim()) throw new Error(`知识事实 ${addition.id} 内容为空`);
    if (addition.evidence_refs.length === 0) throw new Error(`知识事实 ${addition.id} 缺少证据引用`);
    validateKnowledgeScope(state, addition.scope, addition.id);
    for (const supersededId of addition.supersedes_fact_ids ?? []) {
      const oldFact = state.knowledge.facts.find((fact) => fact.id === supersededId);
      if (!oldFact) throw new Error(`待替代事实不存在：${supersededId}`);
      oldFact.status = "superseded";
      oldFact.superseded_by = addition.id;
    }
    const fact: KnowledgeFact = {
      id: addition.id,
      scope: addition.scope,
      claim: addition.claim,
      status: "active",
      evidence_refs: unique(addition.evidence_refs),
      created_at: now
    };
    state.knowledge.facts.push(fact);
    newFactIds.add(addition.id);
  }
  for (const disputedId of delta.dispute_fact_ids ?? []) {
    const fact = state.knowledge.facts.find((item) => item.id === disputedId);
    if (!fact) throw new Error(`待争议事实不存在：${disputedId}`);
    fact.status = "disputed";
  }

  const unknownIds = new Set(state.knowledge.unknowns.map((unknown) => unknown.id));
  for (const addition of delta.add_unknowns ?? []) {
    if (unknownIds.has(addition.id)) throw new Error(`未知项 ID 重复：${addition.id}`);
    if (!addition.question.trim()) throw new Error(`未知项 ${addition.id} 内容为空`);
    validateKnowledgeScope(state, addition.scope, addition.id);
    const unknown: KnowledgeUnknown = {
      id: addition.id,
      scope: addition.scope,
      question: addition.question,
      status: "open",
      ...(addition.blocks_phase ? { blocks_phase: addition.blocks_phase } : {}),
      resolution_fact_ids: [],
      created_at: now
    };
    state.knowledge.unknowns.push(unknown);
    unknownIds.add(addition.id);
  }
  for (const resolution of delta.resolve_unknowns ?? []) {
    const unknown = state.knowledge.unknowns.find((item) => item.id === resolution.id);
    if (!unknown) throw new Error(`待解决未知项不存在：${resolution.id}`);
    if (resolution.resolution_fact_ids.length === 0) throw new Error(`未知项 ${resolution.id} 缺少解决事实`);
    for (const factId of resolution.resolution_fact_ids) {
      const fact = state.knowledge.facts.find((item) => item.id === factId);
      if (!fact || fact.status !== "active") throw new Error(`未知项 ${resolution.id} 引用了非 active 事实 ${factId}`);
    }
    unknown.status = "resolved";
    unknown.resolution_fact_ids = unique(resolution.resolution_fact_ids);
    unknown.resolved_at = now;
  }
  state.knowledge.revision += 1;
}

function validateKnowledgeScope(state: HierarchicalExecutionState, scope: KnowledgeScope, itemId: string): void {
  if (scope.goal_id !== state.goal.id) throw new Error(`知识项 ${itemId} 引用了错误 Goal：${scope.goal_id}`);
  if (scope.requirement_id && !state.requirements.some((requirement) => requirement.id === scope.requirement_id)) {
    throw new Error(`知识项 ${itemId} 引用了不存在的需求：${scope.requirement_id}`);
  }
  if (
    scope.work_unit_id
    && state.active_work_unit?.id !== scope.work_unit_id
    && !state.phase_runs.some((run) => run.work_unit_id === scope.work_unit_id)
  ) {
    throw new Error(`知识项 ${itemId} 引用了不存在的工作单元：${scope.work_unit_id}`);
  }
}

function validateBlocker(blocker: HierarchicalBlocker): void {
  if (!blocker.id.trim()) throw new Error("阻塞项 ID 不能为空");
  if (!blocker.message.trim()) throw new Error(`阻塞项 ${blocker.id} 缺少说明`);
  if (blocker.user_input_required && !mayAskHumanForBlocker(blocker)) {
    throw new Error(`阻塞项 ${blocker.id} 不是可询问用户的业务阻塞`);
  }
  if (!blocker.user_input_required && blocker.owner === "user") {
    throw new Error(`用户责任阻塞项 ${blocker.id} 必须明确需要用户输入`);
  }
}

function selectReadyRequirement(state: HierarchicalExecutionState): HierarchicalRequirement | undefined {
  return state.requirements.find((requirement) =>
    requirement.status === "pending"
    && requirement.dependencies.every((dependencyId) =>
      state.requirements.find((item) => item.id === dependencyId)?.status === "completed"
    )
  );
}

function allRequirementsClosed(state: HierarchicalExecutionState): boolean {
  return state.requirements.length > 0 && state.requirements.every(isRequirementClosed);
}

function isRequirementClosed(requirement: HierarchicalRequirement): boolean {
  return requirement.status === "completed" || requirement.status === "skipped";
}

function createWorkUnit(
  state: HierarchicalExecutionState,
  requirementId: string,
  phase: Exclude<HierarchicalWorkPhase, "close">,
  attempt: number,
  allowedFiles: string[]
): HierarchicalWorkUnit {
  return {
    id: `${requirementId}:${phase}`,
    requirement_id: requirementId,
    phase,
    status: "ready",
    assigned_role: ROLE_BY_PHASE[phase],
    attempt,
    baseline_knowledge_revision: state.knowledge.revision,
    allowed_files: unique(allowedFiles)
  };
}

function requireRequirement(state: HierarchicalExecutionState, id: string): HierarchicalRequirement {
  const requirement = state.requirements.find((item) => item.id === id);
  if (!requirement) throw new Error(`需求不存在：${id}`);
  return requirement;
}

function requireWorkUnit(state: HierarchicalExecutionState, id: string): HierarchicalWorkUnit {
  const workUnit = state.active_work_unit;
  if (!workUnit || workUnit.id !== id) throw new Error(`工作单元不存在或不是当前活动单元：${id}`);
  return workUnit;
}

function settleCurrentPhaseRun(
  state: HierarchicalExecutionState,
  workUnitId: string,
  status: "passed" | "failed",
  now: string,
  evidenceRefs: string[],
  errorFingerprint?: string,
  failureReason?: string
): void {
  const run = [...state.phase_runs].reverse().find((item) =>
    item.work_unit_id === workUnitId && item.status === "running"
  );
  if (!run) throw new Error(`工作单元 ${workUnitId} 没有运行中的 PhaseRun`);
  run.status = status;
  run.completed_at = now;
  run.evidence_refs = unique(evidenceRefs);
  if (errorFingerprint) run.error_fingerprint = errorFingerprint;
  if (failureReason) run.failure_reason = failureReason;
}

function hasValidRequirementOrder(requirements: PlannedRequirement[]): boolean {
  const inDegree = new Map(requirements.map((requirement) => [requirement.id, requirement.dependencies.length]));
  const dependents = new Map(requirements.map((requirement) => [requirement.id, [] as string[]]));
  for (const requirement of requirements) {
    for (const dependency of requirement.dependencies) dependents.get(dependency)?.push(requirement.id);
  }
  const queue = requirements.filter((requirement) => requirement.dependencies.length === 0).map((requirement) => requirement.id);
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
  return visited === requirements.length;
}

function phaseObjective(phase: HierarchicalWorkPhase): string {
  switch (phase) {
    case "investigate": return "关闭当前需求的关键未知并定位可复用实现";
    case "prepare": return "建立调用契约、行为快照、文件边界与验证入口";
    case "implement": return "在授权文件范围内完成最小实现并取得真实 diff";
    case "verify": return "逐条核对验收标准和保留行为";
    case "close": return "归并证据并关闭当前需求";
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

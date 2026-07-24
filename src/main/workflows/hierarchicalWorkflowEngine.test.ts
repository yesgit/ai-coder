import { describe, expect, it } from "vitest";
import type { HierarchicalBlocker, HierarchicalExecutionState } from "../../shared/types.js";
import {
  applyHierarchicalEvent,
  createHierarchicalExecutionState,
  deriveHierarchicalLoopStack,
  deriveHierarchicalNextOperation,
  evaluateHierarchicalCompletion,
  mayAskHumanForBlocker,
  type PlannedRequirement
} from "./hierarchicalWorkflowEngine.js";

const NOW = "2026-07-22T00:00:00.000Z";

function plan(): PlannedRequirement[] {
  return [
    {
      id: "R33",
      source_anchor: "附件第 33 页",
      observable_result: "第 33 页定义的入口可以跳转到目标页面",
      acceptance: ["入口映射正确", "保留现有 guard 和参数"],
      dependencies: []
    },
    {
      id: "R34",
      source_anchor: "附件第 34 页",
      observable_result: "第 34 页定义的入口可以跳转到目标页面",
      acceptance: ["入口映射正确"],
      dependencies: ["R33"]
    }
  ];
}

function plannedState(): HierarchicalExecutionState {
  const initial = createHierarchicalExecutionState("实现附件第 33 页开始的所有页面跳转", { now: NOW });
  return applyHierarchicalEvent(initial, {
    type: "plan_accepted",
    requirements: plan(),
    definition_of_done: ["所有附件页面需求均有稳定 R-ID 并逐项验证"],
    occurred_at: NOW
  });
}

function activateR33(state = plannedState()): HierarchicalExecutionState {
  return applyHierarchicalEvent(state, {
    type: "requirement_activated",
    requirement_id: "R33",
    occurred_at: NOW
  });
}

function passCurrentPhase(
  state: HierarchicalExecutionState,
  options: {
    evidence?: string[];
    allowed_files?: string[];
    acceptance_results?: Array<{
      acceptance_id: string;
      status: "pass" | "fail";
      evidence_refs: string[];
    }>;
    handoff?: Record<string, unknown>;
  } = {}
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
    evidence_refs: options.evidence ?? [`E-${workUnit.phase}`],
    allowed_files: options.allowed_files,
    acceptance_results: options.acceptance_results,
    handoff: options.handoff,
    occurred_at: NOW
  });
}

describe("hierarchical workflow engine", () => {
  it("starts from the goal loop and asks the host to run a planner", () => {
    const state = createHierarchicalExecutionState("完成所有页面跳转", { now: NOW });

    expect(state.goal.statement).toBe("完成所有页面跳转");
    expect(state.macro_phase).toBe("align");
    expect(deriveHierarchicalNextOperation(state)).toEqual({ kind: "run_planner" });
    expect(evaluateHierarchicalCompletion(state)).toContain("尚未建立稳定需求账本");
  });

  it("persists planner rejection context for retry and clears it after an accepted plan", () => {
    let state = createHierarchicalExecutionState("从序号 7 开始处理清单", { now: NOW });
    state = applyHierarchicalEvent(state, {
      type: "planner_failed",
      reason: "planner 需求账本遗漏用户范围内业务序号：12",
      error_fingerprint: "missing-sequence",
      occurred_at: NOW
    });

    expect(state.planner_retry).toEqual({
      attempt: 2,
      failure_reason: "planner 需求账本遗漏用户范围内业务序号：12",
      error_fingerprint: "missing-sequence",
      consecutive_failure_count: 1
    });
    expect(deriveHierarchicalNextOperation(state)).toEqual({ kind: "run_planner" });

    state = applyHierarchicalEvent(state, {
      type: "plan_accepted",
      requirements: [{
        id: "R7",
        source_anchor: "序号 7",
        observable_result: "目标 7 可用",
        acceptance: ["目标 7 可验证"],
        dependencies: []
      }, {
        id: "R12",
        source_anchor: "序号 12",
        observable_result: "目标 12 可用",
        acceptance: ["目标 12 可验证"],
        dependencies: []
      }],
      occurred_at: NOW
    });

    expect(state.planner_retry).toBeUndefined();
  });

  it("runs persisted attachment batches before the planner and never reopens completed batches", () => {
    let state = createHierarchicalExecutionState("实现附件中的全部跳转", { now: NOW });
    state = applyHierarchicalEvent(state, {
      type: "alignment_sources_registered",
      batches: [
        { id: "A1", source_refs: ["/project/.ai-coder/uploads/u/page-01.png", "/project/.ai-coder/uploads/u/page-02.png"] },
        { id: "A2", source_refs: ["/project/.ai-coder/uploads/u/page-03.png"] }
      ],
      occurred_at: NOW
    });
    expect(deriveHierarchicalNextOperation(state)).toMatchObject({ kind: "run_alignment_batch", batch_id: "A1" });

    state = applyHierarchicalEvent(state, { type: "alignment_batch_started", batch_id: "A1", occurred_at: NOW });
    state = applyHierarchicalEvent(state, {
      type: "alignment_batch_passed",
      batch_id: "A1",
      summary: "pages 1-2",
      findings: [{ source_anchor: "page 2", observable_result: "入口可跳转", acceptance: ["目标页正确"] }],
      evidence_refs: ["/project/.ai-coder/uploads/u/page-01.png", "/project/.ai-coder/uploads/u/page-02.png"],
      occurred_at: NOW
    });
    expect(deriveHierarchicalNextOperation(state)).toMatchObject({ kind: "run_alignment_batch", batch_id: "A2" });

    state = applyHierarchicalEvent(state, { type: "alignment_batch_started", batch_id: "A2", occurred_at: NOW });
    state = applyHierarchicalEvent(state, {
      type: "alignment_batch_passed",
      batch_id: "A2",
      summary: "page 3",
      findings: [],
      evidence_refs: ["/project/.ai-coder/uploads/u/page-03.png"],
      occurred_at: NOW
    });
    expect(deriveHierarchicalNextOperation(state)).toEqual({ kind: "run_planner" });
    expect(state.alignment_batches.map((batch) => batch.status)).toEqual(["completed", "completed"]);
  });

  it("keeps stable requirement IDs when knowledge revisions change", () => {
    const state = plannedState();
    const idsBefore = state.requirements.map((requirement) => requirement.id);
    const withKnowledge = applyHierarchicalEvent(state, {
      type: "knowledge_delta_committed",
      delta: {
        add_facts: [{
          id: "F1",
          scope: { goal_id: "G1", requirement_id: "R33" },
          claim: "R33 的入口位于 lib/router.js:42",
          evidence_refs: ["TC-READ-1"]
        }]
      },
      occurred_at: NOW
    });

    expect(withKnowledge.knowledge.revision).toBe(1);
    expect(withKnowledge.requirements.map((requirement) => requirement.id)).toEqual(idsBefore);
    expect(deriveHierarchicalNextOperation(withKnowledge)).toEqual({
      kind: "activate_requirement",
      requirement_id: "R33"
    });
  });

  it("appends newly discovered requirements without replacing existing R-IDs", () => {
    const state = activateR33();
    const appended = applyHierarchicalEvent(state, {
      type: "requirements_appended",
      requirements: [{
        id: "R35",
        source_anchor: "调查 R33 时发现的路由入口",
        observable_result: "补充入口也能跳转",
        acceptance: ["补充入口有独立验证证据"],
        dependencies: ["R33"]
      }],
      occurred_at: NOW
    });

    expect(appended.requirements.map((requirement) => requirement.id)).toEqual(["R33", "R34", "R35"]);
    expect(appended.active_requirement_id).toBe("R33");
    expect(appended.requirements[2]).toMatchObject({ status: "pending", dependencies: ["R33"] });
  });

  it("rejects knowledge revision names as requirement IDs", () => {
    expect(() => applyHierarchicalEvent(createHierarchicalExecutionState("完成目标"), {
      type: "plan_accepted",
      requirements: [{
        id: "knowledge-r59",
        source_anchor: "checkpoint",
        observable_result: "执行下一步",
        acceptance: ["完成"],
        dependencies: []
      }]
    })).toThrow("稳定 R-ID");
  });

  it("runs a vertical investigate-prepare-implement-verify-close loop per requirement", () => {
    let state = activateR33();

    expect(deriveHierarchicalNextOperation(state)).toMatchObject({
      kind: "run_phase",
      requirement_id: "R33",
      phase: "investigate",
      role: "code-investigator"
    });

    state = passCurrentPhase(state);
    expect(state.requirements[0]?.current_phase).toBe("prepare");
    expect(state.active_work_unit?.id).toBe("R33:prepare");
    expect(state.phase_artifacts[0]).toMatchObject({
      requirement_id: "R33",
      phase: "investigate",
      summary: "investigate 阶段已通过"
    });
    expect(state.phase_runs[0]?.artifact_id).toBe(state.phase_artifacts[0]?.id);

    state = passCurrentPhase(state, { allowed_files: ["lib/utils/DisposalRoute.js"] });
    expect(state.requirements[0]?.current_phase).toBe("implement");
    expect(state.active_work_unit?.allowed_files).toEqual(["lib/utils/DisposalRoute.js"]);

    state = passCurrentPhase(state);
    expect(state.requirements[0]?.current_phase).toBe("verify");
    expect(state.workspace_revision).toBe(1);
    expect(state.phase_artifacts.find((artifact) => artifact.phase === "implement"))
      .toMatchObject({ workspace_revision: 1 });
    expect(state.phase_artifacts.find((artifact) => artifact.phase === "investigate"))
      .toMatchObject({ workspace_revision: 0 });

    state = passCurrentPhase(state, {
      acceptance_results: [
        { acceptance_id: "R33-A1", status: "pass", evidence_refs: ["TC-VERIFY-1"] },
        { acceptance_id: "R33-A2", status: "pass", evidence_refs: ["TC-VERIFY-2"] }
      ]
    });
    expect(state.requirements[0]?.current_phase).toBe("close");
    expect(state.active_work_unit).toBeUndefined();
    expect(deriveHierarchicalNextOperation(state)).toEqual({
      kind: "close_requirement",
      requirement_id: "R33"
    });

    state = applyHierarchicalEvent(state, {
      type: "requirement_closed",
      requirement_id: "R33",
      occurred_at: NOW
    });
    expect(state.requirements[0]?.status).toBe("completed");
    expect(deriveHierarchicalNextOperation(state)).toEqual({
      kind: "activate_requirement",
      requirement_id: "R34"
    });
  });

  it("routes verifier discoveries back to the correct inner phase without changing the goal", () => {
    let state = activateR33();
    state = passCurrentPhase(state);
    state = passCurrentPhase(state, { allowed_files: ["lib/utils/DisposalRoute.js"] });
    state = passCurrentPhase(state);
    const verifyId = state.active_work_unit!.id;
    state = applyHierarchicalEvent(state, {
      type: "phase_started",
      work_unit_id: verifyId,
      occurred_at: NOW
    });
    state = applyHierarchicalEvent(state, {
      type: "phase_failed",
      work_unit_id: verifyId,
      reason: "发现调用契约理解错误",
      route: "investigate",
      occurred_at: NOW
    });

    expect(state.goal.statement).toBe("实现附件第 33 页开始的所有页面跳转");
    expect(state.active_requirement_id).toBe("R33");
    expect(state.active_work_unit?.id).toBe("R33:investigate");
    expect(state.active_work_unit?.status).toBe("ready");
  });

  it("reopens the named requirement when the global audit finds a gap", () => {
    let state = createHierarchicalExecutionState("完成 R1", { now: NOW });
    state = applyHierarchicalEvent(state, {
      type: "plan_accepted",
      requirements: [{
        id: "R1",
        source_anchor: "user:R1",
        observable_result: "R1 可用",
        acceptance: ["R1 通过"],
        dependencies: []
      }],
      occurred_at: NOW
    });
    state = applyHierarchicalEvent(state, { type: "requirement_activated", requirement_id: "R1", occurred_at: NOW });
    state = passCurrentPhase(state);
    state = passCurrentPhase(state, { allowed_files: ["src/r1.ts"] });
    state = passCurrentPhase(state);
    state = passCurrentPhase(state, {
      acceptance_results: [{ acceptance_id: "R1-A1", status: "pass", evidence_refs: ["E-R1"] }]
    });
    state = applyHierarchicalEvent(state, { type: "requirement_closed", requirement_id: "R1", occurred_at: NOW });
    state = applyHierarchicalEvent(state, { type: "integration_started", occurred_at: NOW });
    state = applyHierarchicalEvent(state, {
      type: "integration_failed",
      reason: "调用契约证据不足",
      requirement_id: "R1",
      route: "prepare",
      occurred_at: NOW
    });

    expect(state.macro_phase).toBe("deliver");
    expect(state.integration_status).toBe("failed");
    expect(state.active_requirement_id).toBe("R1");
    expect(state.requirements[0]).toMatchObject({ status: "active", current_phase: "prepare" });
    expect(state.requirements[0]?.acceptance[0]).toMatchObject({ status: "pending", evidence_refs: [] });
    expect(state.active_work_unit).toMatchObject({ id: "R1:prepare", status: "ready" });
  });

  it("does not let prepare pass without signing a file capability lease", () => {
    let state = activateR33();
    state = passCurrentPhase(state);
    const workUnitId = state.active_work_unit!.id;
    state = applyHierarchicalEvent(state, { type: "phase_started", work_unit_id: workUnitId, occurred_at: NOW });

    expect(() => applyHierarchicalEvent(state, {
      type: "phase_passed",
      work_unit_id: workUnitId,
      evidence_refs: ["E-PREPARE"],
      occurred_at: NOW
    })).toThrow("需要修改时必须签发非空 allowed_files");
  });

  it("preserves rejected phase drafts and distinct correction reasons across retries", () => {
    let state = activateR33();
    state = passCurrentPhase(state);
    const workUnitId = state.active_work_unit!.id;
    state = applyHierarchicalEvent(state, {
      type: "phase_started",
      work_unit_id: workUnitId,
      occurred_at: NOW
    });
    state = applyHierarchicalEvent(state, {
      type: "phase_failed",
      work_unit_id: workUnitId,
      reason: "缺少 selected reference",
      route: "retry",
      error_fingerprint: "missing-reference",
      rejected_output: "{\"status\":\"passed\",\"handoff\":{}}",
      occurred_at: NOW
    });
    state = applyHierarchicalEvent(state, {
      type: "phase_started",
      work_unit_id: workUnitId,
      occurred_at: NOW
    });
    state = applyHierarchicalEvent(state, {
      type: "phase_failed",
      work_unit_id: workUnitId,
      reason: "manual target should be removed",
      route: "retry",
      error_fingerprint: "manual-target",
      rejected_output: "{\"status\":\"passed\",\"handoff\":{\"call_contract\":{}}}",
      occurred_at: NOW
    });

    expect(state.active_work_unit).toMatchObject({
      id: workUnitId,
      status: "ready",
      attempt: 3,
      correction_history: [
        "缺少 selected reference",
        "manual target should be removed"
      ],
      last_rejected_output: "{\"status\":\"passed\",\"handoff\":{\"call_contract\":{}}}"
    });
    expect(state.phase_runs.filter((run) => run.status === "failed")).toEqual([
      expect.objectContaining({ failure_reason: "缺少 selected reference" }),
      expect.objectContaining({ failure_reason: "manual target should be removed" })
    ]);
  });

  it("skips implement when prepare proves the full behavior contract is already satisfied", () => {
    let state = activateR33();
    state = passCurrentPhase(state);
    state = passCurrentPhase(state, {
      allowed_files: [],
      handoff: {
        change_disposition: "already_satisfied",
        behavior_obligations: [{ id: "B-destination" }],
        satisfaction_evidence: ["lib/existing.ts:10"]
      }
    });

    expect(state.requirements[0]?.current_phase).toBe("verify");
    expect(state.active_work_unit).toMatchObject({ id: "R33:verify", allowed_files: [] });
    expect(state.phase_runs.map((run) => run.phase)).toEqual(["investigate", "prepare"]);
    expect(state.workspace_revision).toBe(0);
  });

  it("does not let internal orchestration faults become human questions", () => {
    const internalFault: HierarchicalBlocker = {
      id: "B-HOST-1",
      kind: "orchestration_fault",
      owner: "host",
      message: "Task schema 缺少 subagent_type",
      status: "open",
      retryable: true,
      user_input_required: false,
      created_at: NOW
    };
    const userDecision: HierarchicalBlocker = {
      id: "B-USER-1",
      kind: "user_decision",
      owner: "user",
      message: "两个业务页面是否应保持为独立入口",
      status: "open",
      retryable: false,
      user_input_required: true,
      created_at: NOW
    };

    expect(mayAskHumanForBlocker(internalFault)).toBe(false);
    expect(mayAskHumanForBlocker(userDecision)).toBe(true);

    const faulted = applyHierarchicalEvent(plannedState(), {
      type: "blocker_raised",
      blocker: internalFault,
      occurred_at: NOW
    });
    expect(deriveHierarchicalNextOperation(faulted)).toEqual({
      kind: "system_fault",
      blocker_id: "B-HOST-1"
    });
  });

  it("stops on agent-owned evidence blockers without asking the human", () => {
    const blocked = applyHierarchicalEvent(plannedState(), {
      type: "blocker_raised",
      blocker: {
        id: "B-EVIDENCE-1",
        kind: "evidence_blocked",
        owner: "agent",
        message: "缺少可验证的仓库内调用点",
        status: "open",
        retryable: true,
        user_input_required: false,
        created_at: NOW
      },
      occurred_at: NOW
    });

    expect(deriveHierarchicalNextOperation(blocked)).toEqual({
      kind: "blocked",
      blocker_id: "B-EVIDENCE-1"
    });
  });

  it("keeps corrected history but injects only the new fact as active", () => {
    let state = plannedState();
    state = applyHierarchicalEvent(state, {
      type: "knowledge_delta_committed",
      delta: {
        add_facts: [{
          id: "F-OLD",
          scope: { goal_id: "G1", requirement_id: "R33" },
          claim: "R33 对应 /old/list",
          evidence_refs: ["E-OLD"]
        }]
      },
      occurred_at: NOW
    });
    state = applyHierarchicalEvent(state, {
      type: "knowledge_delta_committed",
      delta: {
        add_facts: [{
          id: "F-NEW",
          scope: { goal_id: "G1", requirement_id: "R33" },
          claim: "R33 对应 /example/list",
          evidence_refs: ["E-NEW"],
          supersedes_fact_ids: ["F-OLD"]
        }]
      },
      occurred_at: NOW
    });

    expect(state.knowledge.facts.find((fact) => fact.id === "F-OLD")).toMatchObject({
      status: "superseded",
      superseded_by: "F-NEW"
    });
    expect(state.knowledge.facts.find((fact) => fact.id === "F-NEW")?.status).toBe("active");
  });

  it("cannot complete while any requirement or acceptance remains open", () => {
    const state = plannedState();
    expect(evaluateHierarchicalCompletion(state)).toEqual(expect.arrayContaining([
      expect.stringContaining("R33(pending)"),
      expect.stringContaining("R34(pending)"),
      expect.stringContaining("R33/R33-A1(pending)"),
      "全局集成审计尚未通过"
    ]));
  });

  it("renders a goal-to-action breadcrumb without using knowledge revisions as task IDs", () => {
    const state = activateR33();
    expect(deriveHierarchicalLoopStack(state).map((frame) => `${frame.kind}:${frame.id}`)).toEqual([
      "goal:G1",
      "requirement:R33",
      "phase:investigate",
      "action:R33:investigate"
    ]);
  });
});

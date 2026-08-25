import { describe, expect, it } from "vitest";
import type { AgentSession, WorkflowTemplate } from "../../shared/types.js";
import { applyHierarchicalEvent, createHierarchicalExecutionState } from "../workflows/hierarchicalWorkflowEngine.js";
import { buildHierarchicalRoleSpec, parseHierarchicalRoleResult } from "./hierarchicalRoleProtocol.js";

const workflow: WorkflowTemplate = {
  id: "hierarchical",
  name: "Hierarchical",
  version: "1.0.0",
  description: "test",
  source: { type: "builtin", id: "hierarchical" },
  execution_mode: "hierarchical",
  permissions: { filesystem: { mode: "project-only" } },
  rework: { enabled: false, allowed_targets: [], approval_required: false, invalidate_downstream: true },
  stages: []
};

function plannedSession(): AgentSession {
  let state = createHierarchicalExecutionState("实现 R1", { now: "2026-01-01T00:00:00.000Z" });
  state = applyHierarchicalEvent(state, {
    type: "plan_accepted",
    requirements: [{
      id: "R1",
      source_anchor: "user:R1",
      observable_result: "R1 可用",
      acceptance: ["R1 验收通过"],
      dependencies: []
    }]
  });
  state = applyHierarchicalEvent(state, { type: "requirement_activated", requirement_id: "R1" });
  return {
    id: "s1",
    project_path: "/tmp/project",
    workflow_id: workflow.id,
    task_prompt: "实现 R1",
    status: "running",
    current_stage: "R1/investigate",
    messages: [],
    tool_calls: [],
    file_changes: [],
    approvals: [],
    hierarchical_state: state,
    created_at: state.created_at,
    updated_at: state.updated_at
  };
}

function handoffFor(phase: "investigate" | "prepare" | "implement" | "verify") {
  if (phase === "investigate") {
    return {
      confirmed_facts: ["target confirmed"],
      target_locations: ["src/target.ts:1"],
      target_mappings: [{
        target_key: "route",
        requested_token: "route",
        canonical_token: "route",
        dispatcher_location: "src/target.ts:1",
        contract_symbol: "reference",
        contract_location: "src/reference.ts:5",
        evidence_refs: ["src/target.ts:1", "src/reference.ts:5"]
      }],
      feature_census: {
        applicability: "required",
        reason: "功能以用户行为描述，必须普查实现候选",
        status: "complete",
        report_digest: "a".repeat(64),
        candidate_accounting: { total: 1, yes: 1, no: 0, unknown: 0, accounted: true },
        selected_candidate_ids: ["candidate-target"]
      },
      target_investigation: {
        target_kind: "function",
        definition: "target is defined at src/target.ts:1",
        inputs: ["input at src/target.ts:1"],
        outputs: ["output at src/target.ts:2"],
        internal_calls: ["no internal calls; src/target.ts:1"],
        guards: ["no guards; src/target.ts:1"],
        state_and_side_effects: ["no side effects; src/target.ts:1"],
        callers: ["caller at src/caller.ts:3"],
        evidence_refs: ["src/target.ts:1", "src/caller.ts:3"],
        unresolved: []
      },
      reference_analysis: {
        search_scope: ["searched src/**/*.ts"],
        candidates: [{
          target_key: "route",
          reference_kind: "same-feature-entry",
          location: "src/reference.ts:5",
          contract_location: "src/reference.ts:5",
          contract_symbol: "reference",
          feature_equivalence: ["same user-visible feature at src/reference.ts:5"],
          similarity: ["same callable shape"],
          reusable_behavior: ["preserve argument forwarding"],
          differences: ["different exported name"],
          destination: "target component at src/reference.ts:5",
          invocation: "direct function call at src/reference.ts:5",
          arguments: ["input forwarded at src/reference.ts:5"],
          preconditions: ["no preconditions at src/reference.ts:5"],
          context_forwarding: ["no context forwarding at src/reference.ts:5"],
          side_effects: ["no side effects at src/reference.ts:5"],
          evidence_refs: ["src/reference.ts:5"]
        }],
        target_selections: [{
          target_key: "route",
          selected_location: "src/reference.ts:5",
          selection_reason: "closest behavior contract",
          no_reference_reason: ""
        }]
      },
      open_unknowns: []
    };
  }
  if (phase === "prepare") {
    return {
      call_contract: {
        analyzed_targets: [{
          target_file: "src/target.ts",
          symbol: "target",
          analysis_method: "investigation-script",
          method_reason: "",
          analyzer_sections: ["contract", "calls", "wrappers", "references"],
          all_pages_consumed: true,
          definition: "src/target.ts:1",
          inputs: ["input at src/target.ts:1"],
          outputs: ["output at src/target.ts:2"],
          callers: ["src/caller.ts:3"],
          wrappers_and_indirect_references: ["none; src/target.ts:1"],
          guards: ["none; src/target.ts:1"],
          state_and_side_effects: ["none; src/target.ts:1"],
          compatibility_obligations: ["preserve input forwarding"],
          unresolved: [],
          evidence_refs: ["src/target.ts:1", "src/caller.ts:3"]
        }, {
          target_file: "src/reference.ts",
          symbol: "reference",
          analysis_method: "manual-static-analysis",
          method_reason: "synthetic protocol fixture",
          analyzer_sections: [],
          all_pages_consumed: false,
          definition: "src/reference.ts:5",
          inputs: ["input at src/reference.ts:5"],
          outputs: ["output at src/reference.ts:6"],
          callers: ["caller at src/reference.ts:5"],
          wrappers_and_indirect_references: ["none; src/reference.ts:5"],
          guards: ["none; src/reference.ts:5"],
          state_and_side_effects: ["none; src/reference.ts:5"],
          compatibility_obligations: ["preserve reference behavior"],
          unresolved: [],
          evidence_refs: ["src/reference.ts:5"]
        }]
      },
      reference_application: [{
        target_key: "route",
        dimension: "argument forwarding",
        target_behavior: "forward input",
        reference_behavior: "forward input",
        decision: "reuse",
        reason: "same public contract",
        evidence_refs: ["src/reference.ts:5", "src/target.ts:1"]
      }],
      behavior_obligations: behaviorObligations("src/reference.ts:5", "src/target.ts:1"),
      change_disposition: "changes_required",
      satisfaction_evidence: ["destination checked at src/target.ts:1"],
      pre_behavior: ["existing behavior preserved"],
      preserve_invariants: ["public API unchanged"],
      patch_plan: ["apply minimal edit"],
      verification_plan: ["run focused test"]
    };
  }
  if (phase === "implement") {
    return {
      changes: ["updated target"],
      diff_summary: "one minimal change",
      checks_run: ["git diff --check"],
      preserved_invariants: ["public API unchanged"],
      obligation_results: behaviorObligationResults("applied", "src/target.ts:1")
    };
  }
  return {
    verification_summary: "acceptance passed",
    regression_checks: ["focused test passed"],
    unresolved_risks: [],
    contract_results: behaviorObligationResults("pass", "src/target.ts:1")
  };
}

function behaviorObligations(reference: string, target: string) {
  return [
    ["B-destination", "destination"],
    ["B-invocation", "invocation"],
    ["B-arguments", "arguments"],
    ["B-preconditions", "preconditions"],
    ["B-context", "context"],
    ["B-side-effects", "side_effects"]
  ].map(([id, dimension]) => ({
    id,
    dimension,
    target_keys: ["route"],
    reference_behavior: `${dimension} from ${reference}`,
    required_behavior: `${dimension} at ${target}`,
    decision: "reuse",
    reason: "same feature",
    evidence_refs: [reference, target]
  }));
}

function behaviorObligationResults(status: string, evidence: string) {
  return [
    ["B-destination", "destination"],
    ["B-invocation", "invocation"],
    ["B-arguments", "arguments"],
    ["B-preconditions", "preconditions"],
    ["B-context", "context"],
    ["B-side-effects", "side_effects"]
  ].map(([obligation_id, dimension]) => ({
    obligation_id,
    status,
    observed_behavior: `${dimension} at ${evidence}`,
    evidence_refs: [evidence]
  }));
}

describe("hierarchicalRoleProtocol", () => {
  it("gives an attachment reader only its small exact batch and persists findings", () => {
    const state = applyHierarchicalEvent(createHierarchicalExecutionState("读取附件"), {
      type: "alignment_sources_registered",
      batches: [{ id: "A1", source_refs: ["/tmp/project/page-01.png", "/tmp/project/page-02.png"] }]
    });
    const session = { ...plannedSession(), task_prompt: "读取附件", hierarchical_state: state };
    const operation = {
      kind: "run_alignment_batch" as const,
      batch_id: "A1",
      source_refs: ["/tmp/project/page-01.png", "/tmp/project/page-02.png"],
      attempt: 1
    };
    const spec = buildHierarchicalRoleSpec(session, workflow, operation);

    expect(spec.tools).toEqual(["Read"]);
    expect(spec.prompt).toContain("一次只发起一个 Read");
    expect(spec.prompt).toContain("不得向用户提问或返回 blocked");
    expect(spec.prompt).toContain("/tmp/project/page-01.png");
    expect(spec.prompt).toContain("不要建立最终 R-ID");
    expect(parseHierarchicalRoleResult(operation, {
      status: "passed",
      summary: "两页均已读取",
      evidence_refs: operation.source_refs,
      findings: [{ source_anchor: "page-02", observable_result: "按钮跳转", acceptance: ["落点正确"] }]
    })[0]).toMatchObject({
      type: "alignment_batch_passed",
      batch_id: "A1",
      findings: [{ source_anchor: "page-02" }]
    });

    expect(parseHierarchicalRoleResult(operation, {
      status: "blocked",
      summary: "当前批次尚未出现用户指定的第 33 项",
      evidence_refs: operation.source_refs,
      findings: [{ source_anchor: "page-02", observable_result: "按钮跳转", acceptance: ["落点正确"] }],
      blocker: { id: "should-not-escape", kind: "user_decision", message: "请确认序号" }
    })[0]).toMatchObject({
      type: "alignment_batch_passed",
      batch_id: "A1"
    });
  });

  it("builds the final planner from persisted summaries and forbids rereading attachments", () => {
    let state = createHierarchicalExecutionState("读取附件");
    state = applyHierarchicalEvent(state, {
      type: "alignment_sources_registered",
      batches: [{ id: "A1", source_refs: ["/tmp/project/page-01.png"] }]
    });
    state = applyHierarchicalEvent(state, { type: "alignment_batch_started", batch_id: "A1" });
    state = applyHierarchicalEvent(state, {
      type: "alignment_batch_passed",
      batch_id: "A1",
      summary: "第 1 页定义入口",
      findings: [{ source_anchor: "page-01", observable_result: "入口工作", acceptance: ["跳转正确"] }],
      evidence_refs: ["/tmp/project/page-01.png"]
    });
    const spec = buildHierarchicalRoleSpec(
      { ...plannedSession(), task_prompt: "读取附件", hierarchical_state: state },
      workflow,
      { kind: "run_planner" }
    );
    expect(spec.prompt).toContain("第 1 页定义入口");
    expect(spec.prompt).toContain("禁止再次 Read 附件");
    expect(spec.prompt).toContain("本阶段也不得探索项目代码");
    expect(spec.prompt).toContain("必须核对全部已归并批次");
    expect(spec.prompt).toContain("当前角色没有原始附件读取权限");
    expect(spec.tools).toEqual([]);
    expect(spec.requiredSkills).not.toContain("exploring-codebase");
  });

  it("publishes exact dynamic sequence coverage and prior rejection before planner execution", () => {
    let state = createHierarchicalExecutionState("请从序号 7 开始处理所有条目");
    state = applyHierarchicalEvent(state, {
      type: "alignment_sources_registered",
      batches: [{ id: "A1", source_refs: ["/tmp/project/requirements.png"] }]
    });
    state = applyHierarchicalEvent(state, { type: "alignment_batch_started", batch_id: "A1" });
    state = applyHierarchicalEvent(state, {
      type: "alignment_batch_passed",
      batch_id: "A1",
      summary: "包含目标序号 7、9、12",
      findings: [
        { source_anchor: "序号 7", observable_result: "目标七", acceptance: ["七可验证"] },
        { source_anchor: "序号 9", observable_result: "目标九", acceptance: ["九可验证"] },
        { source_anchor: "序号 12", observable_result: "目标十二", acceptance: ["十二可验证"] }
      ],
      evidence_refs: ["/tmp/project/requirements.png"]
    });
    state = applyHierarchicalEvent(state, {
      type: "planner_failed",
      reason: "planner 需求账本遗漏用户范围内业务序号：12",
      error_fingerprint: "missing-12"
    });

    const spec = buildHierarchicalRoleSpec(
      {
        ...plannedSession(),
        task_prompt: "请从序号 7 开始处理所有条目",
        hierarchical_state: state
      },
      workflow,
      { kind: "run_planner" }
    );

    expect(spec.prompt).toContain("requirements 必须分别覆盖这些业务序号：7, 9, 12");
    expect(spec.prompt).toContain("例如 33 写成 R33");
    expect(spec.prompt).toContain("当前为第 2 次 planner 尝试");
    expect(spec.prompt).toContain("planner 需求账本遗漏用户范围内业务序号：12");
    expect(spec.prompt).toContain("同一序号在不同附件中解释冲突时，仍保留该序号的 R-ID");
  });

  it("gives a phase role only its leaf tools and explicit loop stack", () => {
    const session = plannedSession();
    const spec = buildHierarchicalRoleSpec(session, workflow, {
      kind: "run_phase",
      requirement_id: "R1",
      work_unit_id: "R1:investigate",
      phase: "investigate",
      role: "code-investigator"
    });

    expect(spec.tools).toEqual([
      "Read",
      "Grep",
      "Glob",
      "Bash",
      "mcp__ai_coder__locate_feature_implementation"
    ]);
    expect(spec.tools).not.toContain("Task");
    expect(spec.prompt).toContain("G1 > R1 > investigate > R1:investigate");
    expect(spec.prompt).toContain("## 唯一项目根目录\n/tmp/project");
    expect(spec.prompt).toContain("严禁猜测 /workspace");
    expect(spec.prompt).toContain("本阶段启动前已声明的交接契约");
    expect(spec.prompt).toContain("confirmed_facts");
    expect((spec.outputFormat.schema.required as string[])).toContain("handoff");
    expect(() => parseHierarchicalRoleResult({
      kind: "run_phase",
      requirement_id: "R1",
      work_unit_id: "R1:investigate",
      phase: "investigate",
      role: "code-investigator"
    }, {
      status: "passed",
      summary: "missing declared handoff",
      evidence_refs: ["src/target.ts:1"]
    })).toThrow("phase.handoff 必须是对象");
  });

  it("requires a selected same-type reference or an explicit evidence-backed no-match result", () => {
    const operation = {
      kind: "run_phase" as const,
      requirement_id: "R1",
      work_unit_id: "R1:investigate",
      phase: "investigate" as const,
      role: "code-investigator"
    };
    const handoff = handoffFor("investigate") as Record<string, unknown>;
    handoff.reference_analysis = {
      search_scope: ["searched src/**/*.ts"],
      candidates: [],
      target_selections: [{
        target_key: "route",
        selected_location: "",
        selection_reason: "",
        no_reference_reason: ""
      }]
    };

    expect(() => parseHierarchicalRoleResult(operation, {
      status: "passed",
      summary: "reference search omitted",
      evidence_refs: ["src/target.ts:1"],
      handoff
    })).toThrow("逐目标说明 no_reference_reason");
  });

  it("surfaces every investigate reference-analysis violation in one fail-collect rejection", () => {
    const operation = {
      kind: "run_phase" as const,
      requirement_id: "R1",
      work_unit_id: "R1:investigate",
      phase: "investigate" as const,
      role: "code-investigator"
    };
    const handoff = handoffFor("investigate") as Record<string, unknown>;
    // Add a second target with no candidate and no selection.
    (handoff.target_mappings as Array<Record<string, unknown>>).push({
      target_key: "second",
      requested_token: "second",
      canonical_token: "second",
      dispatcher_location: "src/target.ts:1",
      contract_symbol: "reference",
      contract_location: "src/reference.ts:5",
      evidence_refs: ["src/target.ts:1", "src/reference.ts:5"]
    });
    const referenceAnalysis = handoff.reference_analysis as {
      candidates: Array<Record<string, unknown>>;
    };
    // route's candidate no longer traces to route's mapping contract.
    referenceAnalysis.candidates[0]!.contract_symbol = "wrongSymbol";

    let thrown: Error | undefined;
    try {
      parseHierarchicalRoleResult(operation, {
        status: "passed",
        summary: "investigated",
        evidence_refs: ["src/target.ts:1"],
        handoff
      });
    } catch (error) {
      thrown = error instanceof Error ? error : new Error(String(error));
    }
    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain("investigate 阶段交接物未通过校验，共 2 处");
    expect(thrown!.message).toContain("未追到 route 已确认的同一最终函数/组件");
    // Both sides of the mismatch are shown so the model can see what to fix.
    expect(thrown!.message).toContain("candidate wrongSymbol@src/reference.ts:5");
    expect(thrown!.message).toContain("target_mappings 声明的 reference@src/reference.ts:5");
    expect(thrown!.message).toContain("以下目标缺少逐目标 reference selection：second");
  });

  it("does not allow investigate to hide an unclassified feature candidate", () => {
    const handoff = handoffFor("investigate") as Record<string, unknown>;
    const census = handoff.feature_census as {
      candidate_accounting: {
        total: number;
        yes: number;
        no: number;
        unknown: number;
        accounted: true;
      };
    };
    census.candidate_accounting = { total: 2, yes: 1, no: 0, unknown: 1, accounted: true };

    expect(() => parseHierarchicalRoleResult({
      kind: "run_phase",
      requirement_id: "R1",
      work_unit_id: "R1:investigate",
      phase: "investigate",
      role: "code-investigator"
    }, {
      status: "passed",
      summary: "one possible implementation was silently omitted",
      evidence_refs: ["src/target.ts:1"],
      handoff
    })).toThrow("unknown 候选");
  });

  it("does not allow a passed investigate phase to retain material open unknowns", () => {
    const handoff = handoffFor("investigate") as Record<string, unknown>;
    handoff.open_unknowns = [
      "LqbHomeV3 是复用 CurrencyFundExplain 还是进入独立首页组件尚未闭合"
    ];

    expect(() => parseHierarchicalRoleResult({
      kind: "run_phase",
      requirement_id: "R1",
      work_unit_id: "R1:investigate",
      phase: "investigate",
      role: "code-investigator"
    }, {
      status: "passed",
      summary: "target was guessed despite an unresolved destination",
      evidence_refs: ["src/target.ts:1"],
      handoff
    })).toThrow("open_unknowns");
  });

  it("classifies a requested token missing from baseline as an implementation gap", () => {
    const handoff = handoffFor("investigate") as Record<string, unknown>;
    handoff.open_unknowns = [
      "附件要求的 pageName='LQBHomeV3' 与现有代码 pageName='LQBInvest' 不一致，需要确认是否修改"
    ];

    expect(() => parseHierarchicalRoleResult({
      kind: "run_phase",
      requirement_id: "R1",
      work_unit_id: "R1:investigate",
      phase: "investigate",
      role: "code-investigator"
    }, {
      status: "passed",
      summary: "same destination was found but the new token was misclassified",
      evidence_refs: ["src/target.ts:1"],
      handoff
    })).toThrow("基线实现缺口，不是用户决策");
  });

  it("does not accept a baseline token gap as a user-decision blocker", () => {
    expect(() => parseHierarchicalRoleResult({
      kind: "run_phase",
      requirement_id: "R1",
      work_unit_id: "R1:investigate",
      phase: "investigate",
      role: "code-investigator"
    }, {
      status: "blocked",
      summary: "附件要求的 pageName=LQBHomeV3 与现有代码的 LQBInvest 不一致",
      blocker: {
        id: "choose-token",
        kind: "user_decision",
        message: "需要确认是否修改 pageName，还是继续使用现有代码标识"
      }
    })).toThrow("误报为 user_decision/open_unknowns");
  });

  it("requires a reference decision for every independently mapped target", () => {
    const handoff = handoffFor("investigate") as Record<string, unknown>;
    const mappings = handoff.target_mappings as Array<Record<string, unknown>>;
    mappings.push({
      target_key: "second-route",
      requested_token: "TGZCRZ",
      canonical_token: "TGZCRZ",
      dispatcher_location: "src/target.ts:1",
      contract_symbol: "secondReference",
      contract_location: "src/secondReference.ts:3",
      evidence_refs: ["src/target.ts:1", "src/secondReference.ts:3"]
    });

    expect(() => parseHierarchicalRoleResult({
      kind: "run_phase",
      requirement_id: "R1",
      work_unit_id: "R1:investigate",
      phase: "investigate",
      role: "code-investigator"
    }, {
      status: "passed",
      summary: "only one of two page targets was investigated",
      evidence_refs: ["src/target.ts:1"],
      handoff
    })).toThrow("second-route");
  });

  it("requires a callable contract location separately from the same-feature entry", () => {
    const handoff = handoffFor("investigate") as Record<string, unknown>;
    const analysis = handoff.reference_analysis as { candidates: Array<Record<string, unknown>> };
    delete analysis.candidates[0]!.contract_location;

    expect(() => parseHierarchicalRoleResult({
      kind: "run_phase",
      requirement_id: "R1",
      work_unit_id: "R1:investigate",
      phase: "investigate",
      role: "code-investigator"
    }, {
      status: "passed",
      summary: "entry found without tracing its callable destination",
      evidence_refs: ["src/reference.ts:5"],
      handoff
    })).toThrow("contract_location");
  });

  it("allows distinct same-feature entries to converge on the current target component", () => {
    const handoff = handoffFor("investigate") as Record<string, unknown>;
    const target = handoff.target_investigation as Record<string, unknown>;
    target.definition = "LQBInvest component at lib/views/myAssets/LQBInvest.js:33";
    const analysis = handoff.reference_analysis as {
      candidates: Array<Record<string, unknown>>;
      target_selections: Array<Record<string, unknown>>;
    };
    const mappings = handoff.target_mappings as Array<Record<string, unknown>>;
    const candidate = analysis.candidates[0]!;
    candidate.location = "lib/views/myAssets/MyAssetsNewRevision.js:800";
    candidate.contract_location = "lib/views/myAssets/LQBInvest.js:33";
    candidate.contract_symbol = "LQBInvest";
    candidate.evidence_refs = [
      "lib/views/myAssets/MyAssetsNewRevision.js:800",
      "lib/views/myAssets/LQBInvest.js:33"
    ];
    mappings[0]!.contract_location = "lib/views/myAssets/LQBInvest.js:33";
    mappings[0]!.contract_symbol = "LQBInvest";
    analysis.target_selections[0]!.selected_location = "lib/views/myAssets/MyAssetsNewRevision.js:800";

    expect(() => parseHierarchicalRoleResult({
      kind: "run_phase",
      requirement_id: "R1",
      work_unit_id: "R1:investigate",
      phase: "investigate",
      role: "code-investigator"
    }, {
      status: "passed",
      summary: "an existing entry reaches the same destination component",
      evidence_refs: ["lib/views/myAssets/LQBInvest.js:33"],
      handoff
    })).not.toThrow();
  });

  it("rejects the current target definition when it is reused as the reference entry", () => {
    const handoff = handoffFor("investigate") as Record<string, unknown>;
    const analysis = handoff.reference_analysis as {
      candidates: Array<Record<string, unknown>>;
      target_selections: Array<Record<string, unknown>>;
    };
    const candidate = analysis.candidates[0]!;
    candidate.location = "src/target.ts:1";
    candidate.contract_location = "src/reference.ts:5";
    candidate.evidence_refs = ["src/target.ts:1", "src/reference.ts:5"];
    analysis.target_selections[0]!.selected_location = "src/target.ts:1";

    expect(() => parseHierarchicalRoleResult({
      kind: "run_phase",
      requirement_id: "R1",
      work_unit_id: "R1:investigate",
      phase: "investigate",
      role: "code-investigator"
    }, {
      status: "passed",
      summary: "the current target was incorrectly selected as its own entry",
      evidence_refs: ["src/target.ts:1"],
      handoff
    })).toThrow("candidate.location=src/target.ts:1");
  });

  it("rejects a merely similar sibling branch as the canonical reference", () => {
    const handoff = handoffFor("investigate") as Record<string, unknown>;
    const analysis = handoff.reference_analysis as { candidates: Array<Record<string, unknown>> };
    analysis.candidates[0]!.reference_kind = "sibling-pattern";

    expect(() => parseHierarchicalRoleResult({
      kind: "run_phase",
      requirement_id: "R1",
      work_unit_id: "R1:investigate",
      phase: "investigate",
      role: "code-investigator"
    }, {
      status: "passed",
      summary: "picked a visually similar branch",
      evidence_refs: ["src/target.ts:1"],
      handoff
    })).toThrow("必须是同一业务功能的既有用户入口");
  });

  it("requires complete target-symbol coverage before prepare can pass", () => {
    const session = plannedSession();
    const spec = buildHierarchicalRoleSpec(session, workflow, {
      kind: "run_phase",
      requirement_id: "R1",
      work_unit_id: "R1:prepare",
      phase: "prepare",
      role: "implementation-preparer"
    });
    expect(spec.tools).toContain("mcp__ai_coder__investigate_symbol_contract");
    expect(spec.tools).not.toContain("mcp__ai_coder__analyze_symbol_contract");

    const handoff = handoffFor("prepare") as Record<string, unknown>;
    const callContract = handoff.call_contract as { analyzed_targets: Array<Record<string, unknown>> };
    callContract.analyzed_targets[0]!.analyzer_sections = ["contract", "calls"];
    callContract.analyzed_targets[0]!.all_pages_consumed = false;
    expect(() => parseHierarchicalRoleResult({
      kind: "run_phase",
      requirement_id: "R1",
      work_unit_id: "R1:prepare",
      phase: "prepare",
      role: "implementation-preparer"
    }, {
      status: "passed",
      summary: "partial contract",
      evidence_refs: ["src/target.ts:1"],
      handoff,
      allowed_files: ["src/target.ts"]
    })).toThrow("调查脚本证据不完整");
  });

  it("feeds the rejected draft and cumulative correction history into a phase retry", () => {
    const session = plannedSession();
    const state = session.hierarchical_state!;
    state.requirements[0]!.current_phase = "prepare";
    state.active_work_unit = {
      id: "R1:prepare",
      requirement_id: "R1",
      phase: "prepare",
      status: "ready",
      assigned_role: "implementation-preparer",
      attempt: 3,
      baseline_knowledge_revision: 0,
      allowed_files: [],
      failure_reason: "manual-static-analysis 目标可由分析器解析",
      correction_history: [
        "analyzed_targets 不应伪造静态配置目标",
        "manual-static-analysis 目标可由分析器解析"
      ],
      last_rejected_output: "{\"status\":\"passed\",\"handoff\":{\"call_contract\":{}}}"
    };

    const spec = buildHierarchicalRoleSpec(session, workflow, {
      kind: "run_phase",
      requirement_id: "R1",
      work_unit_id: "R1:prepare",
      phase: "prepare",
      role: "implementation-preparer"
    });

    expect(spec.prompt).toContain("宿主已累计的拒绝原因");
    expect(spec.prompt).toContain("后一次修正不能重新引入前一次错误");
    expect(spec.prompt).toContain("上次被拒绝的结构化草稿");
    expect(spec.prompt).toContain("\"call_contract\"");
    expect(spec.prompt).toContain("不要向用户申请阶段工具");
  });

  it("announces the exact prepare shape up front and requires all six behavior dimensions", () => {
    const session = plannedSession();
    const operation = {
      kind: "run_phase" as const,
      requirement_id: "R1",
      work_unit_id: "R1:prepare",
      phase: "prepare" as const,
      role: "implementation-preparer"
    };
    const spec = buildHierarchicalRoleSpec(session, workflow, operation);
    expect(spec.prompt).toContain("本阶段最终输出骨架（开始工作前即生效）");
    expect(spec.prompt).toContain("destination/invocation/arguments/preconditions/context/side_effects");
    expect(spec.prompt).toContain("不要等到工作完成后再猜字段嵌套");

    const handoff = handoffFor("prepare") as Record<string, unknown>;
    const obligations = handoff.behavior_obligations as Array<Record<string, unknown>>;
    obligations.splice(obligations.findIndex((item) => item.dimension === "preconditions"), 1);
    expect(() => parseHierarchicalRoleResult(operation, {
      status: "passed",
      summary: "guard contract omitted",
      evidence_refs: ["src/target.ts:1"],
      handoff,
      allowed_files: ["src/target.ts"]
    })).toThrow("缺少行为维度：preconditions");
  });

  it("supports a proven no-op without issuing a write lease", () => {
    const handoff = handoffFor("prepare") as Record<string, unknown>;
    handoff.change_disposition = "already_satisfied";
    handoff.patch_plan = [];
    handoff.satisfaction_evidence = behaviorObligations("src/reference.ts:5", "src/target.ts:1")
      .map((item) => `${item.dimension} satisfied at src/target.ts:1`);

    const events = parseHierarchicalRoleResult({
      kind: "run_phase",
      requirement_id: "R1",
      work_unit_id: "R1:prepare",
      phase: "prepare",
      role: "implementation-preparer"
    }, {
      status: "passed",
      summary: "full contract already satisfied",
      evidence_refs: ["src/target.ts:1"],
      handoff,
      allowed_files: []
    });

    expect(events[0]).toMatchObject({
      type: "phase_passed",
      allowed_files: [],
      handoff: { change_disposition: "already_satisfied" }
    });
  });

  it("requires a concrete patch plan only when prepare found missing behavior", () => {
    const handoff = handoffFor("prepare") as Record<string, unknown>;
    handoff.patch_plan = [];

    expect(() => parseHierarchicalRoleResult({
      kind: "run_phase",
      requirement_id: "R1",
      work_unit_id: "R1:prepare",
      phase: "prepare",
      role: "implementation-preparer"
    }, {
      status: "passed",
      summary: "changes are still required",
      evidence_refs: ["src/target.ts:1"],
      handoff,
      allowed_files: ["src/target.ts"]
    })).toThrow("changes_required 时 patch_plan 必须至少包含一项");
  });

  it("rejects a role trying to disguise an internal fault as a human blocker", () => {
    expect(() => parseHierarchicalRoleResult({
      kind: "run_phase",
      requirement_id: "R1",
      work_unit_id: "R1:investigate",
      phase: "investigate",
      role: "code-investigator"
    }, {
      status: "blocked",
      summary: "tool failed",
      evidence_refs: [],
      blocker: { id: "b1", kind: "orchestration_fault", message: "please fix tools" }
    })).toThrow("不得创建内部运行故障类型");
  });

  it("rejects agent-owned evidence blockers so the host retries instead of terminating the goal", () => {
    const session = plannedSession();
    const spec = buildHierarchicalRoleSpec(session, workflow, {
      kind: "run_phase",
      requirement_id: "R1",
      work_unit_id: "R1:investigate",
      phase: "investigate",
      role: "code-investigator"
    });
    const blocker = (spec.outputFormat.schema.properties as Record<string, Record<string, unknown>>).blocker;
    const blockerProperties = blocker.properties as Record<string, Record<string, unknown>>;
    expect(blockerProperties.kind.enum).toEqual(["user_decision", "external_resource_missing"]);
    expect(spec.prompt).toContain("evidence_blocked 不属于允许的阶段出口");

    expect(() => parseHierarchicalRoleResult({
      kind: "run_phase",
      requirement_id: "R1",
      work_unit_id: "R1:investigate",
      phase: "investigate",
      role: "code-investigator"
    }, {
      status: "blocked",
      summary: "LgbHome 与 LQBHome 命名不同",
      evidence_refs: ["src/routes.ts:10"],
      blocker: {
        id: "B-alias",
        kind: "evidence_blocked",
        message: "需要确认命名差异"
      }
    })).toThrow("把可继续调查的证据冲突误报为 evidence_blocked");
  });

  it("turns a global audit failure into a typed requirement rework", () => {
    expect(parseHierarchicalRoleResult({ kind: "run_integrator" }, {
      status: "failed",
      summary: "R1 contract evidence is stale",
      failure_reason: "R1 contract evidence is stale",
      evidence_refs: ["audit:1"],
      rework_requirement_id: "R1",
      failure_route: "prepare"
    })).toEqual([expect.objectContaining({
      type: "integration_failed",
      requirement_id: "R1",
      route: "prepare"
    })]);
  });

  it("accepts an already-built planner ledger instead of stopping on investigable evidence conflicts", () => {
    const events = parseHierarchicalRoleResult({ kind: "run_planner" }, {
      status: "blocked",
      summary: "附件备注与用户范围存在解释冲突",
      definition_of_done: ["用户指定范围逐项验证"],
      requirements: [{
        id: "R33",
        source_anchor: "附件业务序号 33",
        observable_result: "序号 33 页面支持跳转",
        acceptance: ["调查阶段确认真实 pageName 并验证跳转"],
        dependencies: []
      }],
      blocker: {
        id: "B-evidence",
        kind: "evidence_blocked",
        message: "pageName 尚需从代码与相邻证据核对"
      }
    });

    expect(events).toEqual([expect.objectContaining({
      type: "plan_accepted",
      requirements: [expect.objectContaining({ id: "R33" })]
    })]);
  });

  it("emits an append-only event for a requirement discovered inside a phase", () => {
    const events = parseHierarchicalRoleResult({
      kind: "run_phase",
      requirement_id: "R1",
      work_unit_id: "R1:investigate",
      phase: "investigate",
      role: "code-investigator"
    }, {
      status: "passed",
      summary: "found another required entry",
      evidence_refs: ["src/routes.ts:42"],
      handoff: handoffFor("investigate"),
      discovered_requirements: [{
        id: "R2",
        source_anchor: "src/routes.ts:42",
        observable_result: "second entry works",
        acceptance: ["second entry is verified"],
        dependencies: ["R1"]
      }]
    });

    expect(events[0]).toMatchObject({
      type: "requirements_appended",
      requirements: [{ id: "R2" }]
    });
    expect(events[1]).toMatchObject({ type: "phase_passed", work_unit_id: "R1:investigate" });
  });

  it("does not let acceptance details disguised as discovered requirements fail a passed phase", () => {
    const operation = {
      kind: "run_phase" as const,
      requirement_id: "R1",
      work_unit_id: "R1:investigate",
      phase: "investigate" as const,
      role: "code-investigator"
    };
    const events = parseHierarchicalRoleResult(operation, {
      status: "passed",
      summary: "LQBInvest 组件存在，UQBHome 仍需补映射",
      evidence_refs: ["lib/views/myAssets/LQBInvest.js:1"],
      handoff: handoffFor("investigate"),
      discovered_requirements: [{
        id: "R1-A1-UQBHome",
        source_anchor: "lib/views/myAssets/LQBInvest.js",
        observable_result: "组件存在",
        acceptance: ["UQBHome 跳转到组件"],
        dependencies: ["lib/views/myAssets/LQBInvest.js 组件存在"]
      }]
    });

    expect(events).toEqual([expect.objectContaining({
      type: "phase_passed",
      work_unit_id: "R1:investigate"
    })]);
  });

  it("injects commit mark into implement phase prompt when configured", () => {
    const session = plannedSession();
    const state = session.hierarchical_state!;
    state.requirements[0]!.current_phase = "implement";
    state.active_work_unit = {
      id: "R1:implement",
      requirement_id: "R1",
      phase: "implement",
      status: "ready",
      assigned_role: "task-executor",
      attempt: 1,
      baseline_knowledge_revision: 0,
      allowed_files: ["src/target.ts"]
    };

    const spec = buildHierarchicalRoleSpec(session, workflow, {
      kind: "run_phase",
      requirement_id: "R1",
      work_unit_id: "R1:implement",
      phase: "implement",
      role: "task-executor"
    }, "Generated-by: AI Coder");

    expect(spec.prompt).toContain("## Git 提交印记");
    expect(spec.prompt).toContain("Generated-by: AI Coder");
    expect(spec.prompt).toContain("git commit -m");
    expect(spec.prompt).toContain("不得省略");
  });

  it("omits commit mark section when commitMark is empty", () => {
    const session = plannedSession();
    const state = session.hierarchical_state!;
    state.requirements[0]!.current_phase = "implement";
    state.active_work_unit = {
      id: "R1:implement",
      requirement_id: "R1",
      phase: "implement",
      status: "ready",
      assigned_role: "task-executor",
      attempt: 1,
      baseline_knowledge_revision: 0,
      allowed_files: ["src/target.ts"]
    };

    const spec = buildHierarchicalRoleSpec(session, workflow, {
      kind: "run_phase",
      requirement_id: "R1",
      work_unit_id: "R1:implement",
      phase: "implement",
      role: "task-executor"
    });

    expect(spec.prompt).not.toContain("## Git 提交印记");
    expect(spec.prompt).not.toContain("commit message");
  });

  it("does not inject commit mark into non-implement phases", () => {
    const session = plannedSession();
    const spec = buildHierarchicalRoleSpec(session, workflow, {
      kind: "run_phase",
      requirement_id: "R1",
      work_unit_id: "R1:investigate",
      phase: "investigate",
      role: "code-investigator"
    }, "Generated-by: AI Coder");

    expect(spec.prompt).not.toContain("## Git 提交印记");
  });
});

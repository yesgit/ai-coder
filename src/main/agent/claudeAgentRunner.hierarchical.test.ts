import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { AgentSession, WorkflowTemplate } from "../../shared/types.js";
import { censusFeatureImplementations } from "../analysis/featureImplementationCensus.js";
import {
  buildHierarchicalSdkToolSurface,
  ClaudeAgentRunner,
  extractRecoverableStructuredOutputToolInput,
  extractPageNameTokens,
  formatRejectedHierarchicalOutput,
  getHierarchicalCapabilityLeaseError,
  getHierarchicalMcpBoundaryMessage,
  hierarchicalErrorFingerprint,
  hierarchicalValidationCorrection,
  isLineAddedByGitDiff,
  isWorkingTreeAddedEvidenceLocation,
  mergeFeatureCensusAdjudications,
  normalizeHierarchicalStructuredContainers,
  reconcileFeatureCensusQueryForStage,
  reconcileHierarchicalPlannerRequirementIds,
  reconcileHierarchicalFeatureCensusHandoff,
  reconcileHierarchicalInvestigateContractLocations,
  reconcileHierarchicalInvestigateFinalContracts,
  reconcileHierarchicalInvestigateMappingScope,
  reconcileHierarchicalInvestigateReferenceContracts,
  reconcileHierarchicalInvestigateReferenceHandoff,
  reconcileHierarchicalPrepareContractHandoff,
  reconcileHierarchicalPrepareObligationEvidence,
  recordFeatureCensusReceipt,
  validateHierarchicalBehaviorObligationContinuity,
  validateHierarchicalContractToolEvidence,
  validateHierarchicalInvestigateMappingScope,
  validateHierarchicalPlannerEnumeratedCoverage
} from "./claudeAgentRunner.js";
import {
  applyHierarchicalEvent,
  createHierarchicalExecutionState
} from "../workflows/hierarchicalWorkflowEngine.js";
import { parseHierarchicalRoleResult } from "./hierarchicalRoleProtocol.js";

const workflow: WorkflowTemplate = {
  id: "hierarchical-test",
  name: "Hierarchical Test",
  version: "1.0.0",
  description: "Test host-owned nested loops",
  source: { type: "builtin", id: "hierarchical-test", version: "1.0.0" },
  execution_mode: "hierarchical",
  permissions: { filesystem: { mode: "project-only" }, shell: { approval_required: false } },
  rework: { enabled: false, allowed_targets: [], approval_required: false, invalidate_downstream: true },
  stages: [],
  agents: {}
};

function createSession(): AgentSession {
  const now = new Date().toISOString();
  return {
    id: "00000000-0000-4000-8000-000000000099",
    project_path: process.cwd(),
    workflow_id: workflow.id,
    task_prompt: "新增 getRouteName，并用测试证明行为正确",
    status: "running",
    current_stage: "align",
    messages: [],
    tool_calls: [],
    file_changes: [],
    approvals: [],
    progress_events: [],
    stage_runs: [],
    rework_requests: [],
    auto_approve: true,
    created_at: now,
    updated_at: now
  };
}

function handoffFor(
  phase: string,
  targetFile = "target.ts",
  referenceFile = "reference.ts",
  featureCensusRequired = false
) {
  const target = `${targetFile}:1`;
  const reference = `${referenceFile}:5`;
  if (phase === "investigate") return {
    confirmed_facts: ["target confirmed"], target_locations: [target],
    target_mappings: [{
      target_key: "route",
      requested_token: "route",
      canonical_token: "route",
      dispatcher_location: target,
      contract_symbol: "reference",
      contract_location: reference,
      evidence_refs: [target, reference]
    }],
    feature_census: {
      applicability: featureCensusRequired ? "required" : "not-applicable",
      reason: featureCensusRequired ? "功能以用户行为描述，必须普查实现候选" : "测试目标是静态配置",
      status: featureCensusRequired ? "complete" : "not-applicable",
      report_digest: featureCensusRequired ? "a".repeat(64) : "",
      candidate_accounting: featureCensusRequired
        ? { total: 1, yes: 1, no: 0, unknown: 0, accounted: true }
        : { total: 0, yes: 0, no: 0, unknown: 0, accounted: true },
      selected_candidate_ids: featureCensusRequired ? ["candidate-target"] : []
    },
    target_investigation: {
      target_kind: featureCensusRequired ? "function" : "static-config",
      definition: target, inputs: [`input at ${target}`],
      outputs: [`output at ${target}`], internal_calls: [`none; ${target}`],
      guards: [`none; ${target}`], state_and_side_effects: [`none; ${target}`],
      callers: [`caller at ${target}`], evidence_refs: [target], unresolved: []
    },
    reference_analysis: {
      search_scope: ["searched project sources"],
      candidates: featureCensusRequired ? [{
        target_key: "route",
        reference_kind: "same-feature-entry",
        location: reference,
        contract_location: reference,
        contract_symbol: "reference",
        feature_equivalence: [`same user-visible feature at ${reference}`],
        similarity: ["same callable shape"],
        reusable_behavior: ["preserve forwarding"], differences: ["different name"],
        destination: `target component at ${reference}`,
        invocation: `direct function call at ${reference}`,
        arguments: [`input forwarded at ${reference}`],
        preconditions: [`no preconditions at ${reference}`],
        context_forwarding: [`no context forwarding at ${reference}`],
        side_effects: [`no side effects at ${reference}`],
        evidence_refs: [reference]
      }] : [],
      target_selections: [{
        target_key: "route",
        selected_location: featureCensusRequired ? reference : "",
        selection_reason: featureCensusRequired ? "closest contract" : "",
        no_reference_reason: featureCensusRequired
          ? ""
          : "static configuration fixture has no callable reference"
      }]
    },
    open_unknowns: []
  };
  if (phase === "prepare") return {
    call_contract: { analyzed_targets: [{
      target_file: targetFile, symbol: "target", analysis_method: "manual-static-analysis",
      method_reason: "synthetic runner fixture has no analyzable source file",
      analyzer_sections: [], all_pages_consumed: false,
      definition: target, inputs: [`input at ${target}`], outputs: [`output at ${target}`],
      callers: [`caller at ${target}`], wrappers_and_indirect_references: [`none; ${target}`],
      guards: [`none; ${target}`], state_and_side_effects: [`none; ${target}`],
      compatibility_obligations: ["preserve forwarding"], unresolved: [],
      evidence_refs: [target]
    }, {
      target_file: referenceFile, symbol: "reference", analysis_method: "manual-static-analysis",
      method_reason: "synthetic runner fixture has no analyzable reference file",
      analyzer_sections: [], all_pages_consumed: false,
      definition: reference, inputs: [`input at ${reference}`], outputs: [`output at ${reference}`],
      callers: [`caller at ${reference}`], wrappers_and_indirect_references: [`none; ${reference}`],
      guards: [`none; ${reference}`], state_and_side_effects: [`none; ${reference}`],
      compatibility_obligations: ["preserve reference behavior"], unresolved: [],
      evidence_refs: [reference]
    }] },
    reference_application: [{
      target_key: "route",
      dimension: "argument forwarding", target_behavior: "forward input", reference_behavior: "forward input",
      decision: "reuse", reason: "same contract", evidence_refs: [reference, target]
    }],
    behavior_obligations: behaviorObligations(reference, target),
    change_disposition: "changes_required",
    satisfaction_evidence: [`destination checked at ${target}`],
    pre_behavior: ["baseline captured"],
    preserve_invariants: ["existing behavior remains"], patch_plan: ["minimal edit"],
    verification_plan: ["focused check"]
  };
  if (phase === "implement") return {
    changes: ["target updated"], diff_summary: "minimal diff",
    checks_run: ["git diff --check"], preserved_invariants: ["existing behavior remains"],
    obligation_results: behaviorObligationResults("applied", target)
  };
  return {
    verification_summary: "acceptance passed", regression_checks: ["focused check passed"],
    unresolved_risks: [],
    contract_results: behaviorObligationResults("pass", target)
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

function integrationContractResults(requirementIds: string[], evidence: string) {
  return requirementIds.flatMap((requirement_id) =>
    behaviorObligationResults("pass", evidence).map((result) => ({
      requirement_id,
      ...result,
      status: "pass" as const
    }))
  );
}

describe("ClaudeAgentRunner hierarchical mode", () => {
  it("accumulates feature census batches and lets the latest verdict replace a prior one", () => {
    const merged = mergeFeatureCensusAdjudications(
      [{
        candidate_id: "first",
        verdict: "no",
        reason: "initial exclusion",
        evidence_refs: ["first.ts:1"]
      }],
      [{
        candidate_id: "second",
        verdict: "yes",
        reason: "target implementation",
        evidence_refs: ["second.ts:2"]
      }, {
        candidate_id: "first",
        verdict: "yes",
        reason: "corrected after full read",
        evidence_refs: ["first.ts:3"]
      }]
    );

    expect(merged).toEqual([{
      candidate_id: "first",
      verdict: "yes",
      reason: "corrected after full read",
      evidence_refs: ["first.ts:3"]
    }, {
      candidate_id: "second",
      verdict: "yes",
      reason: "target implementation",
      evidence_refs: ["second.ts:2"]
    }]);
  });

  it("locks census query fields after the first successful receipt while preserving new adjudications", () => {
    const session = createSession();
    const stageId = "hierarchical:R33/investigate";
    const canonicalInput = {
      feature: "零钱宝页面跳转",
      aliases: ["UQBHomeV", "LQBInvest"],
      acceptance_clues: ["零钱宝主页"],
      negative_clues: ["零钱宝交易记录"],
      scope_paths: ["lib/views"]
    };
    session.tool_calls = [{
      id: "feature-census-first",
      stage_id: stageId,
      tool: "mcp__ai_coder__locate_feature_implementation",
      input: canonicalInput,
      status: "completed",
      created_at: new Date().toISOString()
    }];
    recordFeatureCensusReceipt(session, stageId, canonicalInput, {
      status: "partial",
      report_digest: "d".repeat(64),
      candidate_accounting: { total: 12, yes: 0, no: 0, unknown: 12, accounted: true },
      selected_targets: [],
      unresolved: ["仍有候选待裁决"]
    } as unknown as ReturnType<typeof censusFeatureImplementations>);
    const adjudications = [{
      candidate_id: "candidate-1",
      verdict: "yes" as const,
      reason: "零钱宝目标组件",
      evidence_refs: ["lib/views/myAssets/LQBInvest.js:29"]
    }];

    const reconciled = reconcileFeatureCensusQueryForStage(session, stageId, {
      feature: "转托管入和零钱宝导航",
      aliases: ["ESCTR"],
      acceptance_clues: ["nativeLink"],
      scope_paths: ["lib/Const"],
      adjudications
    });

    expect(reconciled.locked).toBe(true);
    expect(reconciled.input).toEqual({
      ...canonicalInput,
      adjudications
    });
  });

  it("does not lock a census query before any call has produced a receipt", () => {
    const session = createSession();
    const submitted = {
      feature: "零钱宝页面跳转",
      aliases: ["UQBHomeV"]
    };

    expect(reconcileFeatureCensusQueryForStage(
      session,
      "hierarchical:R33/investigate",
      submitted
    )).toEqual({ input: submitted, locked: false });
  });

  it("keeps guarded write tools visible and redirects legacy MCP tools without involving the user", () => {
    expect(buildHierarchicalSdkToolSurface(["Read", "Bash"])).toEqual([
      "Read",
      "Bash",
      "Edit",
      "Write"
    ]);
    expect(buildHierarchicalSdkToolSurface([])).toEqual([]);

    const session = createSession();
    session.hierarchical_state = createHierarchicalExecutionState(session.task_prompt);
    expect(getHierarchicalMcpBoundaryMessage(
      session,
      "mcp__ai_coder__ask_human"
    )).toContain("不能用 ask_human 申请 Edit");
    expect(getHierarchicalMcpBoundaryMessage(
      session,
      "mcp__ai_coder__update_task_tree"
    )).toContain("旧 Profile 循环");
    session.current_stage = "R1/prepare";
    expect(getHierarchicalCapabilityLeaseError(session, "Edit", {
      file_path: "src/route.ts"
    })).toContain("宿主验收 prepare 后会自动进入 implement");
    expect(session.pending_human_questions ?? []).toHaveLength(0);
  });

  it("recovers a structured phase draft from common StructuredOutput name corruption", () => {
    const draft = { status: "passed", summary: "prepared" };
    expect(extractRecoverableStructuredOutputToolInput([{
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "structured-1",
          name: "StructuredStructOutput",
          input: draft
        }]
      }
    }])).toEqual(draft);

    expect(extractRecoverableStructuredOutputToolInput([{
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          id: "unrelated-1",
          name: "update_task_tree",
          input: draft
        }]
      }
    }])).toBeUndefined();
  });

  it("recovers a complete XML-style StructuredOutput draft emitted as assistant text", () => {
    expect(extractRecoverableStructuredOutputToolInput([{
      type: "assistant",
      message: {
        content: [{
          type: "text",
          text: [
            "<StructuredOutput>",
            "<status>blocked</status>",
            "<summary>需求 token 尚未在基线实现</summary>",
            "<evidence_refs>",
            "- attachments/page-12.png",
            "- lib/router.js:63",
            "</evidence_refs>",
            "<handoff>",
            "<confirmed_facts>",
            "- 附件要求 pageName=LQBHomeV3",
            "- 基线已有 LQBInvest 入口",
            "</confirmed_facts>",
            "<open_unknowns></open_unknowns>",
            "</handoff>",
            "</StructuredOutput>"
          ].join("\n")
        }]
      }
    }])).toEqual({
      status: "blocked",
      summary: "需求 token 尚未在基线实现",
      evidence_refs: ["attachments/page-12.png", "lib/router.js:63"],
      handoff: {
        confirmed_facts: ["附件要求 pageName=LQBHomeV3", "基线已有 LQBInvest 入口"],
        open_unknowns: []
      }
    });
  });

  it("decodes JSON containers nested inside tagged or tool-owned fields", () => {
    expect(extractRecoverableStructuredOutputToolInput([{
      type: "assistant",
      message: {
        content: [{
          type: "text",
          text: [
            "<StructuredOutput>",
            "<status>passed</status>",
            "<evidence_refs>[\"src/route.ts:1\"]</evidence_refs>",
            "<discovered_requirements>[]</discovered_requirements>",
            "<handoff>{\"open_unknowns\":[]}</handoff>",
            "</StructuredOutput>"
          ].join("\n")
        }]
      }
    }])).toEqual({
      status: "passed",
      evidence_refs: ["src/route.ts:1"],
      discovered_requirements: [],
      handoff: { open_unknowns: [] }
    });

    expect(normalizeHierarchicalStructuredContainers({
      status: "passed",
      summary: "{keep this prose unchanged}",
      evidence_refs: "[\"src/route.ts:1\"]",
      handoff: "{\"open_unknowns\":[],\"feature_census\":\"{\\\"applicability\\\":\\\"required\\\"}\"}"
    })).toEqual({
      status: "passed",
      summary: "{keep this prose unchanged}",
      evidence_refs: ["src/route.ts:1"],
      handoff: {
        open_unknowns: [],
        feature_census: { applicability: "required" }
      }
    });
  });

  it("requires every in-scope business sequence while ignoring earlier attachment context", () => {
    const session = createSession();
    session.task_prompt = "请从序号 33 开始实现所有页面跳转";
    session.hierarchical_state = {
      ...session.hierarchical_state!,
      alignment_batches: [{
        id: "A1",
        source_refs: ["page-01.png"],
        status: "completed",
        attempt: 1,
        consecutive_failure_count: 0,
        summary: "reference item 1 and target items 33 and 44",
        findings: [
          { source_anchor: "序号1", observable_result: "reference item 1 works", acceptance: ["1 passes"] },
          { source_anchor: "序号33", observable_result: "item 33 works", acceptance: ["33 passes"] },
          { source_anchor: "序号44", observable_result: "item 44 works", acceptance: ["44 passes"] }
        ],
        evidence_refs: ["page-01.png"]
      }]
    };
    const operation = { kind: "run_planner" as const };
    const structured = {
      requirements: [{ id: "R33", source_anchor: "序号33" }]
    };

    expect(() => validateHierarchicalPlannerEnumeratedCoverage(session, operation, structured))
      .toThrow("planner 需求账本遗漏用户范围内业务序号：44");

    structured.requirements.push({ id: "R44", source_anchor: "序号44" });
    expect(() => validateHierarchicalPlannerEnumeratedCoverage(session, operation, structured)).not.toThrow();
  });

  it("normalizes dashed numeric planner ids and dependency references before validation", () => {
    const session = createSession();
    session.task_prompt = "请从序号 33 开始实现所有页面跳转";
    session.hierarchical_state = {
      ...session.hierarchical_state!,
      alignment_batches: [{
        id: "A1",
        source_refs: ["page-12.png"],
        status: "completed",
        attempt: 1,
        consecutive_failure_count: 0,
        summary: "目标条目 33 和 34",
        findings: [
          { source_anchor: "序号33", observable_result: "零钱宝跳转", acceptance: ["33 passes"] },
          { source_anchor: "序号34", observable_result: "托管转入跳转", acceptance: ["34 passes"] }
        ],
        evidence_refs: ["page-12.png"]
      }]
    };
    const operation = { kind: "run_planner" as const };
    const structured = {
      requirements: [
        { id: "R-33", source_anchor: "序号33", dependencies: [] },
        { id: "R_034-entry", source_anchor: "序号34", dependencies: ["R-33"] }
      ]
    };

    expect(reconcileHierarchicalPlannerRequirementIds(operation, structured)).toEqual([
      "R-33→R33",
      "R_034-entry→R34-entry"
    ]);
    expect(structured.requirements).toEqual([
      { id: "R33", source_anchor: "序号33", dependencies: [] },
      { id: "R34-entry", source_anchor: "序号34", dependencies: ["R33"] }
    ]);
    expect(() => validateHierarchicalPlannerEnumeratedCoverage(session, operation, structured)).not.toThrow();
  });

  it("requires the host-owned full investigation script for declared prepare contracts", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "ai-coder-contract-gate-"));
    try {
      await writeFile(path.join(projectPath, "target.ts"), [
        "export function target(input: string) { return input; }",
        "export function caller() { return target('value'); }",
        "export const registeredTarget = target;"
      ].join("\n"));
      await writeFile(path.join(projectPath, "reference.ts"), "export function reference(input: string) { return input; }\n");
      const session = { ...createSession(), project_path: projectPath };
      const handoff = handoffFor("prepare") as Record<string, unknown>;
      const callContract = handoff.call_contract as { analyzed_targets: Array<Record<string, unknown>> };
      callContract.analyzed_targets[0]!.analysis_method = "investigation-script";
      callContract.analyzed_targets[0]!.method_reason = "";
      callContract.analyzed_targets[0]!.analyzer_sections = ["contract", "calls", "wrappers", "references"];
      callContract.analyzed_targets[0]!.all_pages_consumed = true;
      callContract.analyzed_targets[1]!.target_file = "target.ts";
      callContract.analyzed_targets[1]!.symbol = "missingReference";
      const operation = {
        kind: "run_phase" as const,
        requirement_id: "R1",
        work_unit_id: "R1:prepare",
        phase: "prepare" as const,
        role: "implementation-preparer"
      };
      const events = [{
        type: "phase_passed" as const,
        work_unit_id: "R1:prepare",
        summary: "prepared",
        handoff,
        evidence_refs: ["target.ts:1"],
        allowed_files: ["target.ts"]
      }];
      const stageId = "hierarchical:R1/prepare";

      expect(() => validateHierarchicalContractToolEvidence(session, operation, events, stageId))
        .toThrow("未实际执行完整调用契约调查脚本");

      session.tool_calls = [{
        id: "contract-investigation-script",
        stage_id: stageId,
        tool: "mcp__ai_coder__investigate_symbol_contract",
        input: { target_file: "target.ts", symbol: "target" },
        status: "completed" as const,
        created_at: new Date().toISOString()
      }];
      callContract.analyzed_targets[0] = {
        target_file: "target.ts",
        symbol: "target"
      };
      reconcileHierarchicalPrepareContractHandoff(
        session,
        operation,
        { status: "passed", handoff },
        stageId
      );
      expect(callContract.analyzed_targets[0]).toMatchObject({
        investigation_report_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
        reference_accounting: {
          total: expect.any(Number),
          resolved: expect.any(Number),
          irrelevant: expect.any(Number),
          blocked: expect.any(Number),
          accounted: true
        },
        runtime_verification_required: true
      });
      expect(callContract.analyzed_targets[0]!.unresolved).toEqual(expect.arrayContaining([
        expect.stringContaining("target.ts:3")
      ]));
      expect(() => validateHierarchicalContractToolEvidence(session, operation, events, stageId)).not.toThrow();
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("requires a real successful validation command after the last code change", () => {
    const session = createSession();
    const operation = {
      kind: "run_phase" as const,
      requirement_id: "R1",
      work_unit_id: "R1:verify",
      phase: "verify" as const,
      role: "independent-verifier"
    };
    const events = [{
      type: "phase_passed" as const,
      work_unit_id: "R1:verify",
      summary: "verified by reading strings",
      handoff: handoffFor("verify"),
      evidence_refs: ["target.ts:1"]
    }];
    const stageId = "hierarchical:R1/verify";
    session.tool_calls = [{
      id: "edit-target",
      stage_id: "hierarchical:R1/implement",
      tool: "Edit",
      input: { file_path: "target.ts" },
      status: "completed",
      created_at: new Date().toISOString()
    }];

    expect(() => validateHierarchicalContractToolEvidence(session, operation, events, stageId))
      .toThrow("成功验证命令");

    session.tool_calls.push({
      id: "masked-check-target",
      stage_id: stageId,
      tool: "Bash",
      input: { command: "node --check target.ts || echo 'Syntax check completed'" },
      status: "completed",
      exit_code: 0,
      output_summary: "Syntax check completed",
      created_at: new Date().toISOString()
    });
    expect(() => validateHierarchicalContractToolEvidence(session, operation, events, stageId))
      .toThrow("成功验证命令");

    session.tool_calls.push({
      id: "missing-node-check-target",
      stage_id: stageId,
      tool: "Bash",
      input: { command: "node --check target.ts" },
      status: "completed",
      exit_code: 0,
      output_summary: "/bin/bash: node：未找到命令",
      created_at: new Date().toISOString()
    });
    expect(() => validateHierarchicalContractToolEvidence(session, operation, events, stageId))
      .toThrow("成功验证命令");

    session.tool_calls.push({
      id: "check-target",
      stage_id: stageId,
      tool: "Bash",
      input: { command: "node --check target.ts" },
      status: "completed",
      exit_code: 0,
      created_at: new Date().toISOString()
    });
    expect(() => validateHierarchicalContractToolEvidence(session, operation, events, stageId))
      .not.toThrow();
  });

  it("skips code-change validation for verify when prepare declared already_satisfied", () => {
    // Simulate a session where a PREVIOUS requirement made code changes,
    // but the CURRENT requirement (R2) was declared already_satisfied.
    const session = createSession();
    const state = createHierarchicalExecutionState(session.task_prompt);
    // Persist a prepare artifact with change_disposition=already_satisfied for R2
    const prepareHandoff = handoffFor("prepare");
    (prepareHandoff as Record<string, unknown>).change_disposition = "already_satisfied";
    state.phase_artifacts.push({
      id: "R2:prepare:artifact",
      work_unit_id: "R2:prepare",
      requirement_id: "R2",
      phase: "prepare",
      attempt: 1,
      summary: "already satisfied",
      handoff: prepareHandoff,
      evidence_refs: ["target.ts:1"],
      knowledge_revision: 0,
      workspace_revision: 0,
      created_at: new Date().toISOString()
    });
    session.hierarchical_state = state;
    // A previous requirement's Edit leaves file_changes dirty in the same session
    session.file_changes = [{ path: "target.ts", operation: "update", approved: true, created_at: new Date().toISOString() }];
    session.tool_calls = [{
      id: "prev-edit",
      stage_id: "hierarchical:R1/implement",
      tool: "Edit",
      input: { file_path: "target.ts" },
      status: "completed",
      created_at: new Date().toISOString()
    }];

    const operation = {
      kind: "run_phase" as const,
      requirement_id: "R2",
      work_unit_id: "R2:verify",
      phase: "verify" as const,
      role: "independent-verifier"
    };
    const events = [{
      type: "phase_passed" as const,
      work_unit_id: "R2:verify",
      summary: "verified by reading",
      handoff: handoffFor("verify"),
      evidence_refs: ["target.ts:1"]
    }];
    const stageId = "hierarchical:R2/verify";

    // Should NOT throw: already_satisfied means no code change for this requirement
    expect(() => validateHierarchicalContractToolEvidence(session, operation, events, stageId))
      .not.toThrow();
  });

  it("counts a Bash validation command as successful even when SDK did not report exit_code", () => {
    const session = createSession();
    const operation = {
      kind: "run_phase" as const,
      requirement_id: "R1",
      work_unit_id: "R1:verify",
      phase: "verify" as const,
      role: "independent-verifier"
    };
    const events = [{
      type: "phase_passed" as const,
      work_unit_id: "R1:verify",
      summary: "verified",
      handoff: handoffFor("verify"),
      evidence_refs: ["target.ts:1"]
    }];
    const stageId = "hierarchical:R1/verify";
    session.tool_calls = [
      {
        id: "edit-target",
        stage_id: "hierarchical:R1/implement",
        tool: "Edit",
        input: { file_path: "target.ts" },
        status: "completed",
        created_at: new Date().toISOString()
      },
      {
        id: "git-diff-check-no-exit",
        stage_id: stageId,
        tool: "Bash",
        input: { command: "git diff --check" },
        status: "completed",
        // exit_code deliberately omitted: SDK did not report it
        output_summary: "",
        created_at: new Date().toISOString()
      }
    ];

    // Should NOT throw: exit_code=undefined is acceptable when status=completed
    // and output has no error markers
    expect(() => validateHierarchicalContractToolEvidence(session, operation, events, stageId))
      .not.toThrow();
  });

  it("rejects a validation command when SDK omitted exit_code but the output reports failure", () => {
    const session = createSession();
    const operation = {
      kind: "run_phase" as const,
      requirement_id: "R1",
      work_unit_id: "R1:verify",
      phase: "verify" as const,
      role: "independent-verifier"
    };
    const events = [{
      type: "phase_passed" as const,
      work_unit_id: "R1:verify",
      summary: "verified",
      handoff: handoffFor("verify"),
      evidence_refs: ["target.ts:1"]
    }];
    const stageId = "hierarchical:R1/verify";
    session.tool_calls = [
      {
        id: "edit-target",
        stage_id: "hierarchical:R1/implement",
        tool: "Edit",
        input: { file_path: "target.ts" },
        status: "completed",
        created_at: new Date().toISOString()
      },
      {
        id: "tsc-failed-no-exit",
        stage_id: stageId,
        tool: "Bash",
        input: { command: "npx tsc --noEmit" },
        status: "completed",
        // exit_code deliberately omitted: SDK did not report it
        output_summary: "src/target.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
        created_at: new Date().toISOString()
      }
    ];

    let error: string | undefined;
    try {
      validateHierarchicalContractToolEvidence(session, operation, events, stageId);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    expect(error).toContain("成功验证命令");
    expect(error).toContain("失败标记");
  });

  it("includes specific diagnostic reasons when validation commands are rejected", () => {
    const session = createSession();
    const operation = {
      kind: "run_phase" as const,
      requirement_id: "R1",
      work_unit_id: "R1:verify",
      phase: "verify" as const,
      role: "independent-verifier"
    };
    const events = [{
      type: "phase_passed" as const,
      work_unit_id: "R1:verify",
      summary: "verified",
      handoff: handoffFor("verify"),
      evidence_refs: ["target.ts:1"]
    }];
    const stageId = "hierarchical:R1/verify";
    session.tool_calls = [
      {
        id: "edit-target",
        stage_id: "hierarchical:R1/implement",
        tool: "Edit",
        input: { file_path: "target.ts" },
        status: "completed",
        created_at: new Date().toISOString()
      },
      {
        id: "pipe-masked",
        stage_id: stageId,
        tool: "Bash",
        input: { command: "node --check target.ts || echo ok" },
        status: "completed",
        exit_code: 0,
        output_summary: "ok",
        created_at: new Date().toISOString()
      },
      {
        id: "missing-node",
        stage_id: stageId,
        tool: "Bash",
        input: { command: "node --check target.ts" },
        status: "completed",
        exit_code: 0,
        output_summary: "/bin/bash: node：未找到命令",
        created_at: new Date().toISOString()
      }
    ];

    let error: string | undefined;
    try {
      validateHierarchicalContractToolEvidence(session, operation, events, stageId);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    expect(error).toContain("成功验证命令");
    // The diagnostic should name the specific rejection reasons
    expect(error).toContain("管道符");
    expect(error).toContain("未找到命令");
  });

  it("merges the selected callable contract and dynamic reference anchors from trusted reports", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "ai-coder-prepare-reconcile-"));
    try {
      await writeFile(path.join(projectPath, "entry.ts"), [
        "import { reference } from './reference.js';",
        "export const existingRoute = reference;"
      ].join("\n"));
      await writeFile(path.join(projectPath, "reference.ts"), [
        "export function reference(input: string) { return input; }",
        "export const connectedReference = reference;"
      ].join("\n"));
      const session = { ...createSession(), project_path: projectPath };
      const state = createHierarchicalExecutionState(session.task_prompt);
      state.requirements = [{
        id: "R1",
        source_anchor: "user:R1",
        observable_result: "route works",
        acceptance: [{
          id: "R1-A1",
          criterion: "route works",
          status: "pending",
          evidence_refs: []
        }],
        dependencies: [],
        status: "active",
        evidence_refs: []
      }];
      const investigateHandoff = handoffFor(
        "investigate",
        "reference.ts",
        "reference.ts",
        true
      ) as Record<string, unknown>;
      const referenceAnalysis = investigateHandoff.reference_analysis as {
        candidates: Array<Record<string, unknown>>;
        target_selections: Array<Record<string, unknown>>;
      };
      const targetMappings = investigateHandoff.target_mappings as Array<Record<string, unknown>>;
      referenceAnalysis.candidates[0]!.location = "entry.ts:2";
      referenceAnalysis.candidates[0]!.contract_location = "reference.ts:1";
      referenceAnalysis.candidates[0]!.evidence_refs = ["entry.ts:2", "reference.ts:1"];
      targetMappings[0]!.contract_location = "reference.ts:1";
      referenceAnalysis.target_selections[0]!.selected_location = "entry.ts:2";
      state.phase_artifacts = [{
        id: "R1:investigate:artifact",
        work_unit_id: "R1:investigate",
        requirement_id: "R1",
        phase: "investigate",
        attempt: 1,
        summary: "entry traced to callable",
        handoff: investigateHandoff,
        evidence_refs: ["entry.ts:2", "reference.ts:1"],
        knowledge_revision: 0,
        workspace_revision: 0,
        created_at: state.created_at
      }];
      session.hierarchical_state = state;

      const prepareHandoff = handoffFor("prepare") as Record<string, unknown>;
      (prepareHandoff.call_contract as { analyzed_targets: unknown[] }).analyzed_targets = [{
        target_file: "reference.ts",
        symbol: "ConnectedReference"
      }];
      const structured = {
        status: "passed",
        summary: "prepared",
        evidence_refs: ["entry.ts:2", "reference.ts:1"],
        allowed_files: ["entry.ts"],
        handoff: prepareHandoff
      };
      const stageId = "hierarchical:R1/prepare";
      session.tool_calls = [{
        id: "reference-contract",
        stage_id: stageId,
        tool: "mcp__ai_coder__investigate_symbol_contract",
        input: { target_file: "reference.ts", symbol: "reference", target_line: 1 },
        status: "completed",
        created_at: new Date().toISOString()
      }];
      const operation = {
        kind: "run_phase" as const,
        requirement_id: "R1",
        work_unit_id: "R1:prepare",
        phase: "prepare" as const,
        role: "implementation-preparer"
      };

      reconcileHierarchicalPrepareContractHandoff(
        session,
        operation,
        structured,
        stageId
      );

      const targets = (
        prepareHandoff.call_contract as { analyzed_targets: Array<Record<string, unknown>> }
      ).analyzed_targets;
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({
        target_file: "reference.ts",
        symbol: "reference",
        analysis_method: "investigation-script",
        all_pages_consumed: true
      });
      expect(targets[0]!.unresolved).toEqual(expect.arrayContaining([
        expect.stringContaining("reference.ts:2")
      ]));
      expect(() => validateHierarchicalContractToolEvidence(
        session,
        operation,
        [{
          type: "phase_passed",
          work_unit_id: "R1:prepare",
          summary: "prepared",
          handoff: prepareHandoff,
          evidence_refs: ["entry.ts:2", "reference.ts:1"],
          allowed_files: ["entry.ts"]
        }],
        stageId
      )).not.toThrow();
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("keeps rejected structured drafts parseable while retaining tail contract fields", () => {
    const handoff = handoffFor("prepare") as Record<string, unknown>;
    handoff.pre_behavior = ["x".repeat(20_000)];
    handoff.preserve_invariants = ["y".repeat(20_000)];
    const rendered = formatRejectedHierarchicalOutput({
      status: "passed",
      summary: "oversized draft",
      evidence_refs: ["target.ts:1"],
      allowed_files: ["target.ts"],
      handoff
    });

    expect(rendered).toBeDefined();
    expect(rendered!.length).toBeLessThanOrEqual(12_000);
    const parsed = JSON.parse(rendered!) as {
      handoff: {
        behavior_obligations: unknown[];
        patch_plan: unknown[];
        verification_plan: unknown[];
      };
    };
    expect(parsed.handoff.behavior_obligations).toHaveLength(6);
    expect(parsed.handoff.patch_plan).toHaveLength(1);
    expect(parsed.handoff.verification_plan).toHaveLength(1);
  });

  it("requires a real complete feature census before a callable investigate target can pass", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "ai-coder-feature-census-gate-"));
    try {
      await writeFile(path.join(projectPath, "feature.ts"), [
        "export function LQBInvest() {",
        "  return '零钱宝主页';",
        "}"
      ].join("\n"));
      const initial = censusFeatureImplementations({
        projectPath,
        feature: "零钱宝主页",
        aliases: ["LQBInvest"]
      });
      const lqbCandidate = initial.candidates.find((candidate) => candidate.symbol === "LQBInvest")!;
      const adjudications = [{
        candidate_id: lqbCandidate.id,
        verdict: "yes" as const,
        reason: "目标页面组件定义",
        evidence_refs: ["feature.ts:1"]
      }];
      const report = censusFeatureImplementations({
        projectPath,
        feature: "零钱宝主页",
        aliases: ["LQBInvest"],
        adjudications
      });
      expect(report.status).toBe("complete");
      const session = { ...createSession(), project_path: projectPath };
      const state = createHierarchicalExecutionState(session.task_prompt);
      state.requirements = [{
        id: "R1",
        source_anchor: "attachment:page-14",
        observable_result: "pageName='LQBInvest'，linkType='nativeLink'，跳转到零钱宝主页",
        acceptance: [{
          id: "R1-A1",
          criterion: "fixedPathToJSON 中 pageName='LQBInvest'",
          status: "pending",
          evidence_refs: []
        }],
        dependencies: [],
        status: "active",
        evidence_refs: []
      }];
      session.hierarchical_state = state;
      const handoff = handoffFor("investigate", "feature.ts", "reference.ts", true) as Record<string, unknown>;
      const targetMappings = handoff.target_mappings as Array<Record<string, unknown>>;
      targetMappings[0]!.target_key = "LQBInvest";
      targetMappings[0]!.requested_token = "LQBInvest";
      targetMappings[0]!.canonical_token = "LQBInvest";
      targetMappings[0]!.contract_symbol = "LQBInvest";
      targetMappings[0]!.contract_location = "feature.ts:1";
      targetMappings[0]!.evidence_refs = ["feature.ts:1"];
      const referenceAnalysis = handoff.reference_analysis as {
        candidates: Array<Record<string, unknown>>;
        target_selections: Array<Record<string, unknown>>;
      };
      referenceAnalysis.candidates[0]!.target_key = "LQBInvest";
      referenceAnalysis.candidates[0]!.contract_symbol = "LQBInvest";
      referenceAnalysis.candidates[0]!.contract_location = "feature.ts:1";
      referenceAnalysis.candidates[0]!.evidence_refs = ["reference.ts:5", "feature.ts:1"];
      referenceAnalysis.target_selections[0]!.target_key = "LQBInvest";
      handoff.feature_census = {
        applicability: "required",
        reason: "业务功能描述需要完整候选普查",
        status: "complete",
        report_digest: report.report_digest,
        candidate_accounting: report.candidate_accounting,
        selected_candidate_ids: report.selected_targets.map((target) => target.candidate_id)
      };
      const operation = {
        kind: "run_phase" as const,
        requirement_id: "R1",
        work_unit_id: "R1:investigate",
        phase: "investigate" as const,
        role: "code-investigator"
      };
      const events = [{
        type: "phase_passed" as const,
        work_unit_id: "R1:investigate",
        summary: "investigated",
        handoff,
        evidence_refs: ["feature.ts:1"]
      }];
      const stageId = "hierarchical:R1/investigate";

      expect(() => validateHierarchicalContractToolEvidence(session, operation, events, stageId))
        .toThrow("未实际执行功能实现候选普查脚本");

      const censusInput = {
        feature: "零钱宝主页",
        aliases: ["LQBInvest"],
        adjudications
      };
      session.tool_calls = [{
        id: "feature-census",
        stage_id: stageId,
        tool: "mcp__ai_coder__locate_feature_implementation",
        input: censusInput,
        status: "completed" as const,
        created_at: new Date().toISOString()
      }];
      expect(() => validateHierarchicalContractToolEvidence(session, operation, events, stageId))
        .toThrow("缺少宿主 Worker 回执");
      recordFeatureCensusReceipt(session, stageId, censusInput, report);
      expect(() => validateHierarchicalContractToolEvidence(session, operation, events, stageId))
        .not.toThrow();

      targetMappings.push({
        ...targetMappings[0],
        target_key: "R1-A1",
        requested_token: "jumpLinkWX"
      });
      expect(() => validateHierarchicalContractToolEvidence(session, operation, events, stageId))
        .toThrow("不能按验收项 ID 或配置字段拆分：R1-A1=jumpLinkWX");
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("distinguishes baseline reference lines from implementations added in the working tree", () => {
    const diff = [
      "diff --git a/routes.ts b/routes.ts",
      "@@ -1,0 +2,2 @@",
      "+export function justAddedRoute() { return 'new'; }",
      "+export const registered = justAddedRoute;"
    ].join("\n");

    expect(isLineAddedByGitDiff(diff, 1)).toBe(false);
    expect(isLineAddedByGitDiff(diff, 2)).toBe(true);
    expect(isLineAddedByGitDiff(diff, 3)).toBe(true);
    expect(isLineAddedByGitDiff(diff, 4)).toBe(false);
  });

  it("extracts every original pageName token without absorbing adjacent linkType fields", () => {
    expect(extractPageNameTokens([
      "pageName 值为 LqbHomeV3 或 TGZCRZ；linkType 值为 nativeLink",
      "兼容 pageName === 'MyIA'",
      "pageName confirm UQBao routes to the target page",
      "pageName='confirm' 是明确带引号的真实协议值"
    ])).toEqual(["LqbHomeV3", "TGZCRZ", "MyIA", "UQBao", "confirm"]);
  });

  it("treats pre-existing dirty lines as task baseline until the current session edits the file", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "ai-coder-task-baseline-"));
    try {
      execFileSync("git", ["init"], { cwd: projectPath, stdio: "ignore" });
      await writeFile(path.join(projectPath, "routes.ts"), "export const existing = true;\n");
      execFileSync("git", ["add", "routes.ts"], { cwd: projectPath, stdio: "ignore" });
      execFileSync("git", [
        "-c", "user.name=AI Coder Test",
        "-c", "user.email=test@example.invalid",
        "commit", "-m", "baseline"
      ], { cwd: projectPath, stdio: "ignore" });
      await writeFile(path.join(projectPath, "routes.ts"), [
        "export const existing = true;",
        "export const preExistingDirtyEntry = true;"
      ].join("\n"));

      const session = { ...createSession(), project_path: projectPath };
      expect(isWorkingTreeAddedEvidenceLocation(session, "routes.ts:2")).toBe(false);

      session.file_changes.push({
        path: path.join(projectPath, "routes.ts"),
        operation: "update",
        approved: true,
        stage_id: "R1/implement",
        created_at: new Date().toISOString()
      });
      expect(isWorkingTreeAddedEvidenceLocation(session, "routes.ts:2")).toBe(true);
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("rejects acceptance-item pseudo targets before reference-selection validation", () => {
    const session = createSession();
    const state = createHierarchicalExecutionState(session.task_prompt);
    state.requirements = [{
      id: "R39",
      source_anchor: "attachment:page-14",
      observable_result: "pageName='CHGPWD'，linkType='nativeLink'",
      acceptance: [{
        id: "R39-A1",
        criterion: "jumpLinkWX 配置存在",
        status: "pending",
        evidence_refs: []
      }],
      dependencies: [],
      status: "active",
      evidence_refs: []
    }];
    session.hierarchical_state = state;
    const handoff = handoffFor("investigate") as Record<string, unknown>;
    handoff.target_mappings = [{
      ...(handoff.target_mappings as Array<Record<string, unknown>>)[0],
      target_key: "CHGPWD",
      requested_token: "CHGPWD",
      canonical_token: "CHGPWD"
    }, {
      ...(handoff.target_mappings as Array<Record<string, unknown>>)[0],
      target_key: "R39-A1",
      requested_token: "jumpLinkWX",
      canonical_token: "jumpLinkVo"
    }];
    const structured = {
      status: "passed",
      summary: "acceptance fields were incorrectly mapped as targets",
      evidence_refs: ["target.ts:1"],
      handoff
    };

    expect(() => validateHierarchicalInvestigateMappingScope(session, {
      kind: "run_phase",
      requirement_id: "R39",
      work_unit_id: "R39:investigate",
      phase: "investigate",
      role: "code-investigator"
    }, structured)).toThrow("R39-A1=jumpLinkWX");
  });

  it("removes a neighbouring requirement mapping and its reference rows before validation", () => {
    const session = createSession();
    const state = createHierarchicalExecutionState(session.task_prompt);
    state.requirements = [{
      id: "R33",
      source_anchor: "attachment:page-12",
      observable_result: "pageName='UqMoney'，linkType='nativeLink'，跳转到零钱宝页面",
      acceptance: [{
        id: "R33-A1",
        criterion: "UqMoney 能进入零钱宝页面",
        status: "pending",
        evidence_refs: []
      }],
      dependencies: [],
      status: "active",
      evidence_refs: []
    }, {
      id: "R34",
      source_anchor: "attachment:page-12",
      observable_result: "pageName='TGZCRZ'，linkType='nativeLink'，跳转到转托管入页面",
      acceptance: [{
        id: "R34-A1",
        criterion: "TGZCRZ 能进入转托管入页面",
        status: "pending",
        evidence_refs: []
      }],
      dependencies: [],
      status: "pending",
      evidence_refs: []
    }];
    session.hierarchical_state = state;
    const handoff = handoffFor("investigate", "target.ts", "reference.ts", true) as Record<string, unknown>;
    const mappings = handoff.target_mappings as Array<Record<string, unknown>>;
    mappings[0]!.target_key = "UqMoney";
    mappings[0]!.requested_token = "UqMoney";
    mappings[0]!.canonical_token = "LQB";
    mappings.push({
      ...mappings[0],
      target_key: "TGZCRZ",
      requested_token: "TGZCRZ",
      canonical_token: "TGZCRZ"
    });
    const referenceAnalysis = handoff.reference_analysis as {
      candidates: Array<Record<string, unknown>>;
      target_selections: Array<Record<string, unknown>>;
    };
    referenceAnalysis.candidates[0]!.target_key = "UqMoney";
    referenceAnalysis.candidates.push({
      ...referenceAnalysis.candidates[0],
      target_key: "TGZCRZ"
    }, {
      ...referenceAnalysis.candidates[0],
      target_key: "unrelated-invalid-target"
    });
    referenceAnalysis.target_selections[0]!.target_key = "UqMoney";
    referenceAnalysis.target_selections.push({
      ...referenceAnalysis.target_selections[0],
      target_key: "TGZCRZ"
    }, {
      ...referenceAnalysis.target_selections[0],
      target_key: "unrelated-invalid-target"
    });
    const structured = {
      status: "passed",
      summary: "R34 was accidentally copied into R33",
      evidence_refs: ["target.ts:1"],
      handoff
    };
    const operation = {
      kind: "run_phase" as const,
      requirement_id: "R33",
      work_unit_id: "R33:investigate",
      phase: "investigate" as const,
      role: "code-investigator"
    };

    expect(reconcileHierarchicalInvestigateMappingScope(
      session,
      operation,
      structured
    )).toEqual(["TGZCRZ=TGZCRZ"]);
    expect(handoff.target_mappings).toEqual([
      expect.objectContaining({ target_key: "UqMoney", requested_token: "UqMoney" })
    ]);
    expect(referenceAnalysis.candidates).toEqual([
      expect.objectContaining({ target_key: "UqMoney" }),
      expect.objectContaining({ target_key: "unrelated-invalid-target" })
    ]);
    expect(referenceAnalysis.target_selections).toEqual([
      expect.objectContaining({ target_key: "UqMoney" }),
      expect.objectContaining({ target_key: "unrelated-invalid-target" })
    ]);
    expect(() => validateHierarchicalInvestigateMappingScope(
      session,
      operation,
      structured
    )).not.toThrow();
  });

  it("fills host-owned feature census metadata from the last complete tool call", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "ai-coder-feature-census-reconcile-"));
    try {
      await writeFile(path.join(projectPath, "feature.ts"), [
        "export function LQBInvest() {",
        "  return '零钱宝主页';",
        "}"
      ].join("\n"));
      const initial = censusFeatureImplementations({
        projectPath,
        feature: "零钱宝主页",
        aliases: ["LQBInvest"]
      });
      const lqbCandidate = initial.candidates.find((candidate) => candidate.symbol === "LQBInvest")!;
      const adjudications = [{
        candidate_id: lqbCandidate.id,
        verdict: "yes" as const,
        reason: "目标页面组件定义",
        evidence_refs: ["feature.ts:1"]
      }];
      const report = censusFeatureImplementations({
        projectPath,
        feature: "零钱宝主页",
        aliases: ["LQBInvest"],
        adjudications
      });
      expect(report.status).toBe("complete");
      const stageId = "hierarchical:R1/investigate";
      const session = { ...createSession(), project_path: projectPath };
      const censusInput = { feature: "零钱宝主页", aliases: ["LQBInvest"], adjudications };
      session.tool_calls = [{
        id: "feature-census",
        stage_id: stageId,
        tool: "mcp__ai_coder__locate_feature_implementation",
        input: censusInput,
        status: "completed",
        created_at: new Date().toISOString()
      }];
      recordFeatureCensusReceipt(session, stageId, censusInput, report);
      const structured = {
        status: "passed",
        handoff: {
          feature_census: {
            applicability: "required",
            reason: "业务功能需要普查",
            status: "complete",
            report_digest: "模型没有正确抄写",
            candidate_accounting: {
              total: 999,
              yes: 0,
              no: 0,
              unknown: 999,
              accounted: true
            },
            selected_candidate_ids: []
          }
        }
      };

      reconcileHierarchicalFeatureCensusHandoff(session, {
        kind: "run_phase",
        requirement_id: "R1",
        work_unit_id: "R1:investigate",
        phase: "investigate",
        role: "code-investigator"
      }, structured, stageId);

      expect(structured.handoff.feature_census).toMatchObject({
        status: "complete",
        report_digest: report.report_digest,
        candidate_accounting: report.candidate_accounting,
        selected_candidate_ids: report.selected_targets.map((target) => target.candidate_id)
      });
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("backfills truthful host census facts from a partial receipt instead of dead-ending omitted fields", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "ai-coder-census-partial-"));
    try {
      await writeFile(path.join(projectPath, "feature.ts"), [
        "export function LQBInvest() {",
        "  return '零钱宝主页';",
        "}"
      ].join("\n"));
      const report = censusFeatureImplementations({
        projectPath,
        feature: "零钱宝主页",
        aliases: ["LQBInvest"]
      });
      expect(report.status).toBe("partial");
      const stageId = "hierarchical:R33/investigate";
      const session = { ...createSession(), project_path: projectPath };
      const censusInput = { feature: "零钱宝主页", aliases: ["LQBInvest"] };
      session.tool_calls = [{
        id: "feature-census",
        stage_id: stageId,
        tool: "mcp__ai_coder__locate_feature_implementation",
        input: censusInput,
        status: "completed",
        created_at: new Date().toISOString()
      }];
      recordFeatureCensusReceipt(session, stageId, censusInput, report);
      // Mirrors the prompt-guided draft: only applicability + reason are
      // model-supplied; every other census field is host-owned. A partial
      // receipt must still be backfilled truthfully instead of leaving the
      // draft to fail on fields the model was told to omit.
      const structured = {
        status: "passed",
        summary: "investigated",
        evidence_refs: ["feature.ts:1"],
        handoff: {
          feature_census: {
            applicability: "required",
            reason: "业务功能需要普查"
          }
        }
      };

      reconcileHierarchicalFeatureCensusHandoff(session, {
        kind: "run_phase",
        requirement_id: "R33",
        work_unit_id: "R33:investigate",
        phase: "investigate",
        role: "code-investigator"
      }, structured, stageId);

      expect(structured.handoff.feature_census).toMatchObject({
        status: "partial",
        report_digest: report.report_digest,
        candidate_accounting: report.candidate_accounting,
        selected_candidate_ids: report.selected_targets.map((target) => target.candidate_id)
      });
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("does not let a later accidental partial census erase a complete stage receipt", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "ai-coder-census-complete-monotonic-"));
    try {
      await writeFile(path.join(projectPath, "feature.ts"), [
        "export function LQBInvest() {",
        "  return '零钱宝主页';",
        "}"
      ].join("\n"));
      const partialReport = censusFeatureImplementations({
        projectPath,
        feature: "零钱宝主页",
        aliases: ["LQBInvest"]
      });
      const candidate = partialReport.candidates.find((item) => item.symbol === "LQBInvest")!;
      const adjudications = [{
        candidate_id: candidate.id,
        verdict: "yes" as const,
        reason: "目标页面组件定义",
        evidence_refs: ["feature.ts:1"]
      }];
      const completeReport = censusFeatureImplementations({
        projectPath,
        feature: "零钱宝主页",
        aliases: ["LQBInvest"],
        adjudications
      });
      expect(completeReport.status).toBe("complete");
      const stageId = "hierarchical:R33/investigate";
      const session = { ...createSession(), project_path: projectPath };
      const completeInput = {
        feature: "零钱宝主页",
        aliases: ["LQBInvest"],
        adjudications
      };
      const accidentalPartialInput = {
        feature: "零钱宝主页导航",
        aliases: ["LQBInvest", "pageName", "nativeLink"]
      };
      session.tool_calls = [
        {
          id: "feature-census-complete",
          stage_id: stageId,
          tool: "mcp__ai_coder__locate_feature_implementation",
          input: completeInput,
          status: "completed" as const,
          created_at: new Date(1).toISOString()
        },
        {
          id: "feature-census-accidental-partial",
          stage_id: stageId,
          tool: "mcp__ai_coder__locate_feature_implementation",
          input: accidentalPartialInput,
          status: "completed" as const,
          created_at: new Date(2).toISOString()
        }
      ];
      recordFeatureCensusReceipt(session, stageId, completeInput, completeReport);
      recordFeatureCensusReceipt(session, stageId, accidentalPartialInput, partialReport);
      const structured = {
        status: "passed",
        handoff: {
          feature_census: {
            applicability: "required",
            reason: "业务功能需要普查"
          }
        }
      };

      reconcileHierarchicalFeatureCensusHandoff(session, {
        kind: "run_phase",
        requirement_id: "R33",
        work_unit_id: "R33:investigate",
        phase: "investigate",
        role: "code-investigator"
      }, structured, stageId);

      expect(structured.handoff.feature_census).toMatchObject({
        status: "complete",
        report_digest: completeReport.report_digest,
        candidate_accounting: completeReport.candidate_accounting,
        selected_candidate_ids: completeReport.selected_targets.map((target) => target.candidate_id)
      });
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("rejects a partial-backfilled census draft with the actionable census-incomplete error", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "ai-coder-census-partial-parse-"));
    try {
      await writeFile(path.join(projectPath, "feature.ts"), [
        "export function LQBInvest() {",
        "  return '零钱宝主页';",
        "}"
      ].join("\n"));
      const report = censusFeatureImplementations({
        projectPath,
        feature: "零钱宝主页",
        aliases: ["LQBInvest"]
      });
      expect(report.status).toBe("partial");
      const stageId = "hierarchical:R33/investigate";
      const session = { ...createSession(), project_path: projectPath };
      const censusInput = { feature: "零钱宝主页", aliases: ["LQBInvest"] };
      session.tool_calls = [{
        id: "feature-census",
        stage_id: stageId,
        tool: "mcp__ai_coder__locate_feature_implementation",
        input: censusInput,
        status: "completed",
        created_at: new Date().toISOString()
      }];
      recordFeatureCensusReceipt(session, stageId, censusInput, report);
      const handoff = handoffFor("investigate", "feature.ts", "reference.ts", true) as Record<string, unknown>;
      // Prompt-guided drafts omit the host-owned census fields entirely.
      handoff.feature_census = { applicability: "required", reason: "业务功能需要普查" };
      const structured = {
        status: "passed",
        summary: "investigated",
        evidence_refs: ["feature.ts:1"],
        handoff
      };
      const operation = {
        kind: "run_phase" as const,
        requirement_id: "R33",
        work_unit_id: "R33:investigate",
        phase: "investigate" as const,
        role: "code-investigator"
      };

      reconcileHierarchicalFeatureCensusHandoff(session, operation, structured, stageId);

      expect(() => parseHierarchicalRoleResult(operation, structured)).toThrow(
        "功能实现候选普查未 complete，不能结束 investigate"
      );
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("corrects census digest rejections based on the real receipt status", () => {
    const operation = {
      kind: "run_phase" as const,
      requirement_id: "R33",
      work_unit_id: "R33:investigate",
      phase: "investigate" as const,
      role: "code-investigator"
    };
    const digestReason = "handoff.feature_census.report_digest 必须是非空字符串";

    const withComplete = hierarchicalValidationCorrection(operation, digestReason, {
      status: "complete",
      candidate_accounting: { total: 1, yes: 1, no: 0, unknown: 0, accounted: true }
    });
    expect(withComplete).toContain("宿主会从真实报告自动回填 report_digest");

    // The previously unconditional "host will backfill" message was a lie for
    // partial receipts and looped the session into a blocked escalation.
    const withPartial = hierarchicalValidationCorrection(operation, digestReason, {
      status: "partial",
      candidate_accounting: { total: 180, yes: 1, no: 20, unknown: 159, accounted: true }
    });
    expect(withPartial).toContain("partial");
    expect(withPartial).toContain("unknown=159");
    expect(withPartial).toContain("重跑 locate_feature_implementation");
    expect(withPartial).not.toContain("沿用最后一次 complete");

    const withoutReceipt = hierarchicalValidationCorrection(operation, digestReason, null);
    expect(withoutReceipt).toContain("没有 complete 回执");
    expect(withoutReceipt).toContain("重跑 locate_feature_implementation");

    const accountingReason = "feature_census.selected_candidate_ids 必须逐项对应全部 yes 候选：yes=2，selected=1";
    const accountingPartial = hierarchicalValidationCorrection(operation, accountingReason, {
      status: "partial",
      candidate_accounting: { total: 180, yes: 1, no: 20, unknown: 159, accounted: true }
    });
    expect(accountingPartial).toContain("没有 complete 普查报告可回填");
    expect(accountingPartial).toContain("重跑 locate_feature_implementation");

    const contractCorrection = hierarchicalValidationCorrection(
      operation,
      "candidate Setting 未追到 LQBInvest 已确认的同一最终函数/组件",
      {
        status: "complete",
        candidate_accounting: { total: 16, yes: 1, no: 15, unknown: 0, accounted: true }
      }
    );
    expect(contractCorrection).toContain("已有 complete 功能普查回执");
    expect(contractCorrection).toContain("不要重跑普查");
  });

  it("corrects a new requested token misclassified as a user decision", () => {
    const correction = hierarchicalValidationCorrection({
      kind: "run_phase",
      requirement_id: "R33",
      work_unit_id: "R33:investigate",
      phase: "investigate",
      role: "code-investigator"
    }, "investigate 把需求 token 在基线中尚未实现的事实误记成 open_unknowns；这是待实现的基线实现缺口");

    expect(correction).toContain("不是需要用户确认");
    expect(correction).toContain("canonical_token 使用待新增 token");
    expect(correction).toContain("prepare 判定 changes_required");
  });

  it("reopens only a census candidate that was wrongly adjudicated no", () => {
    const correction = hierarchicalValidationCorrection({
      kind: "run_phase",
      requirement_id: "R33",
      work_unit_id: "R33:investigate",
      phase: "investigate",
      role: "code-investigator"
    }, "目标定义 lib/views/myAssets/LQBInvest.js:29 在 complete 功能普查中被误裁为 no（candidate_id=LQBInvest_LQBInvest_js_29）");

    expect(correction).toContain("完全相同的 feature、aliases、clues 与 scope");
    expect(correction).toContain("candidate_id=LQBInvest_LQBInvest_js_29");
    expect(correction).toContain("yes adjudication");
    expect(correction).not.toContain("不要重跑普查");
  });

  it("reconciles dispatcher branch contracts to one census-owned destination component", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "ai-coder-final-contract-reconcile-"));
    try {
      await writeFile(path.join(projectPath, "EscrowTransfer.js"),
        "export class EscrowTransfer {}\n");
      await writeFile(path.join(projectPath, "routes.js"), [
        "import { EscrowTransfer } from './EscrowTransfer.js';",
        "",
        "export function redirectActionPush(pageName, navigator) {",
        "  if (pageName === 'TGCZR') {",
        "    navigator.push({ component: EscrowTransfer });",
        "  }",
        "  if (pageName === 'TOCINV') {",
        "    navigator.push({ component: EscrowTransfer });",
        "  }",
        "  if (pageName === 'TGZCRZ') {",
        "    navigator.push({ component: EscrowTransfer });",
        "  }",
        "}"
      ].join("\n"));

      const session = { ...createSession(), project_path: projectPath };
      const stageId = "hierarchical:R34/investigate";
      const censusInput = {
        feature: "托管转入",
        aliases: ["TGCZR", "TOCINV", "TGZCRZ", "EscrowTransfer"]
      };
      session.tool_calls = [{
        id: "feature-census",
        stage_id: stageId,
        tool: "mcp__ai_coder__locate_feature_implementation",
        input: censusInput,
        status: "completed" as const,
        created_at: new Date().toISOString()
      }];
      recordFeatureCensusReceipt(
        session,
        stageId,
        censusInput,
        {
          status: "complete",
          report_digest: "f".repeat(64),
          candidate_accounting: {
            total: 1,
            yes: 1,
            no: 0,
            unknown: 0,
            accounted: true
          },
          selected_targets: [{
            candidate_id: "EscrowTransfer.js:1#EscrowTransfer",
            symbol: "EscrowTransfer",
            kind: "class",
            definition: {
              file: "EscrowTransfer.js",
              line: 1,
              column: 14
            },
            role: "implementation",
            trace_summary_digest: "trace"
          }],
          unresolved: []
        } as unknown as ReturnType<typeof censusFeatureImplementations>
      );

      const handoff = handoffFor("investigate", "routes.js", "routes.js", true) as Record<string, unknown>;
      const mapping = (handoff.target_mappings as Array<Record<string, unknown>>)[0]!;
      Object.assign(mapping, {
        target_key: "TGCZR",
        requested_token: "TGCZR",
        canonical_token: "TGCZR",
        dispatcher_location: "routes.js:3",
        contract_symbol: "redirectActionPush",
        contract_location: "routes.js:4",
        evidence_refs: ["routes.js:4"]
      });
      const referenceAnalysis = handoff.reference_analysis as {
        candidates: Array<Record<string, unknown>>;
        target_selections: Array<Record<string, unknown>>;
      };
      referenceAnalysis.candidates = [4, 7, 10].map((line) => ({
        ...referenceAnalysis.candidates[0],
        target_key: "TGCZR",
        location: `routes.js:${line}`,
        contract_symbol: "redirectActionPush",
        contract_location: `routes.js:${line}`,
        destination: "EscrowTransfer component",
        invocation: "navigator.push({ component: EscrowTransfer })",
        evidence_refs: [`routes.js:${line}`]
      }));
      referenceAnalysis.target_selections[0]!.target_key = "TGCZR";
      referenceAnalysis.target_selections[0]!.selected_location = "routes.js:7";
      const structured = {
        status: "passed",
        summary: "route branches were mistaken for final contracts",
        evidence_refs: ["routes.js:3"],
        handoff
      };

      expect(reconcileHierarchicalInvestigateFinalContracts(
        session,
        {
          kind: "run_phase",
          requirement_id: "R34",
          work_unit_id: "R34:investigate",
          phase: "investigate",
          role: "code-investigator"
        },
        structured,
        stageId
      )).toEqual([
        "TGCZR: redirectActionPush@routes.js:4 → EscrowTransfer@EscrowTransfer.js:1"
      ]);
      expect(mapping).toMatchObject({
        contract_symbol: "EscrowTransfer",
        contract_location: "EscrowTransfer.js:1",
        evidence_refs: ["routes.js:4", "EscrowTransfer.js:1"]
      });
      expect(referenceAnalysis.candidates).toHaveLength(3);
      expect(referenceAnalysis.candidates.every((candidate) => (
        candidate.contract_symbol === "EscrowTransfer"
        && candidate.contract_location === "EscrowTransfer.js:1"
      ))).toBe(true);
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("canonicalizes submitted branch locations to the symbol definition on the host", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "ai-coder-contract-location-"));
    try {
      await writeFile(path.join(projectPath, "routes.js"), [
        "export const redirectActionPush = (pageName) => {",
        "  if (pageName === 'MIA') return 'advisor';",
        "  if (pageName === 'Setting') return 'settings';",
        "};"
      ].join("\n"));
      const session = { ...createSession(), project_path: projectPath };
      const handoff = handoffFor("investigate", "routes.js", "routes.js", true) as Record<string, unknown>;
      const mappings = handoff.target_mappings as Array<Record<string, unknown>>;
      Object.assign(mappings[0], {
        target_key: "MIA",
        dispatcher_location: "routes.js:1",
        contract_symbol: "redirectActionPush",
        contract_location: "routes.js:2",
        evidence_refs: ["routes.js:2"]
      });
      const referenceAnalysis = handoff.reference_analysis as {
        candidates: Array<Record<string, unknown>>;
      };
      Object.assign(referenceAnalysis.candidates[0], {
        target_key: "MIA",
        contract_symbol: "redirectActionPush",
        contract_location: "routes.js:2",
        evidence_refs: ["routes.js:2"]
      });
      const structured = { status: "passed", summary: "branch location", evidence_refs: [], handoff };

      expect(reconcileHierarchicalInvestigateContractLocations(
        session,
        {
          kind: "run_phase",
          requirement_id: "R35",
          work_unit_id: "R35:investigate",
          phase: "investigate",
          role: "code-investigator"
        },
        structured
      )).toEqual(["redirectActionPush@routes.js:2 → routes.js:1"]);
      expect(mappings[0]).toMatchObject({
        contract_location: "routes.js:1",
        evidence_refs: ["routes.js:2", "routes.js:1"]
      });
      expect(referenceAnalysis.candidates[0]).toMatchObject({
        contract_location: "routes.js:1",
        evidence_refs: ["routes.js:2", "routes.js:1"]
      });
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("does not reconcile final contracts when reference destinations disagree", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "ai-coder-ambiguous-contract-"));
    try {
      await writeFile(path.join(projectPath, "EscrowTransfer.js"),
        "export class EscrowTransfer {}\n");
      await writeFile(path.join(projectPath, "routes.js"), [
        "export function redirectActionPush() {",
        "  return 'route';",
        "}"
      ].join("\n"));
      const session = { ...createSession(), project_path: projectPath };
      const stageId = "hierarchical:R34/investigate";
      const censusInput = { feature: "托管", aliases: ["EscrowTransfer"] };
      session.tool_calls = [{
        id: "feature-census",
        stage_id: stageId,
        tool: "mcp__ai_coder__locate_feature_implementation",
        input: censusInput,
        status: "completed" as const,
        created_at: new Date().toISOString()
      }];
      recordFeatureCensusReceipt(
        session,
        stageId,
        censusInput,
        {
          status: "complete",
          report_digest: "e".repeat(64),
          candidate_accounting: {
            total: 1,
            yes: 1,
            no: 0,
            unknown: 0,
            accounted: true
          },
          selected_targets: [{
            candidate_id: "EscrowTransfer.js:1#EscrowTransfer",
            symbol: "EscrowTransfer",
            kind: "class",
            definition: { file: "EscrowTransfer.js", line: 1, column: 14 },
            role: "implementation",
            trace_summary_digest: "trace"
          }],
          unresolved: []
        } as unknown as ReturnType<typeof censusFeatureImplementations>
      );
      const handoff = handoffFor("investigate", "routes.js", "routes.js", true) as Record<string, unknown>;
      const mapping = (handoff.target_mappings as Array<Record<string, unknown>>)[0]!;
      Object.assign(mapping, {
        target_key: "TGCZR",
        dispatcher_location: "routes.js:1",
        contract_symbol: "redirectActionPush",
        contract_location: "routes.js:2"
      });
      const analysis = handoff.reference_analysis as {
        candidates: Array<Record<string, unknown>>;
      };
      analysis.candidates = [{
        ...analysis.candidates[0],
        target_key: "TGCZR",
        location: "routes.js:1",
        destination: "EscrowTransfer component",
        invocation: "navigator.push({ component: DifferentTransfer })"
      }];

      expect(reconcileHierarchicalInvestigateFinalContracts(
        session,
        {
          kind: "run_phase",
          requirement_id: "R34",
          work_unit_id: "R34:investigate",
          phase: "investigate",
          role: "code-investigator"
        },
        { status: "passed", handoff },
        stageId
      )).toEqual([]);
      expect(mapping).toMatchObject({
        contract_symbol: "redirectActionPush",
        contract_location: "routes.js:2"
      });
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("expands an explicitly selected shared reference across aliases with the same final contract", () => {
    const handoff = handoffFor(
      "investigate",
      "target.ts",
      "reference.ts",
      true
    ) as Record<string, unknown>;
    const mappings = handoff.target_mappings as Array<Record<string, unknown>>;
    mappings.push({
      ...mappings[0],
      target_key: "route-alias",
      requested_token: "route-alias",
      canonical_token: "route"
    }, {
      ...mappings[0],
      target_key: "different-contract",
      requested_token: "different-contract",
      canonical_token: "different-contract",
      contract_symbol: "otherReference",
      contract_location: "other-reference.ts:9"
    });
    const referenceAnalysis = handoff.reference_analysis as {
      candidates: Array<Record<string, unknown>>;
      target_selections: Array<Record<string, unknown>>;
    };
    referenceAnalysis.target_selections.push({
      target_key: "route-alias",
      selected_location: "reference.ts:5",
      selection_reason: "same existing entry reaches the shared final callable",
      no_reference_reason: ""
    }, {
      target_key: "different-contract",
      selected_location: "reference.ts:5",
      selection_reason: "incorrectly assumed to share the entry",
      no_reference_reason: ""
    });
    const structured = {
      status: "passed",
      summary: "shared reference selected for aliases",
      evidence_refs: ["target.ts:1", "reference.ts:5"],
      handoff
    };

    reconcileHierarchicalInvestigateReferenceHandoff({
      kind: "run_phase",
      requirement_id: "R1",
      work_unit_id: "R1:investigate",
      phase: "investigate",
      role: "code-investigator"
    }, structured);

    expect(referenceAnalysis.candidates).toHaveLength(2);
    expect(referenceAnalysis.candidates[1]).toMatchObject({
      target_key: "route-alias",
      location: "reference.ts:5",
      contract_symbol: "reference",
      contract_location: "reference.ts:5"
    });
    expect(referenceAnalysis.candidates).not.toContainEqual(expect.objectContaining({
      target_key: "different-contract"
    }));
  });

  it("removes a stale reference candidate after the complete census confirms a different final contract", () => {
    const session = createSession();
    const stageId = "hierarchical:R34/investigate";
    const censusInput = {
      feature: "托管转入与我的投资顾问页面跳转",
      aliases: ["ESCTR", "MIA", "H5Page"]
    };
    session.tool_calls = [{
      id: "feature-census",
      stage_id: stageId,
      tool: "mcp__ai_coder__locate_feature_implementation",
      input: censusInput,
      status: "completed" as const,
      created_at: new Date().toISOString()
    }];
    recordFeatureCensusReceipt(session, stageId, censusInput, {
      status: "complete",
      report_digest: "b".repeat(64),
      candidate_accounting: { total: 1, yes: 1, no: 0, unknown: 0, accounted: true },
      selected_targets: [{
        candidate_id: "H5Page.js:33#H5Page",
        symbol: "H5Page",
        kind: "class",
        definition: {
          file: "lib/views/product/H5Page.js",
          line: 33,
          column: 14
        },
        role: "implementation",
        trace_summary_digest: "trace"
      }],
      unresolved: []
    } as unknown as ReturnType<typeof censusFeatureImplementations>);

    const handoff = handoffFor("investigate", "target.ts", "reference.ts", true) as Record<string, unknown>;
    const mapping = (handoff.target_mappings as Array<Record<string, unknown>>)[0]!;
    Object.assign(mapping, {
      target_key: "ESCTR",
      requested_token: "TGCBTZ",
      canonical_token: "ESCTR",
      dispatcher_location: "lib/views/homepage/utils/homepageRedirection.js:702",
      contract_symbol: "H5Page",
      contract_location: "lib/views/product/H5Page.js:33"
    });
    const referenceAnalysis = handoff.reference_analysis as {
      candidates: Array<Record<string, unknown>>;
      target_selections: Array<Record<string, unknown>>;
    };
    Object.assign(referenceAnalysis.candidates[0]!, {
      target_key: "ESCTR",
      location: "lib/views/myAssets/LQBInvest.js:29",
      contract_symbol: "LQBInvest",
      contract_location: "lib/views/myAssets/LQBInvest.js:29"
    });
    Object.assign(referenceAnalysis.target_selections[0]!, {
      target_key: "ESCTR",
      selected_location: "lib/views/myAssets/LQBInvest.js:29",
      selection_reason: "同属首页 nativeLink 跳转",
      no_reference_reason: ""
    });
    const structured = { status: "passed", handoff };

    expect(reconcileHierarchicalInvestigateReferenceContracts(
      session,
      {
        kind: "run_phase",
        requirement_id: "R34",
        work_unit_id: "R34:investigate",
        phase: "investigate",
        role: "code-investigator"
      },
      structured,
      stageId
    )).toEqual([
      "ESCTR: lib/views/myAssets/LQBInvest.js:29 (LQBInvest@lib/views/myAssets/LQBInvest.js:29)"
    ]);
    expect(referenceAnalysis.candidates).toEqual([]);
    expect(referenceAnalysis.target_selections[0]).toMatchObject({
      target_key: "ESCTR",
      selected_location: "",
      selection_reason: "",
      no_reference_reason: expect.stringContaining("未提供其他可验证的同功能入口")
    });
  });

  it("keeps a mismatched reference candidate when the census has not confirmed the target mapping", () => {
    const session = createSession();
    const stageId = "hierarchical:R34/investigate";
    const censusInput = { feature: "托管转入", aliases: ["ESCTR"] };
    session.tool_calls = [{
      id: "feature-census",
      stage_id: stageId,
      tool: "mcp__ai_coder__locate_feature_implementation",
      input: censusInput,
      status: "completed" as const,
      created_at: new Date().toISOString()
    }];
    recordFeatureCensusReceipt(session, stageId, censusInput, {
      status: "complete",
      report_digest: "c".repeat(64),
      candidate_accounting: { total: 1, yes: 1, no: 0, unknown: 0, accounted: true },
      selected_targets: [{
        candidate_id: "Other.js:1#Other",
        symbol: "Other",
        kind: "function",
        definition: { file: "Other.js", line: 1, column: 1 },
        role: "implementation",
        trace_summary_digest: "trace"
      }],
      unresolved: []
    } as unknown as ReturnType<typeof censusFeatureImplementations>);
    const handoff = handoffFor("investigate", "target.ts", "reference.ts", true) as Record<string, unknown>;
    const referenceAnalysis = handoff.reference_analysis as {
      candidates: Array<Record<string, unknown>>;
    };
    const before = structuredClone(referenceAnalysis.candidates);

    expect(reconcileHierarchicalInvestigateReferenceContracts(
      session,
      {
        kind: "run_phase",
        requirement_id: "R34",
        work_unit_id: "R34:investigate",
        phase: "investigate",
        role: "code-investigator"
      },
      { status: "passed", handoff },
      stageId
    )).toEqual([]);
    expect(referenceAnalysis.candidates).toEqual(before);
  });

  it("fills a missing alias selection when both tokens share one exact final contract", () => {
    const handoff = handoffFor("investigate", "target.ts", "reference.ts", true) as Record<string, unknown>;
    const mappings = handoff.target_mappings as Array<Record<string, unknown>>;
    mappings.push({
      ...mappings[0],
      target_key: "route-alias",
      requested_token: "LQBInvest",
      canonical_token: "LQBInvest"
    });
    const referenceAnalysis = handoff.reference_analysis as {
      candidates: Array<Record<string, unknown>>;
      target_selections: Array<Record<string, unknown>>;
    };
    const structured = { status: "passed", handoff };

    reconcileHierarchicalInvestigateReferenceHandoff({
      kind: "run_phase",
      requirement_id: "R1",
      work_unit_id: "R1:investigate",
      phase: "investigate",
      role: "code-investigator"
    }, structured);

    expect(referenceAnalysis.target_selections).toContainEqual(expect.objectContaining({
      target_key: "route-alias",
      selected_location: "reference.ts:5",
      no_reference_reason: ""
    }));
    expect(referenceAnalysis.candidates).toContainEqual(expect.objectContaining({
      target_key: "route-alias",
      location: "reference.ts:5",
      contract_symbol: "reference"
    }));
  });

  it("normalizes reference ranges and clears placeholders for no-reference targets", () => {
    const handoff = handoffFor(
      "investigate",
      "target.ts",
      "reference.ts",
      true
    ) as Record<string, unknown>;
    const mappings = handoff.target_mappings as Array<Record<string, unknown>>;
    mappings.push({
      ...mappings[0],
      target_key: "no-reference",
      requested_token: "no-reference",
      canonical_token: "no-reference"
    });
    const referenceAnalysis = handoff.reference_analysis as {
      candidates: Array<Record<string, unknown>>;
      target_selections: Array<Record<string, unknown>>;
    };
    referenceAnalysis.target_selections[0]!.selected_location = "reference.ts:5-12";
    referenceAnalysis.target_selections.push({
      target_key: "no-reference",
      selected_location: "reference.ts:N/A",
      selection_reason: "placeholder for an entry that does not exist",
      no_reference_reason: "the repository has no same-feature entry"
    });

    reconcileHierarchicalInvestigateReferenceHandoff({
      kind: "run_phase",
      requirement_id: "R1",
      work_unit_id: "R1:investigate",
      phase: "investigate",
      role: "code-investigator"
    }, {
      status: "passed",
      summary: "reference transcription contains ranges and placeholders",
      evidence_refs: ["target.ts:1"],
      handoff
    });

    expect(referenceAnalysis.target_selections[0]!.selected_location).toBe("reference.ts:5");
    expect(referenceAnalysis.target_selections[1]).toMatchObject({
      target_key: "no-reference",
      selected_location: "",
      selection_reason: "",
      no_reference_reason: "the repository has no same-feature entry"
    });
  });

  it("groups changing census inventories under one bounded-retry fingerprint", () => {
    const first = hierarchicalErrorFingerprint(
      "R33/investigate",
      "功能实现候选普查未闭合：unknown=22；候选尚未逐项判定：a.ts:1#one"
    );
    const second = hierarchicalErrorFingerprint(
      "R33/investigate",
      "功能实现候选普查未闭合：unknown=126；动态调用边界无法静态穷举：b.ts:712#ChatProvider"
    );
    const digestShape = hierarchicalErrorFingerprint(
      "R33/investigate",
      "feature_census.report_digest 必须是完整调查报告 SHA-256"
    );
    const digestMismatch = hierarchicalErrorFingerprint(
      "R33/investigate",
      "feature_census.report_digest 与宿主重算的真实普查报告不一致"
    );

    expect(first).toBe(second);
    expect(digestShape).toBe(digestMismatch);
    expect(first).not.toBe(digestShape);
  });

  it("groups rotating obligation-citation failures under one class fingerprint", () => {
    const destination = hierarchicalErrorFingerprint(
      "R33/prepare",
      "行为义务 B1-destination 未引用 零钱宝 的选定同功能入口 lib/views/homepage/components/IconConfiguration.js:36"
    );
    const argumentsFp = hierarchicalErrorFingerprint(
      "R33/prepare",
      "行为义务 B3-arguments 未引用 转托管入 的选定同功能入口 lib/views/homepage/utils/homepageRedirection.js:58"
    );
    // Same violation class -> same fingerprint, so the bounded-recovery streak
    // counts "still missing an obligation citation" instead of churning B1->B3
    // and resetting to 1/6 on every rotation.
    expect(destination).toBe(argumentsFp);
    // A different violation class produces a distinct fingerprint.
    const referenceApplication = hierarchicalErrorFingerprint(
      "R33/prepare",
      "reference_application 未逐目标覆盖 TQlqbmore"
    );
    expect(destination).not.toBe(referenceApplication);
    // A fail-collect composite listing several missing obligations still
    // collapses to the single obligation-evidence-missing class fingerprint.
    const composite = hierarchicalErrorFingerprint(
      "R33/prepare",
      "prepare 阶段交接物未通过校验，共 4 处：\n"
      + "- 行为义务 B1-destination 未引用 零钱宝 的选定同功能入口 lib/a.js:36\n"
      + "- 行为义务 B3-arguments 未引用 零钱宝 的选定同功能入口 lib/a.js:36\n"
      + "- 行为义务 B4-preconditions 未引用 零钱宝 的选定同功能入口 lib/a.js:36\n"
      + "- 行为义务 B6-side_effects 未引用 零钱宝 的选定同功能入口 lib/a.js:36"
    );
    expect(composite).toBe(destination);
  });

  it("groups investigate handoff violations into per-section class fingerprints", () => {
    const contractMismatchA = hierarchicalErrorFingerprint(
      "R33/investigate",
      "target_mappings.LQB 的 contract_symbol/contract_location 未命中同一定义：redirectActionPush@lib/views/homepage/utils/homepageRedirection.js:171"
    );
    const contractMismatchB = hierarchicalErrorFingerprint(
      "R33/investigate",
      "target_mappings.LgbWealth 的 contract_symbol/contract_location 未命中同一定义：redirectActionPush@lib/views/homepage/utils/homepageRedirection.js:58"
    );
    expect(contractMismatchA).toBe(contractMismatchB);
    // Coverage and contract-mismatch are both target_mappings issues -> same class.
    const coverage = hierarchicalErrorFingerprint(
      "R33/investigate",
      "target_mappings 未逐项覆盖需求中的 pageName 原词：LgbWealth"
    );
    expect(coverage).toBe(contractMismatchA);
    // A different section (reference_analysis) produces a distinct fingerprint.
    const referenceSelection = hierarchicalErrorFingerprint(
      "R33/investigate",
      "以下目标缺少逐目标 reference selection：LgbWealth"
    );
    expect(referenceSelection).not.toBe(contractMismatchA);
    // candidates-traced and reference-selection are both reference_analysis -> same class.
    const candidatesTraced = hierarchicalErrorFingerprint(
      "R33/investigate",
      "handoff.reference_analysis.candidates[0] 未追到 LQB 已确认的同一最终函数/组件：redirectActionPush@lib/views/homepage/utils/homepageRedirection.js:58"
    );
    expect(candidatesTraced).toBe(referenceSelection);
  });

  it("prioritizes the shared final contract when correcting a reference mismatch", () => {
    const correction = hierarchicalValidationCorrection({
      kind: "run_phase",
      requirement_id: "R39",
      work_unit_id: "R39:investigate",
      phase: "investigate",
      role: "code-investigator"
    }, [
      "investigate 阶段交接物未通过校验，共 2 处：",
      "- handoff.reference_analysis.candidates[0] 未追到 R39-A3 已确认的同一最终函数/组件：",
      "candidate jumptoChangeLoginPassword@AccountSecure.js:638 ≠ ",
      "target_mappings 声明的 redirectActionPush@homepageRedirection.js:59",
      "- R39-A3.selected_location 必须对应同一 target_key 的 candidate.location"
    ].join("\n"));

    expect(correction).toContain("dispatcher_location");
    expect(correction).toContain("共同的最终页面组件/业务函数");
    expect(correction).toContain("candidate.location 保留独立的任务基线入口");
  });

  it("directs acceptance-item target mappings to be removed instead of expanded", () => {
    const correction = hierarchicalValidationCorrection({
      kind: "run_phase",
      requirement_id: "R39",
      work_unit_id: "R39:investigate",
      phase: "investigate",
      role: "code-investigator"
    }, "target_mappings 只能按需求中的 pageName/协议原词建账，不能按验收项 ID 或配置字段拆分：R39-A1=jumpLinkWX");

    expect(correction).toContain("删除按 Rxx-A1 验收项");
    expect(correction).toContain("每个需求原始 pageName/协议值只保留一条映射");
  });

  it("closes frozen obligations by id, status and evidence without requiring identical prose", () => {
    const session = createSession();
    const state = createHierarchicalExecutionState(session.task_prompt);
    const investigateHandoff = handoffFor("investigate", "target.ts", "reference.ts", true);
    const prepareHandoff = handoffFor("prepare") as Record<string, unknown>;
    state.requirements = [{
      id: "R1",
      source_anchor: "user:R1",
      observable_result: "route works",
      acceptance: [{ id: "R1-A1", criterion: "route works", status: "pass", evidence_refs: ["target.ts:1"] }],
      dependencies: [],
      status: "completed",
      evidence_refs: ["target.ts:1"]
    }];
    state.phase_artifacts = [{
      id: "R1:investigate:artifact",
      work_unit_id: "R1:investigate",
      requirement_id: "R1",
      phase: "investigate",
      attempt: 1,
      summary: "same-feature entry selected",
      handoff: investigateHandoff,
      evidence_refs: ["reference.ts:5"],
      knowledge_revision: 0,
      workspace_revision: 0,
      created_at: state.created_at
    }, {
      id: "R1:prepare:artifact",
      work_unit_id: "R1:prepare",
      requirement_id: "R1",
      phase: "prepare",
      attempt: 1,
      summary: "behavior frozen",
      handoff: prepareHandoff,
      evidence_refs: ["target.ts:1", "reference.ts:5"],
      knowledge_revision: 0,
      workspace_revision: 0,
      created_at: state.created_at
    }];
    session.hierarchical_state = state;

    const prepareEvent = {
      type: "phase_passed" as const,
      work_unit_id: "R1:prepare",
      summary: "prepared",
      handoff: prepareHandoff,
      evidence_refs: ["target.ts:1", "reference.ts:5"],
      // Static configuration files need a write lease and patch plan, but they
      // are not callable contracts and must not be forced into analyzed_targets.
      allowed_files: ["target.ts", "RouterDisplayName.js", "Const/index.js"]
    };
    const prepareOperation = {
      kind: "run_phase" as const,
      requirement_id: "R1",
      work_unit_id: "R1:prepare",
      phase: "prepare" as const,
      role: "implementation-preparer"
    };
    expect(() => validateHierarchicalBehaviorObligationContinuity(
      session,
      prepareOperation,
      [prepareEvent]
    )).not.toThrow();
    const obligations = prepareHandoff.behavior_obligations as Array<Record<string, unknown>>;
    const originalObligationEvidence = obligations.map((obligation) => obligation.evidence_refs);
    obligations.forEach((obligation) => {
      // The target branch does not exist before implementation. A
      // changes_required contract must be allowed to cite only the proven
      // same-feature reference; implement/verify provide target evidence later.
      obligation.evidence_refs = ["reference.ts:5"];
    });
    expect(() => validateHierarchicalBehaviorObligationContinuity(
      session,
      prepareOperation,
      [prepareEvent]
    )).not.toThrow();
    prepareHandoff.change_disposition = "already_satisfied";
    expect(() => validateHierarchicalBehaviorObligationContinuity(
      session,
      prepareOperation,
      [prepareEvent]
    )).toThrow("already_satisfied 行为义务 B-destination 缺少当前目标代码");
    prepareHandoff.change_disposition = "changes_required";
    obligations.forEach((obligation, index) => {
      obligation.evidence_refs = originalObligationEvidence[index];
    });
    const analyzedTargets = (
      prepareHandoff.call_contract as { analyzed_targets: Array<Record<string, unknown>> }
    ).analyzed_targets;
    const referenceTarget = analyzedTargets.pop()!;
    expect(() => validateHierarchicalBehaviorObligationContinuity(
      session,
      prepareOperation,
      [prepareEvent]
    )).toThrow("同功能入口对应的真实函数/组件");
    analyzedTargets.push(referenceTarget);
    referenceTarget.symbol = "redirectActionPush";
    expect(() => validateHierarchicalBehaviorObligationContinuity(
      session,
      prepareOperation,
      [prepareEvent]
    )).toThrow("reference@reference.ts:5");
    referenceTarget.symbol = "reference";

    const mappings = investigateHandoff.target_mappings as Array<Record<string, unknown>>;
    mappings.push({
      target_key: "second-route",
      requested_token: "TGZCRZ",
      canonical_token: "TGZCRZ",
      dispatcher_location: "target.ts:1",
      contract_symbol: "secondReference",
      contract_location: "secondReference.ts:8",
      evidence_refs: ["target.ts:1", "secondReference.ts:8"]
    });
    const referenceAnalysis = investigateHandoff.reference_analysis as {
      candidates: Array<Record<string, unknown>>;
      target_selections: Array<Record<string, unknown>>;
    };
    referenceAnalysis.candidates.push({
      target_key: "second-route",
      reference_kind: "same-feature-entry",
      location: "secondEntry.ts:4",
      contract_symbol: "secondReference",
      contract_location: "secondReference.ts:8",
      evidence_refs: ["secondEntry.ts:4", "secondReference.ts:8"]
    });
    referenceAnalysis.target_selections.push({
      target_key: "second-route",
      selected_location: "secondEntry.ts:4",
      selection_reason: "same second route",
      no_reference_reason: ""
    });
    obligations.forEach((obligation) => {
      obligation.target_keys = ["route", "second-route"];
      obligation.evidence_refs = [
        ...obligation.evidence_refs as string[],
        "secondEntry.ts:4"
      ];
    });
    (prepareHandoff.reference_application as Array<Record<string, unknown>>).push({
      target_key: "second-route",
      dimension: "argument forwarding",
      target_behavior: "forward input",
      reference_behavior: "forward input",
      decision: "reuse",
      reason: "same second route",
      evidence_refs: ["secondEntry.ts:4", "target.ts:1"]
    });
    expect(() => validateHierarchicalBehaviorObligationContinuity(
      session,
      prepareOperation,
      [prepareEvent]
    )).toThrow("secondReference@secondReference.ts:8");
    analyzedTargets.push({
      ...referenceTarget,
      target_file: "secondReference.ts",
      symbol: "secondReference",
      definition: "secondReference function；secondReference.ts:8",
      evidence_refs: ["secondReference.ts:8"]
    });
    expect(() => validateHierarchicalBehaviorObligationContinuity(
      session,
      prepareOperation,
      [prepareEvent]
    )).not.toThrow();

    const implementHandoff = handoffFor("implement") as Record<string, unknown>;
    const implementResults = implementHandoff.obligation_results as Array<Record<string, unknown>>;
    implementResults.forEach((result) => {
      result.observed_behavior = `最终代码已落实 ${String(result.obligation_id)}，实现位置见 target.ts:1`;
    });
    const implementEvent = {
      type: "phase_passed" as const,
      work_unit_id: "R1:implement",
      summary: "implemented",
      handoff: implementHandoff,
      evidence_refs: ["target.ts:1"]
    };
    expect(() => validateHierarchicalBehaviorObligationContinuity(
      session,
      {
        kind: "run_phase",
        requirement_id: "R1",
        work_unit_id: "R1:implement",
        phase: "implement",
        role: "task-executor"
      },
      [implementEvent]
    )).not.toThrow();

    const verifyHandoff = handoffFor("verify") as Record<string, unknown>;
    const verifyEvent = {
      type: "phase_passed" as const,
      work_unit_id: "R1:verify",
      summary: "verified",
      handoff: verifyHandoff,
      evidence_refs: ["target.ts:1"]
    };
    const verifyOperation = {
      kind: "run_phase" as const,
      requirement_id: "R1",
      work_unit_id: "R1:verify",
      phase: "verify" as const,
      role: "task-verifier"
    };
    expect(() => validateHierarchicalBehaviorObligationContinuity(
      session,
      verifyOperation,
      [verifyEvent]
    )).not.toThrow();

    const results = verifyHandoff.contract_results as Array<Record<string, unknown>>;
    results.forEach((result) => {
      result.observed_behavior = `独立核对 ${String(result.obligation_id)} 已由最终代码满足，见 target.ts:1`;
    });
    expect(() => validateHierarchicalBehaviorObligationContinuity(
      session,
      verifyOperation,
      [verifyEvent]
    )).not.toThrow();

    const failedDestination = results.find((item) => item.obligation_id === "B-destination")!;
    failedDestination.status = "fail";
    failedDestination.observed_behavior = "最终代码跳到了错误组件，见 target.ts:1";
    expect(() => validateHierarchicalBehaviorObligationContinuity(
      session,
      verifyOperation,
      [verifyEvent]
    )).toThrow("行为义务 B-destination 未通过：fail");
    failedDestination.status = "pass";

    const originalEvidence = failedDestination.evidence_refs;
    failedDestination.evidence_refs = [];
    expect(() => validateHierarchicalBehaviorObligationContinuity(
      session,
      verifyOperation,
      [verifyEvent]
    )).toThrow("行为义务 B-destination 缺少 evidence_refs");
    failedDestination.evidence_refs = originalEvidence;

    failedDestination.evidence_refs = ["destination checked"];
    expect(() => validateHierarchicalBehaviorObligationContinuity(
      session,
      verifyOperation,
      [verifyEvent]
    )).toThrow("行为义务 B-destination 缺少 path:line 代码证据");
    failedDestination.evidence_refs = originalEvidence;

    results.splice(results.findIndex((result) => result.obligation_id === "B-preconditions"), 1);
    expect(() => validateHierarchicalBehaviorObligationContinuity(
      session,
      verifyOperation,
      [verifyEvent]
    )).toThrow("missing=B-preconditions");

    verifyHandoff.contract_results = behaviorObligationResults("pass", "target.ts:1");
    state.phase_artifacts.push({
      id: "R1:verify:artifact",
      work_unit_id: "R1:verify",
      requirement_id: "R1",
      phase: "verify",
      attempt: 1,
      summary: "contract verified",
      handoff: verifyHandoff,
      evidence_refs: ["target.ts:1"],
      knowledge_revision: 0,
      workspace_revision: 0,
      created_at: state.created_at
    });
    const finalContractResults = integrationContractResults(["R1"], "target.ts:1");
    finalContractResults.forEach((result) => {
      result.observed_behavior = `全局审计重新观察 ${result.obligation_id} 已满足，见 target.ts:1`;
    });
    expect(() => validateHierarchicalBehaviorObligationContinuity(
      session,
      { kind: "run_integrator" },
      [{
        type: "integration_passed",
        evidence_refs: ["target.ts:1"],
        contract_results: finalContractResults
      }]
    )).not.toThrow();
  });

  it("surfaces every missing obligation citation in one fail-collect rejection", () => {
    const session = createSession();
    const state = createHierarchicalExecutionState(session.task_prompt);
    const investigateHandoff = handoffFor("investigate", "target.ts", "reference.ts", true);
    const prepareHandoff = handoffFor("prepare") as Record<string, unknown>;
    state.requirements = [{
      id: "R1",
      source_anchor: "user:R1",
      observable_result: "route works",
      acceptance: [{ id: "R1-A1", criterion: "route works", status: "pass", evidence_refs: ["target.ts:1"] }],
      dependencies: [],
      status: "completed",
      evidence_refs: ["target.ts:1"]
    }];
    state.phase_artifacts = [{
      id: "R1:investigate:artifact",
      work_unit_id: "R1:investigate",
      requirement_id: "R1",
      phase: "investigate",
      attempt: 1,
      summary: "same-feature entry selected",
      handoff: investigateHandoff,
      evidence_refs: ["reference.ts:5"],
      knowledge_revision: 0,
      workspace_revision: 0,
      created_at: state.created_at
    }];
    session.hierarchical_state = state;

    const obligations = prepareHandoff.behavior_obligations as Array<Record<string, unknown>>;
    // Two obligations drop the reference.ts citation; the other four keep it.
    const dropEvidence = ["target.ts:1"];
    (obligations.find((obligation) => obligation.id === "B-destination")!).evidence_refs = dropEvidence;
    (obligations.find((obligation) => obligation.id === "B-arguments")!).evidence_refs = dropEvidence;

    const prepareEvent = {
      type: "phase_passed" as const,
      work_unit_id: "R1:prepare",
      summary: "prepared",
      handoff: prepareHandoff,
      evidence_refs: ["target.ts:1", "reference.ts:5"],
      allowed_files: ["target.ts"]
    };
    const prepareOperation = {
      kind: "run_phase" as const,
      requirement_id: "R1",
      work_unit_id: "R1:prepare",
      phase: "prepare" as const,
      role: "implementation-preparer"
    };

    let thrown: Error | undefined;
    try {
      validateHierarchicalBehaviorObligationContinuity(session, prepareOperation, [prepareEvent]);
    } catch (error) {
      thrown = error instanceof Error ? error : new Error(String(error));
    }
    expect(thrown).toBeDefined();
    // Both missing obligations appear in the single rejection, not just the first.
    expect(thrown!.message).toContain("prepare 阶段交接物未通过校验，共 2 处");
    expect(thrown!.message).toContain("行为义务 B-destination 未引用 route 的选定同功能入口 reference.ts:5");
    expect(thrown!.message).toContain("行为义务 B-arguments 未引用 route 的选定同功能入口 reference.ts:5");
    // The four obligations that kept their citation are NOT flagged.
    expect(thrown!.message).not.toContain("B-invocation");
  });

  it("prefills investigate-selected entry citations into obligations before validation", () => {
    const session = createSession();
    const state = createHierarchicalExecutionState(session.task_prompt);
    const investigateHandoff = handoffFor("investigate", "target.ts", "reference.ts", true);
    const prepareHandoff = handoffFor("prepare") as Record<string, unknown>;
    state.requirements = [{
      id: "R1",
      source_anchor: "user:R1",
      observable_result: "route works",
      acceptance: [{ id: "R1-A1", criterion: "route works", status: "pass", evidence_refs: ["target.ts:1"] }],
      dependencies: [],
      status: "completed",
      evidence_refs: ["target.ts:1"]
    }];
    state.phase_artifacts = [{
      id: "R1:investigate:artifact",
      work_unit_id: "R1:investigate",
      requirement_id: "R1",
      phase: "investigate",
      attempt: 1,
      summary: "same-feature entry selected",
      handoff: investigateHandoff,
      evidence_refs: ["reference.ts:5"],
      knowledge_revision: 0,
      workspace_revision: 0,
      created_at: state.created_at
    }];
    session.hierarchical_state = state;

    const prepareStructured = {
      status: "passed",
      summary: "prepared",
      handoff: prepareHandoff,
      evidence_refs: ["target.ts:1", "reference.ts:5"],
      allowed_files: ["target.ts"]
    };
    const obligations = prepareHandoff.behavior_obligations as Array<Record<string, unknown>>;
    // Every obligation drops the reference.ts citation and target coverage.
    obligations.forEach((obligation) => {
      obligation.evidence_refs = ["target.ts:1"];
      obligation.target_keys = [];
    });

    const prepareOperation = {
      kind: "run_phase" as const,
      requirement_id: "R1",
      work_unit_id: "R1:prepare",
      phase: "prepare" as const,
      role: "implementation-preparer"
    };

    reconcileHierarchicalPrepareObligationEvidence(session, prepareOperation, prepareStructured);

    for (const obligation of obligations) {
      const evidence = obligation.evidence_refs as string[];
      expect(evidence).toContain("reference.ts:5");
      expect(evidence).toContain("target.ts:1"); // prefill is additive, never drops existing evidence
      expect(obligation.target_keys).toContain("route");
    }

    // With prefilled citations, the validator no longer rejects for missing
    // entry citations; the safety net stays dormant for the covered target.
    const prepareEvent = {
      type: "phase_passed" as const,
      work_unit_id: "R1:prepare",
      summary: "prepared",
      handoff: prepareHandoff,
      evidence_refs: ["target.ts:1", "reference.ts:5"],
      allowed_files: ["target.ts"]
    };
    expect(() => validateHierarchicalBehaviorObligationContinuity(
      session,
      prepareOperation,
      [prepareEvent]
    )).not.toThrow();

    // No selected entry (static config) -> prefill is a no-op.
    const staticInvestigate = handoffFor("investigate", "target.ts", "reference.ts", false);
    state.phase_artifacts = [{
      id: "R1:investigate:artifact",
      work_unit_id: "R1:investigate",
      requirement_id: "R1",
      phase: "investigate",
      attempt: 1,
      summary: "static config",
      handoff: staticInvestigate,
      evidence_refs: ["target.ts:1"],
      knowledge_revision: 0,
      workspace_revision: 0,
      created_at: state.created_at
    }];
    const before = obligations.map((obligation) => obligation.evidence_refs);
    reconcileHierarchicalPrepareObligationEvidence(session, prepareOperation, prepareStructured);
    const after = obligations.map((obligation) => obligation.evidence_refs);
    expect(after).toEqual(before);
  });

  it("derives already-satisfied target evidence and satisfaction rows on the host", () => {
    const session = createSession();
    const state = createHierarchicalExecutionState(session.task_prompt);
    const investigateHandoff = handoffFor("investigate", "target.ts", "reference.ts", true);
    state.requirements = [{
      id: "R1",
      source_anchor: "user:R1",
      observable_result: "route works",
      acceptance: [{ id: "R1-A1", criterion: "route works", status: "pass", evidence_refs: ["target.ts:1"] }],
      dependencies: [],
      status: "completed",
      evidence_refs: ["target.ts:1"]
    }];
    state.phase_artifacts = [{
      id: "R1:investigate:artifact",
      work_unit_id: "R1:investigate",
      requirement_id: "R1",
      phase: "investigate",
      attempt: 1,
      summary: "same-feature entry and current target confirmed",
      handoff: investigateHandoff,
      evidence_refs: ["target.ts:1", "reference.ts:5"],
      knowledge_revision: 0,
      workspace_revision: 0,
      created_at: state.created_at
    }];
    session.hierarchical_state = state;
    const prepareHandoff = handoffFor("prepare") as Record<string, unknown>;
    prepareHandoff.change_disposition = "already_satisfied";
    prepareHandoff.patch_plan = [];
    prepareHandoff.satisfaction_evidence = [];
    const obligations = prepareHandoff.behavior_obligations as Array<Record<string, unknown>>;
    obligations.forEach((obligation) => {
      // Mirrors the failing Qwen draft: it preserved the selected reference,
      // but omitted duplicated current-target citations from every obligation.
      obligation.evidence_refs = ["reference.ts:5"];
    });
    const structured = {
      status: "passed",
      summary: "existing behavior already satisfies the requirement",
      evidence_refs: ["target.ts:1", "reference.ts:5"],
      allowed_files: [],
      handoff: prepareHandoff
    };
    const operation = {
      kind: "run_phase" as const,
      requirement_id: "R1",
      work_unit_id: "R1:prepare",
      phase: "prepare" as const,
      role: "implementation-preparer"
    };

    reconcileHierarchicalPrepareObligationEvidence(session, operation, structured);

    for (const obligation of obligations) {
      expect(obligation.evidence_refs).toEqual(expect.arrayContaining([
        "reference.ts:5",
        "target.ts:1"
      ]));
    }
    expect(prepareHandoff.satisfaction_evidence).toHaveLength(6);
    expect(prepareHandoff.satisfaction_evidence).toEqual(expect.arrayContaining([
      expect.stringContaining("B-destination destination 已由当前目标代码满足：target.ts:1"),
      expect.stringContaining("B-context context 已由当前目标代码满足：target.ts:1")
    ]));
    const events = parseHierarchicalRoleResult(operation, structured);
    expect(() => validateHierarchicalBehaviorObligationContinuity(
      session,
      operation,
      events
    )).not.toThrow();
  });

  it("separates a static same-feature entry from its callable contract target", () => {
    const session = createSession();
    const state = createHierarchicalExecutionState(session.task_prompt);
    const investigateHandoff = handoffFor(
      "investigate",
      "target.ts",
      "reference.ts",
      true
    ) as Record<string, unknown>;
    const referenceAnalysis = investigateHandoff.reference_analysis as {
      candidates: Array<Record<string, unknown>>;
      target_selections: Array<Record<string, unknown>>;
    };
    const candidate = referenceAnalysis.candidates[0]!;
    candidate.location = "lib/Const/RouterDisplayName.js:24";
    candidate.contract_location = "reference.ts:5";
    candidate.destination = "final component at reference.ts:5";
    candidate.evidence_refs = ["lib/Const/RouterDisplayName.js:24", "reference.ts:5"];
    referenceAnalysis.target_selections[0]!.selected_location = "lib/Const/RouterDisplayName.js:24";

    const prepareHandoff = handoffFor("prepare") as Record<string, unknown>;
    const obligations = prepareHandoff.behavior_obligations as Array<Record<string, unknown>>;
    obligations.forEach((obligation) => {
      obligation.evidence_refs = [
        "lib/Const/RouterDisplayName.js:24",
        "target.ts:1"
      ];
    });
    state.requirements = [{
      id: "R1",
      source_anchor: "user:R1",
      observable_result: "route works",
      acceptance: [{
        id: "R1-A1",
        criterion: "route works",
        status: "pending",
        evidence_refs: []
      }],
      dependencies: [],
      status: "active",
      evidence_refs: []
    }];
    state.phase_artifacts = [{
      id: "R1:investigate:artifact",
      work_unit_id: "R1:investigate",
      requirement_id: "R1",
      phase: "investigate",
      attempt: 1,
      summary: "static entry traced to component",
      handoff: investigateHandoff,
      evidence_refs: ["lib/Const/RouterDisplayName.js:24", "reference.ts:5"],
      knowledge_revision: 0,
      workspace_revision: 0,
      created_at: state.created_at
    }];
    session.hierarchical_state = state;

    const prepareEvent = {
      type: "phase_passed" as const,
      work_unit_id: "R1:prepare",
      summary: "prepared",
      handoff: prepareHandoff,
      evidence_refs: ["target.ts:1", "reference.ts:5"],
      allowed_files: ["lib/Const/RouterDisplayName.js"]
    };
    const prepareOperation = {
      kind: "run_phase" as const,
      requirement_id: "R1",
      work_unit_id: "R1:prepare",
      phase: "prepare" as const,
      role: "implementation-preparer"
    };

    expect(() => validateHierarchicalBehaviorObligationContinuity(
      session,
      prepareOperation,
      [prepareEvent]
    )).not.toThrow();

    // Persisted artifacts from before contract_location existed can recover from
    // the destination/evidence path instead of re-entering the failed loop.
    delete candidate.contract_location;
    expect(() => validateHierarchicalBehaviorObligationContinuity(
      session,
      prepareOperation,
      [prepareEvent]
    )).not.toThrow();

    const analyzedTargets = (
      prepareHandoff.call_contract as { analyzed_targets: Array<Record<string, unknown>> }
    ).analyzed_targets;
    analyzedTargets.pop();
    expect(() => validateHierarchicalBehaviorObligationContinuity(
      session,
      prepareOperation,
      [prepareEvent]
    )).toThrow("同功能入口对应的真实函数/组件");
  });

  it("ingests 21 attachments in seven persisted batches and retries only the crashed batch", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "ai-coder-align-batches-"));
    try {
      const uploadDir = path.join(projectPath, ".ai-coder", "uploads", "spec");
      await mkdir(uploadDir, { recursive: true });
      await writeFile(path.join(projectPath, "target.ts"), "export const fixtureTarget = true;\n");
      await writeFile(path.join(projectPath, "reference.ts"), "export const fixtureReference = true;\n");
      const attachments = [];
      for (let index = 1; index <= 21; index += 1) {
        const filename = `page-${String(index).padStart(2, "0")}.png`;
        await writeFile(path.join(uploadDir, filename), `page ${index}`);
        attachments.push({
          type: "file_ref" as const,
          path: path.join(".ai-coder", "uploads", "spec", filename),
          display_name: filename
        });
      }

      const batchCalls = new Map<string, number>();
      const batchSizes: number[] = [];
      let plannerAttachmentDenial = "";
      let plannerAttachmentSearchDenial = "";
      let wrongBatchPathDenial = "";
      let crashedA2 = false;
      async function* query(params: unknown) {
        const typed = params as {
          prompt?: unknown;
          options: {
            pathToClaudeCodeExecutable?: string;
            stderr?: (chunk: string) => void;
            canUseTool: (
              name: string,
              input: Record<string, unknown>,
              options: { toolUseID: string }
            ) => Promise<{ behavior: string; message?: string }>;
          };
        };
        expect(typed.options.pathToClaudeCodeExecutable).toMatch(/claude$/);
        const prompt = String(typed.prompt ?? "");
        const batchMatch = /G1 > align > (A\d+) > attempt-(\d+)/.exec(prompt);
        let structuredOutput: Record<string, unknown>;
        let crashAfterSuccessfulResult = false;
        if (batchMatch) {
          const batchId = batchMatch[1]!;
          batchCalls.set(batchId, (batchCalls.get(batchId) ?? 0) + 1);
          const paths = [...new Set(prompt.match(/\/[^\s（）]+page-\d+\.png/g) ?? [])];
          batchSizes.push(paths.length);
          if (batchId === "A1") {
            const denial = await typed.options.canUseTool(
              "Read",
              { file_path: "/ai-coder/uploads/spec/page-01.png" },
              { toolUseID: "wrong-batch-path-denied" }
            );
            wrongBatchPathDenial = denial.message ?? "";
          }
          if (batchId === "A2" && !crashedA2) {
            crashedA2 = true;
            throw new Error("Claude Code process terminated by signal SIGABRT");
          }
          if (batchId === "A3") crashAfterSuccessfulResult = true;
          structuredOutput = {
            status: "passed",
            summary: `${batchId} persisted summary`,
            evidence_refs: paths,
            findings: [{
              source_anchor: `${batchId}:page`,
              observable_result: `${batchId} entry works`,
              acceptance: [`${batchId} entry is independently verified`]
            }]
          };
        } else if (prompt.includes("宿主已归并的附件证据")) {
          const denial = await typed.options.canUseTool(
            "Read",
            { file_path: path.join(uploadDir, "page-01.png") },
            { toolUseID: "planner-reread-denied" }
          );
          plannerAttachmentDenial = denial.message ?? "";
          const searchDenial = await typed.options.canUseTool(
            "Bash",
            { command: "find . -path './.ai-coder/uploads*' -name '*.png'" },
            { toolUseID: "planner-search-denied" }
          );
          plannerAttachmentSearchDenial = searchDenial.message ?? "";
          structuredOutput = {
            status: "passed",
            summary: "stable summary-backed plan",
            definition_of_done: ["entry passes"],
            requirements: [{
              id: "R1",
              source_anchor: "A1:page",
              observable_result: "entry works",
              acceptance: ["entry is independently verified"],
              dependencies: []
            }]
          };
        } else if (prompt.includes("对照用户原始目标、稳定需求账本")) {
          structuredOutput = {
            status: "passed",
            summary: "global pass",
            evidence_refs: ["audit:pass"],
            contract_results: integrationContractResults(["R1"], "target.ts:1")
          };
        } else {
          const phase = /G1 > R1 > (investigate|prepare|implement|verify) >/.exec(prompt)?.[1];
          if (!phase) throw new Error("unexpected hierarchical prompt");
          structuredOutput = {
            status: "passed",
            summary: `${phase} pass`,
            evidence_refs: [`${phase}:evidence`],
            handoff: handoffFor(phase),
            ...(phase === "prepare" ? { allowed_files: ["target.ts"] } : {}),
            ...(phase === "verify" ? {
              acceptance_results: [{
                acceptance_id: "R1-A1",
                status: "pass",
                evidence_refs: ["acceptance:pass"]
              }]
            } : {})
          };
        }
        yield { type: "result", subtype: "success", is_error: false, structured_output: structuredOutput };
        if (crashAfterSuccessfulResult) {
          typed.options.stderr?.("native cleanup assertion failed");
          throw new Error("Claude Code process terminated by signal SIGABRT");
        }
      }

      const session = createSession();
      session.project_path = projectPath;
      session.initial_user_message = {
        role: "user",
        content: session.task_prompt,
        created_at: session.created_at,
        attachments
      };
      const updated = await new ClaudeAgentRunner({
        queryOverride: query,
        pluginPaths: [path.resolve("plugins/careful-coder")]
      }).run({ session, workflow });

      expect(updated.status, updated.error).toBe("completed");
      expect(updated.hierarchical_state?.alignment_batches).toHaveLength(7);
      expect(updated.hierarchical_state?.alignment_batches.every((batch) => batch.status === "completed")).toBe(true);
      expect(batchSizes.every((size) => size >= 1 && size <= 3)).toBe(true);
      expect(batchCalls.get("A1")).toBe(1);
      expect(batchCalls.get("A2")).toBe(2);
      expect(batchCalls.get("A3")).toBe(1);
      expect(wrongBatchPathDenial).toContain("A1 只能读取本批次的精确路径");
      expect(plannerAttachmentDenial).toContain("禁止再次 Read");
      expect(plannerAttachmentSearchDenial).toContain("禁止再次 Read");
      expect(updated.progress_events).toContainEqual(expect.objectContaining({
        message: expect.stringContaining("21 个附件拆成 7 个")
      }));
      expect(updated.progress_events).toContainEqual(expect.objectContaining({
        message: expect.stringContaining("A2 失败，仅重试本批")
      }));
      expect(updated.progress_events).toContainEqual(expect.objectContaining({
        message: expect.stringContaining("align/A3 结果已保留")
      }));
      expect(updated.progress_events).toContainEqual(expect.objectContaining({
        message: expect.stringContaining("CLI stderr：native cleanup assertion failed")
      }));
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("resumes a persisted running phase without starting a duplicate attempt", async () => {
    let state = createHierarchicalExecutionState("继续已中断的 R1 调查");
    state = applyHierarchicalEvent(state, {
      type: "plan_accepted",
      requirements: [{
        id: "R1",
        source_anchor: "user:R1",
        observable_result: "R1 的两个候选目标由用户选择",
        acceptance: ["用户选择后继续"],
        dependencies: []
      }],
      definition_of_done: ["R1 完成"]
    });
    state = applyHierarchicalEvent(state, {
      type: "requirement_activated",
      requirement_id: "R1"
    });
    state = applyHierarchicalEvent(state, {
      type: "phase_started",
      work_unit_id: "R1:investigate"
    });
    const originalRunId = state.phase_runs[0]!.id;
    let calls = 0;
    const query = async function* () {
      calls += 1;
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        structured_output: {
          status: "blocked",
          summary: "两个最终目标会产生不同用户可观察行为，需要用户选择",
          evidence_refs: ["decision:pending"],
          handoff: handoffFor("investigate"),
          blocker: {
            id: "R1-target-choice",
            kind: "user_decision",
            message: "请选择目标 A 或目标 B"
          }
        }
      };
    };
    const session = createSession();
    session.hierarchical_state = state;
    session.current_stage = "R1/investigate";

    const updated = await new ClaudeAgentRunner({
      queryOverride: query,
      pluginPaths: [path.resolve("plugins/careful-coder")]
    }).run({ session, workflow });

    expect(updated.status, updated.error).toBe("waiting_approval");
    expect(calls).toBe(1);
    expect(updated.hierarchical_state?.phase_runs).toHaveLength(1);
    expect(updated.hierarchical_state?.phase_runs[0]).toMatchObject({
      id: originalRunId,
      attempt: 1,
      status: "failed"
    });
    expect(updated.progress_events).toContainEqual(expect.objectContaining({
      message: "宿主恢复专职角色：R1/investigate"
    }));
  });

  it("drives one requirement vertically through all phases and global integration", async () => {
    const paraphrasedImplementHandoff = handoffFor(
      "implement",
      "package.json",
      "package.json"
    ) as Record<string, unknown>;
    (paraphrasedImplementHandoff.obligation_results as Array<Record<string, unknown>>)
      .forEach((result) => {
        result.observed_behavior = `代码已完成 ${String(result.obligation_id)}，证据 package.json:1`;
      });
    const outputs = [
      {
        status: "passed",
        summary: "stable plan",
        definition_of_done: ["method exists and tests pass"],
        requirements: [{
          id: "R1",
          source_anchor: "user:getRouteName",
          observable_result: "DisposalRoute exposes getRouteName",
          acceptance: ["getRouteName returns the current route name"],
          dependencies: []
        }]
      },
      {
        status: "passed",
        summary: "located target",
        evidence_refs: ["src/shared/types.ts:1"],
        handoff: handoffFor("investigate", "package.json", "package.json")
      },
      {
        status: "passed",
        summary: "lease prepared",
        evidence_refs: ["src/shared/types.ts:1"],
        handoff: handoffFor("prepare", "package.json", "package.json"),
        allowed_files: ["package.json"]
      },
      {
        status: "passed",
        summary: "implemented",
        evidence_refs: ["git diff --check: pass"],
        handoff: paraphrasedImplementHandoff
      },
      {
        status: "passed",
        summary: "verified",
        evidence_refs: ["focused test: pass"],
        handoff: handoffFor("verify", "package.json", "package.json"),
        acceptance_results: [{ acceptance_id: "R1-A1", status: "pass", evidence_refs: ["focused test: pass"] }]
      },
      {
        status: "passed",
        summary: "complete",
        evidence_refs: ["full audit: pass"],
        contract_results: integrationContractResults(["R1"], "package.json:1")
      }
    ];
    let call = 0;
    let deniedLeaseMessage = "";
    let deniedShellMessage = "";
    let deniedWriteMessage = "";
    let prepareEditMessage = "";
    let prepareAskMessage = "";
    async function* query(params: unknown) {
      const currentCall = call++;
      if (currentCall === 2) {
        const typed = params as {
          options: {
            tools: string[];
            canUseTool: (
              name: string,
              input: Record<string, unknown>,
              options: { toolUseID: string }
            ) => Promise<{ behavior: string; message?: string }>;
          };
        };
        expect(typed.options.tools).toContain("Edit");
        const prepareEditDecision = await typed.options.canUseTool(
          "Edit",
          { file_path: "package.json", old_string: "a", new_string: "b" },
          { toolUseID: "prepare-edit-denied-with-guidance" }
        );
        prepareEditMessage = prepareEditDecision.message ?? "";
        const prepareAskDecision = await typed.options.canUseTool(
          "mcp__ai_coder__ask_human",
          {
            question: "是否启用 Edit？",
            type: "single",
            already_checked: ["当前工具列表"],
            why_needed: "模型认为需要修改文件才能继续",
            options: [{ value: "yes", label: "启用" }]
          },
          { toolUseID: "prepare-ask-human-denied" }
        );
        prepareAskMessage = prepareAskDecision.message ?? "";
      }
      if (currentCall === 3) {
        const canUseTool = (params as {
          options: {
            canUseTool: (
              name: string,
              input: Record<string, unknown>,
              options: { toolUseID: string }
            ) => Promise<{ behavior: string; message?: string }>;
          };
        }).options.canUseTool;
        const leaseDecision = await canUseTool(
          "Edit",
          { file_path: "src/not-leased.ts", old_string: "a", new_string: "b" },
          { toolUseID: "lease-denied" }
        );
        deniedLeaseMessage = leaseDecision.message ?? "";
        const shellDecision = await canUseTool(
          "Bash",
          { command: "sed -i 's/a/b/' src/shared/types.ts" },
          { toolUseID: "shell-denied" }
        );
        deniedShellMessage = shellDecision.message ?? "";
        const writeDecision = await canUseTool(
          "Write",
          { file_path: "package.json", content: "truncated" },
          { toolUseID: "existing-write-denied" }
        );
        deniedWriteMessage = writeDecision.message ?? "";
      }
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        structured_output: outputs[currentCall]
      };
    }

    const session = createSession();
    const updated = await new ClaudeAgentRunner({
      queryOverride: query,
      pluginPaths: [path.resolve("plugins/careful-coder")]
    }).run({ session, workflow });

    expect(updated.status, updated.error).toBe("completed");
    expect(call).toBe(6);
    expect(updated.hierarchical_state?.requirements[0]).toMatchObject({
      id: "R1",
      status: "completed",
      acceptance: [{ id: "R1-A1", status: "pass" }]
    });
    expect(updated.hierarchical_state?.phase_runs.map((run) => `${run.phase}:${run.status}`)).toEqual([
      "investigate:passed",
      "prepare:passed",
      "implement:passed",
      "verify:passed"
    ]);
    expect(updated.hierarchical_state?.integration_status).toBe("passed");
    expect(updated.hierarchical_state?.integration_evidence_refs).toEqual(["full audit: pass"]);
    expect(deniedLeaseMessage).toContain("不允许修改");
    expect(deniedShellMessage).toContain("必须通过受租约约束的 Edit");
    expect(deniedWriteMessage).toContain("禁止使用 Write 覆盖现有文件");
    expect(prepareEditMessage).toContain("宿主验收 prepare 后会自动进入 implement");
    expect(prepareAskMessage).toContain("不能用 ask_human 申请 Edit");
    expect(updated.pending_human_questions ?? []).toHaveLength(0);
  });

  it("retries a rejected prepare draft in place with cumulative correction context", async () => {
    const invalidPrepareHandoff = handoffFor("prepare", "package.json", "package.json") as Record<string, unknown>;
    (invalidPrepareHandoff.call_contract as { analyzed_targets: unknown[] }).analyzed_targets = [];
    const outputs = [
      {
        status: "passed",
        summary: "stable plan",
        definition_of_done: ["route works"],
        requirements: [{
          id: "R1",
          source_anchor: "user:route",
          observable_result: "route works",
          acceptance: ["route is independently verified"],
          dependencies: []
        }]
      },
      {
        status: "passed",
        summary: "located route",
        evidence_refs: ["package.json:1"],
        handoff: handoffFor("investigate", "package.json", "package.json")
      },
      {
        status: "passed",
        summary: "incomplete prepare draft",
        evidence_refs: ["package.json:1"],
        handoff: invalidPrepareHandoff,
        allowed_files: ["package.json"]
      },
      {
        status: "passed",
        summary: "corrected prepare draft",
        evidence_refs: ["package.json:1"],
        handoff: handoffFor("prepare", "package.json", "package.json"),
        allowed_files: ["package.json"]
      },
      {
        status: "passed",
        summary: "implemented",
        evidence_refs: ["git diff --check: pass"],
        handoff: handoffFor("implement", "package.json", "package.json")
      },
      {
        status: "passed",
        summary: "verified",
        evidence_refs: ["focused test: pass"],
        handoff: handoffFor("verify", "package.json", "package.json"),
        acceptance_results: [{
          acceptance_id: "R1-A1",
          status: "pass",
          evidence_refs: ["focused test: pass"]
        }]
      },
      {
        status: "passed",
        summary: "complete",
        evidence_refs: ["audit:pass"],
        contract_results: integrationContractResults(["R1"], "package.json:1")
      }
    ];
    const prompts: string[] = [];
    let call = 0;
    async function* query(params: unknown) {
      prompts.push(String((params as { prompt?: unknown }).prompt ?? ""));
      const currentCall = call++;
      if (currentCall === 3) {
        yield {
          type: "assistant",
          message: {
            content: [{
              type: "tool_use",
              id: "corrupted-structured-prepare",
              name: "StructuredStructOutput",
              input: outputs[currentCall]
            }]
          }
        };
        throw new Error("No such tool available: StructuredStructOutput");
      }
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        structured_output: outputs[currentCall]
      };
    }

    const updated = await new ClaudeAgentRunner({
      queryOverride: query,
      pluginPaths: [path.resolve("plugins/careful-coder")]
    }).run({ session: createSession(), workflow });

    expect(updated.status, updated.error).toBe("completed");
    expect(call).toBe(7);
    expect(prompts[3]).toContain("上次被拒绝的结构化草稿");
    expect(prompts[3]).toContain("incomplete prepare draft");
    expect(prompts[3]).toContain("prepare 至少需要一个完整调查的目标函数或组件");
    expect(prompts[3]).toContain("不要向用户申请阶段工具");
    expect(updated.progress_events).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("轻微损坏的 StructuredOutput 工具名恢复")
    }));
    expect(updated.progress_events).toContainEqual(expect.objectContaining({
      message: expect.stringContaining("attempt 1；同类问题 1/6")
    }));
    expect(updated.hierarchical_state?.phase_runs).toContainEqual(expect.objectContaining({
      phase: "prepare",
      status: "failed",
      failure_reason: expect.stringContaining("prepare 至少需要一个完整调查")
    }));
  });

  it("restores only the current implement snapshot and retries after a recoverable crash", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "ai-coder-implement-recovery-"));
    const targetPath = path.join(projectPath, "target.js");
    const original = `export const value = "stable";\n${"// preserved\n".repeat(120)}`;
    await writeFile(targetPath, original);
    await writeFile(path.join(projectPath, "reference.js"), "export const fixtureReference = true;\n");
    let implementAttempts = 0;

    async function* query(params: unknown) {
      const prompt = String((params as { prompt?: unknown }).prompt ?? "");
      let structuredOutput: Record<string, unknown>;
      if (prompt.includes("建立一次性、稳定的需求账本")) {
        structuredOutput = {
          status: "passed",
          summary: "plan",
          definition_of_done: ["target remains valid"],
          requirements: [{
            id: "R1", source_anchor: "user:R1", observable_result: "target works",
            acceptance: ["target remains valid"], dependencies: []
          }]
        };
      } else if (prompt.includes("对照用户原始目标、稳定需求账本")) {
        structuredOutput = {
          status: "passed",
          summary: "audit",
          evidence_refs: ["audit:pass"],
          contract_results: integrationContractResults(["R1"], "target.js:1")
        };
      } else {
        const phase = /G1 > R1 > (investigate|prepare|implement|verify) >/.exec(prompt)?.[1];
        if (!phase) throw new Error("unexpected prompt");
        if (phase === "implement") {
          implementAttempts += 1;
          if (implementAttempts === 1) {
            await writeFile(targetPath, "truncated");
            throw new Error("recoverable executor crash");
          }
        }
        structuredOutput = {
          status: "passed",
          summary: `${phase} passed`,
          evidence_refs: [`${phase}:evidence`],
          handoff: handoffFor(phase, "target.js", "reference.js"),
          ...(phase === "prepare" ? { allowed_files: ["“target.js”"] } : {}),
          ...(phase === "verify" ? {
            acceptance_results: [{
              acceptance_id: "R1-A1", status: "pass", evidence_refs: ["verify:pass"]
            }]
          } : {})
        };
      }
      yield { type: "result", subtype: "success", is_error: false, structured_output: structuredOutput };
    }

    try {
      const session = createSession();
      session.project_path = projectPath;
      const updated = await new ClaudeAgentRunner({
        queryOverride: query,
        pluginPaths: [path.resolve("plugins/careful-coder")]
      }).run({ session, workflow });

      expect(updated.status, updated.error).toBe("completed");
      expect(implementAttempts).toBe(2);
      expect(await readFile(targetPath, "utf8")).toBe(original);
      expect(updated.hierarchical_state?.active_work_unit).toBeUndefined();
      expect(updated.progress_events).toContainEqual(expect.objectContaining({
        message: expect.stringContaining("已自愈恢复 1 个租约文件")
      }));
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("steps back to prepare after repeated implement failures without interrupting the goal", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "ai-coder-inner-self-heal-"));
    await writeFile(path.join(projectPath, "target.js"), "export const stable = true;\n");
    await writeFile(path.join(projectPath, "reference.js"), "export const fixtureReference = true;\n");
    let implementAttempts = 0;
    let prepareAttempts = 0;

    async function* query(params: unknown) {
      const prompt = String((params as { prompt?: unknown }).prompt ?? "");
      let structuredOutput: Record<string, unknown>;
      if (prompt.includes("建立一次性、稳定的需求账本")) {
        structuredOutput = {
          status: "passed", summary: "plan", definition_of_done: ["done"],
          requirements: [{
            id: "R1", source_anchor: "user:R1", observable_result: "done",
            acceptance: ["done"], dependencies: []
          }]
        };
      } else if (prompt.includes("对照用户原始目标、稳定需求账本")) {
        structuredOutput = {
          status: "passed",
          summary: "audit",
          evidence_refs: ["audit:pass"],
          contract_results: integrationContractResults(["R1"], "target.js:1")
        };
      } else {
        const phase = /G1 > R1 > (investigate|prepare|implement|verify) >/.exec(prompt)?.[1];
        if (!phase) throw new Error("unexpected prompt");
        if (phase === "prepare") prepareAttempts += 1;
        if (phase === "implement") {
          implementAttempts += 1;
          if (implementAttempts <= 3) throw new Error("same recoverable implementation fault");
        }
        structuredOutput = {
          status: "passed", summary: `${phase} passed`, evidence_refs: [`${phase}:evidence`],
          handoff: handoffFor(phase, "target.js", "reference.js"),
          ...(phase === "prepare" ? { allowed_files: ["target.js"] } : {}),
          ...(phase === "verify" ? {
            acceptance_results: [{ acceptance_id: "R1-A1", status: "pass", evidence_refs: ["pass"] }]
          } : {})
        };
      }
      yield { type: "result", subtype: "success", is_error: false, structured_output: structuredOutput };
    }

    try {
      const session = createSession();
      session.project_path = projectPath;
      const updated = await new ClaudeAgentRunner({
        queryOverride: query,
        pluginPaths: [path.resolve("plugins/careful-coder")]
      }).run({ session, workflow });

      expect(updated.status, updated.error).toBe("completed");
      expect(implementAttempts).toBe(4);
      expect(prepareAttempts).toBe(2);
      expect(updated.hierarchical_state?.blockers).not.toContainEqual(expect.objectContaining({
        kind: "agent_failed", status: "open"
      }));
      expect(updated.progress_events).toContainEqual(expect.objectContaining({
        message: expect.stringContaining("退回 prepare 自愈")
      }));
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("stops an unchanged implement/prepare failure cycle after six correction opportunities", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "ai-coder-bounded-self-heal-"));
    await writeFile(path.join(projectPath, "target.js"), "export const stable = true;\n");
    await writeFile(path.join(projectPath, "reference.js"), "export const fixtureReference = true;\n");
    let implementAttempts = 0;
    let prepareAttempts = 0;

    async function* query(params: unknown) {
      const prompt = String((params as { prompt?: unknown }).prompt ?? "");
      let structuredOutput: Record<string, unknown>;
      if (prompt.includes("建立一次性、稳定的需求账本")) {
        structuredOutput = {
          status: "passed", summary: "plan", definition_of_done: ["done"],
          requirements: [{
            id: "R1", source_anchor: "user:R1", observable_result: "done",
            acceptance: ["done"], dependencies: []
          }]
        };
      } else {
        const phase = /G1 > R1 > (investigate|prepare|implement|verify) >/.exec(prompt)?.[1];
        if (!phase) throw new Error("unexpected prompt");
        if (phase === "prepare") prepareAttempts += 1;
        if (phase === "implement") {
          implementAttempts += 1;
          throw new Error("unchanged implementation fault");
        }
        structuredOutput = {
          status: "passed", summary: `${phase} passed`, evidence_refs: [`${phase}:evidence`],
          handoff: handoffFor(phase, "target.js", "reference.js"),
          ...(phase === "prepare" ? { allowed_files: ["target.js"] } : {})
        };
      }
      yield { type: "result", subtype: "success", is_error: false, structured_output: structuredOutput };
    }

    try {
      const session = createSession();
      session.project_path = projectPath;
      const updated = await new ClaudeAgentRunner({
        queryOverride: query,
        pluginPaths: [path.resolve("plugins/careful-coder")]
      }).run({ session, workflow });

      expect(implementAttempts).toBe(6);
      expect(prepareAttempts).toBe(2);
      expect(updated.status).toBe("interrupted");
      expect(updated.pending_human_questions ?? []).toHaveLength(0);
      expect(updated.hierarchical_state?.blockers).toContainEqual(expect.objectContaining({
        kind: "agent_failed",
        owner: "host",
        user_input_required: false,
        status: "open"
      }));
      const progressEvents = updated.progress_events ?? [];
      expect(progressEvents).toContainEqual(expect.objectContaining({
        message: expect.stringContaining("6 次定向修正机会")
      }));
      const selfHealMessages = progressEvents
        .filter((event) => event.message.includes("退回 prepare 自愈"))
        .map((event) => event.message);
      expect(selfHealMessages).toHaveLength(1);
      expect(selfHealMessages[0]).toContain("连续 3 次");
      expect(progressEvents.filter((event) =>
        event.message.includes("同类问题 1/3")
      )).toHaveLength(2);
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("escalates a stuck investigate phase to a blocker after three consecutive same-class failures", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "ai-coder-investigate-stuck-"));
    let investigateAttempts = 0;

    async function* query(params: unknown) {
      const prompt = String((params as { prompt?: unknown }).prompt ?? "");
      let structuredOutput: Record<string, unknown>;
      if (prompt.includes("建立一次性、稳定的需求账本")) {
        structuredOutput = {
          status: "passed", summary: "plan", definition_of_done: ["done"],
          requirements: [{
            id: "R1", source_anchor: "user:R1", observable_result: "done",
            acceptance: ["done"], dependencies: []
          }]
        };
      } else {
        const phase = /G1 > R1 > (investigate|prepare|implement|verify) >/.exec(prompt)?.[1];
        if (!phase) throw new Error("unexpected prompt");
        if (phase === "investigate") {
          investigateAttempts += 1;
          throw new Error("unchanged investigate fault");
        }
        structuredOutput = {
          status: "passed", summary: `${phase} passed`, evidence_refs: [`${phase}:evidence`],
          handoff: handoffFor(phase, "target.js", "reference.js")
        };
      }
      yield { type: "result", subtype: "success", is_error: false, structured_output: structuredOutput };
    }

    try {
      const session = createSession();
      session.project_path = projectPath;
      const updated = await new ClaudeAgentRunner({
        queryOverride: query,
        pluginPaths: [path.resolve("plugins/careful-coder")]
      }).run({ session, workflow });

      // investigate is the first phase (no prior phase to retreat to); after 3
      // consecutive same-class failures it escalates to a blocker instead of
      // churning toward the 6-cap.
      expect(investigateAttempts).toBe(3);
      expect(updated.status).toBe("interrupted");
      expect(updated.pending_human_questions ?? []).toHaveLength(0);
      expect(updated.hierarchical_state?.blockers).toContainEqual(expect.objectContaining({
        kind: "agent_failed",
        owner: "host",
        user_input_required: false,
        status: "open"
      }));
      const progressEvents = updated.progress_events ?? [];
      expect(progressEvents).toContainEqual(expect.objectContaining({
        message: expect.stringContaining("连续 3 次遇到同类问题")
      }));
      expect(progressEvents).toContainEqual(expect.objectContaining({
        message: expect.stringContaining("升级为阻塞")
      }));
      // The 6-cap hard stop did not fire (escalation came first).
      expect(progressEvents.some((event) => event.message.includes("6 次定向修正机会"))).toBe(false);
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("collects multiple census violations in one fail-collect rejection", () => {
    const session = createSession();
    const state = createHierarchicalExecutionState(session.task_prompt);
    state.requirements = [{
      id: "R1",
      source_anchor: "user:R1",
      observable_result: "route works",
      acceptance: [{ id: "R1-A1", criterion: "route works", status: "pass", evidence_refs: ["target.ts:1"] }],
      dependencies: [],
      status: "completed",
      evidence_refs: ["target.ts:1"]
    }];
    session.hierarchical_state = state;

    const censusInput = { feature: "route", aliases: ["route"] };
    const fakeReport = {
      status: "complete" as const,
      report_digest: "a".repeat(64),
      candidate_accounting: { total: 2, yes: 2, no: 0, unknown: 0, accounted: true as const },
      selected_targets: [
        { candidate_id: "cand-1", symbol: "target", kind: "function" as const, definition: { file: "target.ts", line: 1, column: 0 }, role: "entry" as const, trace_summary_digest: "d1" },
        { candidate_id: "cand-2", symbol: "reference", kind: "function" as const, definition: { file: "reference.ts", line: 5, column: 0 }, role: "entry" as const, trace_summary_digest: "d2" }
      ],
      rejected_candidates: [{
        candidate_id: "cand-rejected-target",
        symbol: "other",
        definition: { file: "other.ts", line: 99, column: 0 },
        reason: "incorrect model adjudication",
        evidence_refs: ["other.ts:99"]
      }],
      unresolved: [] as string[]
    };
    const stageId = "hierarchical:R1/investigate";
    session.tool_calls = [{
      id: "census-call",
      stage_id: stageId,
      tool: "mcp__ai_coder__locate_feature_implementation",
      input: censusInput,
      status: "completed" as const,
      created_at: state.created_at
    }];
    recordFeatureCensusReceipt(session, stageId, censusInput, fakeReport);
    expect((session.feature_census_receipts ?? []).length).toBeGreaterThan(0);

    const handoff = handoffFor("investigate", "target.ts", "reference.ts", true) as Record<string, unknown>;
    const featureCensus = handoff.feature_census as Record<string, unknown>;
    // Align the handoff's census fields with the fake report so we reach the
    // selected_candidate_ids / target-definition checks we actually want to test.
    featureCensus.report_digest = fakeReport.report_digest;
    featureCensus.candidate_accounting = { ...fakeReport.candidate_accounting };
    featureCensus.selected_candidate_ids = ["cand-wrong"];
    const targetInvestigation = handoff.target_investigation as Record<string, unknown>;
    targetInvestigation.definition = "other.ts:99";

    const investigateEvent = {
      type: "phase_passed" as const,
      work_unit_id: "R1:investigate",
      summary: "investigated",
      handoff,
      evidence_refs: ["target.ts:1"]
    };
    const investigateOperation = {
      kind: "run_phase" as const,
      requirement_id: "R1",
      work_unit_id: "R1:investigate",
      phase: "investigate" as const,
      role: "code-investigator"
    };

    let thrown: Error | undefined;
    try {
      validateHierarchicalContractToolEvidence(session, investigateOperation, [investigateEvent], stageId);
    } catch (error) {
      thrown = error instanceof Error ? error : new Error(String(error));
    }

    expect(thrown).toBeDefined();
    // Both census violations should appear in one composite message (along with
    // any target_mappings violations -- the point is they are collected, not
    // thrown one-at-a-time).
    expect(thrown!.message).toContain("investigate 阶段交接物未通过校验，共");
    expect(thrown!.message).toContain("feature_census.selected_candidate_ids 未完整对应所有 yes 候选");
    expect(thrown!.message).toContain("被误裁为 no（candidate_id=cand-rejected-target）");
  });

  it("classifies repeated planner failures as a system fault instead of asking the user", async () => {
    let calls = 0;
    const prompts: string[] = [];
    async function* query(params: unknown) {
      calls += 1;
      prompts.push(String((params as { prompt?: unknown }).prompt ?? ""));
      throw new Error("structured output protocol failed");
    }

    const session = createSession();
    const updated = await new ClaudeAgentRunner({
      queryOverride: query,
      pluginPaths: [path.resolve("plugins/careful-coder")]
    }).run({ session, workflow });

    expect(calls).toBe(3);
    expect(prompts[1]).toContain("当前为第 2 次 planner 尝试");
    expect(prompts[1]).toContain("宿主拒绝原因：structured output protocol failed");
    expect(updated.hierarchical_state?.planner_retry).toMatchObject({
      attempt: 4,
      failure_reason: "structured output protocol failed",
      consecutive_failure_count: 3
    });
    expect(updated.status).toBe("interrupted");
    expect(updated.pending_human_questions ?? []).toHaveLength(0);
    expect(updated.hierarchical_state?.blockers).toContainEqual(expect.objectContaining({
      kind: "agent_failed",
      owner: "host",
      user_input_required: false,
      status: "open"
    }));
  });

  it("supports requirement ledgers whose vertical loops need more than 120 host transitions", async () => {
    const requirements = Array.from({ length: 21 }, (_, index) => ({
      id: `R${index + 1}`,
      source_anchor: `attachment:page-${index + 1}`,
      observable_result: `page ${index + 1} entry works`,
      acceptance: [`page ${index + 1} is independently verified`],
      dependencies: []
    }));
    let calls = 0;
    async function* query(params: unknown) {
      calls += 1;
      const prompt = String((params as { prompt?: unknown }).prompt ?? "");
      let structuredOutput: Record<string, unknown>;
      if (prompt.includes("建立一次性、稳定的需求账本")) {
        structuredOutput = {
          status: "passed",
          summary: "21 requirement ledger",
          definition_of_done: ["all 21 requirements pass"],
          requirements
        };
      } else if (prompt.includes("对照用户原始目标、稳定需求账本")) {
        structuredOutput = {
          status: "passed",
          summary: "global pass",
          evidence_refs: ["audit:all-pass"],
          contract_results: integrationContractResults(
            requirements.map((requirement) => requirement.id),
            "package.json:1"
          )
        };
      } else {
        const match = /G1 > (R\d+) > (investigate|prepare|implement|verify) >/.exec(prompt);
        if (!match) throw new Error("unexpected hierarchical role prompt");
        const [, requirementId, phase] = match;
        structuredOutput = {
          status: "passed",
          summary: `${requirementId} ${phase} passed`,
          evidence_refs: [`${requirementId}:${phase}:evidence`],
          handoff: handoffFor(phase, "package.json", "package.json"),
          ...(phase === "prepare" ? { allowed_files: ["package.json"] } : {}),
          ...(phase === "verify"
            ? {
                acceptance_results: [{
                  acceptance_id: `${requirementId}-A1`,
                  status: "pass",
                  evidence_refs: [`${requirementId}:acceptance:pass`]
                }]
              }
            : {})
        };
      }
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        structured_output: structuredOutput
      };
    }

    const updated = await new ClaudeAgentRunner({
      queryOverride: query,
      pluginPaths: [path.resolve("plugins/careful-coder")]
    }).run({ session: createSession(), workflow });

    expect(updated.status, updated.error).toBe("completed");
    expect(updated.hierarchical_state?.requirements).toHaveLength(21);
    expect(updated.hierarchical_state?.requirements.every((requirement) => requirement.status === "completed")).toBe(true);
    expect(calls).toBe(86);
  });
});

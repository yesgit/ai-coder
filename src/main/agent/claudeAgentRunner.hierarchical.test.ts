import path from "node:path";
import os from "node:os";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { AgentSession, WorkflowTemplate } from "../../shared/types.js";
import {
  buildHierarchicalSdkToolSurface,
  ClaudeAgentRunner,
  extractRecoverableStructuredOutputToolInput,
  getHierarchicalCapabilityLeaseError,
  getHierarchicalMcpBoundaryMessage,
  validateHierarchicalBehaviorObligationContinuity,
  validateHierarchicalContractToolEvidence,
  validateHierarchicalPlannerEnumeratedCoverage
} from "./claudeAgentRunner.js";
import { createHierarchicalExecutionState } from "../workflows/hierarchicalWorkflowEngine.js";

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

function handoffFor(phase: string, targetFile = "target.ts", referenceFile = "reference.ts") {
  const target = `${targetFile}:1`;
  const reference = `${referenceFile}:5`;
  if (phase === "investigate") return {
    confirmed_facts: ["target confirmed"], target_locations: [target],
    target_investigation: {
      target_kind: "function", definition: target, inputs: [`input at ${target}`],
      outputs: [`output at ${target}`], internal_calls: [`none; ${target}`],
      guards: [`none; ${target}`], state_and_side_effects: [`none; ${target}`],
      callers: [`caller at ${target}`], evidence_refs: [target], unresolved: []
    },
    reference_analysis: {
      search_scope: ["searched project sources"],
      candidates: [{
        reference_kind: "same-feature-entry",
        location: reference,
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
      }],
      selected_location: reference, selection_reason: "closest contract", no_reference_reason: ""
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
  it("keeps guarded write tools visible and redirects legacy MCP tools without involving the user", () => {
    expect(buildHierarchicalSdkToolSurface(["Read", "Bash"])).toEqual([
      "Read",
      "Bash",
      "Edit",
      "Write"
    ]);

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

  it("requires real, fully paged symbol-analysis calls for declared prepare contracts", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "ai-coder-contract-gate-"));
    try {
      await writeFile(path.join(projectPath, "target.ts"), [
        "export function target(input: string) { return input; }",
        "export function caller() { return target('value'); }"
      ].join("\n"));
      await writeFile(path.join(projectPath, "reference.ts"), "export function reference(input: string) { return input; }\n");
      const session = { ...createSession(), project_path: projectPath };
      const handoff = handoffFor("prepare") as Record<string, unknown>;
      const callContract = handoff.call_contract as { analyzed_targets: Array<Record<string, unknown>> };
      callContract.analyzed_targets[0]!.analysis_method = "symbol-analyzer";
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
        .toThrow("未实际执行 contract 符号契约分析");

      session.tool_calls = ["contract", "calls", "wrappers", "references"].map((section, index) => ({
        id: `contract-${index}`,
        stage_id: stageId,
        tool: "mcp__ai_coder__analyze_symbol_contract",
        input: { target_file: "target.ts", symbol: "target", section, offset: 0, limit: 100 },
        status: "completed" as const,
        created_at: new Date().toISOString()
      }));
      expect(() => validateHierarchicalContractToolEvidence(session, operation, events, stageId)).not.toThrow();
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("closes frozen obligations by id, status and evidence without requiring identical prose", () => {
    const session = createSession();
    const state = createHierarchicalExecutionState(session.task_prompt);
    const investigateHandoff = handoffFor("investigate");
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
    const analyzedTargets = (
      prepareHandoff.call_contract as { analyzed_targets: Array<Record<string, unknown>> }
    ).analyzed_targets;
    const referenceTarget = analyzedTargets.pop()!;
    expect(() => validateHierarchicalBehaviorObligationContinuity(
      session,
      prepareOperation,
      [prepareEvent]
    )).toThrow("必须分析 investigate 选中的同功能入口文件");
    analyzedTargets.push(referenceTarget);

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
      message: expect.stringContaining("attempt 1；同类问题 1/3")
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

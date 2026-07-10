import { describe, expect, it } from "vitest";
import { WorkflowEngine } from "./workflowEngine.js";
import type { AgentSession, WorkflowTemplate } from "../../shared/types.js";

const workflow: WorkflowTemplate = {
  id: "software-engineering",
  name: "Software Engineering",
  version: "1.0.0",
  description: "Test",
  source: { type: "builtin", id: "software-engineering", version: "1.0.0" },
  permissions: { filesystem: { mode: "project-only" }, shell: { approval_required: true } },
  rework: {
    enabled: true,
    allowed_targets: ["understand", "plan"],
    approval_required: true,
    invalidate_downstream: true
  },
  stages: [
    { id: "understand", name: "Understand" },
    { id: "plan", name: "Plan", approval_required: true },
    { id: "execute", name: "Execute" }
  ]
};

function createSession(): AgentSession {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    project_path: "/tmp/project",
    workflow_id: workflow.id,
    task_prompt: "Fix the bug",
    status: "created",
    current_stage: "understand",
    messages: [],
    tool_calls: [],
    file_changes: [],
    approvals: [],
    stage_runs: [],
    rework_requests: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

describe("WorkflowEngine", () => {
  it("creates the first stage run and advances after completion", () => {
    const engine = new WorkflowEngine();
    const session = createSession();

    engine.ensureState(session, workflow);
    engine.completeCurrentStage(session, workflow, "Requirements understood");

    expect(session.stage_runs).toHaveLength(2);
    expect(session.stage_runs?.[0]).toMatchObject({ stage_id: "understand", attempt: 1, status: "completed" });
    expect(session.stage_runs?.[1]).toMatchObject({ stage_id: "plan", attempt: 1, status: "running" });
    expect(session.current_stage).toBe("plan");
  });

  it("waits for approval after an approval-required stage", () => {
    const engine = new WorkflowEngine();
    const session = createSession();

    engine.ensureState(session, workflow);
    engine.completeCurrentStage(session, workflow, "Requirements understood");
    engine.completeCurrentStage(session, workflow, "Implementation plan");

    expect(session.status).toBe("waiting_approval");
    expect(session.stage_runs?.at(-1)).toMatchObject({ stage_id: "plan", status: "waiting_approval" });
    expect(session.approvals).toHaveLength(1);
  });

  it("advances to the next stage after stage approval", () => {
    const engine = new WorkflowEngine();
    const session = createSession();

    engine.ensureState(session, workflow);
    engine.completeCurrentStage(session, workflow, "Requirements understood");
    engine.completeCurrentStage(session, workflow, "Implementation plan");
    engine.approveStage(session, workflow, "plan");

    expect(session.status).toBe("running");
    expect(session.current_stage).toBe("execute");
    expect(session.stage_runs?.at(-1)).toMatchObject({ stage_id: "execute", attempt: 1, status: "running" });
  });

  it("records a rework request and creates a new target attempt after approval", () => {
    const engine = new WorkflowEngine();
    const session = createSession();

    engine.ensureState(session, workflow);
    engine.completeCurrentStage(session, workflow, "Requirements understood");
    engine.completeCurrentStage(session, workflow, "Implementation plan");
    engine.approveStage(session, workflow, "plan");
    engine.requestRework(session, workflow, "plan", "Implementation uncovered a missing API constraint");

    expect(session.status).toBe("waiting_approval");
    expect(session.rework_requests?.[0]).toMatchObject({ target_stage_id: "plan", status: "pending" });
    expect(session.stage_runs?.at(-1)).toMatchObject({ stage_id: "execute", status: "needs_rework" });

    engine.approveRework(session, workflow, session.rework_requests?.[0].id ?? "");

    expect(session.current_stage).toBe("plan");
    expect(session.stage_runs?.at(-1)).toMatchObject({ stage_id: "plan", attempt: 2, status: "running" });
    expect(session.stage_runs?.some((stageRun) => stageRun.stage_id === "plan" && stageRun.status === "superseded")).toBe(true);
  });

  it("applies a completed stage agent result", () => {
    const engine = new WorkflowEngine();
    const session = createSession();

    engine.ensureState(session, workflow);
    engine.applyStageResult(session, workflow, {
      status: "completed",
      output_summary: "Requirements understood"
    });

    expect(session.current_stage).toBe("plan");
    expect(session.stage_runs?.[0]).toMatchObject({ stage_id: "understand", status: "completed" });
  });

  it("soft-completes a stage agent result missing required outputs when retry is exhausted", () => {
    const engine = new WorkflowEngine();
    const session = createSession();
    const workflowWithRequiredOutput: WorkflowTemplate = {
      ...workflow,
      stages: [
        { id: "understand", name: "Understand", required_outputs: ["task_summary"] },
        { id: "plan", name: "Plan" }
      ]
    };

    engine.ensureState(session, workflowWithRequiredOutput);
    engine.applyStageResult(session, workflowWithRequiredOutput, {
      status: "completed",
      output_summary: "Done"
    });

    expect(session.status).toBe("running");
    expect(session.current_stage).toBe("plan");
    expect(session.error).toBeUndefined();
    expect(session.stage_runs?.[0]).toMatchObject({ stage_id: "understand", status: "completed" });
    expect(session.stage_runs?.[0].output_summary).toContain("结构化字段缺失");
    expect(session.stage_runs?.[0].output_summary).toContain("task_summary");
  });

  it("applies a needs_rework stage agent result", () => {
    const engine = new WorkflowEngine();
    const session = createSession();

    engine.ensureState(session, workflow);
    engine.applyStageResult(session, workflow, { status: "completed", output_summary: "Requirements understood" });
    engine.applyStageResult(session, workflow, {
      status: "completed",
      output_summary: "Implementation plan"
    });
    engine.approveStage(session, workflow, "plan");
    engine.applyStageResult(session, workflow, {
      status: "needs_rework",
      output_summary: "Need to revisit plan",
      rework_target_stage_id: "plan",
      rework_reason: "Missing API constraint"
    });

    expect(session.status).toBe("waiting_approval");
    expect(session.rework_requests?.[0]).toMatchObject({
      target_stage_id: "plan",
      status: "pending",
      reason: "Missing API constraint"
    });
  });

  it("marks failed stage agent results as failed", () => {
    const engine = new WorkflowEngine();
    const session = createSession();

    engine.ensureState(session, workflow);
    engine.applyStageResult(session, workflow, {
      status: "failed",
      output_summary: "Failed",
      error: "Agent crashed"
    });

    expect(session.status).toBe("failed");
    expect(session.stage_runs?.[0]).toMatchObject({ status: "failed", output_summary: "Agent crashed" });
  });

  it("resumes from a failed stage with a new attempt", () => {
    const engine = new WorkflowEngine();
    const session = createSession();

    engine.ensureState(session, workflow);
    engine.applyStageResult(session, workflow, {
      status: "failed",
      output_summary: "Failed",
      error: "Agent crashed"
    });

    expect(session.status).toBe("failed");
    expect(session.stage_runs).toHaveLength(1);

    engine.resumeFromFailedStage(session, workflow);

    expect(session.status).toBe("running");
    expect(session.error).toBeUndefined();
    expect(session.stage_runs).toHaveLength(2);
    expect(session.stage_runs?.[0]).toMatchObject({ stage_id: "understand", attempt: 1, status: "failed" });
    expect(session.stage_runs?.[1]).toMatchObject({ stage_id: "understand", attempt: 2, status: "running" });
  });

  it("resumes from an interrupted session by marking active run superseded", () => {
    const engine = new WorkflowEngine();
    const session = createSession();

    engine.ensureState(session, workflow);
    // Simulate an interrupted session: stage is still running but app crashed
    const activeRun = session.stage_runs?.[0];
    if (activeRun) {
      activeRun.status = "running";
    }
    session.status = "interrupted";

    engine.resumeFromFailedStage(session, workflow);

    expect(session.status).toBe("running");
    expect(session.stage_runs).toHaveLength(2);
    expect(session.stage_runs?.[0]).toMatchObject({ stage_id: "understand", attempt: 1, status: "superseded" });
    expect(session.stage_runs?.[1]).toMatchObject({ stage_id: "understand", attempt: 2, status: "running" });
  });

  it("builds correct inputSummary when resuming from first stage", () => {
    const engine = new WorkflowEngine();
    const session = createSession();

    // 从第一个阶段失败后恢复，inputSummary 应该是 "Resume retry"（没有更早的已完成阶段）
    engine.ensureState(session, workflow);
    engine.applyStageResult(session, workflow, {
      status: "failed",
      output_summary: "Failed",
      error: "Agent crashed"
    });

    engine.resumeFromFailedStage(session, workflow);

    expect(session.status).toBe("running");
    expect(session.stage_runs).toHaveLength(2);
    expect(session.stage_runs?.[1].input_summary).toBe("Resume retry");
  });

  it("auto-retries when missing required outputs and attempt count is below limit", () => {
    const engine = new WorkflowEngine();
    const session = createSession();
    const workflowWithRetry: WorkflowTemplate = {
      ...workflow,
      stages: [{ id: "understand", name: "Understand", required_outputs: ["task_summary"], auto_retry_limit: 2 }]
    };

    engine.ensureState(session, workflowWithRetry);
    engine.applyStageResult(session, workflowWithRetry, {
      status: "completed",
      output_summary: "Done"
    });

    // 第一次重试：attempt=2，应该继续 running
    expect(session.status).toBe("running");
    expect(session.stage_runs?.[0]).toMatchObject({ stage_id: "understand", attempt: 2, status: "running", retry_reason: expect.stringContaining("Missing required outputs") });
    expect(session.error).toContain("Missing required outputs");
  });

  it("soft-completes after exceeding auto-retry limit for missing outputs", () => {
    const engine = new WorkflowEngine();
    const session = createSession();
    const workflowWithRetry: WorkflowTemplate = {
      ...workflow,
      stages: [
        { id: "understand", name: "Understand", required_outputs: ["task_summary"], auto_retry_limit: 1 },
        { id: "plan", name: "Plan" }
      ]
    };

    engine.ensureState(session, workflowWithRetry);
    // 第一次尝试：missing output，触发重试（attempt=2）
    engine.applyStageResult(session, workflowWithRetry, {
      status: "completed",
      output_summary: "Done"
    });
    // 第二次尝试：仍然 missing output，应该软通过，把缺口交给下游入境验收
    engine.applyStageResult(session, workflowWithRetry, {
      status: "completed",
      output_summary: "Done"
    });

    expect(session.status).toBe("running");
    expect(session.current_stage).toBe("plan");
    expect(session.error).toBeUndefined();
    expect(session.stage_runs?.[0].output_summary).toContain("结构化字段缺失");
    expect(session.stage_runs?.[0].output_summary).toContain("task_summary");
  });

  it("soft-completes immediately when stage has no auto_retry_limit", () => {
    const engine = new WorkflowEngine();
    const session = createSession();
    const workflowWithoutRetry: WorkflowTemplate = {
      ...workflow,
      stages: [
        { id: "understand", name: "Understand", required_outputs: ["task_summary"] },
        { id: "plan", name: "Plan" }
      ]
    };

    engine.ensureState(session, workflowWithoutRetry);
    engine.applyStageResult(session, workflowWithoutRetry, {
      status: "completed",
      output_summary: "Done"
    });

    expect(session.status).toBe("running");
    expect(session.current_stage).toBe("plan");
    expect(session.error).toBeUndefined();
    expect(session.stage_runs?.[0].output_summary).toContain("结构化字段缺失");
  });

  it("post_output_assertions: review_self_consistency 命中 → 走 retry → 超限 block", () => {
    const engine = new WorkflowEngine();
    const session = createSession();
    const wf: WorkflowTemplate = {
      ...workflow,
      stages: [
        {
          id: "self_review",
          name: "Self Review",
          auto_retry_limit: 1,
          hooks: { post_output_assertions: ["review_self_consistency"] }
        }
      ]
    };

    engine.ensureState(session, wf);
    // 第 1 次：findings 含 blocker 但 decision=pass —— 触发断言 → retry
    engine.applyStageResult(session, wf, {
      status: "completed",
      output_summary: "发现一个 blocker",
      required_outputs: { rework_decision: "pass" }
    });
    expect(session.status).toBe("running");
    expect(session.error).toContain("review_self_consistency");
    expect(session.stage_runs?.[0]).toMatchObject({ attempt: 2, status: "running" });

    // 第 2 次：仍然自相矛盾 → 超限 block
    engine.applyStageResult(session, wf, {
      status: "completed",
      output_summary: "依然 blocker",
      required_outputs: { rework_decision: "pass" }
    });
    expect(session.status).toBe("blocked");
    expect(session.error).toContain("after 2 attempts");
  });

  it("post_output_assertions: 修正后通过", () => {
    const engine = new WorkflowEngine();
    const session = createSession();
    const wf: WorkflowTemplate = {
      ...workflow,
      stages: [
        {
          id: "self_review",
          name: "Self Review",
          auto_retry_limit: 1,
          hooks: { post_output_assertions: ["review_self_consistency"] }
        }
      ]
    };

    engine.ensureState(session, wf);
    engine.applyStageResult(session, wf, {
      status: "completed",
      output_summary: "发现一个 blocker",
      required_outputs: { rework_decision: "pass" }
    });
    expect(session.status).toBe("running");

    // 模型修正：改为 needs_rework
    engine.applyStageResult(session, wf, {
      status: "needs_rework",
      output_summary: "回炉 implement",
      required_outputs: { rework_decision: "needs_rework" },
      rework_target_stage_id: "self_review", // 故意不合法但流程上只是测断言不再触发
      rework_reason: "存在阻塞缺口"
    });
    // 注意：rework_target_stage_id 的合法性由 requestRework 校验，可能 block，
    // 但断言层已通过——这里我们只验证不再因 review_self_consistency 卡住。
    expect(session.error ?? "").not.toContain("review_self_consistency");
  });

  it("post_output_assertions: 未声明该断言时 review 自相矛盾照样放行（向后兼容）", () => {
    const engine = new WorkflowEngine();
    const session = createSession();
    const wf: WorkflowTemplate = {
      ...workflow,
      stages: [{ id: "self_review", name: "Self Review" }]
    };

    engine.ensureState(session, wf);
    engine.applyStageResult(session, wf, {
      status: "completed",
      output_summary: "blocker 存在",
      required_outputs: { rework_decision: "pass" }
    });
    expect(session.status).not.toBe("blocked");
  });

  it("post_output_checks: 本阶段未跑指定命令 → retry → 超限 block；跑过后放行", () => {
    const engine = new WorkflowEngine();
    const session = createSession();
    const wf: WorkflowTemplate = {
      ...workflow,
      stages: [
        {
          id: "investigate",
          name: "Investigate",
          auto_retry_limit: 1,
          hooks: {
            post_output_checks: [
              { require: { commands_run: ["git log "] }, on_fail: "investigate 必须真跑过 git log" }
            ]
          }
        }
      ]
    };

    engine.ensureState(session, wf);
    // session.tool_calls 里没有 stage_id=investigate 的 git log 调用 → 行为校验失败 → retry
    engine.applyStageResult(session, wf, {
      status: "completed",
      output_summary: "我查过了（但其实没跑命令）"
    });
    expect(session.status).toBe("running");
    expect(session.error).toContain("commands_run");
    expect(session.error).toContain("git log");
    expect(session.stage_runs?.[0]).toMatchObject({ attempt: 2, status: "running" });

    // 仍没跑 → 超限 block
    engine.applyStageResult(session, wf, {
      status: "completed",
      output_summary: "还是没跑"
    });
    expect(session.status).toBe("blocked");

    // 另一会话：真跑了 git log（stage_id 匹配）→ 放行
    const session2 = createSession();
    engine.ensureState(session2, wf);
    session2.tool_calls.push({
      id: "tc1",
      stage_id: "investigate",
      tool: "Bash",
      input: { command: "git log --oneline -5" },
      status: "completed",
      created_at: "t"
    });
    engine.applyStageResult(session2, wf, { status: "completed", output_summary: "已查证" });
    expect(session2.status).not.toBe("blocked");
    expect(session2.stage_runs?.[0]).toMatchObject({ status: "completed" });
  });

  it("post_output_checks: 他阶段（stage_id 不匹配）的命令不算本阶段行为", () => {
    const engine = new WorkflowEngine();
    const session = createSession();
    const wf: WorkflowTemplate = {
      ...workflow,
      stages: [
        {
          id: "investigate",
          name: "Investigate",
          auto_retry_limit: 0,
          hooks: {
            post_output_checks: [
              { require: { commands_run: ["git log "] }, on_fail: "本阶段须跑 git log" }
            ]
          }
        }
      ]
    };
    engine.ensureState(session, wf);
    // git log 跑在 implement 阶段，不算 investigate 的本阶段行为 → 失败 block
    session.tool_calls.push({
      id: "tc-other",
      stage_id: "implement",
      tool: "Bash",
      input: { command: "git log --oneline" },
      status: "completed",
      created_at: "t"
    });
    engine.applyStageResult(session, wf, { status: "completed", output_summary: "查过了" });
    expect(session.status).toBe("blocked");
  });

  it("post_output_checks: 同阶段前序 rework run 的旧调用不算本轮（per-run 切片）", () => {
    const engine = new WorkflowEngine();
    const session = createSession();
    const wf: WorkflowTemplate = {
      ...workflow,
      stages: [
        {
          id: "investigate",
          name: "Investigate",
          auto_retry_limit: 0, // 直接 block，便于断言
          hooks: {
            post_output_checks: [
              { require: { commands_run: ["git log "] }, on_fail: "本轮须跑 git log" }
            ]
          }
        }
      ]
    };
    // run-1（已完成，跑过 git log，created_at=T1）+ run-2（rework 回炉，running，started_at=T2>T1）
    session.stage_runs = [
      {
        id: "run-1", stage_id: "investigate", attempt: 1, status: "completed",
        input_summary: "", output_summary: "首轮查证", required_outputs: {},
        started_at: "2026-01-01T00:00:00.000Z", completed_at: "2026-01-01T00:00:05.000Z"
      },
      {
        id: "run-2", stage_id: "investigate", attempt: 2, status: "running",
        input_summary: "Rework requested", started_at: "2026-01-02T00:00:00.000Z"
      }
    ];
    session.current_stage = "investigate";
    // run-1 的 git log 调用，created_at=T1，早于 run-2.started_at=T2 → 不应算本轮
    session.tool_calls.push({
      id: "tc-old", stage_id: "investigate", tool: "Bash",
      input: { command: "git log --oneline" }, status: "completed",
      created_at: "2026-01-01T00:00:01.000Z"
    });
    // run-2 没跑 git log → 行为检查应失败 block（即便 run-1 跑过）
    engine.applyStageResult(session, wf, { status: "completed", output_summary: "复用上轮结论" });
    expect(session.status).toBe("blocked");
    expect(session.error).toContain("git log");

    // 对照：run-2 真跑过 git log（created_at ≥ T2）→ 放行
    const session2 = createSession();
    session2.stage_runs = [
      {
        id: "run-1b", stage_id: "investigate", attempt: 1, status: "completed",
        input_summary: "", output_summary: "首轮", required_outputs: {},
        started_at: "2026-01-01T00:00:00.000Z", completed_at: "2026-01-01T00:00:05.000Z"
      },
      {
        id: "run-2b", stage_id: "investigate", attempt: 2, status: "running",
        input_summary: "Rework", started_at: "2026-01-02T00:00:00.000Z"
      }
    ];
    session2.current_stage = "investigate";
    session2.tool_calls.push({
      id: "tc-new", stage_id: "investigate", tool: "Bash",
      input: { command: "git log --oneline" }, status: "completed",
      created_at: "2026-01-02T00:00:01.000Z" // ≥ run-2b.started_at
    });
    engine.applyStageResult(session2, wf, { status: "completed", output_summary: "重查证" });
    expect(session2.status).not.toBe("blocked");
  });

  it("post_output_checks: needs_rework 不触行为检查（仅 completed 才门控行为）", () => {
    const engine = new WorkflowEngine();
    const session = createSession();
    const wf: WorkflowTemplate = {
      ...workflow,
      stages: [
        {
          id: "investigate",
          name: "Investigate",
          auto_retry_limit: 1,
          hooks: {
            post_output_assertions: ["needs_rework_target_required"],
            post_output_checks: [
              { require: { commands_run: ["git log "] }, on_fail: "本轮须跑 git log" }
            ]
          }
        }
      ]
    };
    engine.ensureState(session, wf);
    // 模型发 needs_rework 但缺 target/reason，且没跑 git log——
    // 早期分支应只触 needs_rework_target_required（文本断言），不触行为检查（status != completed）
    engine.applyStageResult(session, wf, {
      status: "needs_rework",
      output_summary: "要回炉 understand"
      // 故意缺 rework_target_stage_id / rework_reason
    });
    expect(session.status).toBe("running"); // 走 retry
    expect(session.error).toContain("needs_rework_target_required");
    expect(session.error).not.toContain("git log");
    expect(session.error).not.toContain("commands_run");
  });

  it("needs_rework_target_required: 声明该断言时，缺 target → retry 而非立即 block", () => {
    const engine = new WorkflowEngine();
    const session = createSession();
    const wf: WorkflowTemplate = {
      ...workflow,
      stages: [
        {
          id: "self_review",
          name: "Self Review",
          auto_retry_limit: 1,
          hooks: { post_output_assertions: ["needs_rework_target_required"] }
        }
      ]
    };

    engine.ensureState(session, wf);
    // 第 1 次：status=needs_rework 但缺 target —— 旧路径会直接 block，
    // 新路径应让断言层给一次 retry。
    engine.applyStageResult(session, wf, {
      status: "needs_rework",
      output_summary: "回炉但忘了写 target"
    });
    expect(session.status).toBe("running");
    expect(session.error).toContain("needs_rework_target_required");
    expect(session.stage_runs?.[0]).toMatchObject({ attempt: 2, status: "running" });

    // 第 2 次仍缺 target → 超限 block
    engine.applyStageResult(session, wf, {
      status: "needs_rework",
      output_summary: "还是没写"
    });
    expect(session.status).toBe("blocked");
    expect(session.error).toContain("after 2 attempts");
  });

  it("needs_rework_target_required: 未声明该断言时仍保持旧的立即 block 行为（向后兼容）", () => {
    const engine = new WorkflowEngine();
    const session = createSession();
    const wf: WorkflowTemplate = {
      ...workflow,
      stages: [{ id: "self_review", name: "Self Review", auto_retry_limit: 1 }]
    };

    engine.ensureState(session, wf);
    engine.applyStageResult(session, wf, {
      status: "needs_rework",
      output_summary: "回炉但忘了写 target"
    });
    expect(session.status).toBe("blocked");
    expect(session.error).toContain("Rework result requires");
  });

  it("priorOutputs 机制：completed stage 的 required_outputs 会被存到 stageRun，可被后续阶段读取（v1.1 软化后无内置消费方，但机制保留）", () => {
    const engine = new WorkflowEngine();
    const session = createSession();
    const wf: WorkflowTemplate = {
      ...workflow,
      stages: [
        { id: "investigate", name: "Investigate", required_outputs: ["findings"] },
        { id: "design", name: "Design", required_outputs: ["plan_steps"] }
      ]
    };

    engine.ensureState(session, wf);
    engine.applyStageResult(session, wf, {
      status: "completed",
      output_summary: "ok",
      required_outputs: { findings: [{ id: "f1", claim: "x" }] }
    });
    const invRun = session.stage_runs?.find((r) => r.stage_id === "investigate");
    expect(invRun?.status).toBe("completed");
    // 关键不变量：通过校验后 required_outputs 必须落地到 stageRun，让未来的跨阶段断言能读到
    expect(invRun?.required_outputs).toEqual({ findings: [{ id: "f1", claim: "x" }] });
  });

  it("missing_outputs：parse_diagnostics.had_unparsed_tail 命中时，retry hint 必须附诊断信息（治 13:27 卡死症状）", () => {
    const engine = new WorkflowEngine();
    const session = createSession();
    const wf: WorkflowTemplate = {
      ...workflow,
      stages: [
        {
          id: "investigate",
          name: "Investigate",
          required_outputs: ["findings", "unknowns"],
          auto_retry_limit: 2
        }
      ]
    };

    engine.ensureState(session, wf);
    // 模拟实际症状：模型输出 JSON 烂尾，parseStageAgentResult 兜底产出 required_outputs 缺失
    // + parse_diagnostics.had_unparsed_tail=true
    engine.applyStageResult(session, wf, {
      status: "completed",
      output_summary: "...",
      required_outputs: undefined,
      parse_diagnostics: {
        had_unparsed_tail: true,
        tail_length: 240,
        last_open_brace_index: 800,
        bracket_balance: 3,
        candidate_count: 1
      }
    });
    expect(session.status).toBe("running");
    expect(session.error).toContain("Missing required outputs");
    // 关键：必须把 JSON parse 诊断带给模型，否则它以为自己只是少写了字段会再次输出同一份烂 JSON
    expect(session.error).toContain("JSON parse 失败诊断");
    expect(session.error).toContain("bracket_balance=3");
  });
});

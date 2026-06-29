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

  it("blocks a stage agent result missing required outputs", () => {
    const engine = new WorkflowEngine();
    const session = createSession();
    const workflowWithRequiredOutput: WorkflowTemplate = {
      ...workflow,
      stages: [{ id: "understand", name: "Understand", required_outputs: ["task_summary"] }]
    };

    engine.ensureState(session, workflowWithRequiredOutput);
    engine.applyStageResult(session, workflowWithRequiredOutput, {
      status: "completed",
      output_summary: "Done"
    });

    expect(session.status).toBe("blocked");
    expect(session.error).toContain("Missing required outputs after 1 attempts");
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

  it("blocks after exceeding auto-retry limit for missing outputs", () => {
    const engine = new WorkflowEngine();
    const session = createSession();
    const workflowWithRetry: WorkflowTemplate = {
      ...workflow,
      stages: [{ id: "understand", name: "Understand", required_outputs: ["task_summary"], auto_retry_limit: 1 }]
    };

    engine.ensureState(session, workflowWithRetry);
    // 第一次尝试：missing output，触发重试（attempt=2）
    engine.applyStageResult(session, workflowWithRetry, {
      status: "completed",
      output_summary: "Done"
    });
    // 第二次尝试：仍然 missing output，应该 block（因为 auto_retry_limit=1）
    engine.applyStageResult(session, workflowWithRetry, {
      status: "completed",
      output_summary: "Done"
    });

    expect(session.status).toBe("blocked");
    expect(session.error).toContain("Missing required outputs after 2 attempts");
  });

  it("blocks immediately when stage has no auto_retry_limit", () => {
    const engine = new WorkflowEngine();
    const session = createSession();
    const workflowWithoutRetry: WorkflowTemplate = {
      ...workflow,
      stages: [{ id: "understand", name: "Understand", required_outputs: ["task_summary"] }]
    };

    engine.ensureState(session, workflowWithoutRetry);
    engine.applyStageResult(session, workflowWithoutRetry, {
      status: "completed",
      output_summary: "Done"
    });

    expect(session.status).toBe("blocked");
    expect(session.error).toContain("Missing required outputs after 1 attempts");
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

  it("priorOutputs：completed stage 的 required_outputs 会被存到 stageRun 并透传给后续断言", () => {
    const engine = new WorkflowEngine();
    const session = createSession();
    const wf: WorkflowTemplate = {
      ...workflow,
      stages: [
        { id: "investigate", name: "Investigate", required_outputs: ["findings"] },
        {
          id: "design",
          name: "Design",
          required_outputs: ["plan_steps"],
          auto_retry_limit: 1,
          hooks: { post_output_assertions: ["plan_steps_grounded"] }
        }
      ]
    };

    engine.ensureState(session, wf);
    // investigate 通过，required_outputs 应落地到 stage_run.required_outputs
    engine.applyStageResult(session, wf, {
      status: "completed",
      output_summary: "ok",
      required_outputs: { findings: [{ id: "f1" }] }
    });
    const invRun = session.stage_runs?.find((r) => r.stage_id === "investigate");
    expect(invRun?.status).toBe("completed");
    expect(invRun?.required_outputs).toEqual({ findings: [{ id: "f1" }] });

    // design 阶段引用合法 finding id → 通过
    engine.applyStageResult(session, wf, {
      status: "completed",
      output_summary: "ok",
      required_outputs: {
        plan_steps: [{ id: "p1", action: "x", supporting_finding_ids: ["f1"] }]
      }
    });
    expect(session.status).not.toBe("blocked");
    const designRun = session.stage_runs?.find((r) => r.stage_id === "design");
    expect(designRun?.status).toBe("completed");
  });

  it("priorOutputs：design 引用了不存在的 finding id → plan_steps_grounded 触发 retry", () => {
    const engine = new WorkflowEngine();
    const session = createSession();
    const wf: WorkflowTemplate = {
      ...workflow,
      stages: [
        { id: "investigate", name: "Investigate", required_outputs: ["findings"] },
        {
          id: "design",
          name: "Design",
          required_outputs: ["plan_steps"],
          auto_retry_limit: 1,
          hooks: { post_output_assertions: ["plan_steps_grounded"] }
        }
      ]
    };

    engine.ensureState(session, wf);
    engine.applyStageResult(session, wf, {
      status: "completed",
      output_summary: "ok",
      required_outputs: { findings: [{ id: "f1" }] }
    });
    engine.applyStageResult(session, wf, {
      status: "completed",
      output_summary: "ok",
      required_outputs: {
        plan_steps: [{ id: "p1", action: "x", supporting_finding_ids: ["f-ghost"] }]
      }
    });
    expect(session.error).toContain("plan_steps_grounded");
    expect(session.error).toContain("f-ghost");
  });
});

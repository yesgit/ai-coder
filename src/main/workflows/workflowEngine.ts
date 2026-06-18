import { randomUUID } from "node:crypto";
import type {
  AgentSession,
  ApprovalRecord,
  ReworkRequest,
  StageAgentResult,
  StageRun,
  WorkflowStage,
  WorkflowTemplate
} from "../../shared/types.js";

export class WorkflowEngine {
  ensureState(session: AgentSession, workflow: WorkflowTemplate): AgentSession {
    session.stage_runs ??= [];
    session.rework_requests ??= [];

    if (session.stage_runs.length === 0) {
      const firstStage = workflow.stages[0];
      if (firstStage) {
        this.startStage(session, workflow, firstStage, "Initial task");
      }
    }

    return session;
  }

  completeCurrentStage(session: AgentSession, workflow: WorkflowTemplate, outputSummary: string): AgentSession {
    this.ensureState(session, workflow);
    const stageRun = this.getActiveStageRun(session);
    if (!stageRun) {
      session.status = "completed";
      return session;
    }

    stageRun.status = "completed";
    stageRun.output_summary = outputSummary;
    stageRun.completed_at = new Date().toISOString();

    const stage = this.getStage(workflow, stageRun.stage_id);
    if (stage?.approval_required) {
      this.requestStageApproval(session, stage, stageRun);
      return session;
    }

    return this.advanceAfterCompletedStage(session, workflow, stageRun.stage_id);
  }

  applyStageResult(session: AgentSession, workflow: WorkflowTemplate, result: StageAgentResult): AgentSession {
    this.ensureState(session, workflow);
    const stageRun = this.getActiveStageRun(session);
    if (!stageRun) {
      session.status = "completed";
      return session;
    }

    if (result.status === "failed") {
      return this.failCurrentStage(session, result.error ?? result.output_summary);
    }

    if (result.status === "needs_rework") {
      if (!result.rework_target_stage_id || !result.rework_reason) {
        return this.blockCurrentStage(session, "Rework result requires rework_target_stage_id and rework_reason");
      }
      try {
        return this.requestRework(session, workflow, result.rework_target_stage_id, result.rework_reason);
      } catch (error) {
        return this.blockCurrentStage(session, error instanceof Error ? error.message : String(error));
      }
    }

    const stage = this.getStage(workflow, stageRun.stage_id);
    const missingOutputs = (stage?.required_outputs ?? []).filter((name) => !hasRequiredOutput(result, name));
    if (missingOutputs.length > 0) {
      const maxRetry = stage?.auto_retry_limit ?? 0;
      const currentAttempt = this.getStageAttempt(session, stageRun.stage_id);
      if (currentAttempt <= maxRetry) {
        return this.retryCurrentStage(session, workflow, `Missing required outputs: ${missingOutputs.join(", ")}`);
      }
      return this.blockCurrentStage(session, `Missing required outputs after ${currentAttempt} attempts: ${missingOutputs.join(", ")}`);
    }

    return this.completeCurrentStage(session, workflow, result.output_summary);
  }

  approveStage(session: AgentSession, workflow: WorkflowTemplate, stageId: string): AgentSession {
    this.ensureState(session, workflow);
    const approval = session.approvals.find(
      (item) => item.stage_id === stageId && item.kind === "stage" && item.status === "pending"
    );
    if (!approval) {
      throw new Error(`Stage approval not found: ${stageId}`);
    }

    approval.status = "approved";
    approval.resolved_at = new Date().toISOString();

    const approvedRun = approval.stage_run_id
      ? session.stage_runs?.find((stageRun) => stageRun.id === approval.stage_run_id)
      : this.getLatestStageRun(session, stageId);
    if (approvedRun?.status === "waiting_approval") {
      approvedRun.status = "completed";
    }

    return this.advanceAfterCompletedStage(session, workflow, approvedRun?.stage_id ?? stageId);
  }

  requestRework(session: AgentSession, workflow: WorkflowTemplate, targetStageId: string, reason: string): AgentSession {
    this.ensureState(session, workflow);
    if (!workflow.rework.enabled) {
      throw new Error(`Rework is disabled for workflow: ${workflow.id}`);
    }
    if (!workflow.rework.allowed_targets.includes(targetStageId)) {
      throw new Error(`Rework target is not allowed: ${targetStageId}`);
    }

    const activeRun = this.getActiveStageRun(session);
    if (!activeRun) {
      throw new Error("No active stage run to request rework from");
    }
    if (!this.isPreviousStage(workflow, activeRun.stage_id, targetStageId)) {
      throw new Error(`Rework target must be a previous stage: ${targetStageId}`);
    }

    const now = new Date().toISOString();
    activeRun.status = "needs_rework";
    activeRun.rework_reason = reason;
    activeRun.completed_at = now;

    const request: ReworkRequest = {
      id: randomUUID(),
      from_stage_id: activeRun.stage_id,
      target_stage_id: targetStageId,
      status: workflow.rework.approval_required ? "pending" : "approved",
      reason,
      created_at: now,
      resolved_at: workflow.rework.approval_required ? undefined : now
    };
    session.rework_requests?.push(request);

    if (workflow.rework.approval_required) {
      session.status = "waiting_approval";
      return session;
    }

    return this.applyRework(session, workflow, request);
  }

  approveRework(session: AgentSession, workflow: WorkflowTemplate, requestId: string): AgentSession {
    this.ensureState(session, workflow);
    const request = session.rework_requests?.find((item) => item.id === requestId && item.status === "pending");
    if (!request) {
      throw new Error(`Pending rework request not found: ${requestId}`);
    }

    request.status = "approved";
    request.resolved_at = new Date().toISOString();
    return this.applyRework(session, workflow, request);
  }

  resumeFromFailedStage(session: AgentSession, workflow: WorkflowTemplate): AgentSession {
    this.ensureState(session, workflow);

    let targetStageId: string | undefined;
    const activeRun = this.getActiveStageRun(session);
    if (activeRun) {
      activeRun.status = "superseded";
      activeRun.completed_at = new Date().toISOString();
      targetStageId = activeRun.stage_id;
    } else {
      const failedRun = [...(session.stage_runs ?? [])]
        .reverse()
        .find((stageRun) => stageRun.status === "failed");
      if (!failedRun) {
        throw new Error("No stage to resume from");
      }
      targetStageId = failedRun.stage_id;
    }

    const stage = this.getStage(workflow, targetStageId);
    if (!stage) {
      throw new Error(`Workflow stage not found: ${targetStageId}`);
    }

    const inputSummary = this.buildResumeInputSummary(session, workflow, targetStageId);
    session.error = undefined;
    this.startStage(session, workflow, stage, inputSummary);
    return session;
  }

  private buildResumeInputSummary(
    session: AgentSession,
    workflow: WorkflowTemplate,
    targetStageId: string
  ): string {
    const targetIndex = this.stageIndex(workflow, targetStageId);
    for (let index = targetIndex - 1; index >= 0; index -= 1) {
      const priorStageId = workflow.stages[index]?.id;
      if (!priorStageId) {
        continue;
      }
      const priorCompleted = [...(session.stage_runs ?? [])]
        .reverse()
        .find((stageRun) => stageRun.stage_id === priorStageId && stageRun.status === "completed");
      if (priorCompleted?.output_summary) {
        return priorCompleted.output_summary;
      }
    }
    return "Resume retry";
  }

  getActiveStageRun(session: AgentSession): StageRun | undefined {
    return [...(session.stage_runs ?? [])]
      .reverse()
      .find((stageRun) => stageRun.status === "running" || stageRun.status === "waiting_approval");
  }

  private failCurrentStage(session: AgentSession, error: string): AgentSession {
    const stageRun = this.getActiveStageRun(session);
    if (stageRun) {
      stageRun.status = "failed";
      stageRun.output_summary = error;
      stageRun.completed_at = new Date().toISOString();
    }
    session.status = "failed";
    session.error = error;
    return session;
  }

  private blockCurrentStage(session: AgentSession, reason: string): AgentSession {
    const stageRun = this.getActiveStageRun(session);
    if (stageRun) {
      stageRun.status = "failed";
      stageRun.output_summary = reason;
      stageRun.completed_at = new Date().toISOString();
    }
    session.status = "blocked";
    session.error = reason;
    return session;
  }

  private retryCurrentStage(session: AgentSession, workflow: WorkflowTemplate, reason: string): AgentSession {
    const stageRun = this.getActiveStageRun(session);
    if (!stageRun) {
      return session;
    }

    stageRun.status = "running";
    stageRun.retry_reason = reason;
    stageRun.attempt = (stageRun.attempt ?? 1) + 1;
    session.status = "running";
    session.error = reason;
    return session;
  }

  private getStageAttempt(session: AgentSession, stageId: string): number {
    const runs = (session.stage_runs ?? []).filter((run) => run.stage_id === stageId);
    if (runs.length === 0) return 0;
    return Math.max(...runs.map((run) => run.attempt ?? 1));
  }

  private advanceAfterCompletedStage(session: AgentSession, workflow: WorkflowTemplate, completedStageId: string): AgentSession {
    const completedIndex = workflow.stages.findIndex((stage) => stage.id === completedStageId);
    const nextStage = workflow.stages[completedIndex + 1];
    if (!nextStage) {
      // 没有下一阶段时，检查是否是单阶段工作流（如闲聊）—— 如果是则重启该阶段
      if (workflow.stages.length === 1) {
        this.startStage(session, workflow, workflow.stages[0], this.buildInputSummary(session, completedStageId));
        return session;
      }
      session.status = "completed";
      session.current_stage = completedStageId;
      return session;
    }

    this.startStage(session, workflow, nextStage, this.buildInputSummary(session, completedStageId));
    return session;
  }

  private requestStageApproval(session: AgentSession, stage: WorkflowStage, stageRun: StageRun): void {
    const existing = session.approvals.find(
      (approval) => approval.kind === "stage" && approval.stage_run_id === stageRun.id && approval.status === "pending"
    );
    if (!existing) {
      const approval: ApprovalRecord = {
        id: randomUUID(),
        stage_id: stage.id,
        stage_run_id: stageRun.id,
        kind: "stage",
        status: "pending",
        message: `Approval required after stage: ${stage.name}`,
        created_at: new Date().toISOString()
      };
      session.approvals.push(approval);
    }
    stageRun.status = "waiting_approval";
    session.status = "waiting_approval";
    session.current_stage = stage.id;
  }

  private startStage(session: AgentSession, workflow: WorkflowTemplate, stage: WorkflowStage, inputSummary: string): StageRun {
    const now = new Date().toISOString();
    const stageRun: StageRun = {
      id: randomUUID(),
      stage_id: stage.id,
      attempt: this.nextAttempt(session, stage.id),
      status: "running",
      input_summary: inputSummary,
      started_at: now
    };
    session.stage_runs?.push(stageRun);
    session.current_stage = stage.id;
    session.status = "running";
    return stageRun;
  }

  private applyRework(session: AgentSession, workflow: WorkflowTemplate, request: ReworkRequest): AgentSession {
    if (workflow.rework.invalidate_downstream) {
      const targetIndex = this.stageIndex(workflow, request.target_stage_id);
      for (const stageRun of session.stage_runs ?? []) {
        const runIndex = this.stageIndex(workflow, stageRun.stage_id);
        if (runIndex >= targetIndex && stageRun.status !== "needs_rework" && stageRun.status !== "failed") {
          stageRun.status = "superseded";
        }
      }
    }

    const targetStage = this.getStage(workflow, request.target_stage_id);
    if (!targetStage) {
      throw new Error(`Rework target stage not found: ${request.target_stage_id}`);
    }
    this.startStage(session, workflow, targetStage, `Rework requested from ${request.from_stage_id}: ${request.reason}`);
    return session;
  }

  private buildInputSummary(session: AgentSession, completedStageId: string): string {
    const latestCompleted = this.getLatestStageRun(session, completedStageId);
    return latestCompleted?.output_summary ?? `Continue after ${completedStageId}`;
  }

  private getLatestStageRun(session: AgentSession, stageId: string): StageRun | undefined {
    return [...(session.stage_runs ?? [])].reverse().find((stageRun) => stageRun.stage_id === stageId);
  }

  private getStage(workflow: WorkflowTemplate, stageId: string): WorkflowStage | undefined {
    return workflow.stages.find((stage) => stage.id === stageId);
  }

  private nextAttempt(session: AgentSession, stageId: string): number {
    const attempts = (session.stage_runs ?? []).filter((stageRun) => stageRun.stage_id === stageId).map((stageRun) => stageRun.attempt);
    return attempts.length === 0 ? 1 : Math.max(...attempts) + 1;
  }

  private isPreviousStage(workflow: WorkflowTemplate, currentStageId: string, targetStageId: string): boolean {
    return this.stageIndex(workflow, targetStageId) < this.stageIndex(workflow, currentStageId);
  }

  private stageIndex(workflow: WorkflowTemplate, stageId: string): number {
    const index = workflow.stages.findIndex((stage) => stage.id === stageId);
    if (index === -1) {
      throw new Error(`Workflow stage not found: ${stageId}`);
    }
    return index;
  }
}

function hasRequiredOutput(result: StageAgentResult, name: string): boolean {
  return Object.hasOwn(result.required_outputs ?? {}, name);
}

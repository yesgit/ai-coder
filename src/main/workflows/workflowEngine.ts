import { randomUUID } from "node:crypto";
import type { AgentSession, ApprovalRecord, ReworkRequest, StageRun, WorkflowStage, WorkflowTemplate } from "../../shared/types.js";

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

  getActiveStageRun(session: AgentSession): StageRun | undefined {
    return [...(session.stage_runs ?? [])]
      .reverse()
      .find((stageRun) => stageRun.status === "running" || stageRun.status === "waiting_approval");
  }

  private advanceAfterCompletedStage(session: AgentSession, workflow: WorkflowTemplate, completedStageId: string): AgentSession {
    const completedIndex = workflow.stages.findIndex((stage) => stage.id === completedStageId);
    const nextStage = workflow.stages[completedIndex + 1];
    if (!nextStage) {
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

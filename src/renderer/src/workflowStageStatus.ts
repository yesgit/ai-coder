import type { AgentSession, StageRunStatus, WorkflowStage } from "../../shared/types.js";

export type WorkflowStageDisplayStatus = StageRunStatus | "not_started";

export interface WorkflowStageDisplay {
  stage: WorkflowStage;
  status: WorkflowStageDisplayStatus;
  attempt?: number;
  isCurrent: boolean;
}

export function buildWorkflowStageDisplays(
  stages: WorkflowStage[],
  session: AgentSession | null,
  workflowId: string
): WorkflowStageDisplay[] {
  const relevantSession = session?.workflow_id === workflowId ? session : null;

  return stages.map((stage) => {
    const latestRun = relevantSession ? getLatestStageRun(relevantSession, stage.id) : undefined;
    return {
      stage,
      status: latestRun?.status ?? "not_started",
      attempt: latestRun?.attempt,
      isCurrent: Boolean(relevantSession && relevantSession.current_stage === stage.id && latestRun?.status !== "superseded")
    };
  });
}

function getLatestStageRun(session: AgentSession, stageId: string) {
  return [...(session.stage_runs ?? [])].reverse().find((stageRun) => stageRun.stage_id === stageId);
}

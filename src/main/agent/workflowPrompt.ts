import type { AgentSession, StageRun, WorkflowStage, WorkflowTemplate } from "../../shared/types.js";

export function buildStageInstructions(session: AgentSession, workflow: WorkflowTemplate, currentStage: WorkflowStage): string {
  const stageLines = workflow.stages
    .map((stage, index) => {
      const outputs = stage.required_outputs?.length ? ` outputs=${stage.required_outputs.join(",")}` : "";
      const checks = stage.required_checks?.length ? ` checks=${stage.required_checks.join(",")}` : "";
      const approval = stage.approval_required ? " approval_required=true" : "";
      return `${index + 1}. ${stage.id}: ${stage.name}${approval}${outputs}${checks}`;
    })
    .join("\n");

  const previousStageLines = (session.stage_runs ?? [])
    .filter((stageRun) => stageRun.status === "completed")
    .map(formatStageRunSummary)
    .join("\n");

  const allowedTools = currentStage.allowed_tools?.length ? currentStage.allowed_tools.join(", ") : "read-only defaults";
  const requiredOutputs = currentStage.required_outputs?.length ? currentStage.required_outputs.join(", ") : "concise stage summary";
  const gates = currentStage.gates?.length ? currentStage.gates.join(", ") : "none";

  return [
    `You are running inside the "${workflow.name}" workflow.`,
    "The workflow engine controls stage transitions. Complete only the current stage.",
    "You may use the workflow overview and previous stage summaries as context, but do not execute later stages.",
    "Only read or modify files inside the selected project directory.",
    "Ask for approval before shell commands or file writes when policy requires it.",
    "If the current stage uncovers a need to redo an earlier stage, explain the target stage and reason instead of changing workflow state yourself.",
    "",
    "Workflow overview:",
    stageLines,
    "",
    "Previous stage summaries:",
    previousStageLines || "None",
    "",
    "Current stage:",
    `id: ${currentStage.id}`,
    `name: ${currentStage.name}`,
    `allowed_tools: ${allowedTools}`,
    `required_outputs: ${requiredOutputs}`,
    `gates: ${gates}`
  ].join("\n");
}

function formatStageRunSummary(stageRun: StageRun): string {
  return `- ${stageRun.stage_id} attempt ${stageRun.attempt}: ${stageRun.output_summary ?? "completed"}`;
}

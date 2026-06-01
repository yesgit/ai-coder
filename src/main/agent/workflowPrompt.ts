import type { WorkflowTemplate } from "../../shared/types.js";

export function buildWorkflowInstructions(workflow: WorkflowTemplate): string {
  const stageLines = workflow.stages
    .map((stage, index) => {
      const outputs = stage.required_outputs?.length ? ` outputs=${stage.required_outputs.join(",")}` : "";
      const checks = stage.required_checks?.length ? ` checks=${stage.required_checks.join(",")}` : "";
      const approval = stage.approval_required ? " approval_required=true" : "";
      return `${index + 1}. ${stage.id}: ${stage.name}${approval}${outputs}${checks}`;
    })
    .join("\n");

  return [
    `You are running inside the "${workflow.name}" workflow.`,
    "Follow the stages in order. Do not skip an approval-required stage.",
    "Only read or modify files inside the selected project directory.",
    "Ask for approval before shell commands or file writes when policy requires it.",
    "Record concise outputs for every stage.",
    "",
    "Workflow stages:",
    stageLines
  ].join("\n");
}

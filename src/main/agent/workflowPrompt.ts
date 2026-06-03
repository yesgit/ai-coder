import type { StageAgentInput } from "../../shared/types.js";

export function buildStageInstructions(input: StageAgentInput): string {
  const stageLines = input.workflow.stages
    .map((stage, index) => {
      const outputs = stage.required_outputs?.length ? ` outputs=${stage.required_outputs.join(",")}` : "";
      const checks = stage.required_checks?.length ? ` checks=${stage.required_checks.join(",")}` : "";
      const approval = stage.approval_required ? " approval_required=true" : "";
      return `${index + 1}. ${stage.id}: ${stage.name}${approval}${outputs}${checks}`;
    })
    .join("\n");

  const previousStageLines = input.previous_stage_summaries
    .map((summary) => `- ${summary.stage_id} attempt ${summary.attempt}: ${summary.output_summary ?? summary.status}`)
    .join("\n");
  const allowedTools = input.allowed_tools.length ? input.allowed_tools.join(", ") : "read-only defaults";
  const requiredOutputs = input.required_outputs.length ? input.required_outputs.join(", ") : "concise stage summary";
  const gates = input.gates.length ? input.gates.join(", ") : "none";

  return [
    `You are running inside the "${input.workflow.name}" workflow.`,
    "The workflow engine controls stage transitions. Complete only the current stage.",
    "You may use the workflow overview and previous stage summaries as context, but do not execute later stages.",
    "Only read or modify files inside the selected project directory.",
    "Ask for approval before shell commands or file writes when policy requires it.",
    "If the current stage uncovers a need to redo an earlier stage, explain the target stage and reason instead of changing workflow state yourself.",
    "After any tool use, finish the current stage by returning exactly one JSON object that follows the protocol below.",
    "Do not include prose before or after the final JSON object.",
    "",
    "Workflow overview:",
    stageLines,
    "",
    "Previous stage summaries:",
    previousStageLines || "None",
    "",
    "Current stage:",
    `id: ${input.current_stage.id}`,
    `name: ${input.current_stage.name}`,
    `allowed_tools: ${allowedTools}`,
    `required_outputs: ${requiredOutputs}`,
    `gates: ${gates}`,
    "",
    "Final JSON protocol:",
    JSON.stringify(
      {
        status: "completed | failed | needs_rework",
        output_summary: "Concise summary of this stage result",
        required_outputs: Object.fromEntries(input.required_outputs.map((name) => [name, `<${name}>`])),
        rework_target_stage_id: "Only when status is needs_rework",
        rework_reason: "Only when status is needs_rework",
        error: "Only when status is failed"
      },
      null,
      2
    )
  ].join("\n");
}

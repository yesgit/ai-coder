import type { AgentSession, StageAgentInput, StageAgentResult, WorkflowStage, WorkflowTemplate } from "../../shared/types.js";

export function buildStageAgentInput(
  session: AgentSession,
  workflow: WorkflowTemplate,
  currentStage: WorkflowStage
): StageAgentInput {
  return {
    workflow: {
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      stages: workflow.stages.map((stage) => ({
        id: stage.id,
        name: stage.name,
        approval_required: stage.approval_required ?? false,
        required_outputs: stage.required_outputs ?? [],
        required_checks: stage.required_checks ?? [],
        gates: stage.gates ?? []
      }))
    },
    previous_stage_summaries: (session.stage_runs ?? [])
      .filter((stageRun) => stageRun.status === "completed")
      .map((stageRun) => ({
        stage_id: stageRun.stage_id,
        attempt: stageRun.attempt,
        status: stageRun.status,
        output_summary: stageRun.output_summary
      })),
    current_stage: currentStage,
    task_prompt: session.task_prompt,
    project_path: session.project_path,
    allowed_tools: currentStage.allowed_tools ?? [],
    required_outputs: currentStage.required_outputs ?? [],
    gates: currentStage.gates ?? []
  };
}

export function parseStageAgentResult(rawContent: string): StageAgentResult {
  const parsed = parseJsonObject(rawContent);
  if (!parsed) {
    return {
      status: "completed",
      output_summary: summarize(rawContent)
    };
  }

  const status = parseStatus(parsed.status);
  const outputSummary = typeof parsed.output_summary === "string" ? parsed.output_summary : summarize(rawContent);
  const requiredOutputs = isRecord(parsed.required_outputs) ? parsed.required_outputs : undefined;
  const reworkTarget = typeof parsed.rework_target_stage_id === "string" ? parsed.rework_target_stage_id : undefined;
  const reworkReason = typeof parsed.rework_reason === "string" ? parsed.rework_reason : undefined;
  const error = typeof parsed.error === "string" ? parsed.error : undefined;

  return {
    status,
    output_summary: outputSummary,
    required_outputs: requiredOutputs,
    rework_target_stage_id: reworkTarget,
    rework_reason: reworkReason,
    error
  };
}

export function createMockStageAgentResult(input: StageAgentInput): StageAgentResult {
  return {
    status: "completed",
    output_summary: `Mock stage "${input.current_stage.name}" completed. Set ANTHROPIC_API_KEY to use Claude Agent SDK.`,
    required_outputs: Object.fromEntries(input.required_outputs.map((name) => [name, `Mock output for ${name}`]))
  };
}

function parseJsonObject(rawContent: string): Record<string, unknown> | null {
  const fenced = rawContent.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? rawContent;
  try {
    const parsed = JSON.parse(candidate.trim());
    return isRecord(parsed) ? parsed : null;
  } catch {
    const objectMatch = candidate.match(/\{[\s\S]*\}/);
    if (!objectMatch) {
      return null;
    }
    try {
      const parsed = JSON.parse(objectMatch[0]);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function parseStatus(value: unknown): StageAgentResult["status"] {
  if (value === "failed" || value === "needs_rework") {
    return value;
  }
  return "completed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarize(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= 240) {
    return normalized;
  }
  return `${normalized.slice(0, 237)}...`;
}

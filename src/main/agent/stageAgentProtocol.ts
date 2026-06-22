import type { AgentSession, StageAgentInput, StageAgentResult, WorkflowStage, WorkflowTemplate } from "../../shared/types.js";

export function buildStageAgentInput(
  session: AgentSession,
  workflow: WorkflowTemplate,
  currentStage: WorkflowStage
): StageAgentInput {
  const currentStageRun = [...(session.stage_runs ?? [])]
    .reverse()
    .find((stageRun) => stageRun.stage_id === currentStage.id && (stageRun.status === "running" || stageRun.status === "waiting_approval"));

  const priorFailed = [...(session.stage_runs ?? [])]
    .reverse()
    .find((stageRun) => stageRun.stage_id === currentStage.id && stageRun.status === "failed");

  const retryContext = currentStageRun?.retry_reason
    ? {
        previous_attempt: currentStageRun.attempt,
        output_summary: currentStageRun.retry_reason
      }
    : priorFailed
      ? {
          previous_attempt: priorFailed.attempt,
          output_summary: priorFailed.output_summary ?? ""
        }
      : undefined;

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
    gates: currentStage.gates ?? [],
    retry_context: retryContext,
    recent_messages: session.messages.slice(-20)
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
    output_summary: `Mock 阶段“${input.current_stage.name}”已完成。设置 ANTHROPIC_API_KEY 后可使用 Claude Agent SDK。`,
    required_outputs: Object.fromEntries(input.required_outputs.map((name) => [name, `${name} 的 Mock 输出`]))
  };
}

function parseJsonObject(rawContent: string): Record<string, unknown> | null {
  const direct = parseCandidate(rawContent);
  if (direct) {
    return direct;
  }

  const candidates = extractJsonObjectCandidates(rawContent)
    .map(parseCandidate)
    .filter((candidate): candidate is Record<string, unknown> => candidate !== null);
  const stageResult = findLastStageResultCandidate(candidates);
  return stageResult ?? candidates.at(-1) ?? null;
}

function findLastStageResultCandidate(candidates: Record<string, unknown>[]): Record<string, unknown> | undefined {
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    if (typeof candidate.status === "string" || typeof candidate.output_summary === "string") {
      return candidate;
    }
  }
  return undefined;
}

function parseCandidate(candidate: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(candidate.trim());
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractJsonObjectCandidates(content: string): string[] {
  const candidates: string[] = [];
  for (let start = 0; start < content.length; start += 1) {
    if (content[start] !== "{") {
      continue;
    }
    const end = findJsonObjectEnd(content, start);
    if (end !== -1) {
      candidates.push(content.slice(start, end + 1));
      start = end;
    }
  }
  return candidates;
}

function findJsonObjectEnd(content: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
      if (depth < 0) {
        return -1;
      }
    }
  }
  return -1;
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

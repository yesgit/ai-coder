import type {
  AgentSession,
  ParseDiagnostics,
  StageAgentInput,
  StageAgentResult,
  WorkflowStage,
  WorkflowTemplate
} from "../../shared/types.js";

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
    recent_messages: session.messages.slice(-20),
    human_qa_history: (session.pending_human_questions ?? []).filter((q) => q.status === "answered")
  };
}

export function parseStageAgentResult(rawContent: string): StageAgentResult {
  const ranges = extractJsonObjectRanges(rawContent);
  const candidates = ranges
    .map((range) => parseCandidate(rawContent.slice(range.start, range.end + 1)))
    .filter((candidate): candidate is Record<string, unknown> => candidate !== null);

  // direct parse 既适用于 "整段就是单个 JSON 对象" 也适用于 "整段是数组 / 包了一层 wrapper"
  const direct = parseCandidate(rawContent);
  const parsed =
    findLastStageResultCandidate(candidates) ?? candidates.at(-1) ?? direct ?? null;

  const diagnostics = analyzeRawForJsonBreakage(rawContent, ranges, candidates.length, parsed);

  if (!parsed) {
    return {
      status: "completed",
      output_summary: summarize(rawContent),
      parse_diagnostics: diagnostics
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
    error,
    parse_diagnostics: diagnostics
  };
}

export function createMockStageAgentResult(input: StageAgentInput): StageAgentResult {
  return {
    status: "completed",
    output_summary: `Mock 阶段“${input.current_stage.name}”已完成。设置 ANTHROPIC_API_KEY 后可使用 Claude Agent SDK。`,
    required_outputs: Object.fromEntries(input.required_outputs.map((name) => [name, `${name} 的 Mock 输出`]))
  };
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

/** 与既有 extractJsonObjectCandidates 同样的扫描，但返回 [start,end] 范围而非字符串。 */
interface JsonRange {
  start: number;
  end: number;
}

function extractJsonObjectRanges(content: string): JsonRange[] {
  const ranges: JsonRange[] = [];
  for (let start = 0; start < content.length; start += 1) {
    if (content[start] !== "{") {
      continue;
    }
    const end = findJsonObjectEnd(content, start);
    if (end !== -1) {
      ranges.push({ start, end });
      start = end;
    }
  }
  return ranges;
}

/**
 * 评估 raw 末尾是否有"未被任何合法 JSON 候选覆盖"的残留 JSON 内容。
 *
 * 失误样本：模型最后回了一个合法的小 JSON，然后又粘了一段非法的尾部 JSON（多余引号、空 key、未闭合）。
 * 既有逻辑 silently 取了第一段、丢了尾部。本函数让 stageOutputAssertions 能感知到。
 *
 * 判定逻辑：
 *   1) 全文 `{` 与 `}` 配平（字符串外）算 `bracket_balance`。非零（>0）= 有未闭合
 *   2) 最后一个 `{` 的位置在所有合法候选 range 的 end 之后 = 末尾有未闭合 JSON 残骸
 *   3) `parsed`（最终落地的对象）选中之后，文本里仍有更靠后的 `{` = 有被丢弃的尾部
 *
 * 任一条件命中 → `had_unparsed_tail: true`。
 */
export function analyzeRawForJsonBreakage(
  raw: string,
  ranges: JsonRange[],
  candidateCount: number,
  parsed: Record<string, unknown> | null
): ParseDiagnostics {
  const balance = computeBracketBalance(raw);
  const lastOpen = findLastOpenBraceIndex(raw);

  // 把合法 range 摊平为一个"已被消费"的掩码，长度 = raw.length
  let consumedLength = 0;
  for (const range of ranges) {
    consumedLength += range.end - range.start + 1;
  }
  const tailLength = Math.max(0, raw.length - consumedLength);

  // 末尾未闭合 JSON：raw 最后一个 `{` 之后，没有任何合法 range 覆盖到 raw.length-1
  const lastRangeEnd = ranges.length > 0 ? ranges[ranges.length - 1].end : -1;
  const hasOpenBraceAfterLastRange = lastOpen > lastRangeEnd;

  // 如果 parsed 选中了某个候选，但它后面还有更靠后的 `{` 起头，说明尾部有被丢弃的内容
  const hasLaterBraceThanParsed = (() => {
    if (!parsed || ranges.length === 0) return false;
    // 简化：只要存在 lastOpen 且它位于最后一个合法 range 的 end 之后，就视为有
    return hasOpenBraceAfterLastRange;
  })();

  const had_unparsed_tail = balance !== 0 || hasOpenBraceAfterLastRange || hasLaterBraceThanParsed;

  return {
    had_unparsed_tail,
    tail_length: tailLength,
    last_open_brace_index: lastOpen,
    bracket_balance: balance,
    candidate_count: candidateCount
  };
}

/** 字符串外的 `{` 减 `}` 配平；与 findJsonObjectEnd 共用同一种字符串/转义识别。 */
function computeBracketBalance(content: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
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
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
  }
  return depth;
}

/** 文本里最后一个字符串外 `{` 的索引；没有则 -1。 */
function findLastOpenBraceIndex(content: string): number {
  let inString = false;
  let escaped = false;
  let last = -1;
  for (let index = 0; index < content.length; index += 1) {
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
    if (char === "{") last = index;
  }
  return last;
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

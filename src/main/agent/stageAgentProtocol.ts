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
  const isolateInitialTaskContext = shouldIsolateInitialTaskContext(currentStage);
  const isolateBusinessTask = isProjectProfileStage(currentStage.id);
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

  // 返工（needs_rework）重做时，把"谁退我、为什么、我上次产出什么"注入给被退回的目标 stage。
  // 与 retryContext 互补：retry 是 stage 因自身输出不合格被原地退回；rework 是被下游 stage 跨阶段退回。
  // 闭环入境验收（workflowPrompt.ts）：下游发现上游产出不合格→回 needs_rework 指向上游→applyRework
  // 把目标 stage 旧 run 置 superseded（保留 output_summary）→重做时由这里把上下文回灌给它，避免盲重做。
  const reworkRequest = [...(session.rework_requests ?? [])]
    .reverse()
    .find((req) => req.target_stage_id === currentStage.id && req.status === "approved");
  const previousSuperseded = [...(session.stage_runs ?? [])]
    .reverse()
    .find((stageRun) => stageRun.stage_id === currentStage.id && stageRun.status === "superseded");
  const isActiveReworkRun = currentStageRun?.input_summary.startsWith("Rework requested from ") ?? false;
  const reworkContext = !retryContext && isActiveReworkRun && reworkRequest
    ? {
        from_stage: reworkRequest.from_stage_id,
        reason: reworkRequest.reason,
        previous_output_summary: previousSuperseded?.output_summary
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
        output_schema: stage.output_schema,
        required_checks: stage.required_checks ?? [],
        gates: stage.gates ?? []
      }))
    },
    previous_stage_summaries: (session.stage_runs ?? [])
      .filter((stageRun) => stageRun.status === "completed")
      .filter((stageRun) => !(isolateInitialTaskContext && isProjectProfileStage(stageRun.stage_id)))
      .map((stageRun) => ({
        stage_id: stageRun.stage_id,
        attempt: stageRun.attempt,
        status: stageRun.status,
        output_summary: stageRun.output_summary,
        required_outputs: stageRun.required_outputs
      })),
    current_stage: currentStage,
    task_prompt: isolateBusinessTask
      ? "[业务任务正文与附件已由宿主隔离；本阶段只维护长期项目画像。]"
      : session.task_prompt,
    project_path: session.project_path,
    allowed_tools: currentStage.allowed_tools ?? [],
    required_outputs: currentStage.required_outputs ?? [],
    gates: currentStage.gates ?? [],
    retry_context: retryContext,
    rework_context: reworkContext,
    recent_messages: isolateBusinessTask
      ? []
      : selectContextMessages(session.messages, session.initial_user_message, {
          initialOnly: isolateInitialTaskContext
        }),
    human_qa_history: isolateBusinessTask
      ? []
      : (session.pending_human_questions ?? []).filter((q) => q.status === "answered")
  };
}

function selectContextMessages(
  messages: AgentSession["messages"],
  initialUserMessage?: AgentSession["messages"][number],
  options: { initialOnly?: boolean } = {}
): AgentSession["messages"] {
  const sanitizedMessages = messages.map(sanitizeAgentMessage);
  const sanitizedInitial = initialUserMessage ? sanitizeAgentMessage(initialUserMessage) : undefined;
  const seedMessage = sanitizedInitial ?? sanitizedMessages.find((message) => message.role === "user");
  if (options.initialOnly) {
    return seedMessage ? [seedMessage] : [];
  }
  const recentMessages = sanitizedMessages.slice(-20);
  if (!seedMessage) {
    return recentMessages;
  }
  const hasSeedMessage = recentMessages.some((message) => sameMessage(message, seedMessage));
  return hasSeedMessage ? recentMessages : [seedMessage, ...recentMessages];
}

function shouldIsolateInitialTaskContext(stage: WorkflowStage): boolean {
  return stage.id === "understand";
}

function isProjectProfileStage(stageId: string): boolean {
  return stageId === "maintain_project_profile" || stageId === "assess_project_profile" || stageId === "scan_project" || stageId === "update_project_profile";
}

function sameMessage(left: AgentSession["messages"][number], right: AgentSession["messages"][number]): boolean {
  return left.role === right.role && left.created_at === right.created_at && left.content === right.content;
}

function sanitizeAgentMessage(message: AgentSession["messages"][number]): AgentSession["messages"][number] {
  return {
    ...message,
    content: normalizeMessageContent((message as { content?: unknown }).content),
    attachments: message.attachments?.filter((attachment) => attachment.type === "file_ref")
  };
}

function normalizeMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(describeContentBlock).filter(Boolean).join("\n");
  }
  if (content === null || content === undefined) return "";
  return String(content);
}

function describeContentBlock(block: unknown): string {
  if (!isRecord(block)) return String(block);
  const type = typeof block.type === "string" ? block.type : "block";
  if (typeof block.text === "string") return block.text;
  if (typeof block.content === "string") return block.content;
  if (type === "document") return "[document block omitted; use file_ref/PNG pages instead]";
  if (type === "tool_result") return "[tool_result]";
  return `[${type}]`;
}

export function parseStageAgentResult(rawContent: string): StageAgentResult {
  const ranges = extractJsonObjectRanges(rawContent);
  const candidates = ranges
    .map((range) => parseCandidate(rawContent.slice(range.start, range.end + 1)))
    .filter((candidate): candidate is Record<string, unknown> => candidate !== null);

  // direct parse 既适用于 "整段就是单个 JSON 对象" 也适用于 "整段是数组 / 包了一层 wrapper"
  const direct = parseCandidate(rawContent);
  const repairedRawContent = direct ? null : repairCommonStageJsonTypos(rawContent);
  const repairedDirect = repairedRawContent ? parseCandidate(repairedRawContent) : null;
  const relaxed = !direct && !repairedDirect && candidates.length === 0 ? parseRelaxedStageResult(rawContent) : null;
  const embedded = findLastStageResultCandidate(candidates) ?? candidates.at(-1) ?? null;
  const parsed = embedded ?? direct ?? repairedDirect ?? relaxed ?? null;
  const parseStrategy = determineParseStrategy(rawContent, parsed, direct, repairedDirect, embedded, relaxed);

  const diagnosticsSource = parsed === repairedDirect && repairedRawContent ? repairedRawContent : rawContent;
  const diagnosticsRanges = diagnosticsSource === rawContent ? ranges : extractJsonObjectRanges(diagnosticsSource);
  const diagnostics: ParseDiagnostics = {
    ...analyzeRawForJsonBreakage(
      diagnosticsSource,
      diagnosticsRanges,
      diagnosticsSource === rawContent ? candidates.length : 1,
      parsed
    ),
    parse_strategy: parseStrategy,
    protocol_violation: parseStrategy !== "single_json_object"
  };

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

function determineParseStrategy(
  rawContent: string,
  parsed: Record<string, unknown> | null,
  direct: Record<string, unknown> | null,
  repairedDirect: Record<string, unknown> | null,
  embedded: Record<string, unknown> | null,
  relaxed: Record<string, unknown> | null
): ParseDiagnostics["parse_strategy"] {
  if (!parsed) return "none";
  if (direct && parsed === direct && isWholeSingleJsonObject(rawContent)) return "single_json_object";
  if (repairedDirect && parsed === repairedDirect) return "repaired_single_json_object";
  if (embedded && parsed === embedded) return isWholeSingleJsonObject(rawContent) ? "single_json_object" : "embedded_json";
  if (relaxed && parsed === relaxed) return "relaxed_fields";
  return "embedded_json";
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

function repairCommonStageJsonTypos(rawContent: string): string | null {
  let repaired = rawContent;
  // 双重花括号: "required_outputs": { { → "required_outputs": {
  repaired = repaired.replace(/"required_outputs"\s*:\s*\{\s*\{/g, "\"required_outputs\": {");
  // 多余逗号后紧跟 } 或 ]: ,} → }  ,] → ]
  repaired = repaired.replace(/,(\s*[}\]])/g, "$1");
  // 尾部多余引号 + 花括号: }" → } (常见于 JSON 后面多写了引号)
  // 仅在尾部闭合花括号后出现多余引号时修复
  if (/\}"\s*$/.test(repaired) && !/"\s*\}\s*"\s*$/.test(repaired)) {
    repaired = repaired.replace(/\}"\s*$/, "}");
  }
  return repaired === rawContent ? null : repaired;
}

function parseRelaxedStageResult(rawContent: string): Record<string, unknown> | null {
  if (!/\bstatus\s*:|\boutput_summary\s*:|\brequired_outputs\s*:/i.test(rawContent)) {
    return null;
  }

  const statusMatch = rawContent.match(/\bstatus\s*:\s*(completed|failed|needs_rework)\b/i);
  const outputSummary = extractRelaxedField(rawContent, "output_summary");
  const requiredSection = rawContent.split(/\brequired_outputs\s*:/i).at(-1) ?? "";
  const requiredOutputs: Record<string, unknown> = {};
  for (const name of [
    // understand 阶段
    "user_goal_restated",
    "definition_of_done",
    "assumptions",
    // scan_project 阶段
    "profile_mode",
    "existing_profile_assets",
    "inspected_files",
    "project_facts",
    "profile_update_needed",
    // update_project_profile 阶段
    "profile_changes",
    "profile_paths",
    "retained_rules",
    "validation",
    "residual_profile_risks",
    // decompose 阶段
    "task_items",
    // implement 阶段
    "task_results",
    "summary",
    // verify 阶段
    "verification_results",
    // 旧版字段（保留向后兼容）
    "similar_callsites",
    "evidence_findings",
    "callsite_assumptions",
    "boundary_cases",
    "unknowns",
    "lateral_constraints",
    "selected_plan",
    "success_criteria",
    "test_plan",
    "risk_register",
    "changed_files",
    "delta_checks",
    "validation_run",
    "review_findings",
    "rework_decision",
    "residual_risks"
  ]) {
    const value = extractRelaxedField(requiredSection, name);
    if (value) {
      requiredOutputs[name] = value;
    }
  }

  if (!statusMatch && !outputSummary && Object.keys(requiredOutputs).length === 0) {
    return null;
  }

  return {
    status: statusMatch?.[1]?.toLowerCase() ?? "completed",
    output_summary: outputSummary ?? summarize(rawContent),
    required_outputs: Object.keys(requiredOutputs).length > 0 ? requiredOutputs : undefined
  };
}

function extractRelaxedField(content: string, field: string): string | undefined {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escaped}\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*[a-zA-Z_][\\w]*\\s*:|\\n\\d{2}:\\d{2}:\\d{2}\\b|$)`, "i");
  const match = content.match(pattern);
  const value = match?.[1]?.trim().replace(/^["']|["']$/g, "").trim();
  return value || undefined;
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

function isWholeSingleJsonObject(content: string): boolean {
  const trimmedStart = content.search(/\S/);
  if (trimmedStart === -1) return false;
  const trimmedEnd = (() => {
    for (let index = content.length - 1; index >= 0; index -= 1) {
      if (/\S/.test(content[index] ?? "")) return index;
    }
    return -1;
  })();
  if (content[trimmedStart] !== "{" || content[trimmedEnd] !== "}") return false;
  return findJsonObjectEnd(content, trimmedStart) === trimmedEnd;
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

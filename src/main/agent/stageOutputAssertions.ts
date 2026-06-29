import type {
  StageAgentResult,
  StageOutputAssertion,
  WorkflowStage
} from "../../shared/types.js";

/**
 * 阶段产物落地侧的断言评估器。
 *
 * 与 `stageHookEnforcer.evaluateHook`（pre-tool-use）解耦：
 * - 那边管"动手前准备没准备好"；
 * - 这边管"动手完写出来的东西自不自洽、有没有沉默地放过自己列出的问题"。
 *
 * 仅当 stage.hooks?.post_output_assertions 显式声明时才评估，未声明=零额外约束（向后兼容）。
 *
 * 实现纯函数 / 只读 / 无 IO。失败时返回 {assertion, message}，由 workflowEngine 统一走
 * retry → block 的现有路径（与 missing required_outputs 同模式）。
 */
export type AssertionFailure = {
  assertion: StageOutputAssertion;
  message: string;
};

export function evaluateOutputAssertions(
  stage: WorkflowStage,
  result: StageAgentResult
): AssertionFailure[] {
  const declared = stage.hooks?.post_output_assertions;
  if (!declared || declared.length === 0) return [];

  const failures: AssertionFailure[] = [];
  for (const name of declared) {
    const fn = ASSERTION_IMPLS[name];
    if (!fn) continue; // schema 应该挡住未知名，这里防御性跳过而非抛
    const message = fn(result);
    if (message) failures.push({ assertion: name, message });
  }
  return failures;
}

type AssertionImpl = (result: StageAgentResult) => string | null;

/**
 * "动手完发现自己列出问题却写 pass" —— 本次案例的直接病灶。
 *
 * 关键词分两档：
 *  - 强信号词（自带问题语义，命中即视作"提及阻塞"）：blocker / blocking / critical / 阻塞 / 严重缺陷 / 严重不一致 / 安全问题 / 安全风险 / 安全漏洞
 *  - 中信号词（需与"问题/风险/缺口/未覆盖/不一致"等修饰共现）：高优先级 + (问题/风险/缺口) 之类
 *
 * 故意避开单独的"安全"/"风险"/"高"——它们在 residual_risks 的中性描述里太常见，单字命中假阳性会爆。
 *
 * 但仅"提及阻塞"还不够构成"自相矛盾"——必须排除以下良性表达：
 *  - 否定形式："无安全问题"/"未发现 blocker"/"不存在严重不一致"
 *  - 词边界合成词："non-blocking"（这里 blocking 前接连字符，不算独立词）
 *  - 已固化的中性术语："critical path"/"critical section"
 *
 * 命中条件：句子里出现真正的阻塞表达（穿过上述三层过滤）∩ rework_decision === "pass" → 视为自相矛盾。
 */
const reviewSelfConsistency: AssertionImpl = (result) => {
  // rework_decision 可能落在 required_outputs 里，也可能由 status 字段间接表达——
  // 这里只看声明意图：作者用 "pass" 这个字眼，就视作他在主张通过。
  const decision = pickReworkDecision(result);
  if (decision !== "pass") return null;

  const haystack = collectText(result);
  if (!hasRealBlocker(haystack) && !findHighPriorityIssue(haystack)) {
    return null;
  }

  return [
    "review 自洽性失败：output 中出现阻塞类问题信号（如 blocker/critical/严重不一致/安全问题/高优先级问题），",
    "但 rework_decision 仍为 'pass'。如果你确实认为这些问题需要修复，请把 status 改为 needs_rework，",
    "rework_decision 改为 needs_rework，并填写 rework_target_stage_id（通常回到 implement 或更早）；",
    "如果这些条目是已修复/不适用，请在 review_findings 里写明对应 diff 位置或不适用理由，",
    "去除阻塞词的描述方式（例如把'存在严重不一致'改为'已通过 X 处理'）。"
  ].join("");
};

/**
 * 把文本切成"近似句子"。中英标点、换行均算分隔。
 * 注意：英文 `.` 必须后接空白才算分隔——避免把 `3.5-4.0` 切碎。
 */
const SENTENCE_SPLIT_PATTERN = /[。；;！？!?\n]|\.\s+/;
function splitSentences(text: string): string[] {
  return text.split(SENTENCE_SPLIT_PATTERN).map((s) => s.trim()).filter(Boolean);
}

/**
 * 强阻塞词：必须是独立词（前不接连字符或词字符，避免 non-blocking 假阳），
 *           且后面不紧跟良性术语（critical path 等）。
 *
 * 中文阻塞词不会出现在术语合成里，无需额外保护——但仍要走否定前缀过滤。
 */
const STRONG_BLOCKER_PATTERN = /(?<![\-\w])(blocker|blocking|critical|阻塞|严重缺陷|严重不一致|严重错误|安全问题|安全风险|安全漏洞|未授权访问|未鉴权访问|安全隐患)/gi;
const BENIGN_FOLLOWUP = /^[\s-]*(path|section|mass|hit|chain|render|update|region)/i;
const NEGATION_BEFORE = /(没|没有|无|未|不|乏|绝无|未发现|不存在|不属于|not\s|no\s|never\s|none\s)\s*[一-龥\w]{0,3}$/i;

function hasRealBlocker(text: string): boolean {
  for (const sentence of splitSentences(text)) {
    if (sentenceContainsBlocker(sentence)) return true;
  }
  return false;
}

function sentenceContainsBlocker(sentence: string): boolean {
  // matchAll 不消耗游标，逐个匹配检验上下文
  for (const match of sentence.matchAll(STRONG_BLOCKER_PATTERN)) {
    const idx = match.index ?? 0;
    const after = sentence.slice(idx + match[0].length);
    if (BENIGN_FOLLOWUP.test(after)) continue;
    const before = sentence.slice(Math.max(0, idx - 12), idx);
    if (NEGATION_BEFORE.test(before)) continue;
    return true;
  }
  return false;
}

/**
 * 中信号：高/高优先级 与 问题类名词共现，且距离够近（同句内）。
 * 单独的"高优先级"（如 "高优先级建议复用"）不该触发，必须搭配负面词。
 * 同样走否定过滤：否定词在触发词前 12 字内 → 视作良性陈述。
 */
function findHighPriorityIssue(text: string): boolean {
  for (const sentence of splitSentences(text)) {
    const priorityMatch = sentence.match(/(高优先级|high\s*priority|🔴|🟥)/i);
    if (!priorityMatch) continue;
    const issueMatch = sentence.match(/(问题|风险|缺口|缺失|未覆盖|不一致|未校验|漏洞|bug|issue|gap|missing|defect|finding)/i);
    if (!issueMatch) continue;
    // 否定语境过滤：例如 "没有高优先级问题"、"未发现高优先级风险"
    const beforePriority = sentence.slice(Math.max(0, (priorityMatch.index ?? 0) - 12), priorityMatch.index ?? 0);
    if (NEGATION_BEFORE.test(beforePriority)) continue;
    return true;
  }
  return false;
}

/**
 * "status=needs_rework 必须带 target" —— 引擎层早已要求 (workflowEngine 走 blockCurrentStage)，
 * 但那是走 block 而不是 retry——对人类预期更友好的是 retry 一次让模型补 target。
 * 这里给 retry 的机会；如果 stage 没声明该断言，引擎仍走原 block 路径。
 */
const needsReworkTargetRequired: AssertionImpl = (result) => {
  if (result.status !== "needs_rework") return null;
  if (result.rework_target_stage_id && result.rework_target_stage_id.trim()) return null;
  return [
    "返工目标缺失：status 为 needs_rework 但 rework_target_stage_id 未填。",
    "请在最外层 JSON 写明 rework_target_stage_id（已完成的某一个 stage id），",
    "并用一两句中文写明 rework_reason。"
  ].join("");
};

/**
 * 强制 investigate 类阶段老实暴露未知。
 *
 * 触发：required_outputs.unknowns 必须存在且非"空内容"。空的判定故意从宽——
 * 任何不到 4 个字符的纯否定回答（"无"/"none"/"n/a"/"未发现"）都算未老实回答。
 */
const unknownsPresent: AssertionImpl = (result) => {
  const unknowns = result.required_outputs?.unknowns;
  if (unknowns === undefined || unknowns === null) {
    return "investigate 必须显式列出 unknowns（已搜过没找到的、未搜的、找到但未读的）。沉默不算回答。";
  }
  const flat = flattenToText(unknowns).trim();
  if (flat.length === 0) {
    return "unknowns 为空。请如实写明本阶段未搜/未找到/未读的条目；如果确认全部清楚，至少写一句话说明依据。";
  }
  if (TRIVIAL_NEGATIVE.has(flat.toLowerCase())) {
    return "unknowns 只写了'无/none/n/a'。资深开发者在陌生代码区域几乎不会一无所惑——请展开列出至少一项你未完全核实的事实，或写明你是基于什么证据排除了所有未知。";
  }
  return null;
};

const TRIVIAL_NEGATIVE = new Set(["无", "无未知", "无明显未知", "none", "n/a", "na", "nothing", "没有", "未发现"]);

/**
 * "≥3 同类条目时必须出矩阵" —— 横向一致性靠 designer 事前画表，而不是 reviewer 事后捡漏。
 *
 * 触发：output_summary + task_prompt 里出现枚举性提示（数字范围、批量、多个、列表式逗号 ≥3 项）。
 * 满足：required_outputs.item_matrix 必须是含 `|` 的 markdown 表（至少 2 行，含表头与分隔线）。
 *
 * 我们故意不解析矩阵语义——只要求"画了表"。深层一致性核查靠 self_review。
 */
const itemMatrixWhenMulti: AssertionImpl = (result) => {
  const surface = `${result.output_summary}\n${flattenToText(result.required_outputs ?? {})}`;
  if (!isMultiItemTask(surface)) return null;
  const matrix = result.required_outputs?.item_matrix;
  const flat = matrix === undefined ? "" : flattenToText(matrix);
  if (isMarkdownTable(flat)) return null;
  return [
    "本次涉及 ≥3 同类条目，但 item_matrix 缺失或不是合法的 markdown 表。",
    "请在 required_outputs.item_matrix 输出一张表：每一行一个条目，列至少包含'条目 / 维度1 / 维度2 / 备注'；",
    "本次不处理的条目也列入并在备注写'本次不处理 + 原因'。同列出现混合值时，必须在 consistency_audit 给对齐策略。"
  ].join("");
};

function isMultiItemTask(text: string): boolean {
  // 数字范围（33-42 / 33—42 / 33 至 42 / 33 to 42）。
  // 用 lookbehind/lookahead 排除浮点：前面是 `数字.` 或后面是 `.数字` 都不算范围
  // ——避免把 `3.5-4.0` 切出子串 `5-4`、`2.0-3.5` 切出 `0-3` 这种典型假阳。
  if (/(?<!\d\.)\b\d+\s*[-–—~]\s*\d+\b(?!\.\d)/.test(text)) return true;
  if (/\d+\s*(?:至|到|–|—|to)\s*\d+/i.test(text)) return true;
  // 枚举关键词
  if (/(批量|多个|多处|多页|每个|逐个|所有|all of the|each of)/i.test(text)) return true;
  // 逗号分隔 ≥3 项（中英文逗号、顿号）
  for (const line of text.split(/\n+/)) {
    const items = line.split(/[，,、]/).map((s) => s.trim()).filter(Boolean);
    if (items.length >= 3 && items.every((s) => s.length <= 30)) return true;
  }
  return false;
}

function isMarkdownTable(text: string): boolean {
  if (!text || !text.includes("|")) return false;
  const lines = text.split(/\n+/).map((s) => s.trim()).filter((s) => s.startsWith("|"));
  if (lines.length < 2) return false;
  // 至少一行是分隔线 |---|---|
  return lines.some((line) => /^\|\s*:?-{1,}/.test(line));
}

const ASSERTION_IMPLS: Record<StageOutputAssertion, AssertionImpl> = {
  review_self_consistency: reviewSelfConsistency,
  needs_rework_target_required: needsReworkTargetRequired,
  unknowns_present: unknownsPresent,
  item_matrix_when_multi: itemMatrixWhenMulti
};

function pickReworkDecision(result: StageAgentResult): string | null {
  const value = result.required_outputs?.rework_decision;
  if (typeof value !== "string") return null;
  return value.trim().toLowerCase();
}

function collectText(result: StageAgentResult): string {
  const parts = [result.output_summary ?? ""];
  if (result.required_outputs) parts.push(flattenValues(result.required_outputs));
  return parts.join("\n");
}

/**
 * required_outputs 形状不定——可能是字符串、数组、嵌套对象。
 * 全部摊平到纯文本供关键词扫描；不做 JSON 编码以免引入额外引号字符干扰正则。
 *
 * 默认行为：递归打开，对象用 `key: value` 拼接（便于读者快速看到字段对应）。
 * 用于关键词扫描时请使用 `flattenValues`——它只取 value、丢弃 key，
 * 避免字段名（review_findings / unknowns / safety_audit 等）混入语义判断。
 */
function flattenToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(flattenToText).join("\n");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, v]) => `${key}: ${flattenToText(v)}`)
      .join("\n");
  }
  return "";
}

/**
 * 与 `flattenToText` 不同：递归只取 value，丢弃对象键名。
 * review_self_consistency 这类语义扫描专用——不能让 `review_findings` / `safety_audit`
 * 这样的字段名本身被当成 issue/safety 关键词命中。
 */
function flattenValues(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(flattenValues).join("\n");
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).map(flattenValues).join("\n");
  }
  return "";
}

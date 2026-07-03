import type {
  PostOutputBehaviorCheck,
  StageAgentResult,
  StageOutputAssertion,
  ToolCallRecord,
  WorkflowStage
} from "../../shared/types.js";
import { countReadHits, hasShellRun } from "./stageHookEnforcer.js";

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

/**
 * 已完成的前序阶段 required_outputs 的只读视图：键为 stage_id，值为该阶段最新 completed run 的
 * required_outputs 原对象。允许跨阶段断言（如 plan_steps_grounded 在 design 阶段读 investigate.findings）
 * 在引擎层直接核对取证血脉，而不是靠 prompt 让模型自己抄一遍。
 *
 * 对当前阶段是 implement/self_review 之类需要跨阶段验证的断言尤其关键。
 */
export type PriorStageOutputs = Record<string, Record<string, unknown> | undefined>;

export function evaluateOutputAssertions(
  stage: WorkflowStage,
  result: StageAgentResult,
  priorOutputs: PriorStageOutputs = {}
): AssertionFailure[] {
  const declared = stage.hooks?.post_output_assertions;
  if (!declared || declared.length === 0) return [];

  const failures: AssertionFailure[] = [];
  for (const name of declared) {
    const fn = ASSERTION_IMPLS[name];
    if (!fn) continue; // schema 应该挡住未知名，这里防御性跳过而非抛
    const message = fn(result, priorOutputs);
    if (message) failures.push({ assertion: name, message });
  }
  return failures;
}

type AssertionImpl = (result: StageAgentResult, prior: PriorStageOutputs) => string | null;

/**
 * 行为校验失败。与 AssertionFailure 平行——这里 check 是行为检查标签（commands_run/files_read 组合），
 * 不进 StageOutputAssertion 联合（那是文本断言名）。引擎层把两类失败合并走同一条 retry → block 路径。
 */
export type BehaviorCheckFailure = { check: string; message: string };

/**
 * 评估 stage.hooks.post_output_checks——行为即证据层（L1）。
 *
 * 与 evaluateOutputAssertions（扫产出文本，L3，可被模板糊弄）解耦：
 * - 那边管"写出来的东西形态对不对"；
 * - 这边管"该做的动作真做了没"——查 tool_calls，模型没法假装跑过一个没跑过的命令。
 *
 * 传入的 toolCalls 由调用方按 stage_id + created_at ≥ 本次 stageRun.started_at 过滤——
 * 排除他阶段调用与同阶段前序 rework run 的旧调用（rework 第二轮须重新验证）；
 * retry 复用同一 stageRun 不改 started_at，故同 run 多 attempt 调用都算。
 *
 * 调用方仅在 result.status === "completed" 时调用本函数——needs_rework/failed 不主张完成，不适用行为门控。
 *
 * 实现纯函数 / 只读 / 无 IO。复用 stageHookEnforcer 的 hasShellRun/countReadHits，与 pre_tool_use 同一套行为判定。
 */
export function evaluateBehaviorChecks(
  stage: WorkflowStage,
  toolCalls: ToolCallRecord[],
  projectPath: string
): BehaviorCheckFailure[] {
  const checks = stage.hooks?.post_output_checks;
  if (!checks || checks.length === 0) return [];
  const failures: BehaviorCheckFailure[] = [];
  for (const check of checks) {
    const missing = checkBehaviorRequire(check, toolCalls, projectPath);
    if (missing) {
      failures.push({ check: behaviorCheckLabel(check), message: `${check.on_fail}（缺：${missing}）` });
    }
  }
  return failures;
}

function behaviorCheckLabel(check: PostOutputBehaviorCheck): string {
  const parts: string[] = [];
  if (check.require.commands_run?.length) {
    parts.push(`commands_run[${check.require.commands_run.join(",")}]`);
  }
  if (check.require.files_read?.length) {
    parts.push(`files_read[${check.require.files_read.map((f) => f.target).join(",")}]`);
  }
  return parts.join("+") || "post_output_check";
}

function checkBehaviorRequire(
  check: PostOutputBehaviorCheck,
  toolCalls: ToolCallRecord[],
  projectPath: string
): string | null {
  const { commands_run, files_read } = check.require;
  if (commands_run && commands_run.length > 0) {
    const missing = commands_run.filter((needle) => !hasShellRun(toolCalls, needle));
    if (missing.length > 0) return `本阶段未执行：${missing.join(" / ")}`;
  }
  if (files_read && files_read.length > 0) {
    const under = files_read.filter((f) => countReadHits(toolCalls, f.target, projectPath) < f.min);
    if (under.length > 0) {
      return `目标文件读取不足：${under.map((f) => `${f.target}(需${f.min})`).join(" / ")}`;
    }
  }
  return null;
}

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

/**
 * "未取证的 hedged 结论" —— 扫 output_summary + required_outputs 摊平文本，
 * 句子里"可能 / 或许 / 似乎 / 疑似 / maybe / might / likely / probably" 与
 * "问题 / 风险 / 缺口 / 隐患 / 不一致 / 漏洞 / bug / issue / gap / defect / regression"
 * 共现 ∩ 句中无 path:line 证据引用 → 视为未取证下了结论 → fail。
 *
 * 设计动机：v1.0 这条断言依赖 required_outputs.findings 是数组——但实证表明 LLM 在硬
 * schema 约束下经常产不出结构化对象数组。v1.1 改成纯文本扫描，不挑场景，不依赖具体字段。
 *
 * 避免误伤的三层过滤：
 *  1) 否定语境（"未发现可能 X"/"无可能 Y 风险"）→ 放行
 *  2) 句子里出现 path:line 证据引用（如 "Foo.tsx:123" / "src/x.js:45" ）→ 视为已取证、放行
 *  3) 单独"可能"或单独"风险"不触发——必须共现
 */
const HEDGE_PATTERN = /可能|或许|似乎|疑似|大概|maybe|might|likely|probably/i;
const NEGATIVE_NOUN_PATTERN = /问题|风险|缺口|缺失|隐患|不一致|未覆盖|未校验|漏洞|bug|issue|gap|defect|regression|fail/i;
const NEGATION_FOR_HEDGE = /(没|没有|无|未|不|不会|绝无|未发现|不存在|not\s|no\s|never\s|none\s)\s*[一-龥\w]{0,8}$/i;
const EVIDENCE_REF_PATTERN = /[\w\-./@]+:\d+|commit\s*[0-9a-f]{7,}|git\s+log/i;

const hedgedFindingsDemoted: AssertionImpl = (result) => {
  const text = collectText(result);
  if (!text.trim()) return null;

  const violators: string[] = [];
  for (const sentence of splitSentences(text)) {
    const hedgeMatch = sentence.match(HEDGE_PATTERN);
    if (!hedgeMatch) continue;
    if (!NEGATIVE_NOUN_PATTERN.test(sentence)) continue;
    // 否定语境过滤："未发现可能 X 风险" 不算下结论
    const before = sentence.slice(Math.max(0, (hedgeMatch.index ?? 0) - 20), hedgeMatch.index ?? 0);
    if (NEGATION_FOR_HEDGE.test(before)) continue;
    // 取证语境过滤：句子里挂了 path:line 或 commit hash 引用就视为已取证
    if (EVIDENCE_REF_PATTERN.test(sentence)) continue;
    violators.push(sentence.length > 60 ? `${sentence.slice(0, 57)}...` : sentence);
    if (violators.length >= 3) break; // 提示三条够了，别刷屏
  }
  if (violators.length === 0) return null;
  return [
    "未取证的 hedged 结论：",
    violators.join(" | "),
    "。'可能/或许/似乎/maybe/might/likely + 问题/风险/缺口/...' 这种句式是 unknowns 的领地，",
    "不允许当结论写出来。请二选一：(1) 真去读对应代码取证、改写成肯定/否定结论 + path:line 证据；",
    "(2) 把这条移进 unknowns 字段，明示你还没查清。"
  ].join("");
};

/**
 * raw 输出有未闭合 JSON 残骸 / 尾部丢弃 → 失败。
 *
 * 跨场景通用：触发条件不依赖具体任务字段，看 parseStageAgentResult 写的 parse_diagnostics 即可。
 * 建议挂到每个阶段的 post_output_assertions——结构性断言，零业务语义、零误伤。
 */
const noTrailingUnparsedPayload: AssertionImpl = (result) => {
  const d = result.parse_diagnostics;
  if (!d) return null;
  if (!d.had_unparsed_tail) return null;
  return [
    "JSON 输出有残骸：",
    `bracket_balance=${d.bracket_balance}`,
    `, tail_length=${d.tail_length}`,
    `, candidate_count=${d.candidate_count}`,
    "。这通常是字符串引号未闭合、花括号未闭合、末尾多余分隔符等。",
    "请把最外层 stage result 写成单一合法 JSON 对象——本地 JSON.parse 验证一遍再回传。",
    "不要在 JSON 外再粘一段未完成的 JSON 草稿。"
  ].join("");
};

/**
 * v1.2 新增：investigate 阶段 output_summary 必须含 4 个 markdown 标题——用模板引导 LLM 把思维过程写出来。
 */
const investigateStructurePresent: AssertionImpl = (result) => {
  const text = result.output_summary ?? "";
  const requiredHeaders = [
    "## 调查任务清单",
    "## 假设与验证",
    "## 已证实的结论",
    "## 仍未确定的事项"
  ];
  const missing = requiredHeaders.filter(h => !text.includes(h));
  if (missing.length === 0) return null;
  return [
    "output_summary 缺少 investigate 思维模板的 markdown 标题：",
    missing.join(" / "),
    "。请按模板填写：\n",
    "## 调查任务清单\n- 任务 1: ...\n\n",
    "## 假设与验证\n- H1: ... → [证实/证伪/inconclusive]\n\n",
    "## 已证实的结论\n- f1: ...（证据：`file:line`）\n\n",
    "## 仍未确定的事项\n- ..."
  ].join("");
};

/**
 * v1.2 新增：investigate 阶段每个 finding 应标注置信度（high/medium/low）。
 * 极宽松判定——只扫是否出现 high/medium/low 任一词或"置信度"/"confidence"。
 * 不强制每条 finding 都标（避免 JSON 负担和误伤）。深层质量靠 self_review"优先核对 low/medium"闭环。
 */
const CONFIDENCE_MARKER_PATTERN = /\b(high|medium|low)\b|置信度|confidence/i;
const confidenceLevelsPresent: AssertionImpl = (result) => {
  const text = result.output_summary ?? "";
  if (CONFIDENCE_MARKER_PATTERN.test(text)) return null;
  return [
    "investigate 缺少置信度分级：output_summary 里每个 finding 应标注 ",
    "[high/medium/low + 依据类型（代码直读/git log/推断）]。",
    "high=代码直读确认，medium=推断有间接证据，low=纯推断/未读到关键代码。",
    "标 low 不是坏事——是诚实暴露，self_review 会优先核对。"
  ].join("");
};

/**
 * v1.2 新增：investigate 阶段必须含"## 调用方清单"标题——列目标符号的所有调用方 + 每处语义假设。
 * 把原 similar_callsites 的"目标调用方"语义显式化，防逻辑遗漏（改动会打破哪些调用方的假设）。
 * 无明确目标符号的任务（新建文件）可写"本次无目标符号"。
 */
const CALLSITES_HEADER_PATTERN = /^#{1,3}\s*(调用方清单|callsites?)/im;
const callsitesInventoryPresent: AssertionImpl = (result) => {
  const text = result.output_summary ?? "";
  if (CALLSITES_HEADER_PATTERN.test(text)) return null;
  return [
    "investigate 缺少调用方清单：output_summary 必须含 '## 调用方清单' 标题段落，",
    "列目标符号的所有调用方 + 每处对其行为的语义假设（如'调用方假定返回非 null'）。",
    "无明确目标符号的任务（如新建文件）可写'本次无目标符号'。"
  ].join("");
};

/**
 * v1.2 新增：investigate 阶段必须含"## 边界与异常路径"标题——枚举空/零/负/并发/超时/失败/超大输入。
 * 与 unknowns（没查清的）互补：boundary 是已知需要处理的边缘情况。
 */
const BOUNDARY_HEADER_PATTERN = /^#{1,3}\s*(边界与异常路径|边界条件|boundary)/im;
const boundaryEnumerationPresent: AssertionImpl = (result) => {
  const text = result.output_summary ?? "";
  if (BOUNDARY_HEADER_PATTERN.test(text)) return null;
  return [
    "investigate 缺少边界与异常路径枚举：output_summary 必须含 '## 边界与异常路径' 标题段落，",
    "列已知需要处理的边缘情况（空/零/负/并发/超时/失败/超大输入等）。",
    "与 unknowns 互补——unknowns 是没查清的，boundary 是已知需处理的。"
  ].join("");
};

/**
 * v1.2 新增：design 阶段必须含"## 事前风险"标题——动手前预演失败。
 * 区别于事后 adversarial_critique——挑的是"我自己心里都没底的地方"，不是方案定好后的辩护式反驳。
 */
const PREFLIGHT_HEADER_PATTERN = /^#{1,3}\s*(事前风险|preflight\s*risks?)/im;
const preflightRisksPresent: AssertionImpl = (result) => {
  const text = result.output_summary ?? "";
  if (PREFLIGHT_HEADER_PATTERN.test(text)) return null;
  return [
    "design 缺少事前风险预演：output_summary 必须含 '## 事前风险' 标题段落，",
    "列出最易出错的两三处 + 最没把握的反例 + 预案。",
    "这是'事前预演失败'，不是事后挑刺——挑你心里没底的地方。"
  ].join("");
};

/**
 * v1.2 新增：design 阶段必须含"## 候选方案"标题 + 候选数 ≥2。
 * 强制双方案对照，避免"先定再辩护"。不复用 item_matrix_when_multi（触发条件/条目数/维度都不同）。
 */
const ALTERNATIVES_HEADER_PATTERN = /^#{1,3}\s*(候选方案|方案对照|双方案|alternatives?)/im;
const designAlternativesPresent: AssertionImpl = (result) => {
  const text = result.output_summary ?? "";
  if (!ALTERNATIVES_HEADER_PATTERN.test(text)) {
    return [
      "design 缺少候选方案对照：output_summary 必须含 '## 候选方案' 标题段落，",
      "先列 ≥2 候选并排比较（取舍维度：复杂度/风险/可逆性），再写选定理由。"
    ].join("");
  }
  const altCount = countAlternatives(text);
  if (altCount < 2) {
    return [
      "候选方案数量不足：'## 候选方案' 段落里至少要列 2 个候选",
      "（如'方案 A'/'方案 B'或'候选 1'/'候选 2'），并给出选定理由。"
    ].join("");
  }
  return null;
};

function countAlternatives(text: string): number {
  const patterns: RegExp[] = [
    /方案\s*[A-Z]/g,
    /方案\s*[甲乙丙丁]/g,
    /方案\s*[一二三四五六七八九十]/g,
    /候选\s*\d+/g,
    /alternative\s*[A-Z]/gi
  ];
  const alternatives = new Set<string>();
  for (const p of patterns) {
    const matches = text.match(p);
    for (const match of matches ?? []) alternatives.add(match.toLowerCase());
  }
  return alternatives.size;
}

/**
 * v1.2 新增：design 阶段必须含"## 方案评估"标题 + 四维关键词（性能/安全/扩展/可维护）共现。
 * 把 self_review 的事后挑刺前置到 design——对选定方案做纵深审视，而非仅在方案间横向比较。
 */
const QUADRANT_HEADER_PATTERN = /^#{1,3}\s*(方案评估|方案四维|quadrant\s*eval)/im;
const QUADRANT_KEYWORD_PATTERNS = [
  /性能|performance/i,
  /安全|security/i,
  /扩展|extensib/i,
  /可维护|maintainab/i
];
const designQuadrantEvalPresent: AssertionImpl = (result) => {
  const text = result.output_summary ?? "";
  if (!QUADRANT_HEADER_PATTERN.test(text)) {
    return [
      "design 缺少方案评估：output_summary 必须含 '## 方案评估' 标题段落，",
      "对选定方案给性能/安全/扩展/可维护四维简评（每维一两句 + 风险等级 high/med/low）。"
    ].join("");
  }
  if (!QUADRANT_KEYWORD_PATTERNS.every((pattern) => pattern.test(text))) {
    return [
      "方案评估缺少四维关键词：'## 方案评估' 段落里必须同时出现 性能/安全/扩展/可维护 四维关键词，",
      "并对每维给风险等级。"
    ].join("");
  }
  return null;
};

/**
 * v1.2 新增：implement 阶段必须含"## 改动核对"标题——每改过文件一段（推进哪条 success_criteria + 新风险）。
 * 让"边写边审"成为可见产物，回溯写在最终 output_summary，引擎零改动。未改动也要写一段说明原因。
 */
const DELTA_CHECK_HEADER_PATTERN = /^#{1,3}\s*(改动核对|delta\s*check)/im;
const implementDeltaCheckPresent: AssertionImpl = (result) => {
  const text = result.output_summary ?? "";
  if (DELTA_CHECK_HEADER_PATTERN.test(text)) return null;
  return [
    "implement 缺少改动核对：output_summary 必须含 '## 改动核对' 标题段落，",
    "每个改过的文件一段（推进了哪条 success_criteria + 引入了什么新风险）。",
    "未改动也要写一段说明原因——过程留痕，不等 self_review 才发现走偏。"
  ].join("");
};

/**
 * v1.2 新增：implement 弱断言——若 output_summary 含 rm/git reset/git clean/drop table/truncate 等不可逆词，
 * 必须含"回滚"或"rollback"字样。不可逆操作前要想好怎么退。
 */
const IRREVERSIBLE_PATTERN = /\b(rm\b|git\s+reset\b|git\s+clean\b|drop\s+table\b|truncate\s+table\b)/i;
const ROLLBACK_PATTERN = /回滚|rollback/i;
const rollbackPlanWhenIrreversible: AssertionImpl = (result) => {
  const text = result.output_summary ?? "";
  if (!IRREVERSIBLE_PATTERN.test(text)) return null;
  if (ROLLBACK_PATTERN.test(text)) return null;
  return [
    "implement 检测到不可逆操作（rm/git reset/git clean/drop table/truncate）但未提供回滚预案：",
    "请在对应文件的 '## 改动核对' 子段内写明回滚步骤（如何撤销本次不可逆操作）。"
  ].join("");
};

const ASSERTION_IMPLS: Record<StageOutputAssertion, AssertionImpl> = {
  review_self_consistency: reviewSelfConsistency,
  needs_rework_target_required: needsReworkTargetRequired,
  unknowns_present: unknownsPresent,
  item_matrix_when_multi: itemMatrixWhenMulti,
  hedged_findings_demoted: hedgedFindingsDemoted,
  no_trailing_unparsed_payload: noTrailingUnparsedPayload,
  investigate_structure_present: investigateStructurePresent,
  confidence_levels_present: confidenceLevelsPresent,
  callsites_inventory_present: callsitesInventoryPresent,
  boundary_enumeration_present: boundaryEnumerationPresent,
  preflight_risks_present: preflightRisksPresent,
  design_alternatives_present: designAlternativesPresent,
  design_quadrant_eval_present: designQuadrantEvalPresent,
  implement_delta_check_present: implementDeltaCheckPresent,
  rollback_plan_when_irreversible: rollbackPlanWhenIrreversible
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

/**
 * 与 `flattenToText`/`flattenValues` 不同：直接返回 required_outputs[key] 的原始值（不打平、不字符串化）。
 *
 * 新断言（all_tasks_resolved / findings_traceable_to_probes / hedged_findings_demoted /
 * plan_readiness_honest）需要按对象/数组结构遍历，而非按文本扫描，故需要这条入口。
 */
function collectStructured(result: StageAgentResult, key: string): unknown {
  return result.required_outputs?.[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

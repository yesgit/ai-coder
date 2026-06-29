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
 * "Plan loop 闭环" —— investigation_tasks 的每条 task 必须达到终态：
 *  - status === "done"，且（若 task 有 verdict 字段）verdict ∈ {confirmed, refuted, inconclusive}
 *  - 或 status === "deferred"，且 defer_reason 非空
 *
 * 拒绝接收 pending/in_progress 残留——这是"先拟定调查任务、逐项落实、复盘"thinking loop 的闭环条件。
 * inconclusive 也允许 done（结论是 "查了但没结论"），但这种 hypothesis 不应升上 findings——
 * 那个由 findings_traceable_to_probes 兜底。
 *
 * 故意宽松：不强求 evidence_collected 字段必填，避免误伤简单任务。
 */
const allTasksResolved: AssertionImpl = (result) => {
  const tasks = collectStructured(result, "investigation_tasks");
  if (!Array.isArray(tasks)) return null; // 字段缺失另由 required_outputs 校验
  const unresolved: string[] = [];
  for (let i = 0; i < tasks.length; i += 1) {
    const t = tasks[i];
    if (!isRecord(t)) continue;
    const status = typeof t.status === "string" ? t.status.trim().toLowerCase() : "";
    if (status === "done") continue;
    if (status === "deferred") {
      const reason = typeof t.defer_reason === "string" ? t.defer_reason.trim() : "";
      if (reason.length === 0) {
        unresolved.push(`[${i}] ${describeTask(t)}：deferred 但 defer_reason 为空`);
      }
      continue;
    }
    unresolved.push(`[${i}] ${describeTask(t)}：status=${status || "(缺失)"}`);
  }
  if (unresolved.length === 0) return null;
  return [
    "investigation_tasks 未闭环：以下 task 仍处于 pending/in_progress/未知状态——",
    unresolved.join("; "),
    "。请按'拟定 → 落实 → 复盘'走完：每条 task 要么落实到 done（并填 verdict）、",
    "要么 deferred 并写明 defer_reason。Plan loop 不闭环不允许进入下一阶段。"
  ].join("");
};

function describeTask(task: Record<string, unknown>): string {
  const id = typeof task.id === "string" ? task.id : "";
  const q = typeof task.question === "string" ? task.question : "";
  const label = id || q || "(unnamed)";
  return label.length > 40 ? `${label.slice(0, 37)}...` : label;
}

/**
 * findings 必须可追溯到取证：每条 finding.from_hypothesis 在 hypotheses 里有对应条目，
 * 且其 linked task 的 verdict ∈ {confirmed, refuted}。
 *
 * 阻断"未取证就开列结论"——任何"我看着像 X"的结论必须先有 task → probe → verdict 的支持。
 * inconclusive 的 hypothesis 不允许升上来；这种应当留在 unknowns。
 */
const findingsTraceableToProbes: AssertionImpl = (result) => {
  const findings = collectStructured(result, "findings");
  if (!Array.isArray(findings) || findings.length === 0) return null; // 没 findings 自然没违规

  const hypotheses = collectStructured(result, "hypotheses");
  const tasks = collectStructured(result, "investigation_tasks");
  const hypothesisById = indexBy(Array.isArray(hypotheses) ? hypotheses : [], "id");
  const taskById = indexBy(Array.isArray(tasks) ? tasks : [], "id");

  const orphans: string[] = [];
  for (let i = 0; i < findings.length; i += 1) {
    const f = findings[i];
    if (!isRecord(f)) continue;
    const fromHyp = typeof f.from_hypothesis === "string" ? f.from_hypothesis : "";
    if (!fromHyp) {
      orphans.push(`[${i}] ${describeFinding(f)}：缺 from_hypothesis`);
      continue;
    }
    const hyp = hypothesisById.get(fromHyp);
    if (!hyp) {
      orphans.push(`[${i}] from_hypothesis="${fromHyp}" 在 hypotheses 找不到`);
      continue;
    }
    const linkedTaskId = typeof hyp.linked_task_id === "string" ? hyp.linked_task_id : "";
    const task = linkedTaskId ? taskById.get(linkedTaskId) : undefined;
    const verdict = task && typeof task.verdict === "string" ? task.verdict.trim().toLowerCase() : "";
    if (verdict !== "confirmed" && verdict !== "refuted") {
      orphans.push(
        `[${i}] hypothesis="${fromHyp}" 对应的 task verdict=${verdict || "(缺失)"}，需 confirmed/refuted 才能升 finding`
      );
    }
  }
  if (orphans.length === 0) return null;
  return [
    "findings 未取证：以下结论缺少可追溯的取证链路——",
    orphans.join("; "),
    "。每条 finding 必须挂 from_hypothesis；该 hypothesis 必须挂 linked_task_id；",
    "对应 task 的 verdict 必须是 confirmed 或 refuted。inconclusive 的请回到 unknowns 或新增取证 task。"
  ].join("");
};

function describeFinding(f: Record<string, unknown>): string {
  const claim = typeof f.claim === "string" ? f.claim : "";
  const anchor = typeof f.path_anchor === "string" ? f.path_anchor : "";
  const label = claim || anchor || "(no claim)";
  return label.length > 40 ? `${label.slice(0, 37)}...` : label;
}

function indexBy(items: unknown[], key: string): Map<string, Record<string, unknown>> {
  const m = new Map<string, Record<string, unknown>>();
  for (const item of items) {
    if (!isRecord(item)) continue;
    const k = typeof item[key] === "string" ? (item[key] as string) : "";
    if (k) m.set(k, item);
  }
  return m;
}

/**
 * findings[*] 文本含 hedge 措辞（可能/或许/似乎/疑似/maybe/might/likely）→ 失败。
 *
 * findings 是"已经取证的肯定/否定结论"，不允许出现模糊措辞——那是 unknowns 的领地。
 * 强制 demote：要么补 task 取证到肯定/否定，要么挪到 unknowns。
 *
 * 注意：避开误伤——只扫 findings 字段，不扫 unknowns/hypotheses（那里出现 hedge 是合理的）。
 */
const HEDGE_PATTERN = /可能|或许|似乎|疑似|大概|maybe|might|likely|probably/i;
const NEGATION_FOR_HEDGE = /(没|没有|无|未|不|不会|绝无|未发现|不存在|not\s|no\s|never\s|none\s)\s*[一-龥\w]{0,3}$/i;

const hedgedFindingsDemoted: AssertionImpl = (result) => {
  const findings = collectStructured(result, "findings");
  if (!Array.isArray(findings) || findings.length === 0) return null;

  const violators: string[] = [];
  for (let i = 0; i < findings.length; i += 1) {
    const f = findings[i];
    if (!isRecord(f)) continue;
    const text = [
      typeof f.claim === "string" ? f.claim : "",
      typeof f.description === "string" ? f.description : "",
      typeof f.note === "string" ? f.note : ""
    ].join(" \n ");
    if (!text.trim()) continue;
    // 逐句扫描，避免被否定语境（"未发现可能 X"之类）误伤
    for (const sentence of splitSentences(text)) {
      const m = sentence.match(HEDGE_PATTERN);
      if (!m) continue;
      const before = sentence.slice(Math.max(0, (m.index ?? 0) - 12), m.index ?? 0);
      if (NEGATION_FOR_HEDGE.test(before)) continue;
      violators.push(`[${i}] ${describeFinding(f)}：含 hedge 词 "${m[0]}"`);
      break;
    }
  }
  if (violators.length === 0) return null;
  return [
    "findings 含模糊措辞：",
    violators.join("; "),
    "。findings 必须是已取证的结论，不允许'可能/或许/似乎/maybe/might/likely'。",
    "请二选一：(1) 把这条移到 unknowns 并新增 investigation_task 去取证；",
    "(2) 真正读对应代码取证后改成肯定/否定结论。"
  ].join("");
};

/**
 * plan_readiness.sufficient === false 时，unknowns 或 investigation_tasks 中 status=pending 的至少一项必须非空。
 *
 * 阻断"自报不 ready 但啥都不补"——人类工程师说"还差点意思"必然能说出差啥；
 * 模型不被允许只表态、不落到清单。
 */
const planReadinessHonest: AssertionImpl = (result) => {
  const readiness = collectStructured(result, "plan_readiness");
  if (!isRecord(readiness)) return null; // 字段缺失另由 required_outputs 校验
  if (readiness.sufficient === true) return null; // 自报 ready 由其他断言把关

  const unknowns = collectStructured(result, "unknowns");
  const unknownsFlat = unknowns === undefined ? "" : flattenToText(unknowns).trim();

  const tasks = collectStructured(result, "investigation_tasks");
  const hasPending = Array.isArray(tasks)
    ? tasks.some((t) => isRecord(t) && typeof t.status === "string" && /^(pending|in_progress)$/i.test(t.status.trim()))
    : false;

  const missingFor = readiness.missing_evidence_for;
  const missingFlat = missingFor === undefined ? "" : flattenToText(missingFor).trim();

  if (unknownsFlat.length > 0 || hasPending || missingFlat.length > 0) return null;
  return [
    "plan_readiness 不诚实：自报 sufficient=false 但既无 unknowns、又无 pending 的 investigation_tasks、",
    "也没填 missing_evidence_for。请明确写出缺什么证据/还要查什么。",
    "Plan loop 的语义是'差点啥要说清'——只表态不补漏算未闭环。"
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
 * design 阶段：每个 plan_step 必须挂 ≥1 个 supporting_finding_ids，且这些 id 能在
 * investigate.findings 里找到。阻断"想得很多但没挂取证血脉"。
 *
 * 跨阶段断言：依赖 PriorStageOutputs 拿到 investigate 阶段已落地的 findings。
 * 容错：findings 不是数组 / 缺 id 字段 → 退化到"只要 supporting_finding_ids 非空"。
 */
const planStepsGrounded: AssertionImpl = (result, prior) => {
  const steps = collectStructured(result, "plan_steps");
  if (!Array.isArray(steps) || steps.length === 0) return null; // 字段缺失另由 required_outputs 校验

  // 拿 investigate.findings（任一前序阶段都可放 findings，但优先 investigate）
  const findingIds = collectFindingIds(prior);
  const violators: string[] = [];

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (!isRecord(step)) continue;
    const stepId = typeof step.id === "string" ? step.id : `[${i}]`;
    const refs = step.supporting_finding_ids;
    const list = Array.isArray(refs) ? refs.map((r) => (typeof r === "string" ? r.trim() : "")).filter(Boolean) : [];
    if (list.length === 0) {
      violators.push(`${stepId}: supporting_finding_ids 为空`);
      continue;
    }
    // 若拿到了 findingIds 集合，每个 ref 必须存在；如果整个 findings 集合都拿不到，
    // 我们至少保证 supporting_finding_ids 非空（不退化为"放过一切"）。
    if (findingIds.size === 0) continue;
    const missing = list.filter((id) => !findingIds.has(id));
    if (missing.length > 0) {
      violators.push(`${stepId}: 引用了不存在的 finding id [${missing.join(", ")}]`);
    }
  }

  if (violators.length === 0) return null;
  return [
    "plan_steps 缺取证血脉：",
    violators.join("; "),
    "。每个 plan_step 必须挂 ≥1 个 supporting_finding_ids，且 id 在 investigate.findings 里能查到。",
    "如果某步骤无法溯源到 finding，说明它是凭空设计的——请要么补 investigation_task 取证后再设计，",
    "要么把这步从方案里去掉。"
  ].join("");
};

function collectFindingIds(prior: PriorStageOutputs): Set<string> {
  const ids = new Set<string>();
  for (const stageOutputs of Object.values(prior)) {
    if (!stageOutputs) continue;
    const findings = stageOutputs.findings;
    if (!Array.isArray(findings)) continue;
    for (const f of findings) {
      if (isRecord(f) && typeof f.id === "string" && f.id.trim()) ids.add(f.id);
    }
  }
  return ids;
}

/**
 * implement 阶段：deviations_from_plan 非空时，plan_revisions 必须有对应条目。
 *
 * 阻断"动手中发现 plan 跑不通但闷头改下去不更新计划"。每个 deviation 应当对应一条
 * plan_revisions[*]——按 step_id 配对；plan_revisions 里的 trigger 字段应当能引用到该 deviation。
 *
 * 容错：plan_revisions 不要求一一对应到 step_id（trigger 字段措辞自由），只要数量 ≥ deviations 即可——
 * 让模型有空间把多个相关 deviation 合到一条 revision。
 */
const deviationsMustBeRevised: AssertionImpl = (result) => {
  const dev = collectStructured(result, "deviations_from_plan");
  if (!Array.isArray(dev) || dev.length === 0) return null;

  const rev = collectStructured(result, "plan_revisions");
  const revisions = Array.isArray(rev) ? rev : [];
  if (revisions.length >= dev.length) return null;

  return [
    `检测到 ${dev.length} 条 deviations_from_plan，但 plan_revisions 只有 ${revisions.length} 条。`,
    "动手中发现 plan 跑不通时，必须同步更新 plan_revisions——",
    "每条 deviation 至少对应一条 revision（说明触发原因、新增/修改了哪些 step）。",
    "如果不更新计划就闷头改，下次回头看就再也对不上账。"
  ].join("");
};

/**
 * implement 阶段：任一 deviation 自报 out_of_scope=true 时，stage 必须 needs_rework 回 design。
 *
 * 阻断"偏差超出 design 边界但还在 implement 内继续改"——这种情况下 design 的前提假设
 * 已被推翻，正确做法是回到 design 重新规划，而不是越界完成 implement。
 */
const deviationSeverityMustRework: AssertionImpl = (result) => {
  const dev = collectStructured(result, "deviations_from_plan");
  if (!Array.isArray(dev)) return null;

  const outOfScope = dev.filter(
    (d) => isRecord(d) && d.out_of_scope === true
  );
  if (outOfScope.length === 0) return null;

  // status=needs_rework 且 target 为 design（或更早）→ 通过
  if (result.status === "needs_rework") {
    const target = result.rework_target_stage_id;
    if (typeof target === "string" && target.trim()) return null;
  }

  const samples = outOfScope
    .slice(0, 2)
    .map((d, i) => {
      const r = d as Record<string, unknown>;
      const step = typeof r.step_id === "string" ? r.step_id : `[${i}]`;
      const what = typeof r.what_changed === "string" ? r.what_changed.slice(0, 40) : "";
      return `${step}: ${what}`;
    });

  return [
    `检测到 ${outOfScope.length} 条 deviation 自报 out_of_scope=true（例：${samples.join("; ")}）。`,
    "这意味着 design 的前提已被推翻，本阶段无法在原方案边界内继续——",
    "请把 status 改为 needs_rework、rework_target_stage_id 改为 design（或更早），",
    "在 rework_reason 写明哪些前提需要重新规划。继续 implement 会让 plan 与代码脱节。"
  ].join("");
};

/**
 * self_review 阶段：rework_decision="pass" 时同时要求
 *   - phase_1_self_check 无 status=missing；partial 必须配 mitigation
 *   - phase_2_tests.green === true
 *   - phase_3_adversarial_review 三类（perf/security/extensibility）findings 无 severity=high
 *   - residual_risks 为空，investigate.unknowns 已关闭
 *
 * 任一不满足 → fail，要求改为 pass_with_followups（每条 residual 配 followup_owner/followup_action）
 * 或 needs_rework。pass 的语义收紧为"无遗留 + 全部已查实 + 测试绿 + 无高危"。
 */
const passRequiresAllValidated: AssertionImpl = (result, prior) => {
  const decision = pickReworkDecision(result);
  if (decision !== "pass") return null;

  const reasons: string[] = [];

  // phase_1: 无 missing；partial 必须配 mitigation
  const phase1 = collectStructured(result, "phase_1_self_check");
  if (Array.isArray(phase1)) {
    for (let i = 0; i < phase1.length; i += 1) {
      const c = phase1[i];
      if (!isRecord(c)) continue;
      const status = typeof c.status === "string" ? c.status.trim().toLowerCase() : "";
      if (status === "missing") {
        reasons.push(`phase_1_self_check[${i}]: status=missing`);
      } else if (status === "partial") {
        const mit = typeof c.mitigation === "string" ? c.mitigation.trim() : "";
        if (mit.length === 0) reasons.push(`phase_1_self_check[${i}]: partial 但缺 mitigation`);
      }
    }
  }

  // phase_2: green 必须为 true
  const phase2 = collectStructured(result, "phase_2_tests");
  if (isRecord(phase2)) {
    if (phase2.green !== true) reasons.push("phase_2_tests.green != true");
  } else {
    reasons.push("phase_2_tests 缺失或非对象");
  }

  // phase_3: 三类 findings 无 severity=high
  const phase3 = collectStructured(result, "phase_3_adversarial_review");
  if (isRecord(phase3)) {
    for (const dim of ["perf_findings", "security_findings", "extensibility_findings"] as const) {
      const arr = phase3[dim];
      if (!Array.isArray(arr)) continue;
      const highs = arr.filter((f) => isRecord(f) && typeof f.severity === "string" && /^high$/i.test(f.severity.trim()));
      if (highs.length > 0) reasons.push(`phase_3_adversarial_review.${dim}: ${highs.length} 项 severity=high`);
    }
  }

  // residual_risks 为空
  const residuals = collectStructured(result, "residual_risks");
  const residualsFlat = residuals === undefined ? "" : flattenToText(residuals).trim();
  // "无"/"none" 视为空
  if (residualsFlat.length > 0 && !/^(无|none|n\/a|na|nothing|无明显风险|无遗留|—|-)$/i.test(residualsFlat)) {
    reasons.push("residual_risks 非空");
  }

  // investigate.unknowns 必须关闭——把它当作前序阶段产物来读
  const investigate = prior?.investigate;
  if (investigate) {
    const unknowns = investigate.unknowns;
    const unknownsFlat = unknowns === undefined ? "" : flattenToText(unknowns).trim();
    if (unknownsFlat.length > 0 && !TRIVIAL_NEGATIVE.has(unknownsFlat.toLowerCase())) {
      reasons.push("investigate.unknowns 仍非空（请在 followups 关闭或在 review_findings 里说明已消解）");
    }
  }

  if (reasons.length === 0) return null;
  return [
    "pass 高门槛未达成：",
    reasons.join("; "),
    "。pass 的语义是'所有自检过、测试绿、无高危、无遗留'——任一项不满足请二选一：",
    "(1) rework_decision='pass_with_followups'，并在 followups 数组里给每条 residual 配 followup_owner + followup_action；",
    "(2) rework_decision='needs_rework' 回炉。不允许稀释 pass 的语义。"
  ].join("");
};

const ASSERTION_IMPLS: Record<StageOutputAssertion, AssertionImpl> = {
  review_self_consistency: reviewSelfConsistency,
  needs_rework_target_required: needsReworkTargetRequired,
  unknowns_present: unknownsPresent,
  item_matrix_when_multi: itemMatrixWhenMulti,
  all_tasks_resolved: allTasksResolved,
  findings_traceable_to_probes: findingsTraceableToProbes,
  hedged_findings_demoted: hedgedFindingsDemoted,
  plan_readiness_honest: planReadinessHonest,
  no_trailing_unparsed_payload: noTrailingUnparsedPayload,
  plan_steps_grounded: planStepsGrounded,
  deviations_must_be_revised: deviationsMustBeRevised,
  deviation_severity_must_rework: deviationSeverityMustRework,
  pass_requires_all_validated: passRequiresAllValidated
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

import type { PostOutputBehaviorCheck, StageAgentInput, StageHooksConfig } from "../../shared/types.js";
import { isMeaningfulAgentText } from "../../shared/agentMessages.js";
import { estimatePromptTokens, shouldCompress } from "./tokenEstimator.js";

const MAX_ARRAY_ITEMS = 5;
const MAX_STRING_LENGTH = 200;
const RECENT_STAGE_COUNT = 2; // 最近 N 个阶段保留截断后的 required_outputs，更早的只保留 output_summary

export function buildStageInstructions(input: StageAgentInput): string {
  const isTaskUnderstandingStage = input.current_stage.id === "understand";
  const isProfileMaintenanceStage = input.current_stage.id === "maintain_project_profile";
  const completedStageIds = new Set(input.previous_stage_summaries.map((s) => s.stage_id));
  const stageProgressLines = input.workflow.stages
    .map((stage, index) => {
      const isCurrent = stage.id === input.current_stage.id;
      const isCompleted = completedStageIds.has(stage.id);
      let marker = "";
      if (isCurrent) marker = "  ← 当前阶段";
      else if (isCompleted) marker = "  ✅";
      return `${index + 1}. ${stage.id}: ${stage.name}${marker}`;
    })
    .join("\n");

  const allowedTools = input.allowed_tools.length ? input.allowed_tools.join(", ") : "read-only defaults";
  const requiredOutputs = input.required_outputs.length ? input.required_outputs.join(", ") : "concise stage summary";
  const gates = input.gates.length ? input.gates.join(", ") : "none";
  const hookSections = describeStageHooks(input.current_stage.hooks);
  const outputShapeHints = describeRequiredOutputShapes(input.required_outputs, input.current_stage.output_schema);
  const stageStartContract = describeStageStartContract(input, outputShapeHints);

  // ── 静态前缀（跨阶段不变，可利用 prompt cache）──

  const staticPrefix = [
    `你正在执行「${input.workflow.name}」工作流。`,
    ...(input.workflow.description.trim()
      ? ["", "## 工作流人设与原则", input.workflow.description.trim()]
      : []),
    "请始终使用简体中文回答，包括阶段总结、问题说明、审批请求和最终 JSON 中的自然语言内容。",
    "像一名谨慎的人类开发者一样推进：先理解意图，再查看证据，形成假设，比较方案，实施最小改动，并用验证结果校准判断。",
    "谨慎程序员 Plugin 提供按需加载的 Skills。遇到匹配情境时，先调用原生 Skill 工具并遵循完整 Skill；不要只凭 Skill 名称猜测其流程。",
    "准备宣称任务完成时，必须先使用 `careful-coder:verification-before-completion`，并以原始用户请求、最终 diff 与真实验证结果为依据。",
    "优先解决真实用户问题，而不是机械完成字段；如果流程字段与问题本质有张力，请在阶段输出中解释取舍。",
    "每个阶段都要把判断建立在可观察事实上：代码、配置、测试、错误信息、用户明确要求或前序阶段摘要。",
    "",
    isProfileMaintenanceStage
      ? "## 画像维护目标（业务需求正文与附件已由宿主隔离）"
      : "## 总体任务（最高优先级验收来源——当前阶段不得越位执行）",
    input.task_prompt,
    "",
    ...(isProfileMaintenanceStage
      ? [
          "⚠️ 画像阶段与本次业务任务语义隔离。不得猜测任务、附件内容、功能范围或后续实现；只维护跨任务复用的长期项目事实。",
          "你的职责仅限于当前阶段的 required_outputs。"
        ]
      : [
          "⚠️ 上方的「总体任务」和后续人类问答定义最终验收；你只执行当前阶段，但不得让阶段字段或前序摘要缩窄这个目标。",
          "你的职责仅限于当前阶段的 required_outputs。它们服务于总体任务，而不是替代总体任务。",
          "除非你在 `understand` 阶段，否则不要阅读总体任务附带的 PDF/图片——那是给 understand 阶段理解需求用的。"
        ]),
    "",
    "工作流引擎负责控制阶段流转。你只需要完成当前阶段。",
    "你可以参考工作流概览和此前阶段摘要，但不要执行后续阶段。",
    "严格遵守当前阶段的阶段指令、allowed_tools、required_outputs 和 gates；如果它们与用户任务冲突，请说明冲突并请求返工。",
    "allowed_tools 是当前阶段的能力边界（由工作流引擎注入到 SDK），不是平台限制：如果完成当前阶段需要的能力（如 git/构建/网络）不在 allowed_tools 中，请在 output_summary 中明确说明哪些信息无法核实，并把阶段标记为 needs_rework 指向能提供该能力的阶段。不要靠猜测代替核实，也不要对用户说'我没有 X 工具'让用户介入。",
    "只能修改已选择项目目录内的文件。读取项目外文件需要发起 Read，宿主会请求用户审批（用户批准后该路径在本会话内不再询问）。",
    "不要编造文件内容、命令结果、测试结果或项目规则；不确定时明确说明不确定，并尽量用允许的工具核实。",
    "面对不确定性时，先寻找低成本证据；如果仍不确定，说明最可能的解释、采用的保守假设和可能影响。",
    "避免过度工程：选择能满足验收标准、符合现有代码风格且风险最小的方案。",
    "当策略要求审批时，仍然要正常发起对应工具调用；宿主应用会拦截工具调用、创建审批项并暂停执行。",
    "不要用文字审批请求代替工具调用，也不要仅因为 shell 命令或文件写入需要审批就把阶段标记为 failed。",
    "如果当前阶段发现需要返工到更早阶段，请说明目标阶段和原因，不要自行改变工作流状态。",
    ...(isTaskUnderstandingStage
      ? [
          "当前是 understand 阶段：你的任务语义输入是用户本次提交的原始任务、附件和后续明确回答。",
          "maintain_project_profile 是独立的项目背景预处理，不是本次用户任务的语义上游；不要把画像阶段总结、画像更新事项或画像 required_outputs 当作用户需求、验收标准或待办。"
        ]
      : [
          "入境验收（重要）：如果存在前序阶段摘要（即非首阶段），动手当前阶段工作之前必须先核对前序阶段产出是否满足本阶段的输入要求——",
          "  - 核对维度：以前序阶段的文义是否足够支撑当前阶段为根本；综合阅读 output_summary 与已有 required_outputs，不要只因某个结构字段缺失就机械打回。",
          "  - 优先消费前序阶段 required_outputs 中的结构化状态（如 DoD、证据、调用方假设、成功标准、验证计划、改动核对）；结构字段缺失但 output_summary 已清楚表达同等信息时，可以继续推进并在本阶段摘要里说明采用了文义依据。",
          "  - 不合格时：把当前阶段 status 写成 needs_rework、rework_target_stage_id 指向不合格的直接前序阶段、rework_reason 用一两句中文写明哪里不合格、缺了什么；如果该前序阶段重做后仍发现缺更上游信息，再由它继续回溯。",
          "  - 合格时：继续当前阶段工作，无需在 output_summary 里专门说明验收通过。",
          "  - 这不是挑刺，是'我能基于前序产出继续推进吗'的诚实自检——前序产出有缺口却硬推进，只会把问题留到 self_review 才暴露，成本更高。"
        ]),
    "如果阶段要求输出结构化字段，请让 required_outputs 中的字段内容具体、可复用，并包含支撑判断的事实或路径。",
    "使用任何工具后，或在不需要工具时完成阶段工作后，请通过且仅通过一个符合下方协议的 JSON 对象结束当前阶段。",
    "最终 JSON 对象前后不要添加额外说明文字。",
    "禁止输出“先解释一下”“下面是 JSON”“根据分析如下”等前导语；也禁止在 JSON 后补充说明、再贴第二个对象，或把 JSON 放进 ```json 代码块。",
    "首选格式：最后一条回复的第一个非空字符是 `{`，最后一个非空字符是 `}`。宿主会优先读取 SDK 结构化输出，并兼容提取文本中的完整对象；无法恢复完整对象或缺少必填字段时才会打回重试。",
    "输出前自行做一次严格自检：最外层必须是单个对象；所有 key/字符串都用双引号；没有未闭合的引号/花括号/方括号；没有尾随逗号；required_outputs 必须是对象而不是数组或字符串。",
    "",
  ].join("\n");

  // ── 动态后缀前部（阶段元信息，变化频率低）──

  const stageMeta = [
    `## 工作流阶段（共 ${input.workflow.stages.length} 个）`,
    stageProgressLines,
    "",
    `## 当前阶段：${input.current_stage.name}（${input.current_stage.id}）`,
    input.current_stage.instructions ? `${input.current_stage.instructions}` : "（无阶段指令）",
    `allowed_tools: ${allowedTools}`,
    `required_outputs: ${requiredOutputs}`,
    `gates: ${gates}`,
    "",
    "## 阶段启动契约（先读这里，再开始行动）",
    stageStartContract,
    ...(hookSections.preToolUse
      ? ["", "本阶段工序闸门（在工具调用前由宿主校验，未满足会被 deny 并要求补齐）：", hookSections.preToolUse]
      : []),
    ...(hookSections.postOutput
      ? ["", "本阶段产物校验（输出落地后由宿主评估：自洽性断言扫产出文本、行为校验按 tool_calls 核对真动作；未通过会带原因打回重试；JSON 协议/required_outputs 缺字段会进入输出合同修复重试）：", hookSections.postOutput]
      : []),
    ...(outputShapeHints
      ? [
          "",
          "required_outputs 字段形状提示（必须仍然嵌在上面的单一 JSON 对象内；不要输出裸 key/value 清单；如有 JSON Schema，以它为唯一口径）：",
          outputShapeHints
        ]
      : []),
    "",
  ].join("\n");

  const subAgentSection = input.current_stage.agents && Object.keys(input.current_stage.agents).length > 0
    ? [
        "",
        "可用 Sub-Agent（通过 Task 工具调用，每个 sub-agent 只调查一个目标符号）：",
        ...Object.entries(input.current_stage.agents).map(
          ([name, def]) => `- **${name}**：${def.description}`
        ),
        "调用方式：Task({ subagent_type: \"${name}\", description: \"调查 XXX\", prompt: \"调查目标符号 YYY 的...\" })",
        "一次只调查一个目标符号。不要在一次 Task 调用中塞多个目标。可并行调用多个 Task。",
        "",
      ].join("\n")
    : "";

  // ── 动态后缀后部（每次调用变化最大的内容，放在最后以最大化缓存命中）──

  // 渐进式压缩：最近 N 个阶段保留截断后的 required_outputs，更早的只保留 output_summary
  const previousStageLines = buildPreviousStageLines(input);

  // self_review 阶段：生成结构化变更摘要
  const reviewChangeSummary = input.current_stage.id === "self_review"
    ? buildReviewChangeSummary(input)
    : null;

  const retrySection = input.retry_context
    ? [
        "",
        `本次为当前阶段的重试（上次为第 ${input.retry_context.previous_attempt} 次尝试）：`,
        `- 上次失败原因/总结：${input.retry_context.output_summary}`,
        "请认真分析失败原因，避免重复同样的错误，优先采取与上次不同的策略或更小的改动。",
        ...(needsStrictJsonRetry(input.retry_context.output_summary)
          ? [
              "这次重试命中过 JSON/必填字段问题：结束时不要先写解释、清单、Markdown 或代码块，再补 JSON。",
              "请先在脑内组装完整对象，确认双引号、括号、逗号都合法，再一次性输出单一 JSON 对象。",
              "特别注意：required_outputs 后面只能是一个对象，写成 \"required_outputs\": { ... }，不要写成 \"required_outputs\": {{ ... }}。"
            ]
          : [])
      ].join("\n")
    : "";

  const reworkSection = input.rework_context
    ? [
        "",
        "本次为被下游阶段退回重做（入境验收不通过）：",
        `- 退回方：${input.rework_context.from_stage}`,
        `- 退回原因：${input.rework_context.reason}`,
        ...(input.rework_context.previous_output_summary
          ? [`- 你上一版产出：${input.rework_context.previous_output_summary}`]
          : []),
        "请对照退回原因修正上一版产出的缺口，而非原样重做。"
      ].join("\n")
    : "";

  const messageHistory = input.recent_messages
    .filter((m) => isMeaningfulAgentText(m.content) || m.attachments?.length)
    .map((m) => {
      const roleLabel = m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : "系统";
      let text = `[${roleLabel}]: ${m.content || "(附带附件)"}`;
      if (m.attachments?.length) {
        text += "\n附件（项目相对路径；图片用 Read 工具读取，文本文件也用 Read，二进制可用 Bash 处理。PDF 已自动拆页为多个 PNG，display_name 形如 “xxx.pdf · 第 N 页 / 共 M 页”，按需 Read 关心的页码即可）:\n" + m.attachments.map((a) => {
          if (a.type === "image") {
            return `- [图片] ${a.display_name}（内联 base64，未保存到磁盘）`;
          }
          if (a.type === "file_ref") {
            return `- [文件] ${a.path}（显示名: ${a.display_name}）`;
          }
          return `- [文件] ${a.display_name}（未落盘）`;
        }).join("\n");
      }
      return text;
    })
    .join("\n\n");

  const humanQaHistory = (input.human_qa_history ?? [])
    .map((q) => {
      const answer = Array.isArray(q.answer) ? q.answer.join(", ") : (q.answer ?? "");
      return `- 问：${q.question}\n  类型：${q.question_type}\n  答：${answer}`;
    })
    .join("\n");

  const finalJsonProtocol = [
    "最终 JSON 协议（最后一条消息必须只包含这个 JSON 对象）：",
    JSON.stringify(
      {
        status: "completed | failed | needs_rework",
        output_summary: "用简体中文简要总结当前阶段结果",
        required_outputs: Object.fromEntries(input.required_outputs.map((name) => [name, `<${name}>`])),
        rework_target_stage_id: "仅当 status 为 needs_rework 时填写",
        rework_reason: "仅当 status 为 needs_rework 时填写，并使用简体中文说明原因",
        error: "仅当 status 为 failed 时填写，并使用简体中文说明错误"
      },
      null,
      2
    ),
    "",
    "硬性输出规则：",
    "- 最后一条回复只能是上面的单一 JSON 对象，不要输出 Markdown、代码块、标题、列表或解释文字。",
    "- 不要主动把 JSON 放进 ```json 代码块；直接输出对象最稳定。宿主能完整恢复对象时仍会接受。",
    "- 首选让第一个非空字符为 `{`、最后一个非空字符为 `}`。",
    "- 不要只输出 required_outputs 内部字段；必须保留最外层 status、output_summary、required_outputs。",
    "- 阶段指令或 sub-agent prompt 中的 JSON 示例只用于说明子任务返回格式，不是当前阶段最终输出格式。",
    "- 如果你需要在 output_summary 或 required_outputs 字符串中包含 Markdown，请把它作为 JSON 字符串值转义后放入对象内部。"
  ].join("\n");

  // ── 组装：静态前缀 + 阶段元信息 + sub-agent 定义 + 尾部上下文 ──
  // 尾部构建为函数：正常模式含 reviewChangeSummary，激进压缩模式不含

  const buildTail = (opts: { lines: string; includeReviewSummary: boolean }) =>
    [
      "---",
      "## ⚠️ 阶段边界与需求保真（重要——违反会导致阶段失败）",
      "",
      "1. **你只需要完成「当前阶段」的工作**。总体任务会在后续阶段中逐步推进，不要提前执行后续阶段的工作。",
      isProfileMaintenanceStage
        ? "2. **宿主没有向本阶段提供业务任务正文、问答或附件；不得从文件名或 Git 变更猜测它们。**"
        : "2. **不要阅读总体任务附带的 PDF/图片附件**——除非当前阶段指令明确允许（只有 `understand` 阶段需要读附件理解需求；其他阶段的输入是前序阶段的 required_outputs，不是原始附件）。",
      "3. **每个阶段都有明确的 required_outputs**——聚焦于产出这些字段，但它们只是工作产物，不得缩窄、改写或覆盖用户要达成的结果。",
      isProfileMaintenanceStage
        ? "4. **只维护长期项目事实；不得输出本次需求结论、实现建议、业务文件清单或后续阶段安排。**"
        : isTaskUnderstandingStage
        ? "4. **当前 understand 阶段必须从初始用户任务和附件理解需求**。项目画像文件只能作为背景证据按需读取；画像阶段摘要不是本阶段输入。"
        : "4. **初始用户任务与后续人类问答始终是最高优先级的验收来源**。前序阶段的 required_outputs 只是证据和可质疑的工作假设；发现它们遗漏、误解或缩窄需求时，必须纠正并明确记录，而不是机械继承。",
      "5. **提问是昂贵的阻塞动作，不是需求访谈。调用 ask_human 前必须回看用户原话/附件/既有回答，并用只读工具检查项目规则、相邻实现、消费者和 git 证据。只有答案会导致不同实现、安全边界或验收结果，且证据无法回答时才提问。**",
      "6. **一次只问一个决策。用户已经明确的范围（如“全部”“从 N 开始”）、仓库可查的事实、可按惯例采取的可逆默认值，一律不要再问。**",
      "---",
      "",
      "可用扩展工具：",
      "- mcp__ai_coder__ask_human(question, type, already_checked, why_needed, options?)",
      "  向用户提问并暂停执行。already_checked 必须列出已核对的用户原话/附件/代码/规则证据；why_needed 必须说明不同回答会如何改变实现、安全或验收。一次只能问一个决策。single/multi 时 options 必填。",
      "  调用该工具后工作流会暂停；用户回答后下一轮指令的\"人类问答历史\"部分会包含答案。",
      "",
      "人类问答历史（你之前向用户提的问题及回答）：",
      humanQaHistory || "无",
      "请基于这些答案继续推进；不要重复已经回答过的问题。",
      "",
      "此前阶段摘要：",
      opts.lines || "无",
      ...(opts.includeReviewSummary && typeof reviewChangeSummary === "string"
        ? ["", "## 结构化变更摘要（self_review 专用——替代逐阶段 JSON 的紧凑视图）", reviewChangeSummary]
        : []),
      retrySection,
      reworkSection,
      "",
      "对话历史：",
      messageHistory || "无",
      "",
      "---",
      finalJsonProtocol
    ].join("\n");

  const dynamicTail = buildTail({ lines: previousStageLines, includeReviewSummary: true });
  const prompt = staticPrefix + stageMeta + subAgentSection + dynamicTail;

  // 自动压缩：当 prompt 估算 token 数超过阈值时，用激进压缩重建（所有前序阶段只保留 output_summary，去掉 reviewChangeSummary）
  const estimatedTokens = estimatePromptTokens(prompt);
  if (shouldCompress(estimatedTokens)) {
    const aggressiveLines = buildPreviousStageLines(input, { aggressive: true });
    const compressedTail = buildTail({ lines: aggressiveLines, includeReviewSummary: false });
    return staticPrefix + stageMeta + subAgentSection + compressedTail;
  }

  return prompt;
}

function needsStrictJsonRetry(summary: string | undefined): boolean {
  if (!summary) return false;
  return /json parse|missing required outputs|单一合法对象|required_outputs/i.test(summary);
}

function describeRequiredOutputShapes(requiredOutputs: string[], outputSchema?: Record<string, unknown>): string | null {
  if (outputSchema && Object.keys(outputSchema).length > 0) {
    return [
      "当前阶段 required_outputs JSON Schema:",
      JSON.stringify(outputSchema, null, 2)
    ].join("\n");
  }

  const lines: string[] = [];
  if (requiredOutputs.includes("lateral_constraints")) {
    lines.push(
      "- lateral_constraints: JSON 数组；每一项必须是对象，形如 {\"constraint\":\"约束\",\"evidence\":\"证据来源/同类位置\",\"implication\":\"对本次改动的含义\"}。"
    );
  }
  if (requiredOutputs.includes("clarifications_asked")) {
    lines.push("- clarifications_asked: JSON 数组；未询问用户时写 []。");
  }
  if (requiredOutputs.includes("changed_files")) {
    lines.push(
      "- changed_files: JSON 数组；每项是对象，形如 {\"file\":\"相对路径\",\"changes\":[\"改动点\"],\"reason\":\"未改动时写原因，可省略\"}。"
    );
  }
  if (requiredOutputs.includes("delta_checks")) {
    lines.push(
      "- delta_checks: JSON 数组；每项是对象，形如 {\"file\":\"相对路径\",\"success_criteria_addressed\":[\"标准\"],\"new_risks\":[\"风险\"],\"verification\":\"如何验证\"}。"
    );
  }
  if (requiredOutputs.includes("validation_run")) {
    lines.push(
      "- validation_run: JSON 对象，形如 {\"commands_executed\":[\"命令\"],\"results\":\"结果摘要\",\"skipped_validations\":[\"跳过项及原因\"],\"residual_risks\":\"残余风险\"}。"
    );
  }
  return lines.length ? lines.join("\n") : null;
}

function describeStageStartContract(input: StageAgentInput, outputShapeHints: string | null): string {
  const requiredOutputsObject = Object.fromEntries(
    input.required_outputs.map((name) => [name, exampleValueForRequiredOutput(name, input.current_stage.output_schema?.[name])])
  );
  const stageTask = input.current_stage.instructions?.trim() || "完成当前阶段定义的工作，并只产出当前阶段要求的内容。";
  return [
    `- 当前阶段任务：${stageTask}`,
    "- 阶段结束时只能输出一个 JSON object；不要输出 Markdown、代码块、前导解释或尾随说明。",
    "- 首选让第一个非空字符为 `{`、最后一个非空字符为 `}`；不要主动添加 ```json 代码块。",
    "- 最外层 JSON object 必须包含：status、output_summary、required_outputs。",
    "- required_outputs 必须是 JSON object，字段必须完整覆盖当前阶段 required_outputs：",
    JSON.stringify(requiredOutputsObject, null, 2),
    ...(outputShapeHints
      ? [
          "- required_outputs 字段说明 / JSON Schema：",
          outputShapeHints
        ]
      : [
          "- 没有额外 JSON Schema 时，也必须让每个字段内容具体、可复用，并包含事实、路径、命令结果或明确假设。"
        ])
  ].join("\n");
}

function exampleValueForRequiredOutput(name: string, schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return `<${name}>`;
  }
  const record = schema as Record<string, unknown>;
  if (Array.isArray(record.enum) && record.enum.length > 0) {
    return record.enum.map(String).join(" | ");
  }
  if (record.type === "array") return [];
  if (record.type === "object") return {};
  if (record.type === "boolean") return false;
  if (record.type === "number" || record.type === "integer") return 0;
  return `<${name}>`;
}

function describeStageHooks(hooks: StageHooksConfig | undefined): { preToolUse: string | null; postOutput: string | null } {
  const preToolUse = describePreToolUse(hooks?.pre_tool_use);
  const postOutput = describePostOutput(hooks);
  return { preToolUse, postOutput };
}

function describePreToolUse(rules: StageHooksConfig["pre_tool_use"]): string | null {
  if (!rules || rules.length === 0) return null;
  return rules
    .map((rule, idx) => {
      const tools = Array.isArray(rule.when.tool)
        ? rule.when.tool.join("/")
        : rule.when.tool ?? "（任意工具）";
      const cmd = rule.when.command_contains?.length
        ? `，且命令含 ${rule.when.command_contains.map((s) => `\`${s}\``).join("/")}`
        : "";
      const requirements: string[] = [];
      if (rule.require.same_file_reads_min !== undefined) {
        requirements.push(`目标文件需先被 Read/Grep ≥ ${rule.require.same_file_reads_min} 次`);
      }
      if (rule.require.shell_must_have_run?.length) {
        requirements.push(`本会话需先执行包含 ${rule.require.shell_must_have_run.map((s) => `\`${s.trim()}\``).join(" / ")} 的命令`);
      }
      if (rule.require.ask_human_consent) {
        requirements.push("本阶段必须先通过 ask_human 取得用户明确确认");
      }
      return `${idx + 1}. 调用 ${tools}${cmd} 之前，${requirements.join("；")}。否则：${rule.on_fail}`;
    })
    .join("\n");
}

function describePostOutput(hooks: StageHooksConfig | undefined): string | null {
  const lines: string[] = [];
  const assertions = hooks?.post_output_assertions;
  if (assertions && assertions.length > 0) {
    assertions.forEach((name) => lines.push(`${lines.length + 1}. ${describeAssertion(name)}`));
  }
  const checks = hooks?.post_output_checks;
  if (checks && checks.length > 0) {
    checks.forEach((check) => lines.push(`${lines.length + 1}. ${describeBehaviorCheck(check)}`));
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

function describeBehaviorCheck(check: PostOutputBehaviorCheck): string {
  const reqs: string[] = [];
  if (check.require.commands_run?.length) {
    reqs.push(
      `本阶段必须真跑过包含 ${check.require.commands_run.map((s) => `\`${s.trim()}\``).join(" / ")} 的 Bash 命令（宿主按 tool_calls 核对，写文字不算数）`
    );
  }
  if (check.require.successful_commands_run?.length) {
    reqs.push(
      `本阶段必须成功执行（SDK 回传 exit_code=0）包含 ${check.require.successful_commands_run.map((s) => `\`${s.trim()}\``).join(" / ")} 的 Bash 命令；仅发起调用或吞掉失败均不算验证证据`
    );
  }
  if (check.require.evidence_calls_min !== undefined) {
    reqs.push(`本阶段至少产生 ${check.require.evidence_calls_min} 次 Read/Grep/Glob/Bash 证据调用`);
  }
  if (check.require.successful_commands_min !== undefined) {
    reqs.push(`本阶段至少有 ${check.require.successful_commands_min} 条 Bash 命令获得 exit_code=0 的真实结果`);
  }
  if (check.require.files_read?.length) {
    reqs.push(
      `本阶段必须 Read/Grep 命中 ${check.require.files_read.map((f) => `\`${f.target}\` ≥ ${f.min} 次`).join(" / ")}`
    );
  }
  return `行为校验：${reqs.join("；")}。否则：${check.on_fail}`;
}

function describeAssertion(name: string): string {
  switch (name) {
    case "review_self_consistency":
      return "review_self_consistency：output 中出现阻塞类问题信号（blocker/critical/严重不一致/安全问题/高优先级问题…）时，rework_decision 不允许是 pass——要么改 needs_rework，要么改写描述消除阻塞词。";
    case "requirements_evidence_grounded":
      return "requirements_evidence_grounded：用户结果、可观察验收、保留行为、证据、行为因果路径和关键未知必须完整；存在阻塞规划的未知项不得 completed。";
    case "needs_rework_target_required":
      return "needs_rework_target_required：status=needs_rework 时必须带 rework_target_stage_id。";
    case "unknowns_present":
      return "unknowns_present：unknowns 不能为空或仅写'无/none/n/a'。陌生代码区域几乎不存在'无未知'，请如实暴露。";
    case "item_matrix_when_multi":
      return "item_matrix_when_multi：任务涉及 ≥3 同类条目（数字范围/批量/逗号列表）时，required_outputs.item_matrix 必须是合法 markdown 表。";
    case "confidence_levels_present":
      return "confidence_levels_present：investigate 的 output_summary 必须出现置信度标记（high/medium/low 或'置信度'），每个 finding 标 [等级 + 依据类型]。self_review 优先核对 low/medium。";
    case "callsites_inventory_present":
      return "callsites_inventory_present：investigate 的 output_summary 必须含 '## 调用方清单' 标题段落，列目标符号所有调用方 + 每处语义假设。无目标符号可写'本次无目标符号'。";
    case "boundary_enumeration_present":
      return "boundary_enumeration_present：investigate 的 output_summary 必须含 '## 边界与异常路径' 标题段落，枚举空/零/负/并发/超时/失败/超大输入等已知需处理的边缘情况。";
    case "preflight_risks_present":
      return "preflight_risks_present：design 的 output_summary 必须含 '## 事前风险' 标题段落，列出最易出错处与最没把握的反例（事前预演，非事后挑刺）。";
    case "design_alternatives_present":
      return "design_alternatives_present：design 的 output_summary 必须含 '## 候选方案' 标题段落，列 ≥2 候选并排比较（复杂度/风险/可逆性维度）+ 选定理由。不允许只写一个方案。";
    case "design_quadrant_eval_present":
      return "design_quadrant_eval_present：design 的 output_summary 必须含 '## 方案评估' 标题段落，对选定方案给性能/安全/扩展/可维护四维简评（每维一两句 + 风险等级）。";
    case "implement_delta_check_present":
      return "implement_delta_check_present：implement 的 output_summary 必须含 '## 改动核对' 标题段落，每个改过文件一段（推进了哪条 success_criteria + 新风险）。未改动也要写说明。";
    case "rollback_plan_when_irreversible":
      return "rollback_plan_when_irreversible：implement 若执行了不可逆操作（rm/git reset/git clean/drop table/truncate），output_summary 必须含'回滚'或'rollback'字样，并在 '## 改动核对' 子段写明回滚步骤。";
    default:
      return `${name}：（断言）`;
  }
}

// ── 上下文压缩辅助函数 ──

interface BuildLinesOptions {
  /** 激进模式：所有前序阶段只保留 output_summary，去掉 required_outputs JSON */
  aggressive?: boolean;
}

function buildPreviousStageLines(input: StageAgentInput, opts?: BuildLinesOptions): string {
  const { aggressive = false } = opts ?? {};
  const summaries = input.previous_stage_summaries;
  if (summaries.length === 0) return "";

  // 激进模式：所有阶段只保留 output_summary
  if (aggressive) {
    return summaries
      .map((s) => `- ${s.stage_id} attempt ${s.attempt}: ${s.output_summary ?? s.status}`)
      .join("\n");
  }

  // 正常模式：最近 RECENT_STAGE_COUNT 个阶段保留 output_summary + 截断后的 required_outputs；
  // 更早的阶段只保留 output_summary（其关键信息已被后续阶段消费并转化）。
  const recentStart = Math.max(0, summaries.length - RECENT_STAGE_COUNT);

  return summaries
    .map((summary, idx) => {
      const isRecent = idx >= recentStart;
      const requiredOutputs = isRecent && summary.required_outputs && Object.keys(summary.required_outputs).length > 0
        ? `\n  required_outputs: ${JSON.stringify(truncateRequiredOutputs(summary.required_outputs, MAX_ARRAY_ITEMS, MAX_STRING_LENGTH))}`
        : "";
      return `- ${summary.stage_id} attempt ${summary.attempt}: ${summary.output_summary ?? summary.status}${requiredOutputs}`;
    })
    .join("\n");
}

function truncateRequiredOutputs(
  value: unknown,
  maxArrayItems: number,
  maxStringLen: number
): unknown {
  if (Array.isArray(value)) {
    if (value.length <= maxArrayItems) {
      return value.map((item) => truncateRequiredOutputs(item, maxArrayItems, maxStringLen));
    }
    const shown = value.slice(0, maxArrayItems).map((item) => truncateRequiredOutputs(item, maxArrayItems, maxStringLen));
    shown.push(`[${value.length} items total, showing first ${maxArrayItems}]`);
    return shown;
  }

  if (typeof value === "string") {
    if (value.length <= maxStringLen) return value;
    return `${value.slice(0, maxStringLen)}... [truncated ${value.length}→${maxStringLen} chars]`;
  }

  if (value !== null && typeof value === "object") {
    const truncated: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      truncated[key] = truncateRequiredOutputs(val, maxArrayItems, maxStringLen);
    }
    return truncated;
  }

  return value;
}

function buildReviewChangeSummary(input: StageAgentInput): string | null {
  const summaries = input.previous_stage_summaries;
  if (summaries.length === 0) return null;

  const lines: string[] = [];

  // 从 understand 提取目标与 DoD
  const understandOutputs = summaries.find((s) => s.stage_id === "understand")?.required_outputs;
  if (understandOutputs) {
    const goal = typeof understandOutputs.user_goal_restated === "string" ? understandOutputs.user_goal_restated : null;
    const dod = Array.isArray(understandOutputs.definition_of_done) ? understandOutputs.definition_of_done : [];
    if (goal) lines.push(`- 用户目标：${truncateString(goal, 150)}`);
    for (const d of dod.slice(0, 5)) {
      if (typeof d === "string") lines.push(`  - DoD：${truncateString(d, 100)}`);
    }
    if (dod.length > 5) lines.push(`  - ... 共 ${dod.length} 条 DoD`);
  }

  // 从 design 提取选定方案与风险
  const designOutputs = summaries.find((s) => s.stage_id === "design")?.required_outputs;
  if (designOutputs) {
    const plan = Array.isArray(designOutputs.selected_plan) ? designOutputs.selected_plan : [];
    lines.push(`- 选定方案：${plan.length} 步`);
    for (const step of plan.slice(0, 5)) {
      if (step && typeof step === "object" && typeof (step as Record<string, unknown>).step === "string") {
        lines.push(`  - ${truncateString((step as Record<string, unknown>).step as string, 120)}`);
      }
    }

    const risks = Array.isArray(designOutputs.risk_register) ? designOutputs.risk_register : [];
    if (risks.length > 0) {
      lines.push(`- 风险登记：${risks.length} 条`);
      for (const risk of risks.slice(0, 3)) {
        if (risk && typeof risk === "object" && typeof (risk as Record<string, unknown>).risk === "string") {
          lines.push(`  - ${truncateString((risk as Record<string, unknown>).risk as string, 100)}`);
        }
      }
    }
  }

  // 从 implement 提取改动文件
  const implementOutputs = summaries.find((s) => s.stage_id === "implement")?.required_outputs;
  if (implementOutputs) {
    const changedFiles = Array.isArray(implementOutputs.changed_files) ? implementOutputs.changed_files : [];
    if (changedFiles.length > 0) {
      lines.push(`- 改动文件：${changedFiles.length} 个`);
      for (const cf of changedFiles.slice(0, 8)) {
        if (cf && typeof cf === "object") {
          const file = (cf as Record<string, unknown>).file;
          const changes = (cf as Record<string, unknown>).changes;
          if (typeof file === "string") {
            const changeSummary = Array.isArray(changes) ? truncateString(changes.join("; "), 80) : "";
            lines.push(`  - ${file}${changeSummary ? `：${changeSummary}` : ""}`);
          }
        }
      }
      if (changedFiles.length > 8) lines.push(`  - ... 共 ${changedFiles.length} 个文件`);
    }

    const validation = implementOutputs.validation_run;
    if (validation && typeof validation === "object") {
      const commands = Array.isArray((validation as Record<string, unknown>).commands_executed)
        ? (validation as Record<string, unknown>).commands_executed as string[]
        : [];
      const results = typeof (validation as Record<string, unknown>).results === "string"
        ? (validation as Record<string, unknown>).results as string
        : "";
      if (commands.length > 0) {
        lines.push(`- 已执行验证：${commands.join(", ")}`);
        if (results) lines.push(`  - 结果：${truncateString(results, 150)}`);
      }
    }
  }

  // 从 investigate 提取关键证据（低置信度优先——自审重点）
  const investigateOutputs = summaries.find((s) => s.stage_id === "investigate")?.required_outputs;
  if (investigateOutputs) {
    const findings = Array.isArray(investigateOutputs.evidence_findings) ? investigateOutputs.evidence_findings : [];
    const lowConfidenceFindings = findings.filter((f) => {
      if (f && typeof f === "object") {
        const conf = (f as Record<string, unknown>).confidence;
        return conf === "low" || conf === "medium";
      }
      return false;
    });
    if (lowConfidenceFindings.length > 0) {
      lines.push(`- 低/中置信度证据（自审重点）：${lowConfidenceFindings.length} 条`);
      for (const f of lowConfidenceFindings.slice(0, 3)) {
        const finding = (f as Record<string, unknown>).finding;
        if (typeof finding === "string") lines.push(`  - ${truncateString(finding, 100)}`);
      }
    }
  }

  // 从 align 提取关键约束
  const alignOutputs = summaries.find((s) => s.stage_id === "align")?.required_outputs;
  if (alignOutputs) {
    const constraints = Array.isArray(alignOutputs.lateral_constraints) ? alignOutputs.lateral_constraints : [];
    if (constraints.length > 0) {
      lines.push(`- 横向约束：${constraints.length} 条`);
      for (const c of constraints.slice(0, 5)) {
        const constraint = c && typeof c === "object" ? (c as Record<string, unknown>).constraint : null;
        if (typeof constraint === "string") lines.push(`  - ${truncateString(constraint, 100)}`);
      }
    }
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

function truncateString(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen)}...`;
}

import type { StageAgentInput, StageHooksConfig } from "../../shared/types.js";
import { isMeaningfulAgentText } from "../../shared/agentMessages.js";

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

  const retrySection = input.retry_context
    ? [
        "",
        `本次为当前阶段的重试（上次为第 ${input.retry_context.previous_attempt} 次尝试）：`,
        `- 上次失败原因/总结：${input.retry_context.output_summary}`,
        "请认真分析失败原因，避免重复同样的错误，优先采取与上次不同的策略或更小的改动。"
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

  const allowedTools = input.allowed_tools.length ? input.allowed_tools.join(", ") : "read-only defaults";
  const requiredOutputs = input.required_outputs.length ? input.required_outputs.join(", ") : "concise stage summary";
  const gates = input.gates.length ? input.gates.join(", ") : "none";
  const hookSections = describeStageHooks(input.current_stage.hooks);

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

  return [
    `你正在执行「${input.workflow.name}」工作流。`,
    "请始终使用简体中文回答，包括阶段总结、问题说明、审批请求和最终 JSON 中的自然语言内容。",
    "像一名谨慎的人类开发者一样推进：先理解意图，再查看证据，形成假设，比较方案，实施最小改动，并用验证结果校准判断。",
    "优先解决真实用户问题，而不是机械完成字段；如果流程字段与问题本质有张力，请在阶段输出中解释取舍。",
    "每个阶段都要把判断建立在可观察事实上：代码、配置、测试、错误信息、用户明确要求或前序阶段摘要。",
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
    "入境验收（重要）：如果存在前序阶段摘要（即非首阶段），动手当前阶段工作之前必须先核对前序阶段产出是否满足本阶段的输入要求——",
    "  - 核对维度：前序阶段的 output_summary 是否覆盖了它声明的 required_outputs / 必写核心段；内容是否具体可用（不是空话套话）；是否与当前阶段任务衔接。",
    "  - 不合格时：把当前阶段 status 写成 needs_rework、rework_target_stage_id 指向不合格的前序阶段、rework_reason 用一两句中文写明哪里不合格、缺了什么。",
    "  - 合格时：继续当前阶段工作，无需在 output_summary 里专门说明验收通过。",
    "  - 这不是挑刺，是'我能基于前序产出继续推进吗'的诚实自检——前序产出有缺口却硬推进，只会把问题留到 self_review 才暴露，成本更高。",
    "如果阶段要求输出结构化字段，请让 required_outputs 中的字段内容具体、可复用，并包含支撑判断的事实或路径。",
    "使用任何工具后，或在不需要工具时完成阶段工作后，请通过且仅通过一个符合下方协议的 JSON 对象结束当前阶段。",
    "最终 JSON 对象前后不要添加额外说明文字。",
    "",
    "工作流概览：",
    stageLines,
    "",
    "此前阶段摘要：",
    previousStageLines || "无",
    retrySection,
    reworkSection,
    "",
    "当前阶段：",
    `id: ${input.current_stage.id}`,
    `名称: ${input.current_stage.name}`,
    input.current_stage.instructions ? `阶段指令:\n${input.current_stage.instructions}` : "阶段指令: 无",
    `allowed_tools: ${allowedTools}`,
    `required_outputs: ${requiredOutputs}`,
    `gates: ${gates}`,
    ...(hookSections.preToolUse
      ? ["", "本阶段工序闸门（在工具调用前由宿主校验，未满足会被 deny 并要求补齐）：", hookSections.preToolUse]
      : []),
    ...(hookSections.postOutput
      ? ["", "本阶段产物自洽性断言（输出落地后由宿主评估，未通过按 auto_retry_limit 重试，超限走 blocked）：", hookSections.postOutput]
      : []),
    "",
    "最终 JSON 协议：",
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
    "可用扩展工具：",
    "- mcp__ai_coder__ask_human(question: string, type: \"single\"|\"multi\"|\"text\", options?: [{value,label}])",
    "  向用户提问并暂停执行。single/multi 时 options 必填。仅在你确实需要用户的偏好、选择或缺失信息时使用，不要因为可以求助就回避自己应该做的判断。",
    "  调用该工具后工作流会暂停；用户回答后下一轮指令的\"人类问答历史\"部分会包含答案。",
    "",
    "人类问答历史（你之前向用户提的问题及回答）：",
    humanQaHistory || "无",
    "请基于这些答案继续推进；不要重复已经回答过的问题。",
    "",
    "对话历史：",
    messageHistory || "无"
  ].join("\n");
}

/**
 * 把 stage.hooks 翻译成两段人话提示，让模型在动手前就知道闸门规则。
 *
 * 返回 { preToolUse, postOutput }：分别对应"动手前由宿主拦截 deny"和"输出后宿主评估 retry"。
 * 这两类机制语义不同（前者是工具调用前的硬挡 + 由用户写的 on_fail 文案；后者是输出落地后的
 * retry/block + 由引擎写的固定文案）——分两段返回让调用方各自加 header，避免模型把它们混为一谈。
 *
 * 任何一段为空时对应字段为 null，调用方据此决定是否在 prompt 里渲染该段。
 */
function describeStageHooks(hooks: StageHooksConfig | undefined): { preToolUse: string | null; postOutput: string | null } {
  const preToolUse = describePreToolUse(hooks?.pre_tool_use);
  const postOutput = describePostOutputAssertions(hooks?.post_output_assertions);
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

function describePostOutputAssertions(assertions: StageHooksConfig["post_output_assertions"]): string | null {
  if (!assertions || assertions.length === 0) return null;
  return assertions.map((name, idx) => `${idx + 1}. ${describeAssertion(name)}`).join("\n");
}

function describeAssertion(name: string): string {
  switch (name) {
    case "review_self_consistency":
      return "review_self_consistency：output 中出现阻塞类问题信号（blocker/critical/严重不一致/安全问题/高优先级问题…）时，rework_decision 不允许是 pass——要么改 needs_rework，要么改写描述消除阻塞词。";
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

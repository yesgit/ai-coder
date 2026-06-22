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

  const retrySection = input.retry_context
    ? [
        "",
        `本次为当前阶段的重试（上次为第 ${input.retry_context.previous_attempt} 次尝试）：`,
        `- 上次失败原因/总结：${input.retry_context.output_summary}`,
        "请认真分析失败原因，避免重复同样的错误，优先采取与上次不同的策略或更小的改动。"
      ].join("\n")
    : "";

  const allowedTools = input.allowed_tools.length ? input.allowed_tools.join(", ") : "read-only defaults";
  const requiredOutputs = input.required_outputs.length ? input.required_outputs.join(", ") : "concise stage summary";
  const gates = input.gates.length ? input.gates.join(", ") : "none";

  const messageHistory = input.recent_messages
    .filter((m) => (m.content?.trim() && m.content !== "(no content)" && !m.content.startsWith("收到 Claude SDK 消息：")) || m.attachments?.length)
    .map((m) => {
      const roleLabel = m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : "系统";
      let text = `[${roleLabel}]: ${m.content || "(附带附件)"}`;
      if (m.attachments?.length) {
        text += "\n附件（项目相对路径，可用 Read 工具读取）:\n" + m.attachments.map((a) =>
          a.type === "image"
            ? `- [图片] ${a.display_name}（内联 base64，未保存到磁盘）`
            : `- [文件] ${a.path}（显示名: ${a.display_name}）`
        ).join("\n");
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
    "只能读取或修改已选择项目目录内的文件。",
    "不要编造文件内容、命令结果、测试结果或项目规则；不确定时明确说明不确定，并尽量用允许的工具核实。",
    "面对不确定性时，先寻找低成本证据；如果仍不确定，说明最可能的解释、采用的保守假设和可能影响。",
    "避免过度工程：选择能满足验收标准、符合现有代码风格且风险最小的方案。",
    "当策略要求审批时，仍然要正常发起对应工具调用；宿主应用会拦截工具调用、创建审批项并暂停执行。",
    "不要用文字审批请求代替工具调用，也不要仅因为 shell 命令或文件写入需要审批就把阶段标记为 failed。",
    "如果当前阶段发现需要返工到更早阶段，请说明目标阶段和原因，不要自行改变工作流状态。",
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
    "",
    "当前阶段：",
    `id: ${input.current_stage.id}`,
    `名称: ${input.current_stage.name}`,
    input.current_stage.instructions ? `阶段指令:\n${input.current_stage.instructions}` : "阶段指令: 无",
    `allowed_tools: ${allowedTools}`,
    `required_outputs: ${requiredOutputs}`,
    `gates: ${gates}`,
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

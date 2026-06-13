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
  const allowedTools = input.allowed_tools.length ? input.allowed_tools.join(", ") : "read-only defaults";
  const requiredOutputs = input.required_outputs.length ? input.required_outputs.join(", ") : "concise stage summary";
  const gates = input.gates.length ? input.gates.join(", ") : "none";

  return [
    `你正在执行「${input.workflow.name}」工作流。`,
    "请始终使用简体中文回答，包括阶段总结、问题说明、审批请求和最终 JSON 中的自然语言内容。",
    "工作流引擎负责控制阶段流转。你只需要完成当前阶段。",
    "你可以参考工作流概览和此前阶段摘要，但不要执行后续阶段。",
    "只能读取或修改已选择项目目录内的文件。",
    "当策略要求审批时，仍然要正常发起对应工具调用；宿主应用会拦截工具调用、创建审批项并暂停执行。",
    "不要用文字审批请求代替工具调用，也不要仅因为 shell 命令或文件写入需要审批就把阶段标记为 failed。",
    "如果当前阶段发现需要返工到更早阶段，请说明目标阶段和原因，不要自行改变工作流状态。",
    "使用任何工具后，请通过且仅通过一个符合下方协议的 JSON 对象结束当前阶段。",
    "最终 JSON 对象前后不要添加额外说明文字。",
    "",
    "工作流概览：",
    stageLines,
    "",
    "此前阶段摘要：",
    previousStageLines || "无",
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
    )
  ].join("\n");
}

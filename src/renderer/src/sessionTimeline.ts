import type {
  AgentMessage,
  AgentSession,
  ApprovalRecord,
  FileChangeRecord,
  HumanQuestion,
  ReworkRequest,
  SessionProgressEvent,
  StageRun,
  ToolCallRecord
} from "../../shared/types.js";
import { isMeaningfulAgentText } from "../../shared/agentMessages.js";
import { formatApprovalKind, formatFileOperation, formatRole, formatStageName, formatStatus } from "./labels.js";
import { formatStageRunStartDetail } from "./stageRunPresentation.js";

export type TimelineEventType = "task" | "stage" | "message" | "approval" | "tool" | "file" | "rework" | "status" | "error";

export interface TimelineEvent {
  id: string;
  type: TimelineEventType;
  title: string;
  detail?: string;
  timestamp: string;
  status?: string;
  sort_order: number;
  /** 是否需要用户处理（待审批/待回答）— 这类事件优先显示在最上面 */
  needs_user_action?: boolean;
}

export function buildSessionTimeline(session: AgentSession): TimelineEvent[] {
  const events: TimelineEvent[] = [
    {
      id: `${session.id}:task`,
      type: "task",
      title: "任务已提交",
      detail: session.task_prompt,
      timestamp: session.created_at,
      status: session.status,
      sort_order: 0
    }
  ];

  if (session.routing) {
    events.push({
      id: `${session.id}:routing`,
      type: "status",
      title: `工作流已${session.routing.requested_mode === "auto" ? "自动选择" : "手动指定"}`,
      detail: session.routing.reason,
      timestamp: session.created_at,
      status: session.routing.method,
      sort_order: 1
    });
  }

  // 找到"最后一条有意义的助手消息" — 该会话仅显示最终回答
  // 中间过程通过 stage_runs / progress_events 体现，避免重复
  let lastAssistantIndex = -1;
  session.messages.forEach((message: AgentMessage, index: number) => {
    if (message.role !== "assistant") return;
    if (!isMeaningfulAgentText(message.content)) return;
    lastAssistantIndex = index;
  });

  session.messages.forEach((message: AgentMessage, index: number) => {
    // 跳过空内容或占位符内容的消息
    if (!isMeaningfulAgentText(message.content)) {
      return;
    }
    const content = message.content?.trim() ?? "";
    // 助手普通消息仅保留最终回答；Skill 使用记录是可审计的运行事实，必须保留。
    if (message.role === "assistant" && message.kind !== "skill_usage" && index !== lastAssistantIndex) {
      return;
    }
    // 把消息文本里嵌入的 JSON 子块包成 ```json``` 代码块，使其在 markdown 中渲染为美化的代码块。
    // 之前只在「整段就是一个 JSON 字面量」时才 prettify（startsWith('{') / '['），
    // 但 agent 常输出「中文叙述 + 末尾甩一段 JSON」，那种形态完全漏掉。
    const formattedContent = formatEmbeddedJsonBlocks(content);
    // display_name 用户可控，需转义 markdown 元字符避免被解析为链接
    const escapeMd = (s: string) => s.replace(/[\\`*_{}\[\]()#+\-.!|<>]/g, "\\$&");
    const attachmentDetail = message.attachments?.length
      ? "\n\n" + message.attachments.map((a) =>
          a.type === "image" ? `[图片: ${escapeMd(a.display_name)}]` : `[文件: ${escapeMd(a.display_name)}]`
        ).join("\n")
      : undefined;
    events.push({
      id: `${session.id}:message:${index}`,
      type: "message",
      title: message.kind === "skill_usage"
        ? "助手使用 Skill"
        : `${formatRole(message.role)}消息${message.attachments?.length ? ` (${message.attachments.length} 个附件)` : ""}`,
      detail: formattedContent + (attachmentDetail ?? ""),
      timestamp: message.created_at,
      status: message.role,
      sort_order: 10
    });
  });

  (session.stage_runs ?? []).forEach((stageRun: StageRun) => {
    events.push({
      id: `${session.id}:stage:${stageRun.id}:started`,
      type: "stage",
      title: `阶段开始：${formatStageName(stageRun.stage_id)} 第 ${stageRun.attempt} 次尝试`,
      detail: formatStageRunStartDetail(stageRun),
      timestamp: stageRun.started_at,
      status: stageRun.status,
      sort_order: 15
    });

    if (stageRun.completed_at) {
      events.push({
        id: `${session.id}:stage:${stageRun.id}:completed`,
        type: "stage",
        title:
          stageRun.status === "needs_rework"
            ? `阶段需要返工：${formatStageName(stageRun.stage_id)} 第 ${stageRun.attempt} 次尝试`
            : `阶段${formatStatus(stageRun.status)}：${formatStageName(stageRun.stage_id)} 第 ${stageRun.attempt} 次尝试`,
        detail: stageRun.rework_reason ?? stageRun.output_summary,
        timestamp: stageRun.completed_at,
        status: stageRun.status,
        sort_order: 16
      });
    }
  });

  // transient 进度（SDK 消息/工具决策/重试中）走独立活动流，不进 timeline 节点；
  // timeline 只留 milestone 进度，保持关键节点干净。
  (session.progress_events ?? []).forEach((progress: SessionProgressEvent) => {
    if (progress.visibility === "transient") return;
    events.push({
      id: `${session.id}:progress:${progress.id}`,
      type: "status",
      title: "运行进度",
      detail: progress.message,
      timestamp: progress.created_at,
      status: progress.type,
      sort_order: 18
    });
  });

  session.approvals.forEach((approval: ApprovalRecord) => {
    const isPending = approval.status === "pending";
    events.push({
      id: `${session.id}:approval:${approval.id}:requested`,
      type: "approval",
      title: `${formatApprovalKind(approval.kind)}审批待处理`,
      detail: approval.message,
      timestamp: approval.created_at,
      status: approval.status,
      sort_order: 20,
      needs_user_action: isPending
    });

    if (approval.resolved_at) {
      events.push({
        id: `${session.id}:approval:${approval.id}:resolved`,
        type: "approval",
        title: `${formatApprovalKind(approval.kind)}审批${formatStatus(approval.status)}`,
        detail: approval.message,
        timestamp: approval.resolved_at,
        status: approval.status,
        sort_order: 21,
        needs_user_action: false
      });
    }
  });

  session.tool_calls.forEach((toolCall: ToolCallRecord) => {
    const isPending = toolCall.status === "pending_approval";
    events.push({
      id: `${session.id}:tool:${toolCall.id}:requested`,
      type: "tool",
      title: `工具请求：${toolCall.tool}`,
      detail: formatJson(toolCall.input),
      timestamp: toolCall.created_at,
      status: toolCall.status,
      sort_order: 30,
      needs_user_action: isPending
    });

    if (toolCall.resolved_at) {
      events.push({
        id: `${session.id}:tool:${toolCall.id}:resolved`,
        type: "tool",
        title: `工具${formatStatus(toolCall.status)}：${toolCall.tool}`,
        detail: formatJson(toolCall.input),
        timestamp: toolCall.resolved_at,
        status: toolCall.status,
        sort_order: 31,
        needs_user_action: false
      });
    }
  });

  session.file_changes.forEach((fileChange: FileChangeRecord, index: number) => {
    const isPending = !fileChange.approved;
    events.push({
      id: `${session.id}:file:${index}`,
      type: "file",
      title: `文件${formatFileOperation(fileChange.operation)}`,
      detail: fileChange.path,
      timestamp: fileChange.created_at,
      status: fileChange.approved ? "approved" : "pending",
      sort_order: 40,
      needs_user_action: isPending
    });
  });

  (session.rework_requests ?? []).forEach((request: ReworkRequest) => {
    const isPending = request.status === "pending";
    events.push({
      id: `${session.id}:rework:${request.id}:requested`,
      type: "rework",
      title: `返工请求：${formatStageName(request.from_stage_id)} -> ${formatStageName(request.target_stage_id)}`,
      detail: request.reason,
      timestamp: request.created_at,
      status: request.status,
      sort_order: 50,
      needs_user_action: isPending
    });

    if (request.resolved_at) {
      events.push({
        id: `${session.id}:rework:${request.id}:resolved`,
        type: "rework",
        title: `返工${formatStatus(request.status)}：${formatStageName(request.target_stage_id)}`,
        detail: request.reason,
        timestamp: request.resolved_at,
        status: request.status,
        sort_order: 51,
        needs_user_action: false
      });
    }
  });

  (session.pending_human_questions ?? []).forEach((question: HumanQuestion) => {
    const isPending = question.status === "pending";
    if (isPending) {
      events.push({
        id: `${session.id}:human-question:${question.id}`,
        type: "message",
        title: `助手提问待回答`,
        detail: question.question,
        timestamp: question.created_at,
        status: "pending",
        sort_order: 25,
        needs_user_action: true
      });
    }
  });

  if (session.error && ["failed", "blocked", "interrupted"].includes(session.status)) {
    const errorTitle =
      session.status === "blocked"
        ? "会话已阻断"
        : session.status === "interrupted"
          ? "会话已中断"
          : "会话失败";
    events.push({
      id: `${session.id}:error`,
      type: "error",
      title: errorTitle,
      detail: session.error,
      timestamp: session.updated_at,
      status: session.status,
      sort_order: 90
    });
  }

  events.push({
    id: `${session.id}:status`,
    type: "status",
    title: `会话${formatStatus(session.status)}`,
    timestamp: session.updated_at,
    status: session.status,
    sort_order: 100
  });

  return events.sort((left, right) => {
    // 需要用户操作的事件（待审批/待回答）优先显示在最上面
    if (left.needs_user_action && !right.needs_user_action) return -1;
    if (right.needs_user_action && !left.needs_user_action) return 1;
    // 同类事件内按时间戳倒序（最新的在前）
    const timeDelta = Date.parse(right.timestamp) - Date.parse(left.timestamp);
    if (timeDelta !== 0) return timeDelta;
    return right.sort_order - left.sort_order;
  });
}

function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

/**
 * 扫描文本，把内嵌的合法 JSON 对象/数组替换成 ```json ``` 代码块。
 *
 * - 已在 ``` fenced code block 内的内容原样保留（避免二次包裹）
 * - 只处理满足以下条件的 JSON 候选：
 *    1) 通过括号配平（粗略支持字符串字面量内的 `{` `}` `[` `]`）找到完整片段
 *    2) `JSON.parse` 成功，且 parse 结果是 object/array（避免误把数学表达式当 JSON）
 *    3) 串长 ≥ 40 字符或 parse 后是带嵌套的复合值——避免把 `{"a":1}` 这种短片段抢走 inline 显示
 * - 不抛错：解析失败的候选原样保留
 */
function formatEmbeddedJsonBlocks(text: string): string {
  if (!text) return text;
  // 没有 `{` `[` 直接返回，省掉一次扫描
  if (text.indexOf("{") === -1 && text.indexOf("[") === -1) return text;

  const segments: string[] = [];
  let i = 0;
  let plainStart = 0;
  // 标识符 + 选项的代码块栅栏：` ``` ` 直到行首再 ``` 才闭合
  const fenceRe = /(^|\n)```/;

  while (i < text.length) {
    const ch = text[i];

    // 跳过已存在的 fenced code block
    if (ch === "`" && text.startsWith("```", i) && (i === 0 || text[i - 1] === "\n")) {
      // 找到闭合的 ``` （行首）
      const rest = text.slice(i + 3);
      const closeMatch = rest.search(fenceRe);
      if (closeMatch === -1) {
        // 没闭合：整段当代码块跳过到末尾
        i = text.length;
      } else {
        // 闭合位置：i + 3 + closeMatch 指向 \n 或 0；前移到 ``` 后
        const closeAt = i + 3 + closeMatch;
        // closeMatch 命中的是 (^|\n)``` 的开头；跳到三反引号之后
        const newlineOffset = text[closeAt] === "\n" ? 1 : 0;
        i = closeAt + newlineOffset + 3;
      }
      continue;
    }

    if (ch !== "{" && ch !== "[") {
      i++;
      continue;
    }

    const end = findBalancedJsonEnd(text, i);
    if (end === -1) {
      i++;
      continue;
    }
    const candidate = text.slice(i, end + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      i++;
      continue;
    }
    if (!parsed || typeof parsed !== "object") {
      i++;
      continue;
    }
    // 短 JSON 内联保留可读性更好；阈值定在 40 字符——能容纳 `{"a":1,"b":2,"c":3}` 这类
    // 单行配置示例，但不会让多键嵌套块漏过
    if (candidate.length < 40) {
      i++;
      continue;
    }

    // flush 前面的普通段
    segments.push(text.slice(plainStart, i));
    // 用 trim 收尾：parse/stringify 已经规范化了空白
    const pretty = formatJson(parsed);
    // 保证前后留空行——MarkdownContent 用了 GFM，紧贴中文会渲染成段内
    segments.push("\n\n```json\n" + pretty + "\n```\n\n");
    i = end + 1;
    plainStart = i;
  }

  segments.push(text.slice(plainStart));
  return segments.join("");
}

/**
 * 从 text[start] 开始（必须是 `{` 或 `[`）找到匹配的闭合括号位置（含）。
 * 字符串字面量内的括号不计数；转义字符按 JSON 规则跳过。
 * 找不到返回 -1。
 */
function findBalancedJsonEnd(text: string, start: number): number {
  const open = text[start];
  const close = open === "{" ? "}" : open === "[" ? "]" : "";
  if (!close) return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        // 必须配对：开 { 闭 } ；开 [ 闭 ]
        return ch === close ? i : -1;
      }
      if (depth < 0) return -1;
    }
  }
  return -1;
}

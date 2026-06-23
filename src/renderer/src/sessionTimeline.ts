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
import { formatApprovalKind, formatFileOperation, formatRole, formatStageName, formatStatus } from "./labels.js";

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
    const content = message.content?.trim() ?? "";
    if (!content || content === "(no content)" || content.startsWith("收到 Claude SDK 消息：")) return;
    lastAssistantIndex = index;
  });

  session.messages.forEach((message: AgentMessage, index: number) => {
    // 跳过空内容或占位符内容的消息
    const content = message.content?.trim();
    if (!content || content === "(no content)" || content.startsWith("收到 Claude SDK 消息：")) {
      return;
    }
    // 助手消息：仅保留最后一条有意义的回答，避免中间过程与最终结果重复
    if (message.role === "assistant" && index !== lastAssistantIndex) {
      return;
    }
    // 尝试格式化 JSON 内容，使其更易读
    let formattedContent = content;
    try {
      if (content.startsWith('{') || content.startsWith('[')) {
        const parsed = JSON.parse(content);
        formattedContent = '```json\n' + JSON.stringify(parsed, null, 2) + '\n```';
      }
    } catch {
      // 不是 JSON，保持原样
    }
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
      title: `${formatRole(message.role)}消息${message.attachments?.length ? ` (${message.attachments.length} 个附件)` : ""}`,
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
      detail: stageRun.input_summary,
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

  (session.progress_events ?? []).filter(isMilestoneProgress).forEach((progress: SessionProgressEvent) => {
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

  if (session.error) {
    events.push({
      id: `${session.id}:error`,
      type: "error",
      title: "会话失败",
      detail: session.error,
      timestamp: session.updated_at,
      status: "failed",
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

function isMilestoneProgress(progress: SessionProgressEvent): boolean {
  return !("visibility" in progress) || progress.visibility === "milestone";
}

function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

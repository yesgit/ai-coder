import type {
  AgentMessage,
  AgentSession,
  ApprovalRecord,
  FileChangeRecord,
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

  session.messages.forEach((message: AgentMessage, index: number) => {
    events.push({
      id: `${session.id}:message:${index}`,
      type: "message",
      title: `${formatRole(message.role)}消息`,
      detail: message.content,
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
    events.push({
      id: `${session.id}:approval:${approval.id}:requested`,
      type: "approval",
      title: `${formatApprovalKind(approval.kind)}审批待处理`,
      detail: approval.message,
      timestamp: approval.created_at,
      status: approval.status,
      sort_order: 20
    });

    if (approval.resolved_at) {
      events.push({
        id: `${session.id}:approval:${approval.id}:resolved`,
        type: "approval",
        title: `${formatApprovalKind(approval.kind)}审批${formatStatus(approval.status)}`,
        detail: approval.message,
        timestamp: approval.resolved_at,
        status: approval.status,
        sort_order: 21
      });
    }
  });

  session.tool_calls.forEach((toolCall: ToolCallRecord) => {
    events.push({
      id: `${session.id}:tool:${toolCall.id}:requested`,
      type: "tool",
      title: `工具请求：${toolCall.tool}`,
      detail: formatJson(toolCall.input),
      timestamp: toolCall.created_at,
      status: toolCall.status,
      sort_order: 30
    });

    if (toolCall.resolved_at) {
      events.push({
        id: `${session.id}:tool:${toolCall.id}:resolved`,
        type: "tool",
        title: `工具${formatStatus(toolCall.status)}：${toolCall.tool}`,
        detail: formatJson(toolCall.input),
        timestamp: toolCall.resolved_at,
        status: toolCall.status,
        sort_order: 31
      });
    }
  });

  session.file_changes.forEach((fileChange: FileChangeRecord, index: number) => {
    events.push({
      id: `${session.id}:file:${index}`,
      type: "file",
      title: `文件${formatFileOperation(fileChange.operation)}`,
      detail: fileChange.path,
      timestamp: fileChange.created_at,
      status: fileChange.approved ? "approved" : "pending",
      sort_order: 40
    });
  });

  (session.rework_requests ?? []).forEach((request: ReworkRequest) => {
    events.push({
      id: `${session.id}:rework:${request.id}:requested`,
      type: "rework",
      title: `返工请求：${formatStageName(request.from_stage_id)} -> ${formatStageName(request.target_stage_id)}`,
      detail: request.reason,
      timestamp: request.created_at,
      status: request.status,
      sort_order: 50
    });

    if (request.resolved_at) {
      events.push({
        id: `${session.id}:rework:${request.id}:resolved`,
        type: "rework",
        title: `返工${formatStatus(request.status)}：${formatStageName(request.target_stage_id)}`,
        detail: request.reason,
        timestamp: request.resolved_at,
        status: request.status,
        sort_order: 51
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
    const timeDelta = Date.parse(left.timestamp) - Date.parse(right.timestamp);
    if (timeDelta !== 0) return timeDelta;
    return left.sort_order - right.sort_order;
  });
}

function isMilestoneProgress(progress: SessionProgressEvent): boolean {
  return !("visibility" in progress) || progress.visibility === "milestone";
}

function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

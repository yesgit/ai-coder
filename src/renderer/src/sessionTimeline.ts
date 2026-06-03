import type { AgentMessage, AgentSession, ApprovalRecord, FileChangeRecord, ToolCallRecord } from "../../shared/types.js";

export type TimelineEventType = "task" | "message" | "approval" | "tool" | "file" | "status" | "error";

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
      title: "Task submitted",
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
      title: `${capitalize(message.role)} message`,
      detail: message.content,
      timestamp: message.created_at,
      status: message.role,
      sort_order: 10
    });
  });

  session.approvals.forEach((approval: ApprovalRecord) => {
    events.push({
      id: `${session.id}:approval:${approval.id}:requested`,
      type: "approval",
      title: `${capitalize(approval.kind)} approval requested`,
      detail: approval.message,
      timestamp: approval.created_at,
      status: approval.status,
      sort_order: 20
    });

    if (approval.resolved_at) {
      events.push({
        id: `${session.id}:approval:${approval.id}:resolved`,
        type: "approval",
        title: `${capitalize(approval.kind)} approval ${approval.status}`,
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
      title: `Tool requested: ${toolCall.tool}`,
      detail: formatJson(toolCall.input),
      timestamp: toolCall.created_at,
      status: toolCall.status,
      sort_order: 30
    });

    if (toolCall.resolved_at) {
      events.push({
        id: `${session.id}:tool:${toolCall.id}:resolved`,
        type: "tool",
        title: `Tool ${toolCall.status}: ${toolCall.tool}`,
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
      title: `File ${fileChange.operation}`,
      detail: fileChange.path,
      timestamp: fileChange.created_at,
      status: fileChange.approved ? "approved" : "pending",
      sort_order: 40
    });
  });

  if (session.error) {
    events.push({
      id: `${session.id}:error`,
      type: "error",
      title: "Session failed",
      detail: session.error,
      timestamp: session.updated_at,
      status: "failed",
      sort_order: 90
    });
  }

  events.push({
    id: `${session.id}:status`,
    type: "status",
    title: `Session ${session.status}`,
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

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

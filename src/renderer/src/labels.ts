import type {
  ApprovalRecord,
  AgentMessage,
  FileChangeRecord,
  SessionStatus,
  StageRunStatus,
  ToolCallRecord,
  WorkflowSourceType
} from "../../shared/types.js";

const STATUS_LABELS: Record<string, string> = {
  created: "已创建",
  running: "运行中",
  waiting_approval: "等待审批",
  blocked: "已阻断",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
  pending: "待处理",
  approved: "已批准",
  denied: "已拒绝",
  pending_approval: "等待审批",
  needs_rework: "需要返工",
  superseded: "已被替代",
  not_started: "未开始",
  claude_md_exists: "待确认",
  pending_review: "待复核",
  confirmed: "已确认",
  mock: "模拟",
  live: "实时",
  runner: "执行器",
  sdk_message: "SDK消息",
  tool_policy: "工具策略",
  status: "状态"
};

const ROLE_LABELS: Record<AgentMessage["role"], string> = {
  user: "用户",
  assistant: "助手",
  system: "系统"
};

const APPROVAL_KIND_LABELS: Record<ApprovalRecord["kind"], string> = {
  stage: "阶段",
  shell: "命令",
  file: "文件"
};

const FILE_OPERATION_LABELS: Record<FileChangeRecord["operation"], string> = {
  create: "创建",
  update: "更新",
  delete: "删除"
};

const SOURCE_LABELS: Record<WorkflowSourceType, string> = {
  builtin: "内置",
  user: "用户",
  project: "项目",
  marketplace: "市场"
};

const WORKFLOW_LABELS: Record<string, { name: string; description?: string }> = {
  "careful-coder": {
    name: "谨慎程序员",
    description: "先建立或调整项目画像，再按理解、勘察、对齐、方案、实施、自审推进编码任务。"
  }
};

const STAGE_LABELS: Record<string, string> = {
  understand: "理解",
  plan: "计划",
  execute: "执行",
  verify: "验证",
  summarize: "总结",
  requirements: "需求分析",
  code_reading: "代码阅读",
  impact_analysis: "影响分析",
  implementation: "编码实现",
  test: "测试",
  collect_context: "收集上下文",
  identify_risks: "识别风险",
  report: "报告",
  scan_project: "扫描项目画像",
  update_project_profile: "建立或调整项目画像",
  understand_project: "理解项目",
  draft_memory: "起草项目画像",
  write_memory: "写入项目画像",
  review: "复核"
};

export function formatStatus(status: SessionStatus | StageRunStatus | ToolCallRecord["status"] | string): string {
  return STATUS_LABELS[status] ?? status;
}

export function formatRole(role: AgentMessage["role"]): string {
  return ROLE_LABELS[role] ?? role;
}

export function formatApprovalKind(kind: ApprovalRecord["kind"]): string {
  return APPROVAL_KIND_LABELS[kind] ?? kind;
}

export function formatFileOperation(operation: FileChangeRecord["operation"]): string {
  return FILE_OPERATION_LABELS[operation] ?? operation;
}

export function formatWorkflowSource(source: WorkflowSourceType): string {
  return SOURCE_LABELS[source] ?? source;
}

export function formatWorkflowName(id: string, fallback: string): string {
  return WORKFLOW_LABELS[id]?.name ?? fallback;
}

export function formatWorkflowDescription(id: string, fallback: string): string {
  return WORKFLOW_LABELS[id]?.description ?? fallback;
}

export function formatStageName(id: string, fallback?: string): string {
  return STAGE_LABELS[id] ?? fallback ?? id;
}

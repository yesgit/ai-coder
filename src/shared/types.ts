export type WorkflowSourceType = "builtin" | "user" | "project" | "marketplace";

export interface WorkflowSource {
  type: WorkflowSourceType;
  id: string;
  version?: string;
  path?: string;
}

export interface WorkflowPermissions {
  filesystem?: {
    mode: "project-only";
  };
  shell?: {
    approval_required: boolean;
  };
  network?: {
    enabled: boolean;
  };
}

export interface WorkflowStage {
  id: string;
  name: string;
  approval_required?: boolean;
  allowed_tools?: string[];
  required_outputs?: string[];
  required_checks?: string[];
  gates?: string[];
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  version: string;
  description: string;
  source: WorkflowSource;
  permissions: WorkflowPermissions;
  stages: WorkflowStage[];
}

export interface WorkflowLoadIssue {
  source_type: WorkflowSourceType;
  path: string;
  message: string;
}

export interface WorkflowListResult {
  workflows: WorkflowTemplate[];
  issues: WorkflowLoadIssue[];
}

export type SessionStatus = "created" | "running" | "waiting_approval" | "blocked" | "completed" | "failed";

export interface AgentMessage {
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
}

export interface ToolCallRecord {
  id: string;
  stage_id: string;
  tool: string;
  input: unknown;
  status: "pending_approval" | "approved" | "denied" | "completed" | "blocked";
  created_at: string;
  resolved_at?: string;
}

export interface FileChangeRecord {
  path: string;
  operation: "create" | "update" | "delete";
  approved: boolean;
  created_at: string;
}

export interface ApprovalRecord {
  id: string;
  stage_id: string;
  kind: "stage" | "shell" | "file";
  status: "pending" | "approved" | "denied";
  message: string;
  created_at: string;
  resolved_at?: string;
}

export interface AgentSession {
  id: string;
  project_path: string;
  workflow_id: string;
  task_prompt: string;
  status: SessionStatus;
  current_stage: string;
  messages: AgentMessage[];
  tool_calls: ToolCallRecord[];
  file_changes: FileChangeRecord[];
  approvals: ApprovalRecord[];
  created_at: string;
  updated_at: string;
  error?: string;
}

export interface StartSessionInput {
  projectPath: string;
  workflowId: string;
  taskPrompt: string;
}

export interface StartSessionResult {
  session: AgentSession;
}

export interface AppApi {
  selectProjectDirectory(): Promise<string | null>;
  listWorkflows(projectPath?: string): Promise<WorkflowListResult>;
  startSession(input: StartSessionInput): Promise<StartSessionResult>;
  listSessions(): Promise<AgentSession[]>;
  getSession(id: string): Promise<AgentSession | null>;
  approveStage(sessionId: string, stageId: string): Promise<AgentSession>;
  approveToolCall(sessionId: string, toolCallId: string): Promise<AgentSession>;
  denyToolCall(sessionId: string, toolCallId: string): Promise<AgentSession>;
  continueSession(sessionId: string): Promise<AgentSession>;
}

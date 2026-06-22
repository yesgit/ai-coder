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

export interface WorkflowReworkPolicy {
  enabled: boolean;
  allowed_targets: string[];
  approval_required: boolean;
  invalidate_downstream: boolean;
}

export interface WorkflowStage {
  id: string;
  name: string;
  instructions?: string;
  approval_required?: boolean;
  allowed_tools?: string[];
  required_outputs?: string[];
  required_checks?: string[];
  gates?: string[];
  auto_retry_limit?: number;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  version: string;
  description: string;
  source: WorkflowSource;
  permissions: WorkflowPermissions;
  rework: WorkflowReworkPolicy;
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

export type SessionStatus =
  | "created"
  | "running"
  | "waiting_approval"
  | "blocked"
  | "completed"
  | "failed"
  | "interrupted";

export type StageRunStatus =
  | "pending"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "needs_rework"
  | "superseded";

export interface StageRun {
  id: string;
  stage_id: string;
  attempt: number;
  status: StageRunStatus;
  input_summary: string;
  output_summary?: string;
  started_at: string;
  completed_at?: string;
  rework_reason?: string;
  retry_reason?: string;
}

export interface ReworkRequest {
  id: string;
  from_stage_id: string;
  target_stage_id: string;
  status: "pending" | "approved" | "denied";
  reason: string;
  created_at: string;
  resolved_at?: string;
}

export interface StageSummary {
  stage_id: string;
  attempt: number;
  status: StageRunStatus;
  output_summary?: string;
}

export interface WorkflowOverviewStage {
  id: string;
  name: string;
  approval_required: boolean;
  required_outputs: string[];
  required_checks: string[];
  gates: string[];
}

export interface StageRetryContext {
  previous_attempt: number;
  output_summary: string;
}

export interface StageAgentInput {
  workflow: {
    id: string;
    name: string;
    description: string;
    stages: WorkflowOverviewStage[];
  };
  previous_stage_summaries: StageSummary[];
  current_stage: WorkflowStage;
  task_prompt: string;
  project_path: string;
  allowed_tools: string[];
  required_outputs: string[];
  gates: string[];
  retry_context?: StageRetryContext;
  recent_messages: AgentMessage[];
}

export interface StageAgentResult {
  status: "completed" | "failed" | "needs_rework";
  output_summary: string;
  required_outputs?: Record<string, unknown>;
  rework_target_stage_id?: string;
  rework_reason?: string;
  error?: string;
}

export interface FileRefAttachment {
  type: "file_ref";
  path: string;
  display_name: string;
}

export interface ImageAttachment {
  type: "image";
  data_base64: string;
  media_type: string;
  display_name: string;
}

export type Attachment = FileRefAttachment | ImageAttachment;

export interface AgentMessage {
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
  attachments?: Attachment[];
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

export interface SessionProgressEvent {
  id: string;
  type: "runner" | "sdk_message" | "tool_policy" | "status";
  message: string;
  visibility: "transient" | "milestone";
  created_at: string;
}

export interface ApprovalRecord {
  id: string;
  stage_id: string;
  stage_run_id?: string;
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
  progress_events?: SessionProgressEvent[];
  stage_runs?: StageRun[];
  rework_requests?: ReworkRequest[];
  onboarding?: SessionOnboardingSnapshot;
  created_at: string;
  updated_at: string;
  error?: string;
}

export interface SessionOnboardingSnapshot {
  status: ProjectOnboardingStatus["status"];
  claude_md_hash?: string;
  override: boolean;
  checked_at: string;
}

export interface StartSessionInput {
  projectPath: string;
  workflowId: string;
  taskPrompt: string;
  onboardingOverride?: boolean;
  attachments?: Attachment[];
}

export interface StartSessionResult {
  session: AgentSession;
}

export interface AgentRuntimeStatus {
  mode: "mock" | "live";
  sdk_available: boolean;
  node_runtime_available: boolean;
  auth_env_available: boolean;
  diagnostics: string[];
}

export interface ProjectOnboardingStatus {
  status: "not_started" | "claude_md_exists" | "pending_review" | "confirmed";
  project_path: string;
  claude_md_path: string;
  claude_md_exists: boolean;
  claude_md_hash?: string;
  confirmed_at?: string;
  confirmed_by?: "local-user";
}

export interface AppApi {
  selectProjectDirectory(): Promise<string | null>;
  getAgentRuntimeStatus(): Promise<AgentRuntimeStatus>;
  getProjectOnboardingStatus(projectPath: string): Promise<ProjectOnboardingStatus>;
  confirmProjectOnboarding(projectPath: string): Promise<ProjectOnboardingStatus>;
  listWorkflows(projectPath?: string): Promise<WorkflowListResult>;
  startSession(input: StartSessionInput): Promise<StartSessionResult>;
  listSessions(): Promise<AgentSession[]>;
  getSession(id: string): Promise<AgentSession | null>;
  approveStage(sessionId: string, stageId: string): Promise<AgentSession>;
  authorizeStage(sessionId: string, stageId: string): Promise<AgentSession>;
  approveRework(sessionId: string, requestId: string): Promise<AgentSession>;
  approveToolCall(sessionId: string, toolCallId: string): Promise<AgentSession>;
  denyToolCall(sessionId: string, toolCallId: string): Promise<AgentSession>;
  continueSession(sessionId: string): Promise<AgentSession>;
  resumeSession(sessionId: string): Promise<AgentSession>;
  sendMessage(sessionId: string, message: string, attachments?: Attachment[]): Promise<AgentSession>;
  listProjectFiles(projectPath: string, query?: string): Promise<string[]>;
  readProjectFile(projectPath: string, filePath: string): Promise<string>;
}

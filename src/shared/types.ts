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

export interface WorkflowRoutingConfig {
  enabled: boolean;
  auto_start: boolean;
  keywords: string[];
  examples: string[];
}

/**
 * 阶段级工序闸门：在工具调用真正落地前，由 `stageHookEnforcer` 评估。
 * 与 `projectPolicy.approveOrDenyToolUse`（策略层 = 能不能做）解耦——hook 只管"按不按顺序做"。
 * 字段命名用 yaml 风格（snake_case），由 zod schema 透传到此处。
 */
export interface PreToolUseHookRule {
  when: {
    /** SDK 工具名（大写驼峰）：Edit/MultiEdit/Write/Bash/Read/Grep 等。可单值或数组。 */
    tool?: string | string[];
    /** 仅当 tool 含 Bash 时生效：input.command 须包含其中任一子串才匹配规则。 */
    command_contains?: string[];
  };
  require: {
    /** 目标文件被 Read/Grep/Glob 命中次数下限（来自 session.tool_calls 历史）。 */
    same_file_reads_min?: number;
    /** 本会话内必须执行过包含这些子串的 Bash 命令（每条都要满足）。 */
    shell_must_have_run?: string[];
    /** 本阶段必须发起过 ask_human（pending_human_questions 中至少一条 stage_id 匹配的记录）。 */
    ask_human_consent?: boolean;
  };
  /** 拦截时回传给模型的中文人话提示。 */
  on_fail: string;
}

/**
 * 阶段产物落地时跑的内置断言名集合。
 *
 * 与 pre_tool_use 解耦——pre_tool_use 挡"动手前没准备好"，
 * 这里挡"动手完发现自己列出问题却写 pass"这类输出侧的自相矛盾。
 *
 * 断言名是枚举（不是 JS 表达式），实现写在 stageOutputAssertions.ts，
 * 一一对应。yaml 端按名字声明，无法注入逻辑。
 */
export type StageOutputAssertion =
  /** review 类阶段：findings/summary 含阻塞词时，rework_decision 不能是 pass */
  | "review_self_consistency"
  /** status=needs_rework 时必须带 rework_target_stage_id */
  | "needs_rework_target_required"
  /** investigate 类阶段：unknowns 必须显式给出非空内容（不允许沉默） */
  | "unknowns_present"
  /** design 类阶段：当任务文字含枚举性提示（多/批量/范围/逗号列表）时，必须输出 markdown 矩阵 */
  | "item_matrix_when_multi"
  /**
   * investigate 类阶段：required_outputs.investigation_tasks 中每条 task 的 status 必须 ∈
   * {done, deferred}，deferred 必须配 defer_reason。pending/in_progress 残留视为"调查未闭合"。
   * 配合"先拟定任务清单、逐项落实、复盘补漏"的人类思维 loop——闭环前不许进入 align/design。
   */
  | "all_tasks_resolved"
  /**
   * findings 必须可追溯：每条 finding.from_hypothesis 在 hypotheses 中存在，
   * 且其 linked task 的 verdict ∈ {confirmed, refuted}。
   * 阻断"未取证就开列结论"。
   */
  | "findings_traceable_to_probes"
  /**
   * findings[*] 文本中含 hedge 措辞（可能/或许/似乎/疑似/maybe/might/likely）→ 失败。
   * 强制 demote 到 unknowns 或补取证 task——避免用模糊措辞绕过取证义务。
   */
  | "hedged_findings_demoted"
  /**
   * plan_readiness.sufficient === false 时，unknowns 或 investigation_tasks[status=pending] 必须非空。
   * 禁止"自报方案不 ready 但啥都不补"。
   */
  | "plan_readiness_honest"
  /**
   * raw 输出尾部存在未闭合 JSON（bracket_balance != 0 或 last 合法 JSON 之后还有大段 JSON 残骸）→ 失败。
   * 跨场景通用——结构性断言，不绑定具体任务类型，建议每阶段都挂。
   */
  | "no_trailing_unparsed_payload"
  /**
   * design 类阶段：plan_steps[*].supporting_finding_ids 中每个 id 必须能在 investigate.findings 找到。
   * 阻断"想出方案但没挂到 finding"——动手前的步骤必须有取证血脉。
   */
  | "plan_steps_grounded"
  /**
   * implement 类阶段：deviations_from_plan 非空时，plan_revisions 必须有对应条目。
   * 阻断"动手中发现 plan 跑不通但闷头改下去"。
   */
  | "deviations_must_be_revised"
  /**
   * implement 类阶段：任一 deviation 自报 out_of_scope=true 时，stage 必须 needs_rework 回 design。
   * 阻断"偏差超出 design 边界但还在 implement 内继续"。
   */
  | "deviation_severity_must_rework"
  /**
   * self_review 阶段：rework_decision="pass" 时同时要求
   *   - phase_1_self_check 无 status=missing 项（partial 必须有 mitigation）
   *   - phase_2_tests.green === true
   *   - phase_3_adversarial_review 三类 findings 无 severity=high
   *   - residual_risks 为空、investigate.unknowns 已关闭
   * 否则必须改为 pass_with_followups（每条 residual 配 followup_owner+followup_action）或 needs_rework。
   */
  | "pass_requires_all_validated"
  /**
   * design 阶段：plan_steps 每条必须填 perf_consideration / security_consideration /
   * extensibility_consideration 三栏。允许写"不适用 + 原因"——目的是让"三个维度都想过"
   * 成为肌肉记忆，而非要求所有任务都涉及性能/安全/扩展性。
   * 全栏空（或只写"无"/"none"）→ fail。
   */
  | "design_considerations_filled";

export interface StageHooksConfig {
  pre_tool_use?: PreToolUseHookRule[];
  /** 阶段输出落地时按顺序评估的断言名。失败按 stage.auto_retry_limit 重试，超限走 block。 */
  post_output_assertions?: StageOutputAssertion[];
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
  /** 可选；仅在显式声明时由 hookEnforcer 评估，否则该阶段零额外约束（向后兼容）。 */
  hooks?: StageHooksConfig;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  version: string;
  description: string;
  source: WorkflowSource;
  permissions: WorkflowPermissions;
  rework: WorkflowReworkPolicy;
  routing?: WorkflowRoutingConfig;
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
  /**
   * 已通过的阶段产出（completed/waiting_approval 时由 workflowEngine 写入）。
   * 跨阶段断言（如 plan_steps_grounded 在 design 阶段读 investigate.findings）依赖此字段。
   * 字段可选——向后兼容旧 session.json；老 stageRun 没存就是空字典。
   */
  required_outputs?: Record<string, unknown>;
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
  human_qa_history: HumanQuestion[];
}

export interface StageAgentResult {
  status: "completed" | "failed" | "needs_rework";
  output_summary: string;
  required_outputs?: Record<string, unknown>;
  rework_target_stage_id?: string;
  rework_reason?: string;
  error?: string;
  /**
   * 原始 agent 输出的 JSON 解析诊断——`parseStageAgentResult` 在所有出口填写。
   * 用途：让 `no_trailing_unparsed_payload` 断言能感知"输出有合法 JSON 但尾部还有大段未闭合 JSON 残骸"
   * 这种当前会被静默吞掉的情况，并触发 retry → block。
   *
   * 字段对所有阶段都可选（向后兼容），但 `parseStageAgentResult` 始终会填。
   */
  parse_diagnostics?: ParseDiagnostics;
}

export interface ParseDiagnostics {
  /** true = raw 末尾还有未闭合 JSON 或大段 JSON 残骸（多余引号/未闭合括号等） */
  had_unparsed_tail: boolean;
  /** 末尾未解析文本字符数（去除合法 JSON 已覆盖的范围） */
  tail_length: number;
  /** raw 中最后一个 `{` 的位置；-1 表示根本没有 */
  last_open_brace_index: number;
  /** 全文 `{`/`}` 配平计数（在字符串外）；0 = 平衡，>0 = 多 `{` 未闭，<0 = 多 `}` */
  bracket_balance: number;
  /** 找到的合法 JSON 候选总数 */
  candidate_count: number;
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

export interface FileUploadAttachment {
  type: "file_upload";        // 待落盘的二进制文件（如 PDF、文档）
  data_base64: string;
  media_type: string;
  display_name: string;
}

export type Attachment = FileRefAttachment | ImageAttachment | FileUploadAttachment;

export interface AgentMessage {
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
  attachments?: Attachment[];
}

export interface HumanQuestionOption {
  value: string;
  label: string;
}

export interface HumanQuestion {
  id: string;
  stage_id: string;
  question: string;
  question_type: "single" | "multi" | "text";
  options?: HumanQuestionOption[];
  status: "pending" | "answered" | "cancelled";
  answer?: string | string[];
  created_at: string;
  resolved_at?: string;
}

export interface ToolCallRecord {
  id: string;
  stage_id: string;
  tool: string;
  input: unknown;
  status: "pending_approval" | "approved" | "denied" | "completed" | "blocked" | "cancelled";
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
  title?: string;
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
  pending_human_questions?: HumanQuestion[];
  /** 用户批准过的项目外只读路径（realpath）。仅 Read/Grep/Glob/LS 命中时放行。 */
  approved_external_paths?: string[];
  onboarding?: SessionOnboardingSnapshot;
  routing?: SessionRoutingSnapshot;
  pinned_at?: string;
  archived_at?: string;
  created_at: string;
  updated_at: string;
  error?: string;
}

export interface WorkflowRoutingCandidate {
  workflow_id: string;
  name: string;
  score: number;
}

export type WorkflowRoutingMethod = "rule" | "model" | "none" | "manual";

export interface WorkflowRoutingDecision {
  status: "selected" | "needs_confirmation" | "no_candidates";
  method: WorkflowRoutingMethod;
  recommended_workflow_id?: string;
  candidates: WorkflowRoutingCandidate[];
  reason: string;
}

export interface SessionRoutingSnapshot {
  requested_mode: "auto" | "manual";
  method: WorkflowRoutingMethod;
  candidates: WorkflowRoutingCandidate[];
  recommended_workflow_id?: string;
  final_workflow_id: string;
  user_action: "none" | "confirmed" | "overridden";
  reason: string;
}

export interface ResolveWorkflowInput {
  projectPath: string;
  taskPrompt: string;
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
  routing?: SessionRoutingSnapshot;
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
  authorizeSessionProject(projectPath: string): Promise<string>;
  getAgentRuntimeStatus(): Promise<AgentRuntimeStatus>;
  getProjectOnboardingStatus(projectPath: string): Promise<ProjectOnboardingStatus>;
  confirmProjectOnboarding(projectPath: string): Promise<ProjectOnboardingStatus>;
  listWorkflows(projectPath?: string): Promise<WorkflowListResult>;
  resolveWorkflow(input: ResolveWorkflowInput): Promise<WorkflowRoutingDecision>;
  startSession(input: StartSessionInput): Promise<StartSessionResult>;
  listSessions(): Promise<AgentSession[]>;
  getSession(id: string): Promise<AgentSession | null>;
  approveStage(sessionId: string, stageId: string): Promise<AgentSession>;
  approveRework(sessionId: string, requestId: string): Promise<AgentSession>;
  approveToolCall(sessionId: string, toolCallId: string): Promise<AgentSession>;
  denyToolCall(sessionId: string, toolCallId: string): Promise<AgentSession>;
  continueSession(sessionId: string): Promise<AgentSession>;
  resumeSession(sessionId: string): Promise<AgentSession>;
  abortSession(sessionId: string): Promise<AgentSession>;
  restartSession(sessionId: string): Promise<AgentSession>;
  answerHumanQuestion(sessionId: string, questionId: string, answer: string | string[]): Promise<AgentSession>;
  sendMessage(sessionId: string, message: string, attachments?: Attachment[]): Promise<AgentSession>;
  setSessionPinned(sessionId: string, pinned: boolean): Promise<AgentSession>;
  setSessionArchived(sessionId: string, archived: boolean): Promise<AgentSession>;
  deleteSession(sessionId: string): Promise<void>;
  listProjectFiles(projectPath: string, query?: string): Promise<string[]>;
  readProjectFile(projectPath: string, filePath: string): Promise<string>;
}

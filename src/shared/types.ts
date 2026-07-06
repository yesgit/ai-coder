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
   * 扫文本：句子里 hedge 词（可能/或许/maybe/might/likely）与负面词（问题/风险/缺口/...）共现
   * 且无 path:line 证据引用时 → 失败。让"未取证就下 hedged 结论"无处可藏。
   * 不依赖任何结构化字段——v1.1 软化方案下唯一保留的"未取证检测"。
   */
  | "hedged_findings_demoted"
  /**
   * investigate 阶段专用：扫 output_summary 是否含 4 个 markdown 标题（## 调查任务清单 / ## 假设与验证 /
   * ## 已证实的结论 / ## 仍未确定的事项）。用模板引导 LLM 把思维过程写出来，而非跳步。
   * v1.2 新增——结构化自然语言，不依赖 JSON 嵌套对象。
   */
  | "investigate_structure_present"
  /**
   * investigate 阶段：扫 output_summary 是否出现 high/medium/low 任一词或"置信度"/"confidence"。
   * 极宽松——只验证模型提到了置信度概念，不强制每条 finding 都标。深层质量靠 self_review 闭环。
   * v1.2 新增——配合 investigate markdown 模板里"## 已证实的结论"每条 finding 标 [等级+依据]。
   */
  | "confidence_levels_present"
  /**
   * investigate 阶段：扫 output_summary 含"## 调用方清单"标题。强制列目标符号的所有调用方 + 每处语义假设。
   * v1.2 新增——把原 similar_callsites 的"目标调用方"语义显式化，防逻辑遗漏。
   */
  | "callsites_inventory_present"
  /**
   * investigate 阶段：扫 output_summary 含"## 边界与异常路径"标题。强制枚举空/零/负/并发/超时/失败/超大输入。
   * v1.2 新增——与 unknowns（没查清的）互补：boundary 是已知需处理的边缘情况。
   */
  | "boundary_enumeration_present"
  /**
   * design 阶段：扫 output_summary 含"## 事前风险"标题。动手前预演失败——最易出错处 + 最没把握的反例 + 预案。
   * v1.2 新增——区别于事后 adversarial_critique，是"事前焦虑"的显式化。
   */
  | "preflight_risks_present"
  /**
   * design 阶段：扫"## 候选方案"标题 + 粗扫候选数 ≥2（方案 A/B、方案 甲/乙、候选 1/2、alternative A/B）。
   * v1.2 新增——强制双方案对照，避免"先定再辩护"。不复用 item_matrix_when_multi（触发条件/维度都不同）。
   */
  | "design_alternatives_present"
  /**
   * design 阶段：扫"## 方案评估"标题 + 四维关键词（性能/安全/扩展/可维护）共现。
   * v1.2 新增——把 self_review 的事后挑刺前置到 design，对选定方案做纵深审视。
   */
  | "design_quadrant_eval_present"
  /**
   * implement 阶段：扫 output_summary 含"## 改动核对"标题。每改过文件一段（推进哪条 success_criteria + 新风险）。
   * v1.2 新增——让"边写边审"成为可见产物，回溯写在最终 output_summary，引擎零改动。
   */
  | "implement_delta_check_present"
  /**
   * implement 阶段：弱断言——若 output_summary 含 rm/git reset/git clean/drop table/truncate 等不可逆词，
   * 必须含"回滚"或"rollback"字样，否则失败。v1.2 新增。
   */
  | "rollback_plan_when_irreversible"
  /**
   * raw 输出尾部存在未闭合 JSON（bracket_balance != 0 或 last 合法 JSON 之后还有大段 JSON 残骸）→ 失败。
   * 跨场景通用——结构性断言，不绑定具体任务类型，建议每阶段都挂。
   */
  | "no_trailing_unparsed_payload";

/**
 * 阶段产物落地时的*行为*校验——post_output_assertions 的参数化兄弟。
 *
 * 与 post_output_assertions（扫产出文本形态，L3，可被模板糊弄）的根本区别：
 * 这里校验的是**本阶段的工具调用序列**（L1，行为即证据，不可糊弄）——
 * "你真跑过这条命令吗 / 你真读过目标文件吗"。模型可以写一堵 markdown 标题糊弄文本断言，
 * 但没法假装跑过一个没跑过的命令。
 *
 * 镜像 pre_tool_use 的 require/on_fail 约定，使"动手前门控"与"落地后门控"共用同一套行为词汇。
 * 评估范围：post_output_checks 按 stage_id 过滤 session.tool_calls 取*本阶段*切片
 * （验证本轮真发生，而非全会话累计——rework 回炉后第二轮仍须重新验证）。
 */
export interface PostOutputBehaviorCheck {
  require: {
    /**
     * 本阶段内必须跑过包含这些子串的 Bash 命令，每条都要满足（与 pre_tool_use.shell_must_have_run
     * 同语义，但作用域为本阶段切片）。如 ["git log "] / ["git diff"] / ["npm test"]。
     */
    commands_run?: string[];
    /**
     * 本阶段内必须 Read/Grep/Glob 命中目标文件至少 min 次。用于强制"真看过"关键文件。
     * target 为项目相对路径或 basename（与 same_file_reads_min 同一归一化）。
     */
    files_read?: { target: string; min: number }[];
  };
  /** 命中失败时回传给模型的中文人话提示。与 pre_tool_use.on_fail 同约定。 */
  on_fail: string;
}

export interface StageHooksConfig {
  pre_tool_use?: PreToolUseHookRule[];
  /** 阶段输出落地时按顺序评估的断言名（扫产出文本，L3）。失败按 stage.auto_retry_limit 重试，超限走 block。 */
  post_output_assertions?: StageOutputAssertion[];
  /** 阶段输出落地时按顺序评估的行为校验（查 tool_calls，L1，不可糊弄）。与 post_output_assertions 同走 retry → block。 */
  post_output_checks?: PostOutputBehaviorCheck[];
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
  rework_context?: {
    from_stage: string;
    reason: string;
    /**
     * 被退回目标 stage 上一版产出摘要。invalidate_downstream=false 的工作流可能无
     * superseded run（此时仅注入 from_stage/reason），故可选。
     */
    previous_output_summary?: string;
  };
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
  /** 订阅后台会话进度推送（main 在每次 runner 进度事件时广播整个 session）。返回取消订阅函数。 */
  onSessionProgress(cb: (session: AgentSession) => void): () => void;
}

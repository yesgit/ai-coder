import { randomUUID } from "node:crypto";
import { evaluateBehaviorChecks, evaluateOutputAssertions } from "../agent/stageOutputAssertions.js";
import type {
  AgentSession,
  ApprovalRecord,
  ReworkRequest,
  StageAgentResult,
  StageRun,
  WorkflowStage,
  WorkflowTemplate
} from "../../shared/types.js";

const OUTPUT_CONTRACT_REPAIR_RETRY_LIMIT = 5;

export class WorkflowEngine {
  ensureState(session: AgentSession, workflow: WorkflowTemplate): AgentSession {
    session.stage_runs ??= [];
    session.rework_requests ??= [];

    if (session.stage_runs.length === 0) {
      const firstStage = workflow.stages[0];
      if (firstStage) {
        this.startStage(session, workflow, firstStage, "Initial task");
      }
    }

    return session;
  }

  completeCurrentStage(session: AgentSession, workflow: WorkflowTemplate, outputSummary: string): AgentSession {
    this.ensureState(session, workflow);
    const stageRun = this.getActiveStageRun(session);
    if (!stageRun) {
      session.status = "completed";
      return session;
    }

    stageRun.status = "completed";
    stageRun.output_summary = outputSummary;
    stageRun.completed_at = new Date().toISOString();

    const stage = this.getStage(workflow, stageRun.stage_id);
    if (stage?.approval_required) {
      this.requestStageApproval(session, stage, stageRun);
      return session;
    }

    return this.advanceAfterCompletedStage(session, workflow, stageRun.stage_id);
  }

  applyStageResult(session: AgentSession, workflow: WorkflowTemplate, result: StageAgentResult): AgentSession {
    this.ensureState(session, workflow);
    const stageRun = this.getActiveStageRun(session);
    if (!stageRun) {
      session.status = "completed";
      return session;
    }

    if (result.status === "failed") {
      return this.failCurrentStage(session, result.error ?? result.output_summary);
    }

    const stage = this.getStage(workflow, stageRun.stage_id);

    if (result.status === "needs_rework") {
      // target/reason 缺失时优先走断言层：如果 stage 声明了 needs_rework_target_required
      // 断言，给模型一次按 auto_retry_limit 重试补齐的机会；未声明则保持原 block 路径，
      // 保证未启用该断言的旧工作流行为不变。
      if (!result.rework_target_stage_id || !result.rework_reason) {
        if (stage && this.runOutputAssertions(session, workflow, stage, stageRun, result)) {
          return session;
        }
        return this.blockCurrentStage(session, "Rework result requires rework_target_stage_id and rework_reason");
      }
      try {
        return this.requestRework(session, workflow, result.rework_target_stage_id, result.rework_reason);
      } catch (error) {
        return this.blockCurrentStage(session, error instanceof Error ? error.message : String(error));
      }
    }

    const missingOutputs = (stage?.required_outputs ?? []).filter((name) => !hasRequiredOutput(result, name));
    if (missingOutputs.length > 0) {
      const maxRetry = getOutputContractRetryLimit(stage);
      const currentAttempt = this.getStageAttempt(session, stageRun.stage_id);
      // 若 parse_diagnostics 已经发现 JSON 烂尾，极大概率"missing"的真因是 JSON 没解析出来，
      // 而不是模型真的少写了字段。把诊断信息一并回传——避免模型反复输出同一份烂 JSON 还以为自己写对了。
      const diag = result.parse_diagnostics;
      const parseHint = diag?.parse_strategy === "none"
        ? "（没有解析到结构化阶段结果；可能只输出了说明文字，或 JSON 已损坏。）"
        : "";
      const diagHint = diag?.had_unparsed_tail
        ? ` (JSON parse 失败诊断：bracket_balance=${diag.bracket_balance}, tail_length=${diag.tail_length}, candidate_count=${diag.candidate_count}——最外层 JSON 大概率有未闭合字符串/花括号/多余引号。请本地 JSON.parse 验证一遍再回传，整段写成单一合法对象。)`
        : "";
      const shapeHint = buildMissingOutputsShapeHint(stage, result);
      if (currentAttempt <= maxRetry) {
        return this.retryCurrentStage(session, workflow, `Missing required outputs: ${missingOutputs.join(", ")}${parseHint}${diagHint}${shapeHint}`);
      }
      return this.blockCurrentStage(
        session,
        `Missing required outputs after ${currentAttempt} attempts: ${missingOutputs.join(", ")}${parseHint}${diagHint}${shapeHint}`
      );
    }

    // 阶段产物自洽性断言：与 missing outputs 同模式走 retry → block。
    // 仅当 stage.hooks.post_output_assertions 显式声明时触发；未声明=透传，与既有工作流完全兼容。
    if (stage && this.runOutputAssertions(session, workflow, stage, stageRun, result)) {
      return session;
    }

    // 通过所有校验后落地 required_outputs 到 stageRun，供后续阶段的跨阶段断言读取。
    // 这一步必须晚于 runOutputAssertions——失败重试时 stageRun 不应吸收无效产出。
    if (result.required_outputs) {
      stageRun.required_outputs = result.required_outputs;
    }

    return this.completeCurrentStage(session, workflow, result.output_summary);
  }

  /**
   * 评估阶段输出断言。命中失败时按 stage.auto_retry_limit 走 retry → block 路径，
   * 返回 true 表示已处理（调用方应直接 return session）；返回 false 表示无失败、调用方继续。
   *
   * needs_rework_target_required 这种"结构性"断言在 applyStageResult 的早期分支也会用到——
   * 这是断言层有意被抽出 helper 的原因：让 missing-outputs 之后和 needs_rework 缺字段两条路径
   * 共享同一种 retry-or-block 行为。
   */
  private runOutputAssertions(
    session: AgentSession,
    workflow: WorkflowTemplate,
    stage: WorkflowStage,
    stageRun: StageRun,
    result: StageAgentResult
  ): boolean {
    const prior = this.collectPriorOutputs(session, stageRun.stage_id);
    const textFailures = evaluateOutputAssertions(stage, result, prior);
    // 行为校验（L1，行为即证据）只在阶段声明"完成"时生效——needs_rework/failed 不主张完成了工作，
    // 不应被行为门控（否则 needs_rework 早期分支会误触，且模型可用合法 needs_rework 逃逸行为要求）。
    // 切片范围：stage_id 匹配 + created_at ≥ 本次 stageRun.started_at——既排除他阶段调用，
    // 也排除同阶段前序 rework run 的旧调用（rework 起 new stageRun 有新 started_at，旧 run 调用被排除，
    // 第二轮须重新验证）；retry 复用同一 stageRun 不改 started_at，故同 run 多 attempt 调用都算，
    // 符合"本次 stageRun 真发生过"语义。与文本断言（L3）合并走同一条 retry → block。
    const behaviorFailures = result.status === "completed"
      ? evaluateBehaviorChecks(
          stage,
          (session.tool_calls ?? []).filter(
            (tc) => tc.stage_id === stageRun.stage_id && tc.created_at >= stageRun.started_at
          ),
          session.project_path
        )
      : [];
    const allFailures = [
      ...textFailures.map((f) => `[${f.assertion}] ${f.message}`),
      ...behaviorFailures.map((f) => `[${f.check}] ${f.message}`)
    ];
    if (allFailures.length === 0) return false;
    const reason = `Output checks failed: ${allFailures.join(" | ")}`;
    const maxRetry = stage.auto_retry_limit ?? 0;
    const currentAttempt = this.getStageAttempt(session, stageRun.stage_id);
    if (currentAttempt <= maxRetry) {
      this.retryCurrentStage(session, workflow, reason);
    } else {
      this.blockCurrentStage(session, `${reason} (after ${currentAttempt} attempts)`);
    }
    return true;
  }

  /**
   * 收集已完成阶段的 required_outputs，构造 {stage_id: required_outputs} 字典传给断言层。
   *
   * 跳过自己（currentStageId），并对同一 stage_id 只取最新的 completed run——
   * 这样 rework 走回 design 再前进时，新值会覆盖旧值。
   */
  private collectPriorOutputs(
    session: AgentSession,
    currentStageId: string
  ): Record<string, Record<string, unknown> | undefined> {
    const out: Record<string, Record<string, unknown> | undefined> = {};
    for (const run of session.stage_runs ?? []) {
      if (run.stage_id === currentStageId) continue;
      if (run.status !== "completed" && run.status !== "waiting_approval") continue;
      if (!run.required_outputs) continue;
      // 后写入者覆盖——遍历顺序即时间顺序，最新 completed 自然胜出
      out[run.stage_id] = run.required_outputs;
    }
    return out;
  }

  approveStage(session: AgentSession, workflow: WorkflowTemplate, stageId: string): AgentSession {
    this.ensureState(session, workflow);
    const approval = session.approvals.find(
      (item) => item.stage_id === stageId && item.kind === "stage" && item.status === "pending"
    );
    if (!approval) {
      throw new Error(`Stage approval not found: ${stageId}`);
    }

    approval.status = "approved";
    approval.resolved_at = new Date().toISOString();

    const approvedRun = approval.stage_run_id
      ? session.stage_runs?.find((stageRun) => stageRun.id === approval.stage_run_id)
      : this.getLatestStageRun(session, stageId);
    if (approvedRun?.status === "waiting_approval") {
      approvedRun.status = "completed";
    }

    return this.advanceAfterCompletedStage(session, workflow, approvedRun?.stage_id ?? stageId);
  }

  requestRework(session: AgentSession, workflow: WorkflowTemplate, targetStageId: string, reason: string): AgentSession {
    this.ensureState(session, workflow);
    if (!workflow.rework.enabled) {
      throw new Error(`Rework is disabled for workflow: ${workflow.id}`);
    }
    if (!workflow.rework.allowed_targets.includes(targetStageId)) {
      throw new Error(`Rework target is not allowed: ${targetStageId}`);
    }

    const activeRun = this.getActiveStageRun(session);
    if (!activeRun) {
      throw new Error("No active stage run to request rework from");
    }
    if (!this.isPreviousStage(workflow, activeRun.stage_id, targetStageId)) {
      throw new Error(`Rework target must be a previous stage: ${targetStageId}`);
    }

    const now = new Date().toISOString();
    activeRun.status = "needs_rework";
    activeRun.rework_reason = reason;
    activeRun.completed_at = now;

    const request: ReworkRequest = {
      id: randomUUID(),
      from_stage_id: activeRun.stage_id,
      target_stage_id: targetStageId,
      status: workflow.rework.approval_required ? "pending" : "approved",
      reason,
      created_at: now,
      resolved_at: workflow.rework.approval_required ? undefined : now
    };
    session.rework_requests?.push(request);

    if (workflow.rework.approval_required) {
      session.status = "waiting_approval";
      return session;
    }

    return this.applyRework(session, workflow, request);
  }

  approveRework(session: AgentSession, workflow: WorkflowTemplate, requestId: string): AgentSession {
    this.ensureState(session, workflow);
    const request = session.rework_requests?.find((item) => item.id === requestId && item.status === "pending");
    if (!request) {
      throw new Error(`Pending rework request not found: ${requestId}`);
    }

    request.status = "approved";
    request.resolved_at = new Date().toISOString();
    return this.applyRework(session, workflow, request);
  }

  resumeFromFailedStage(session: AgentSession, workflow: WorkflowTemplate): AgentSession {
    this.ensureState(session, workflow);

    let targetStageId: string | undefined;
    const activeRun = this.getActiveStageRun(session);
    if (activeRun) {
      activeRun.status = "superseded";
      activeRun.completed_at = new Date().toISOString();
      targetStageId = activeRun.stage_id;
    } else {
      const failedRun = [...(session.stage_runs ?? [])]
        .reverse()
        .find((stageRun) => stageRun.status === "failed");
      if (!failedRun) {
        throw new Error("No stage to resume from");
      }
      targetStageId = failedRun.stage_id;
    }

    const stage = this.getStage(workflow, targetStageId);
    if (!stage) {
      throw new Error(`Workflow stage not found: ${targetStageId}`);
    }

    const inputSummary = this.buildResumeInputSummary(session, workflow, targetStageId);
    session.error = undefined;
    this.startStage(session, workflow, stage, inputSummary);
    return session;
  }

  restartFromBeginning(session: AgentSession, workflow: WorkflowTemplate, startStageId?: string): AgentSession {
    // 完全清理旧状态，重新开始
    session.stage_runs = [];
    session.rework_requests = [];
    session.approvals = [];
    session.error = undefined;
    session.status = "running";

    const firstStage = startStageId
      ? workflow.stages.find((stage) => stage.id === startStageId)
      : workflow.stages[0];
    if (!firstStage) {
      throw new Error(startStageId ? `Workflow stage not found: ${startStageId}` : "Workflow has no stages");
    }

    this.startStage(session, workflow, firstStage, session.task_prompt);
    return session;
  }

  resetSessionContext(session: AgentSession, workflow: WorkflowTemplate, startStageId?: string): AgentSession {
    const firstUserMessage = session.initial_user_message ?? session.messages.find((message) => message.role === "user");
    session.messages = firstUserMessage ? [firstUserMessage] : [];
    session.stage_runs = [];
    session.tool_calls = [];
    session.file_changes = [];
    session.approvals = [];
    session.rework_requests = [];
    session.pending_human_questions = [];
    session.progress_events = [];
    session.error = undefined;
    session.status = "running";

    const firstStage = startStageId
      ? workflow.stages.find((stage) => stage.id === startStageId)
      : workflow.stages[0];
    if (!firstStage) {
      throw new Error(startStageId ? `Workflow stage not found: ${startStageId}` : "Workflow has no stages");
    }
    this.startStage(session, workflow, firstStage, session.task_prompt);
    return session;
  }

  startFollowUp(session: AgentSession, workflow: WorkflowTemplate, inputSummary: string): AgentSession {
    if (this.getActiveStageRun(session)) {
      return session;
    }
    const firstStage = workflow.stages.find((stage) => !isProjectProfileStage(stage.id)) ?? workflow.stages[0];
    if (!firstStage) {
      throw new Error("Workflow has no stages");
    }
    session.error = undefined;
    this.startStage(session, workflow, firstStage, inputSummary);
    return session;
  }

  private buildResumeInputSummary(
    session: AgentSession,
    workflow: WorkflowTemplate,
    targetStageId: string
  ): string {
    const targetIndex = this.stageIndex(workflow, targetStageId);
    for (let index = targetIndex - 1; index >= 0; index -= 1) {
      const priorStageId = workflow.stages[index]?.id;
      if (!priorStageId) {
        continue;
      }
      const priorCompleted = [...(session.stage_runs ?? [])]
        .reverse()
        .find((stageRun) => stageRun.stage_id === priorStageId && stageRun.status === "completed");
      if (priorCompleted?.output_summary) {
        return priorCompleted.output_summary;
      }
    }
    return "Resume retry";
  }

  getActiveStageRun(session: AgentSession): StageRun | undefined {
    return [...(session.stage_runs ?? [])]
      .reverse()
      .find((stageRun) => stageRun.status === "running" || stageRun.status === "waiting_approval");
  }

  private failCurrentStage(session: AgentSession, error: string): AgentSession {
    const stageRun = this.getActiveStageRun(session);
    if (stageRun) {
      stageRun.status = "failed";
      stageRun.output_summary = error;
      stageRun.completed_at = new Date().toISOString();
    }
    session.status = "failed";
    session.error = error;
    return session;
  }

  private blockCurrentStage(session: AgentSession, reason: string): AgentSession {
    const stageRun = this.getActiveStageRun(session);
    if (stageRun) {
      stageRun.status = "failed";
      stageRun.output_summary = reason;
      stageRun.completed_at = new Date().toISOString();
    }
    session.status = "blocked";
    session.error = reason;
    return session;
  }

  private retryCurrentStage(session: AgentSession, workflow: WorkflowTemplate, reason: string): AgentSession {
    const stageRun = this.getActiveStageRun(session);
    if (!stageRun) {
      return session;
    }

    stageRun.status = "running";
    stageRun.retry_reason = reason;
    stageRun.attempt = (stageRun.attempt ?? 1) + 1;
    session.status = "running";
    session.error = reason;
    return session;
  }

  private getStageAttempt(session: AgentSession, stageId: string): number {
    const runs = (session.stage_runs ?? []).filter((run) => run.stage_id === stageId);
    if (runs.length === 0) return 0;
    return Math.max(...runs.map((run) => run.attempt ?? 1));
  }

  private advanceAfterCompletedStage(session: AgentSession, workflow: WorkflowTemplate, completedStageId: string): AgentSession {
    const completedIndex = workflow.stages.findIndex((stage) => stage.id === completedStageId);
    const nextStage = workflow.stages[completedIndex + 1];
    if (!nextStage) {
      // 没有下一阶段时，检查是否是单阶段工作流（如闲聊）—— 如果是则重启该阶段
      if (workflow.stages.length === 1) {
        this.startStage(session, workflow, workflow.stages[0], this.buildInputSummary(session, completedStageId));
        return session;
      }
      session.status = "completed";
      session.current_stage = completedStageId;
      return session;
    }

    this.startStage(session, workflow, nextStage, this.buildInputSummary(session, completedStageId));
    return session;
  }

  private requestStageApproval(session: AgentSession, stage: WorkflowStage, stageRun: StageRun): void {
    const existing = session.approvals.find(
      (approval) => approval.kind === "stage" && approval.stage_run_id === stageRun.id && approval.status === "pending"
    );
    if (!existing) {
      const approval: ApprovalRecord = {
        id: randomUUID(),
        stage_id: stage.id,
        stage_run_id: stageRun.id,
        kind: "stage",
        status: "pending",
        message: `Approval required after stage: ${stage.name}`,
        created_at: new Date().toISOString()
      };
      session.approvals.push(approval);
    }
    stageRun.status = "waiting_approval";
    session.status = "waiting_approval";
    session.current_stage = stage.id;
  }

  private startStage(session: AgentSession, workflow: WorkflowTemplate, stage: WorkflowStage, inputSummary: string): StageRun {
    const now = new Date().toISOString();
    const stageRun: StageRun = {
      id: randomUUID(),
      stage_id: stage.id,
      stage_name: stage.name,
      attempt: this.nextAttempt(session, stage.id),
      status: "running",
      input_summary: inputSummary,
      started_at: now
    };
    session.stage_runs?.push(stageRun);
    session.current_stage = stage.id;
    session.status = "running";
    return stageRun;
  }

  private applyRework(session: AgentSession, workflow: WorkflowTemplate, request: ReworkRequest): AgentSession {
    if (workflow.rework.invalidate_downstream) {
      const targetIndex = this.stageIndex(workflow, request.target_stage_id);
      for (const stageRun of session.stage_runs ?? []) {
        const runIndex = this.stageIndex(workflow, stageRun.stage_id);
        if (runIndex >= targetIndex && stageRun.status !== "needs_rework" && stageRun.status !== "failed") {
          stageRun.status = "superseded";
        }
      }
    }

    const targetStage = this.getStage(workflow, request.target_stage_id);
    if (!targetStage) {
      throw new Error(`Rework target stage not found: ${request.target_stage_id}`);
    }
    this.startStage(session, workflow, targetStage, `Rework requested from ${request.from_stage_id}: ${request.reason}`);
    return session;
  }

  private buildInputSummary(session: AgentSession, completedStageId: string): string {
    const latestCompleted = this.getLatestStageRun(session, completedStageId);
    return latestCompleted?.output_summary ?? `Continue after ${completedStageId}`;
  }

  private getLatestStageRun(session: AgentSession, stageId: string): StageRun | undefined {
    return [...(session.stage_runs ?? [])].reverse().find((stageRun) => stageRun.stage_id === stageId);
  }

  private getStage(workflow: WorkflowTemplate, stageId: string): WorkflowStage | undefined {
    return workflow.stages.find((stage) => stage.id === stageId);
  }

  private nextAttempt(session: AgentSession, stageId: string): number {
    const attempts = (session.stage_runs ?? []).filter((stageRun) => stageRun.stage_id === stageId).map((stageRun) => stageRun.attempt);
    return attempts.length === 0 ? 1 : Math.max(...attempts) + 1;
  }

  private isPreviousStage(workflow: WorkflowTemplate, currentStageId: string, targetStageId: string): boolean {
    return this.stageIndex(workflow, targetStageId) < this.stageIndex(workflow, currentStageId);
  }

  private stageIndex(workflow: WorkflowTemplate, stageId: string): number {
    const index = workflow.stages.findIndex((stage) => stage.id === stageId);
    if (index === -1) {
      throw new Error(`Workflow stage not found: ${stageId}`);
    }
    return index;
  }
}

function isProjectProfileStage(stageId: string): boolean {
  return stageId === "scan_project" || stageId === "update_project_profile";
}

function hasRequiredOutput(result: StageAgentResult, name: string): boolean {
  return Object.hasOwn(result.required_outputs ?? {}, name);
}

function buildStrictJsonShapeHint(): string {
  return " 请把整段回复写成单一合法 JSON 对象，最外层必须包含 status、output_summary、required_outputs；不要只输出 required_outputs 内部字段。直接输出对象最稳定，不要主动嵌入 Markdown 或 ```json 代码块。";
}

function getOutputContractRetryLimit(stage: WorkflowStage | undefined): number {
  return Math.max(stage?.auto_retry_limit ?? 0, OUTPUT_CONTRACT_REPAIR_RETRY_LIMIT);
}

function buildMissingOutputsShapeHint(stage: WorkflowStage | undefined, result: StageAgentResult): string {
  const parsedKeys = Object.keys(result.required_outputs ?? {});
  const requiredTemplate = Object.fromEntries(
    (stage?.required_outputs ?? []).map((name) => [name, exampleValueForRequiredOutput(name, stage?.output_schema?.[name])])
  );
  const stageResultTemplate = {
    status: "completed",
    output_summary: "用一句话总结本阶段结果",
    required_outputs: requiredTemplate
  };
  const parsedKeysText = parsedKeys.length > 0 ? parsedKeys.join(", ") : "无";
  return [
    buildStrictJsonShapeHint(),
    ` 已解析到 required_outputs keys: ${parsedKeysText}。`,
    "不要把某个字段值直接写成 required_outputs（例如 required_outputs: full 是错误的）；required_outputs 必须是对象，且缺失字段必须作为对象 key 放进去。",
    "请按这个完整外层 JSON 模板重写整段回复：",
    JSON.stringify(stageResultTemplate, null, 2)
  ].join(" ");
}

function exampleValueForRequiredOutput(name: string, schema: unknown): unknown {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return `<${name}>`;
  }
  const record = schema as Record<string, unknown>;
  if (Array.isArray(record.enum) && record.enum.length > 0) {
    return record.enum.map(String).join(" | ");
  }
  if (record.type === "array") return [];
  if (record.type === "object") return {};
  if (record.type === "boolean") return false;
  if (record.type === "number" || record.type === "integer") return 0;
  return `<${name}>`;
}

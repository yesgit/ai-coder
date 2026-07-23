import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { access, chmod, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage, AgentSession, Attachment, ExplorationCheckpoint, ExplorationDisposition, ExplorationPhase, HierarchicalBlockerKind, HierarchicalExecutionState, HierarchicalWorkPhase, HumanQuestion, HumanQuestionOption, SessionProgressEvent, StageAgentResult, TaskTree, WorkflowStage, WorkflowTemplate } from "../../shared/types.js";
import { isMeaningfulAgentText } from "../../shared/agentMessages.js";
import { analyzeSymbolContract } from "../analysis/symbolContractAnalyzer.js";
import {
  approveOrDenyToolUse,
  assertPathInsideProject,
  buildAllowedClaudeTools,
  buildDisallowedClaudeTools
} from "../security/projectPolicy.js";
import { WorkflowEngine } from "../workflows/workflowEngine.js";
import {
  applyHierarchicalEvent,
  createHierarchicalExecutionState,
  deriveHierarchicalNextOperation,
  evaluateHierarchicalCompletion,
  mayAskHumanForBlocker,
  type HierarchicalEvent,
  type HierarchicalNextOperation
} from "../workflows/hierarchicalWorkflowEngine.js";
import {
  buildHierarchicalPlannerCoverageContract,
  extractBusinessSequenceNumbers
} from "../workflows/hierarchicalPlannerCoverage.js";
import { buildStageInstructions } from "./workflowPrompt.js";
import { buildStageOutputFormat } from "./stageOutputFormat.js";
import { evaluateHook, checkCommandSafety } from "./stageHookEnforcer.js";
import { buildStageAgentInput, createMockStageAgentResult, parseStageAgentResult } from "./stageAgentProtocol.js";
import { extractClaudeStageOutput, formatClaudeTranscript } from "./claudeMessageAdapter.js";
import { resolveBundledClaudeCodeExecutable, shouldUseClaudeSdk } from "./claudeRuntime.js";
import {
  buildHierarchicalRoleSpec,
  parseHierarchicalRoleResult
} from "./hierarchicalRoleProtocol.js";

export interface AgentRunInput {
  session: AgentSession;
  workflow: WorkflowTemplate;
  onProgress?: (session: AgentSession) => Promise<void>;
  /**
   * Atomically drains messages submitted while this run is active.
   * The runner consumes them only between SDK queries, never during a tool call.
   */
  takeQueuedUserMessages?: () => AgentMessage[] | Promise<AgentMessage[]>;
}

type ClaudeQuery = (params: unknown) => AsyncIterable<unknown>;
type ToolApprovalResolution = "approved" | "denied";
export interface ClaudeAgentRunnerOptions {
  queryOverride?: ClaudeQuery;
  pluginPaths?: string[];
  /** 连续服务不可用时，各次自动重试前的等待时间；数组长度同时决定最大重试次数。 */
  serviceUnavailableRetryDelaysMs?: number[];
}

interface ProfileQueryResult {
  sdkMessages: unknown[];
  preQueryMsgCount: number;
  preQueryTcCount: number;
  apiError?: unknown;
  postResultProcessError?: unknown;
  finalSession?: AgentSession;
  effectiveModel?: string;
}

interface HierarchicalRoleQueryResult {
  events: HierarchicalEvent[];
  transcript: string;
}

interface HierarchicalWorkUnitSnapshot {
  work_unit_id: string;
  files: Array<{
    path: string;
    existed: boolean;
    content?: Uint8Array;
    mode?: number;
  }>;
}

interface PendingToolApproval {
  session: AgentSession;
  resolve: (status: ToolApprovalResolution) => void;
}

/** 已知不支持多模态（图片）输入的模型名称片段。用小写匹配。 */
const NON_MULTIMODAL_MODEL_PATTERNS = ["deepseek"];

function isModelMultimodal(model: string | undefined | null): boolean {
  if (!model) return true; // 无指定 → 默认 Claude，支持多模态
  const lower = model.toLowerCase();
  return !NON_MULTIMODAL_MODEL_PATTERNS.some((p) => lower.includes(p));
}

function extractSkillCatalogMetadata(content: string, fallbackName: string): { name: string; description: string } {
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? "";
  const readScalar = (key: string): string | undefined => {
    const raw = new RegExp(`^${key}:\\s*(.+)$`, "m").exec(frontmatter)?.[1]?.trim();
    if (!raw) return undefined;
    const quote = raw[0];
    return (quote === "\"" || quote === "'") && raw.at(-1) === quote
      ? raw.slice(1, -1).trim()
      : raw;
  };
  const name = readScalar("name") || fallbackName;
  const description = readScalar("description") || "按 Skill 的完整说明判断是否适用";
  return { name, description };
}

export class ClaudeAgentRunner {
  private readonly workflowEngine = new WorkflowEngine();
  private readonly maxStageIterations = 50;
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly activeRuns = new Map<string, Promise<AgentSession>>();
  private readonly pendingToolApprovals = new Map<string, Map<string, PendingToolApproval>>();
  private readonly mcpServerCache = new WeakMap<AgentRunInput, { server: unknown | null }>();
  private readonly options: ClaudeAgentRunnerOptions;
  private resolvedEffectiveModel: string | null = null;
  private discoveredSkillCatalog?: Promise<Array<{ id: string; description: string }>>;

  constructor(options: ClaudeAgentRunnerOptions | ClaudeQuery = {}) {
    this.options = typeof options === "function" ? { queryOverride: options } : options;
  }

  abort(sessionId: string): boolean {
    const controller = this.abortControllers.get(sessionId);
    if (!controller) {
      return false;
    }
    this.abortControllers.delete(sessionId);
    controller.abort();
    return true;
  }

  resolveToolApproval(sessionId: string, toolCallId: string, status: ToolApprovalResolution): boolean {
    const pendingForSession = this.pendingToolApprovals.get(sessionId);
    const pending = pendingForSession?.get(toolCallId);
    if (!pending) {
      return false;
    }

    const toolCall = pending.session.tool_calls.find(
      (item) => item.id === toolCallId && item.status === "pending_approval"
    );
    if (toolCall) {
      toolCall.status = status;
      toolCall.resolved_at = new Date().toISOString();
      pending.session.status = status === "approved" ? "running" : "blocked";
    }
    pending.resolve(status);
    pendingForSession?.delete(toolCallId);

    if (status === "approved" && pendingForSession && pendingForSession.size > 0) {
      for (const [queuedId, queued] of pendingForSession) {
        const queuedCall = pending.session.tool_calls.find(
          (item) => item.id === queuedId && item.status === "pending_approval"
        );
        if (queuedCall) {
          queuedCall.status = "approved";
          queuedCall.resolved_at = new Date().toISOString();
        }
        queued.resolve("approved");
      }
      pendingForSession.clear();
      this.pendingToolApprovals.delete(sessionId);
    } else if (pendingForSession?.size === 0) {
      this.pendingToolApprovals.delete(sessionId);
    }
    return true;
  }

  run(input: AgentRunInput): Promise<AgentSession> {
    const existing = this.activeRuns.get(input.session.id);
    if (existing) return existing;
    const tracked = this.runUnlocked(input).finally(() => {
      if (this.activeRuns.get(input.session.id) === tracked) {
        this.activeRuns.delete(input.session.id);
      }
    });
    this.activeRuns.set(input.session.id, tracked);
    return tracked;
  }

  private async runUnlocked(input: AgentRunInput): Promise<AgentSession> {
    if (input.session.status !== "created" && input.session.status !== "running") {
      return input.session;
    }

    if (input.workflow.execution_mode === "hierarchical") {
      return this.runHierarchicalMode(input);
    }

    // Profile 模式：可显式声明；旧配置仍以无阶段管线作为兼容判据。
    if (input.workflow.execution_mode === "profile" || input.workflow.stages.length === 0) {
      return this.runProfileMode(input);
    }

    // Stage 模式（向后兼容）：逐阶段推进
    for (let iteration = 0; iteration < this.maxStageIterations; iteration += 1) {
      const updated = await this.runCurrentStage(input);
      if (updated.status !== "running") {
        return updated;
      }
      if (!this.workflowEngine.getActiveStageRun(updated)) {
        return updated;
      }
    }

    input.session.status = "failed";
    input.session.error = `Workflow exceeded ${this.maxStageIterations} automatic stage iterations.`;
    await this.recordProgress(input, "status", input.session.error, "milestone");
    return input.session;
  }

  /**
   * 分层循环模式：宿主拥有 Goal/Requirement/Phase 的控制权，模型只执行当前叶子角色。
   * 稳定需求 ID 与阶段出口由状态机维护，不再依赖模型在自由文本中自报 next_action。
   */
  private async runHierarchicalMode(input: AgentRunInput): Promise<AgentSession> {
    input.session.status = "running";
    input.session.error = undefined;
    input.session.hierarchical_state ??= createHierarchicalExecutionState(input.session.task_prompt, {
      source_refs: ["initial_user_message"]
    });
    migrateHierarchicalAlignmentState(input.session.hierarchical_state, input.session.project_path);

    const attachmentErrors = await findUnreadableProfileAttachments(input.session);
    if (attachmentErrors.length > 0) {
      input.session.status = "interrupted";
      input.session.error = ["附件完整性检查失败，分层循环尚未启动。", ...attachmentErrors].join("\n");
      await this.recordProgress(input, "status", input.session.error, "milestone");
      return input.session;
    }

    const registeredAlignmentBatches = this.ensureHierarchicalAlignmentBatches(input.session);
    if (registeredAlignmentBatches > 0) {
      const sourceCount = input.session.hierarchical_state?.alignment_batches
        .slice(-registeredAlignmentBatches)
        .reduce((total, batch) => total + batch.source_refs.length, 0) ?? 0;
      await this.recordProgress(
        input,
        "runner",
        `宿主将 ${sourceCount} 个附件拆成 ${registeredAlignmentBatches} 个只读摄取批次。`,
        "milestone"
      );
    }

    this.resolveAnsweredHierarchicalBlockers(input.session);
    const abortController = new AbortController();
    this.abortControllers.set(input.session.id, abortController);
    const nonPhaseFailures = new Map<string, { fingerprint: string; count: number }>();
    const maxHierarchicalTransitions = 2_000;

    try {
      for (let iteration = 0; iteration < maxHierarchicalTransitions; iteration += 1) {
        const state = input.session.hierarchical_state;
        if (!state) throw new Error("分层循环状态意外丢失");

        let operation: HierarchicalNextOperation;
        try {
          operation = deriveHierarchicalNextOperation(state);
        } catch (error) {
          this.raiseHierarchicalHostBlocker(input.session, "orchestration_fault", error);
          operation = deriveHierarchicalNextOperation(input.session.hierarchical_state!);
        }

        if (operation.kind === "activate_requirement") {
          this.applyHierarchicalEvents(input.session, [{
            type: "requirement_activated",
            requirement_id: operation.requirement_id
          }]);
          input.session.current_stage = `${operation.requirement_id}/investigate`;
          await this.recordProgress(input, "runner", `进入需求 ${operation.requirement_id}：investigate`, "milestone");
          continue;
        }

        if (operation.kind === "close_requirement") {
          this.applyHierarchicalEvents(input.session, [{
            type: "requirement_closed",
            requirement_id: operation.requirement_id
          }]);
          await this.recordProgress(input, "runner", `需求 ${operation.requirement_id} 已由逐项验收证据关闭。`, "milestone");
          continue;
        }

        if (operation.kind === "wait_for_user") {
          const blocker = state.blockers.find((item) => item.id === operation.blocker_id);
          if (!blocker || !mayAskHumanForBlocker(blocker)) {
            this.raiseHierarchicalHostBlocker(input.session, "orchestration_fault", new Error("非法的人类提问路由"));
            continue;
          }
          this.ensureHierarchicalHumanQuestion(input.session, blocker.id, blocker.message);
          input.session.status = "waiting_approval";
          input.session.error = undefined;
          await this.recordProgress(input, "status", `等待用户解决业务阻塞：${blocker.message}`, "milestone");
          return input.session;
        }

        if (operation.kind === "system_fault") {
          const blocker = state.blockers.find((item) => item.id === operation.blocker_id);
          input.session.status = "interrupted";
          input.session.error = blocker?.message ?? "分层循环发生宿主故障";
          await this.recordProgress(
            input,
            "status",
            `系统故障已停止自动循环，不会转嫁为人类业务问题：${input.session.error}`,
            "milestone"
          );
          return input.session;
        }

        if (operation.kind === "blocked") {
          const blocker = state.blockers.find((item) => item.id === operation.blocker_id);
          input.session.status = "blocked";
          input.session.error = blocker?.message ?? "当前阶段存在未解决的内部阻塞";
          await this.recordProgress(
            input,
            "status",
            `分层循环已停在内部阻塞，不会向用户伪装成业务提问：${input.session.error}`,
            "milestone"
          );
          return input.session;
        }

        if (operation.kind === "complete") {
          const incomplete = evaluateHierarchicalCompletion(state);
          if (incomplete.length > 0) {
            this.raiseHierarchicalHostBlocker(
              input.session,
              "orchestration_fault",
              new Error(`状态机错误地请求完成：${incomplete.join("；")}`)
            );
            continue;
          }
          input.session.status = "completed";
          input.session.current_stage = "complete";
          await this.recordProgress(input, "status", "分层循环完成：所有需求、逐项验收与全局审计均已通过。", "milestone");
          return input.session;
        }

        const roleOperation = operation;
        if (roleOperation.kind === "run_alignment_batch") {
          input.session.current_stage = `align/${roleOperation.batch_id}`;
          const batch = state.alignment_batches.find((item) => item.id === roleOperation.batch_id);
          if (batch?.status !== "running") {
            this.applyHierarchicalEvents(input.session, [{
              type: "alignment_batch_started",
              batch_id: roleOperation.batch_id
            }]);
          }
        } else if (roleOperation.kind === "run_phase") {
          input.session.current_stage = `${roleOperation.requirement_id}/${roleOperation.phase}`;
          this.applyHierarchicalEvents(input.session, [{
            type: "phase_started",
            work_unit_id: roleOperation.work_unit_id
          }]);
        } else if (roleOperation.kind === "run_integrator") {
          input.session.current_stage = "integrate";
          if (state.integration_status !== "running") {
            this.applyHierarchicalEvents(input.session, [{ type: "integration_started" }]);
          }
        } else {
          input.session.current_stage = "align";
        }

        const label = roleOperation.kind === "run_alignment_batch"
          ? `align/${roleOperation.batch_id}`
          : roleOperation.kind === "run_phase"
            ? `${roleOperation.requirement_id}/${roleOperation.phase}`
            : roleOperation.kind === "run_planner" ? "align" : "integrate";
        await this.recordProgress(input, "runner", `宿主启动专职角色：${label}`, "milestone");

        let workUnitSnapshot: HierarchicalWorkUnitSnapshot | undefined;
        let workUnitSnapshotRestored = false;
        try {
          if (roleOperation.kind === "run_phase" && roleOperation.phase === "implement") {
            workUnitSnapshot = await captureHierarchicalWorkUnitSnapshot(input.session);
          }
          const result = await this.runHierarchicalRoleQuery(input, roleOperation, abortController);
          if (result.transcript) this.appendAssistantMessage(input.session, result.transcript);
          if (workUnitSnapshot && result.events.some((event) => event.type === "phase_failed")) {
            await restoreHierarchicalWorkUnitSnapshot(input.session.project_path, workUnitSnapshot);
            workUnitSnapshotRestored = true;
            await this.recordProgress(
              input,
              "status",
              `当前 implement 未通过；宿主已恢复 ${workUnitSnapshot.files.length} 个租约文件到本次工作单元开始前，并保留此前 R-ID 的累计修改。`,
              "milestone"
            );
          } else if (workUnitSnapshot) {
            await assertHierarchicalWorkUnitIntegrity(workUnitSnapshot);
          }
          this.applyHierarchicalEvents(input.session, result.events);
          nonPhaseFailures.delete(label);
          await this.recordProgress(input, "runner", `专职角色完成并提交结构化状态事件：${label}`, "milestone");
        } catch (error) {
          if (workUnitSnapshot && !workUnitSnapshotRestored) {
            await restoreHierarchicalWorkUnitSnapshot(input.session.project_path, workUnitSnapshot);
            workUnitSnapshotRestored = true;
            await this.recordProgress(
              input,
              "status",
              `当前 implement 异常退出；宿主已自愈恢复 ${workUnitSnapshot.files.length} 个租约文件，仅重试当前工作单元。`,
              "milestone"
            );
          }
          if (abortController.signal.aborted) {
            input.session.status = this.hasPendingToolCall(input.session) ? "waiting_approval" : "interrupted";
            input.session.error = input.session.status === "interrupted" ? "用户停止了分层循环" : undefined;
            await this.recordProgress(input, "status", input.session.error ?? "等待工具审批", "milestone");
            return input.session;
          }
          const message = error instanceof Error ? error.message : String(error);
          const fingerprint = hierarchicalErrorFingerprint(label, message);
          if (roleOperation.kind === "run_alignment_batch") {
            this.applyHierarchicalEvents(input.session, [{
              type: "alignment_batch_failed",
              batch_id: roleOperation.batch_id,
              reason: message,
              route: "retry",
              error_fingerprint: fingerprint
            }]);
            const failedBatch = input.session.hierarchical_state?.alignment_batches.find(
              (item) => item.id === roleOperation.batch_id
            );
            const repeats = failedBatch?.consecutive_failure_count ?? 1;
            await this.recordProgress(
              input,
              "status",
              `附件摄取批次 ${roleOperation.batch_id} 失败，仅重试本批（${repeats}/3）：${message}`,
              "milestone"
            );
            if (repeats >= 3) {
              this.raiseHierarchicalHostBlocker(input.session, "agent_failed", error, { fingerprint });
            }
          } else if (roleOperation.kind === "run_phase") {
            const previousRepeats = countConsecutiveHierarchicalPhaseFailures(
              input.session,
              roleOperation.work_unit_id,
              fingerprint
            );
            const repeats = previousRepeats + 1;
            const recoveryRoute = repeats >= 3
              ? hierarchicalPhaseSelfHealRoute(roleOperation.phase)
              : "retry";
            this.applyHierarchicalEvents(input.session, [{
              type: "phase_failed",
              work_unit_id: roleOperation.work_unit_id,
              reason: message,
              route: recoveryRoute,
              error_fingerprint: fingerprint
            }]);
            if (repeats >= 3 && recoveryRoute !== "retry") {
              await this.recordProgress(
                input,
                "status",
                `当前 ${roleOperation.phase} 连续 ${repeats} 次遇到同类问题；宿主保持 Goal 运行并退回 ${recoveryRoute} 自愈：${message}`,
                "milestone"
              );
            } else {
              await this.recordProgress(
                input,
                "status",
                `阶段角色失败，宿主仅重试当前工作单元（${repeats}/6）：${message}`,
                "milestone"
              );
            }
            // investigate 已经是最内层取证阶段，没有更早阶段可退。给带失败上下文的
            // 自愈重试更大窗口；只有六次完全相同的失败才升级为宿主故障。
            if (repeats >= 6 && recoveryRoute === "retry") {
              this.raiseHierarchicalHostBlocker(input.session, "agent_failed", error, {
                requirementId: roleOperation.requirement_id,
                workUnitId: roleOperation.work_unit_id,
                fingerprint
              });
            }
          } else {
            if (roleOperation.kind === "run_planner") {
              this.applyHierarchicalEvents(input.session, [{
                type: "planner_failed",
                reason: message,
                error_fingerprint: fingerprint
              }]);
              const retry = input.session.hierarchical_state?.planner_retry;
              const repeats = retry?.consecutive_failure_count ?? 1;
              await this.recordProgress(
                input,
                "status",
                `align 角色失败，宿主已将拒绝原因写入第 ${retry?.attempt ?? repeats + 1} 次 planner 输出契约（${repeats}/3）：${message}`,
                "milestone"
              );
              if (repeats >= 3) {
                this.raiseHierarchicalHostBlocker(input.session, "agent_failed", error, { fingerprint });
              }
              continue;
            }
            if (roleOperation.kind === "run_integrator") {
              this.applyHierarchicalEvents(input.session, [{ type: "integration_failed", reason: message }]);
            }
            const previous = nonPhaseFailures.get(label);
            const repeats = previous?.fingerprint === fingerprint ? previous.count + 1 : 1;
            nonPhaseFailures.set(label, { fingerprint, count: repeats });
            await this.recordProgress(input, "status", `${label} 角色失败，宿主将恢复重试（${repeats}/3）：${message}`, "milestone");
            if (repeats >= 3) {
              this.raiseHierarchicalHostBlocker(input.session, "agent_failed", error, { fingerprint });
            }
          }
        }
      }

      this.raiseHierarchicalHostBlocker(
        input.session,
        "orchestration_fault",
        new Error(`分层循环超过 ${maxHierarchicalTransitions} 次宿主状态迁移安全上限`)
      );
      input.session.status = "interrupted";
      input.session.error = `分层循环超过 ${maxHierarchicalTransitions} 次宿主状态迁移安全上限`;
      await this.recordProgress(input, "status", input.session.error, "milestone");
      return input.session;
    } finally {
      if (this.abortControllers.get(input.session.id) === abortController) {
        this.abortControllers.delete(input.session.id);
      }
    }
  }

  private async runHierarchicalRoleQuery(
    input: AgentRunInput,
    operation: Extract<HierarchicalNextOperation, {
      kind: "run_alignment_batch" | "run_planner" | "run_phase" | "run_integrator"
    }>,
    abortController: AbortController
  ): Promise<HierarchicalRoleQueryResult> {
    const spec = buildHierarchicalRoleSpec(input.session, input.workflow, operation);
    const skillStage: WorkflowStage = {
      id: `hierarchical-${spec.phaseLabel}`,
      name: spec.phaseLabel,
      required_skills: spec.requiredSkills
    };
    const loadedSkills = await this.loadRequiredSkills(skillStage);
    const skillContracts = loadedSkills.length > 0
      ? [
          "## 宿主强制加载的 Skill 契约",
          "这些是当前角色的执行契约，必须在行动与证据中落实。",
          ...loadedSkills.map((skill) => `### ${skill.id}\n${skill.content}`)
        ].join("\n\n")
      : "";
    const prompt = [spec.prompt, skillContracts].filter(Boolean).join("\n\n");
    const query = await this.resolveQuery();
    const needsContractAnalyzer = spec.tools.includes("mcp__ai_coder__analyze_symbol_contract");
    const mcpServer = needsContractAnalyzer ? await this.resolveMcpServer(input) : null;
    if (needsContractAnalyzer && !mcpServer) {
      throw new Error("当前阶段要求完整调查目标函数/组件，但符号契约分析工具初始化失败");
    }
    const claudeCodeExecutable = resolveBundledClaudeCodeExecutable();
    const sdkMessages: unknown[] = [];
    const sdkStderr: string[] = [];
    const policyDenials = new Map<string, number>();
    const stageId = `hierarchical:${spec.phaseLabel}`;

    const recoverableDenial = async (category: string, message: string) => {
      const count = (policyDenials.get(category) ?? 0) + 1;
      policyDenials.set(category, count);
      const recovery = count >= 2
        ? `${message} 同类动作已被宿主纠正 ${count} 次；不要继续改写命令规避策略，保留当前进度并执行阶段契约中的下一项合法动作。`
        : message;
      await this.recordProgress(input, "tool_policy", recovery, "milestone");
      return { behavior: "deny" as const, message: recovery, interrupt: false };
    };

    const queryInstance = query({
      prompt,
      options: {
        cwd: input.session.project_path,
        ...(claudeCodeExecutable ? { pathToClaudeCodeExecutable: claudeCodeExecutable } : {}),
        env: buildClaudeSdkEnv(),
        stderr: (chunk: string) => captureBoundedSdkStderr(sdkStderr, chunk),
        abortController,
        mcpServers: mcpServer ? { ai_coder: mcpServer } : undefined,
        ...(this.options.pluginPaths?.length
          ? { plugins: this.options.pluginPaths.map((pluginPath) => ({ type: "local" as const, path: pluginPath })) }
          : {}),
        tools: spec.tools,
        disallowedTools: buildDisallowedClaudeTools(input.workflow),
        permissionMode: "default",
        settingSources: [],
        outputFormat: spec.outputFormat,
        canUseTool: async (
          toolName: string,
          toolInput: Record<string, unknown>,
          options: { toolUseID: string }
        ) => {
          const projectPathError = operation.kind === "run_alignment_batch"
            ? null
            : getHierarchicalProjectPathError(input.session, toolName, toolInput);
          if (projectPathError) {
            return recoverableDenial("project-path", projectPathError);
          }
          const attachmentReadError = getHierarchicalAttachmentReadError(
            input.session,
            operation,
            toolName,
            toolInput
          );
          if (attachmentReadError) {
            return recoverableDenial("attachment-boundary", attachmentReadError);
          }
          const malformed = await validateProfileToolInput(
            toolName,
            toolInput,
            input.session.project_path,
            collectSessionAttachments(input.session)
          );
          if (malformed) {
            return recoverableDenial("malformed-tool-input", `分层角色工具参数无效：${malformed}`);
          }
          if (toolName === "Bash" && isMutatingShellCommand(String(toolInput.command ?? ""))) {
            const message = [
              "分层角色的 Bash 仅用于读取和验证；代码修改必须通过受租约约束的 Edit。",
              "分支、stash、reset、restore 属于已锁定的 Goal 工作区契约，当前叶子角色不得重做；请保留已完成 R-ID 的累计修改并继续当前需求。"
            ].join(" ");
            return recoverableDenial("mutating-shell", message);
          }
          const writeSafetyError = await getHierarchicalWriteSafetyError(
            input.session,
            toolName,
            toolInput
          );
          if (writeSafetyError) {
            return recoverableDenial("overwrite-existing-file", writeSafetyError);
          }
          const leaseError = getHierarchicalCapabilityLeaseError(input.session, toolName, toolInput);
          if (leaseError) {
            return recoverableDenial("file-lease", leaseError);
          }
          const safety = checkCommandSafety(stageId, toolName, toolInput);
          if (!safety.allow) {
            await this.recordProgress(input, "tool_policy", `安全拦截：${safety.message}`, "milestone");
            return { behavior: "deny", message: safety.message, interrupt: false };
          }
          const decision = await approveOrDenyToolUse(
            input.session,
            input.workflow,
            toolName,
            toolInput,
            options.toolUseID
          );
          if (decision.allow) return { behavior: "allow", updatedInput: decision.updatedInput };
          if (this.hasPendingToolCall(input.session, options.toolUseID)) {
            const resolved = await this.waitForToolApproval(input.session, options.toolUseID, abortController.signal);
            if (resolved === "approved") {
              const approved = await approveOrDenyToolUse(
                input.session,
                input.workflow,
                toolName,
                toolInput,
                options.toolUseID
              );
              if (approved.allow) {
                input.session.status = "running";
                return { behavior: "allow", updatedInput: approved.updatedInput };
              }
              return { behavior: "deny", message: approved.message, interrupt: approved.interrupt };
            }
            input.session.status = "running";
            return { behavior: "deny", message: "用户拒绝了工具调用，请在当前权限边界内继续。", interrupt: false };
          }
          return { behavior: "deny", message: decision.message, interrupt: decision.interrupt };
        }
      }
    } as never);

    let postResultProcessError: unknown;
    try {
      for await (const message of queryInstance) {
        sdkMessages.push(message);
        this.recordSdkToolUses(input.session, stageId, message);
        this.recordToolExecutionResult(input.session, message);
        await this.recordDiscoveredSkills(input, message);
        const snippet = this.describeSdkMessage(message);
        if (isMeaningfulSdkProgress(snippet)) {
          await this.recordProgress(input, "sdk_message", snippet, "transient");
        }
      }
    } catch (error) {
      if (abortController.signal.aborted || !hasSuccessfulSdkTerminalResult(sdkMessages)) {
        throw enrichClaudeSdkProcessError(error, sdkStderr);
      }
      postResultProcessError = error;
    }

    if (abortController.signal.aborted) throw new Error("分层角色查询被中止");
    const output = extractClaudeStageOutput(sdkMessages);
    if (output.error) throw new Error(output.error);
    const transcript = formatClaudeTranscript(sdkMessages) || formatStructuredOutput(output.structuredOutput);
    const structured = output.structuredOutput !== undefined
      ? output.structuredOutput
      : output.resultText || output.assistantText;
    validateHierarchicalPlannerEnumeratedCoverage(input.session, operation, structured);
    const events = parseHierarchicalRoleResult(operation, structured);
    validateHierarchicalContractToolEvidence(input.session, operation, events, stageId);
    validateHierarchicalBehaviorObligationContinuity(input.session, operation, events);
    for (const event of events) {
      if (event.type !== "phase_passed" || !event.allowed_files) continue;
      const normalizedAllowedFiles: string[] = [];
      for (const filePath of event.allowed_files) {
        const normalized = normalizeHierarchicalLeasePath(input.session.project_path, filePath);
        if (normalized !== filePath) {
          await this.recordProgress(
            input,
            "tool_policy",
            `宿主已将 allowed_files 中的格式噪声规范化：${filePath} → ${normalized}`,
            "milestone"
          );
        }
        normalizedAllowedFiles.push(normalized);
      }
      event.allowed_files = [...new Set(normalizedAllowedFiles)];
      for (const filePath of event.allowed_files) {
        await assertPathInsideProject(input.session.project_path, filePath);
      }
    }
    if (postResultProcessError) {
      const warning = postResultProcessError instanceof Error
        ? postResultProcessError.message
        : String(postResultProcessError);
      await this.recordProgress(
        input,
        "status",
        `SDK 已返回成功结构化结果；子进程随后异常退出，${spec.phaseLabel} 结果已保留：${warning.slice(0, 120)}${formatSdkStderrSuffix(sdkStderr)}`,
        "milestone"
      );
    }
    return {
      events,
      transcript
    };
  }

  private applyHierarchicalEvents(session: AgentSession, events: HierarchicalEvent[]): void {
    let state = session.hierarchical_state;
    if (!state) throw new Error("会话尚未建立分层循环状态");
    for (const event of events) state = applyHierarchicalEvent(state, event);
    session.hierarchical_state = state;
  }

  private ensureHierarchicalAlignmentBatches(session: AgentSession): number {
    const state = session.hierarchical_state;
    if (!state || state.requirements.length > 0 || state.macro_phase !== "align") return 0;
    const registered = new Set(state.alignment_batches.flatMap((batch) =>
      batch.source_refs.map((source) => path.normalize(source))
    ));
    const candidateSources = collectSessionAttachments(session).flatMap((attachment) => {
      if (attachment.type !== "file_ref" || !attachment.path) return [];
      const exactPath = path.normalize(path.isAbsolute(attachment.path)
        ? attachment.path
        : path.resolve(session.project_path, attachment.path));
      return registered.has(exactPath) ? [] : [exactPath];
    });
    const newSources = [...new Set(candidateSources)];
    if (newSources.length === 0) return 0;
    const batches: Array<{ id: string; source_refs: string[] }> = [];
    let nextId = state.alignment_batches.reduce((largest, batch) => {
      const numeric = /^A(\d+)$/.exec(batch.id)?.[1];
      return Math.max(largest, numeric ? Number(numeric) : 0);
    }, 0) + 1;
    for (let index = 0; index < newSources.length; index += 3) {
      batches.push({ id: `A${nextId}`, source_refs: newSources.slice(index, index + 3) });
      nextId += 1;
    }
    this.applyHierarchicalEvents(session, [{ type: "alignment_sources_registered", batches }]);
    return batches.length;
  }

  private resolveAnsweredHierarchicalBlockers(session: AgentSession): void {
    const state = session.hierarchical_state;
    if (!state) return;
    const events: HierarchicalEvent[] = [];
    for (const blocker of state.blockers) {
      if (blocker.status !== "open" || !mayAskHumanForBlocker(blocker)) continue;
      const question = (session.pending_human_questions ?? []).find((item) =>
        item.id === `hierarchical:${blocker.id}` && item.status === "answered"
      );
      if (question) events.push({ type: "blocker_resolved", blocker_id: blocker.id });
    }
    if (events.length > 0) this.applyHierarchicalEvents(session, events);
  }

  private ensureHierarchicalHumanQuestion(session: AgentSession, blockerId: string, message: string): void {
    const id = `hierarchical:${blockerId}`;
    if ((session.pending_human_questions ?? []).some((question) => question.id === id)) return;
    session.pending_human_questions = [...(session.pending_human_questions ?? []), {
      id,
      stage_id: session.current_stage,
      question: message,
      question_type: "text",
      status: "pending",
      created_at: new Date().toISOString()
    }];
  }

  private raiseHierarchicalHostBlocker(
    session: AgentSession,
    kind: Extract<HierarchicalBlockerKind, "orchestration_fault" | "agent_failed" | "service_interrupted">,
    error: unknown,
    context: { requirementId?: string; workUnitId?: string; fingerprint?: string } = {}
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    const fingerprint = context.fingerprint ?? hierarchicalErrorFingerprint(session.current_stage, message);
    const state = session.hierarchical_state;
    if (!state) throw new Error(message);
    if (state.blockers.some((blocker) => blocker.status === "open" && blocker.error_fingerprint === fingerprint)) return;
    this.applyHierarchicalEvents(session, [{
      type: "blocker_raised",
      blocker: {
        id: `host-${kind}-${fingerprint}`,
        kind,
        owner: "host",
        message,
        status: "open",
        retryable: true,
        user_input_required: false,
        ...(context.requirementId ? { requirement_id: context.requirementId } : {}),
        ...(context.workUnitId ? { work_unit_id: context.workUnitId } : {}),
        error_fingerprint: fingerprint,
        created_at: new Date().toISOString()
      }
    }]);
  }

  private async runProfileMode(input: AgentRunInput): Promise<AgentSession> {
    input.session.status = "running";
    const simpleProfileLoop = input.workflow.simple_profile_loop === true;
    const attachmentErrors = await findUnreadableProfileAttachments(input.session);
    if (attachmentErrors.length > 0) {
      input.session.status = "interrupted";
      input.session.error = [
        "附件完整性检查失败，任务尚未开始。",
        ...attachmentErrors,
        "请重新附加缺失文件后再重新开始，宿主不会根据旧提交或文件名猜测附件需求。"
      ].join("\n");
      await this.recordProgress(input, "status", input.session.error, "milestone");
      return input.session;
    }
    const explorationBootstrapped = ensureExplorationCheckpoint(input.session);
    const taskTreeBootstrapped = simpleProfileLoop
      ? syncPhaseTaskTreeWithCheckpoint(input.session)
      : ensureProfileTaskTree(input.session);
    const taskTreeRepair = simpleProfileLoop ? null : repairConcurrentProfileTasks(input.session);
    await input.onProgress?.(input.session);
    if (taskTreeBootstrapped) {
      await this.recordProgress(
        input,
        "status",
        simpleProfileLoop
          ? "宿主已根据知识雪球的 next_action 建立当前阶段任务。"
          : "宿主已建立 Profile 根任务，等待执行与验证证据。",
        "milestone"
      );
    }
    if (taskTreeRepair) {
      await this.recordProgress(input, "status", taskTreeRepair, "milestone");
    }
    if (explorationBootstrapped) {
      await this.recordProgress(input, "status", "宿主已建立探索工作记忆，后续认知将通过 checkpoint 持续沉淀。", "milestone");
    }

    const abortController = new AbortController();
    this.abortControllers.set(input.session.id, abortController);
    const maxProfileQueries = 24;
    const maxRuntimeFollowUpQueries = 8;
    let profileQueryLimit = maxProfileQueries;
    const maxStalledQueries = 3;
    const maxSubprocessCrashRetries = 2;
    let stalledQueries = 0;
    let subprocessCrashRetries = 0;
    let consecutiveServiceUnavailableFailures = 0;
    let recentAssistantContext = collectRecentAssistantContext(input.session.messages);
    let continuationContext = "";

    try {
      for (let attempt = 0; attempt < profileQueryLimit; attempt += 1) {
        const queuedBeforeQuery = await this.takeQueuedUserMessages(input);
        if (queuedBeforeQuery.length > 0) {
          continuationContext = [
            buildQueuedUserMessageContext(queuedBeforeQuery, input.session.project_path),
            continuationContext
          ].filter(Boolean).join("\n\n");
          await this.recordProgress(
            input,
            "status",
            `已在安全执行边界接入 ${queuedBeforeQuery.length} 条用户补充消息。`,
            "milestone"
          );
        }
        const progressBeforeQuery = buildProfileProgressFingerprint(input.session);
        const result = await this.runProfileQuery(
          input,
          abortController,
          attempt > 0 || Boolean(continuationContext),
          continuationContext
        );
        if (result.finalSession) return result.finalSession;

        const transcript = formatClaudeTranscript(result.sdkMessages);
        if (transcript) {
          enrichImageReadEvidence(input.session, result.preQueryTcCount, transcript);
          this.appendAssistantMessage(input.session, transcript);
          recentAssistantContext = appendBoundedAssistantContext(recentAssistantContext, transcript);
          await this.recordProgress(input, "runner", transcript, "milestone");
        }

        if (!result.apiError) {
          const milestoneCheckpoint = checkpointProfileMilestoneIfNeeded(
            input.session,
            transcript
          );
          if (milestoneCheckpoint) {
            if (simpleProfileLoop) syncPhaseTaskTreeWithCheckpoint(input.session);
            await this.recordProgress(
              input,
              "status",
              milestoneCheckpoint,
              "milestone"
            );
          }
        }

        if (result.postResultProcessError) {
          const warning = result.postResultProcessError instanceof Error
            ? result.postResultProcessError.message
            : String(result.postResultProcessError);
          await this.recordProgress(
            input,
            "status",
            `SDK 已返回成功结果；子进程随后异常退出，本轮结果已保留：${warning.slice(0, 120)}`,
            "milestone"
          );
        }

        if (result.apiError) {
          const errorMessage = result.apiError instanceof Error
            ? result.apiError.message
            : String(result.apiError);
          const errorName = result.apiError instanceof Error
            ? result.apiError.name
            : typeof result.apiError;
          input.session.messages = input.session.messages.slice(0, result.preQueryMsgCount);
          const completedDuringInterruptedQuery = retainSettledProfileToolCalls(
            input.session,
            result.preQueryTcCount
          );
          if (completedDuringInterruptedQuery.length > 0) {
            checkpointInterruptedProfileProgress(
              input.session,
              completedDuringInterruptedQuery,
              transcript,
              errorMessage
            );
            if (simpleProfileLoop) syncPhaseTaskTreeWithCheckpoint(input.session);
          }
          input.session.status = "running";
          input.session.error = undefined;
          await this.recordProgress(input, "status", `API 调用失败：${errorMessage.slice(0, 120)}`, "milestone");
          continuationContext = buildLlmDecisionContext(
            errorName,
            errorMessage,
            transcript,
            completedDuringInterruptedQuery
          );
          if (isSubprocessCrashError(result.apiError)) {
            subprocessCrashRetries += 1;
          }
          const serviceUnavailable = isServiceUnavailableError(result.apiError);
          consecutiveServiceUnavailableFailures = serviceUnavailable
            ? consecutiveServiceUnavailableFailures + 1
            : 0;
          const serviceUnavailableRetryDelays = this.options.serviceUnavailableRetryDelaysMs ?? [2_000, 10_000];
          if (
            serviceUnavailable
            && consecutiveServiceUnavailableFailures > serviceUnavailableRetryDelays.length
          ) {
            input.session.status = "interrupted";
            input.session.error = errorMessage;
            await this.recordProgress(
              input,
              "status",
              `模型服务连续 ${consecutiveServiceUnavailableFailures} 次不可用，已停止自动重试。请稍后使用断点恢复。`,
              "milestone"
            );
            return input.session;
          }
          const exhaustedCrashRetries = subprocessCrashRetries > maxSubprocessCrashRetries;
          if (attempt + 1 < maxProfileQueries && !exhaustedCrashRetries && isRetriableApiError(result.apiError)) {
            if (serviceUnavailable) {
              const delayMs = serviceUnavailableRetryDelays[consecutiveServiceUnavailableFailures - 1] ?? 0;
              await this.recordProgress(
                input,
                "status",
                `模型服务暂不可用，${formatRetryDelay(delayMs)}后重试（${consecutiveServiceUnavailableFailures}/${serviceUnavailableRetryDelays.length}）。`,
                "milestone"
              );
              const elapsed = await waitForAbortableDelay(delayMs, abortController.signal);
              if (!elapsed) {
                input.session.status = "interrupted";
                input.session.error = "用户在服务重试等待期间停止了任务";
                return input.session;
              }
            }
            continue;
          }
          input.session.status = "interrupted";
          input.session.error = errorMessage;
          await this.recordProgress(input, "status", "SDK 调用失败，任务未完成。可使用断点恢复继续。", "milestone");
          return input.session;
        }
        consecutiveServiceUnavailableFailures = 0;

        if (this.hasPendingHumanQuestion(input.session)) {
          input.session.status = "waiting_approval";
          await this.recordProgress(input, "status", "等待用户回答", "milestone");
          return input.session;
        }
        if (input.session.tool_calls.some((toolCall) => toolCall.status === "pending_approval")) {
          input.session.status = "waiting_approval";
          await this.recordProgress(input, "status", "等待工具审批", "milestone");
          return input.session;
        }

        const terminalError = extractSdkTerminalError(result.sdkMessages);
        if (terminalError) {
          input.session.status = "interrupted";
          input.session.error = terminalError;
          await this.recordProgress(input, "status", `SDK 查询异常结束：${terminalError.slice(0, 160)}`, "milestone");
          return input.session;
        }

        const queuedAfterQuery = await this.takeQueuedUserMessages(input);
        if (queuedAfterQuery.length > 0) {
          continuationContext = buildQueuedUserMessageContext(queuedAfterQuery, input.session.project_path);
          stalledQueries = 0;
          input.session.status = "running";
          if (
            attempt + 1 >= profileQueryLimit &&
            profileQueryLimit < maxProfileQueries + maxRuntimeFollowUpQueries
          ) {
            profileQueryLimit += 1;
          }
          await this.recordProgress(
            input,
            "status",
            `已在安全执行边界接入 ${queuedAfterQuery.length} 条用户补充消息，将并入当前任务继续处理。`,
            "milestone"
          );
          continue;
        }

        if (simpleProfileLoop) syncPhaseTaskTreeWithCheckpoint(input.session);
        const latestCheckpoint = getLatestExplorationCheckpoint(input.session);
        if (latestCheckpoint?.source === "agent" && latestCheckpoint.disposition === "blocked") {
          input.session.status = "blocked";
          input.session.error = latestCheckpoint.next_action
            ? `探索工作记忆标记为 blocked：${latestCheckpoint.next_action}`
            : "探索工作记忆标记为 blocked；需要外部信息或状态变化后继续。";
          await this.recordProgress(input, "status", input.session.error, "milestone");
          return input.session;
        }

        const incompleteReasons = evaluateProfileCompletion(input.session, !simpleProfileLoop);
        if (incompleteReasons.length === 0) {
          input.session.status = "completed";
          input.session.error = undefined;
          await this.recordProgress(input, "status", "Profile 模式执行完成（完成闸门已通过）", "milestone");
          return input.session;
        }

        continuationContext = buildCompletionContinuationContext(
          incompleteReasons,
          recentAssistantContext,
          Boolean(result.postResultProcessError)
        );
        const progressAfterQuery = buildProfileProgressFingerprint(input.session);
        stalledQueries = progressAfterQuery === progressBeforeQuery ? stalledQueries + 1 : 0;
        if (stalledQueries >= maxStalledQueries) {
          input.session.status = "interrupted";
          input.session.error = `连续 ${maxStalledQueries} 轮没有可验证进展：${incompleteReasons.join("；")}`;
          await this.recordProgress(
            input,
            "status",
            `连续 ${maxStalledQueries} 轮没有任务状态、知识或文件改动，已暂停以避免空转。可使用断点恢复继续。`,
            "milestone"
          );
          return input.session;
        }
        input.session.status = "running";
        await this.recordProgress(
          input,
          "status",
          `任务尚未完成，自动继续（工作轮次 ${attempt + 1}/${maxProfileQueries}，连续无进展 ${stalledQueries}/${maxStalledQueries}）：${incompleteReasons.join("；").slice(0, 240)}`,
          "milestone"
        );
      }

      const incompleteReasons = evaluateProfileCompletion(input.session, !simpleProfileLoop);
      input.session.status = "interrupted";
      input.session.error = `完成闸门未通过：${incompleteReasons.join("；")}`;
      await this.recordProgress(input, "status", "达到 Profile 工作轮次安全上限，任务未完成。可使用断点恢复继续。", "milestone");
      return input.session;
    } finally {
      if (this.abortControllers.get(input.session.id) === abortController) {
        this.abortControllers.delete(input.session.id);
      }
    }
  }

  private async takeQueuedUserMessages(input: AgentRunInput): Promise<AgentMessage[]> {
    if (!input.takeQueuedUserMessages) return [];
    const queued = await input.takeQueuedUserMessages();
    const appended: AgentMessage[] = [];
    for (const message of queued) {
      if (message.role !== "user") continue;
      const exists = input.session.messages.some(
        (item) =>
          item.role === message.role &&
          item.created_at === message.created_at &&
          item.content === message.content
      );
      if (!exists) {
        input.session.messages.push(message);
        appended.push(message);
      }
    }
    return appended;
  }

  /** 单次 Profile 查询的返回结果 */
  private async runProfileQuery(
    input: AgentRunInput,
    abortController: AbortController,
    isLlmRetry: boolean,
    llmDecisionContext: string
  ): Promise<ProfileQueryResult> {
    const sdkMessages: unknown[] = [];
    const rewrittenToolInputs = new Map<string, Record<string, unknown>>();
    const preQueryMsgCount = input.session.messages.length;
    const preQueryTcCount = input.session.tool_calls.length;
    // 运行时解析的有效模型只来自 SDK init；宿主不指定或切换模型。
    let effectiveModel = "";

    try {
      const query = await this.resolveQuery();
      const mcpServer = await this.resolveMcpServer(input);

      const skillIds = input.workflow.skills ?? [];
      const allProfileSkills = await this.loadProfileSkills(skillIds);
      const profileSkills = selectProfileSkillsForPhase(
        allProfileSkills,
        getLatestExplorationCheckpoint(input.session)?.phase ?? "investigate"
      );
      const capabilityCatalog = await this.buildProfileCapabilityCatalog(input.workflow, Boolean(mcpServer));
      if (!isLlmRetry) {
        await this.recordProgress(
          input,
          "runner",
          `宿主已按当前阶段注入 ${profileSkills.length} 个 Skill 执行契约：${profileSkills.map((skill) => skill.id).join(", ") || "无"}`,
          "milestone"
        );
      }

      const simpleProfileLoop = input.workflow.simple_profile_loop === true;
      const carefulCoderInstructions = this.buildProfileSystemPrompt(
        profileSkills,
        input.workflow.system_prompt,
        isLlmRetry ? effectiveModel : undefined,
        simpleProfileLoop
      );

      const taskPrompt = input.session.task_prompt ?? "";
      const humanQaHistory = (input.session.pending_human_questions ?? [])
        .filter((q) => q.status === "answered")
        .map((q) => `- 问：${q.question}\n  答：${Array.isArray(q.answer) ? q.answer.join(", ") : (q.answer ?? "")}`)
        .join("\n");

      const initialMessage = input.session.initial_user_message ?? input.session.messages.find((m) => m.role === "user");
      const sessionAttachments = collectSessionAttachments(input.session);
      const attachmentList = formatProfileAttachmentList(sessionAttachments, input.session.project_path);

      const instructions = [
        `## 用户原始目标与输入\n${taskPrompt || "（无任务描述）"}`,
        attachmentList ? `### 附件\n${attachmentList}` : "",
        humanQaHistory ? `### 人类问答历史\n${humanQaHistory}` : "",
        buildExplorationPromptSection(input.session),
        input.session.task_tree
          ? simpleProfileLoop
            ? buildPhaseTaskTreePromptSection(input.session.task_tree)
            : buildTaskTreePromptSection(input.session.task_tree)
          : "",
        buildExecutionProgressPromptSection(input.session),
        isLlmRetry && llmDecisionContext ? llmDecisionContext : "",
        capabilityCatalog
      ].filter(Boolean).join("\n\n");

      await this.recordProgress(input, "runner", isLlmRetry ? "LLM 判断后继续执行（Profile 模式）" : "开始执行（Profile 模式）", "milestone");
      const claudeCodeExecutable = resolveBundledClaudeCodeExecutable();
      const sdkEnv = buildClaudeSdkEnv();

      const sdkAgents: Record<string, { description: string; tools?: string[]; prompt: string; model?: string }> = {};
      const workflowAgents = input.workflow.agents ?? {};
      for (const [name, def] of Object.entries(workflowAgents)) {
        sdkAgents[name] = {
          description: def.description,
          prompt: def.prompt,
          ...(def.tools && def.tools.length > 0 ? { tools: def.tools } : {}),
          ...(def.model ? { model: def.model } : {})
        };
      }
      const activeProfileSubagents = new Set<string>();
      const inspectToolUse = async (
        toolName: string,
        toolInput: Record<string, unknown>,
        _toolUseID: string
      ): Promise<string | null> => {
        return validateProfileToolInput(
          toolName,
          toolInput,
          input.session.project_path,
          sessionAttachments,
          getLatestExplorationCheckpoint(input.session)?.phase
        );
      };
      const redirectTaskToPlanner = async (
        toolInput: Record<string, unknown>,
        toolUseID: string
      ): Promise<Record<string, unknown>> => {
        const subagentType = optionalString(toolInput.subagent_type);
        const updatedInput = augmentTaskInputWithAttachmentManifest({
          ...toolInput,
          subagent_type: "task-planner",
          description: optionalString(toolInput.description)
            ? `制定计划：${optionalString(toolInput.description)}`
            : "读取需求与代码证据并制定任务 DAG"
        }, input.session);
        rewrittenToolInputs.set(toolUseID, updatedInput);
        const recordedToolCall = input.session.tool_calls.find(
          (toolCall) => toolCall.id === toolUseID
        );
        if (recordedToolCall) {
          recordedToolCall.input = updatedInput;
        }
        await this.recordProgress(
          input,
          "runner",
          `PLAN 阶段将 ${subagentType ?? "未指定 Agent"} 自动纠正为 task-planner`,
          "milestone"
        );
        return updatedInput;
      };

      const queryInstance = query({
        prompt: instructions,
        options: {
          systemPrompt: {
            type: "preset" as const,
            preset: "claude_code" as const,
            append: carefulCoderInstructions
          },
          cwd: input.session.project_path,
          ...(claudeCodeExecutable ? { pathToClaudeCodeExecutable: claudeCodeExecutable } : {}),
          env: sdkEnv,
          abortController,
          mcpServers: mcpServer ? { ai_coder: mcpServer } : undefined,
          ...(this.options.pluginPaths?.length
            ? { plugins: this.options.pluginPaths.map((pluginPath) => ({ type: "local" as const, path: pluginPath })) }
            : {}),
          tools: buildAllowedClaudeTools(input.workflow),
          disallowedTools: buildDisallowedClaudeTools(input.workflow),
          permissionMode: "default",
          // 只使用 ai-coder 自己的权限策略，避免用户/项目 hooks 形成第二套审批链。
          settingSources: [],
          // canUseTool 只会收到需要权限判断的工具。Read/Grep/Glob 等只读工具可能被 SDK
          // 自动放行，因此必须用宿主 PreToolUse hook 对 PLAN 状态机做确定性约束。
          hooks: {
            SubagentStart: [{
              hooks: [async (hookInput: Record<string, unknown>) => {
                const agentId = optionalString(hookInput.agent_id);
                if (agentId) activeProfileSubagents.add(agentId);
                return { continue: true };
              }]
            }],
            SubagentStop: [{
              hooks: [async (hookInput: Record<string, unknown>) => {
                const agentId = optionalString(hookInput.agent_id);
                if (agentId) activeProfileSubagents.delete(agentId);
                return { continue: true };
              }]
            }],
            PreToolUse: [{
              hooks: [async (hookInput: Record<string, unknown>) => {
                const hookToolName = optionalString(hookInput.tool_name) ?? "";
                const hookToolInput = isPlainObject(hookInput.tool_input) ? hookInput.tool_input : {};
                const hookToolUseID = optionalString(hookInput.tool_use_id) ?? "";
                const hookAgentID = optionalString(hookInput.agent_id);
                const plannerGuard = simpleProfileLoop && !hookAgentID
                  ? getSimplePlannerGuardError(input.session, sessionAttachments, hookToolName, hookToolInput)
                  : null;
                if (plannerGuard) {
                  return {
                    continue: true,
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "deny",
                      permissionDecisionReason: plannerGuard
                    }
                  };
                }
                const executorPrerequisiteGuard = simpleProfileLoop && !hookAgentID
                  ? getSimpleExecutorPrerequisiteGuardError(input.session, hookToolName, hookToolInput)
                  : null;
                if (executorPrerequisiteGuard) {
                  return {
                    continue: true,
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "deny",
                      permissionDecisionReason: executorPrerequisiteGuard
                    }
                  };
                }
                const delegationGuard = simpleProfileLoop && !hookAgentID
                  ? getSimpleDelegationGuardError(hookToolName, hookToolInput)
                  : null;
                if (delegationGuard) {
                  return {
                    continue: true,
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "deny",
                      permissionDecisionReason: delegationGuard
                    }
                  };
                }
                const repeatsCompletedPlanner = !simpleProfileLoop && hookToolName === "Task"
                  && optionalString(hookToolInput.subagent_type) === "task-planner"
                  && !profileNeedsPlanning(input.session)
                  && hasCompletedSubagent(input.session, "task-planner");
                if (repeatsCompletedPlanner) {
                  return {
                    continue: true,
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "deny",
                      permissionDecisionReason: "task-planner 和任务树已经完成；这是续跑，不得重新规划。请从当前未完成节点继续。"
                    }
                  };
                }
                const explorationGuard = hookAgentID || activeProfileSubagents.size > 0
                  ? null
                  : simpleProfileLoop
                    ? getSimpleKnowledgeBoundaryGuardError(input.session, hookToolName, hookToolInput, hookToolUseID)
                    : getExplorationActionGuardError(input.session, hookToolName, hookToolInput, hookToolUseID);
                if (explorationGuard) {
                  return {
                    continue: true,
                    hookSpecificOutput: {
                      hookEventName: "PreToolUse",
                      permissionDecision: "deny",
                      permissionDecisionReason: explorationGuard
                    }
                  };
                }
                if (simpleProfileLoop || activeProfileSubagents.size > 0 || !profileNeedsPlanning(input.session)) {
                  const guardError = await inspectToolUse(hookToolName, hookToolInput, hookToolUseID);
                  if (guardError) {
                    return {
                      continue: true,
                      hookSpecificOutput: {
                        hookEventName: "PreToolUse",
                        permissionDecision: "deny",
                        permissionDecisionReason: guardError
                      }
                    };
                  }
                  return { continue: true };
                }
                const plannerCompleted = hasCompletedSubagent(input.session, "task-planner");
                if (!plannerCompleted && hookToolName === "Task") {
                  const subagentType = optionalString(hookToolInput.subagent_type);
                  if (subagentType !== "task-planner") {
                    const updatedInput = await redirectTaskToPlanner(hookToolInput, hookToolUseID);
                    return {
                      continue: true,
                      hookSpecificOutput: {
                        hookEventName: "PreToolUse",
                        permissionDecision: "allow",
                        updatedInput
                      }
                    };
                  }
                  return { continue: true };
                }
                if (
                  hookToolName === "Skill"
                  || hookToolName === "mcp__ai_coder__checkpoint_exploration"
                  || (plannerCompleted && hookToolName === "mcp__ai_coder__update_task_tree")
                ) {
                  return { continue: true };
                }
                return {
                  continue: true,
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse",
                    permissionDecision: "deny",
                    permissionDecisionReason: plannerCompleted
                      ? "task-planner 已完成，但详细任务 DAG 尚未建立。请先调用 update_task_tree 接管 planner 结果。"
                      : "宿主仍处于 PLAN 阶段。根 Agent 不得直接读取附件或代码；请立即调用 Task，并使用 task-planner。"
                  }
                };
              }]
            }]
          },
          ...(Object.keys(sdkAgents).length > 0 ? { agents: sdkAgents } : {}),
          canUseTool: async (
            toolName: string,
            toolInput: Record<string, unknown>,
            options: { toolUseID: string; agentID?: string }
          ) => {
            if (toolName === "Skill") {
              const skillName = String(toolInput.skill ?? toolInput.name ?? "unknown");
              this.appendAssistantMessage(input.session, `正在加载 Skill：\`${skillName}\``, "skill_usage");
              await this.recordProgress(input, "runner", `加载 Skill：${skillName}`, "milestone");
            }
            const plannerGuard = simpleProfileLoop && !options.agentID
              ? getSimplePlannerGuardError(input.session, sessionAttachments, toolName, toolInput)
              : null;
            if (plannerGuard) {
              await this.recordProgress(input, "tool_policy", plannerGuard, "milestone");
              return { behavior: "deny", message: plannerGuard, interrupt: false };
            }
            const rootNeedsTaskDag = !simpleProfileLoop && !options.agentID && profileNeedsPlanning(input.session);
            const plannerCompleted = hasCompletedSubagent(input.session, "task-planner");
            if (
              rootNeedsTaskDag
              && toolName !== "Skill"
              && toolName !== "mcp__ai_coder__checkpoint_exploration"
              && (
                (!plannerCompleted && toolName !== "Task")
                || (plannerCompleted && toolName !== "mcp__ai_coder__update_task_tree")
              )
            ) {
              return {
                behavior: "deny",
                message: plannerCompleted
                  ? "task-planner 已完成，但详细任务 DAG 尚未建立。请先调用 update_task_tree 接管 planner 结果。"
                  : "宿主仍处于 PLAN 阶段。根 Agent 不得直接读取附件或代码；请立即调用 Task，并使用 task-planner。",
                interrupt: false
              };
            }
            if (
              toolName === "Task"
              && optionalString(toolInput.subagent_type) === "task-planner"
              && !simpleProfileLoop
              && !profileNeedsPlanning(input.session)
              && hasCompletedSubagent(input.session, "task-planner")
            ) {
              return {
                behavior: "deny",
                message: "task-planner 和任务树已经完成；这是续跑，不得重新规划。请从当前未完成节点继续。",
                interrupt: false
              };
            }
            const explorationGuard = options.agentID
              ? null
              : simpleProfileLoop
                ? getSimpleKnowledgeBoundaryGuardError(input.session, toolName, toolInput, options.toolUseID)
                : getExplorationActionGuardError(input.session, toolName, toolInput, options.toolUseID);
            if (explorationGuard) {
              await this.recordProgress(input, "tool_policy", explorationGuard, "milestone");
              return { behavior: "deny", message: explorationGuard, interrupt: false };
            }
            const delegationGuard = simpleProfileLoop && !options.agentID
              ? getSimpleDelegationGuardError(toolName, toolInput)
              : null;
            if (delegationGuard) {
              await this.recordProgress(input, "tool_policy", delegationGuard, "milestone");
              return { behavior: "deny", message: delegationGuard, interrupt: false };
            }
            const guardError = await inspectToolUse(toolName, toolInput, options.toolUseID);
            if (guardError) {
              await this.recordProgress(input, "tool_policy", `工具调用失败：${guardError}`, "milestone");
              return { behavior: "deny", message: guardError, interrupt: false };
            }
            if (toolName === "mcp__ai_coder__checkpoint_exploration") {
              try {
                const normalizedCheckpoint = normalizeExplorationCheckpointArgs(toolInput);
                const auditInput = summarizeExplorationCheckpointToolInput(normalizedCheckpoint);
                rewrittenToolInputs.set(options.toolUseID, auditInput);
                const recordedToolCall = input.session.tool_calls.find(
                  (toolCall) => toolCall.id === options.toolUseID
                );
                if (recordedToolCall) recordedToolCall.input = auditInput;
                // The SDK's PermissionResult allow branch requires updatedInput.
                // Keep the full checkpoint payload here so the MCP handler receives
                // `memory`; only the separately rewritten audit record is redacted.
                return { behavior: "allow", updatedInput: toolInput };
              } catch (error) {
                const message = `探索 checkpoint 参数无效，已拒绝执行：${error instanceof Error ? error.message : String(error)}`;
                await this.recordProgress(input, "tool_policy", message, "milestone");
                return { behavior: "deny", message, interrupt: false };
              }
            }
            if (toolName === "mcp__ai_coder__update_task_tree") {
              let effectiveInput = toolInput;
              try {
                let normalizedMutation = normalizeTaskTreeMutationArgs(toolInput, input.session);
                normalizedMutation = repairIncompleteTaskStatusMutation(input.session, normalizedMutation);
                normalizedMutation = normalizePrematureTaskCompletion(input.session, normalizedMutation);
                const reusedMutation = reusePriorBootstrapTasks(input.session, normalizedMutation, options.toolUseID);
                const reusedPriorBootstrap = reusedMutation !== normalizedMutation;
                normalizedMutation = reusedMutation;
                if (reusedPriorBootstrap) {
                  await this.recordProgress(
                    input,
                    "runner",
                    `宿主复用前序 bootstrap 携带的 ${normalizedMutation.tasks?.length ?? 0} 个任务节点（前序因工具名损坏或参数丢失未生效）`,
                    "milestone"
                  );
                }
                effectiveInput = taskTreeMutationToToolInput(normalizedMutation);
                rewrittenToolInputs.set(options.toolUseID, effectiveInput);
                const recordedToolCall = input.session.tool_calls.find(
                  (toolCall) => toolCall.id === options.toolUseID
                );
                if (recordedToolCall) recordedToolCall.input = effectiveInput;
                const mutationResult = applyTaskTreeMutation(
                  input.session,
                  normalizedMutation
                );
                await this.recordProgress(
                  input,
                  "runner",
                  `${mutationResult.split("\n")[0] || "任务树已更新"}（${
                    normalizedMutation.status_reason?.startsWith("宿主安全补齐")
                      ? normalizedMutation.status_reason
                      : "宿主兜底"
                  }）`,
                  "milestone"
                );
              } catch (error) {
                const message = `任务树参数无效，已拒绝执行：${error instanceof Error ? error.message : String(error)}`;
                await this.recordProgress(
                  input,
                  "tool_policy",
                  message,
                  "milestone"
                );
                return { behavior: "deny", message, interrupt: false };
              }
              return { behavior: "allow", updatedInput: effectiveInput };
            }
            if (toolName === "Task") {
              const subagentType = optionalString(toolInput.subagent_type);
              const allowedSubagents = new Set(Object.keys(input.workflow.agents ?? {}));
              if (
                subagentType === "task-planner"
                && !profileNeedsPlanning(input.session)
                && hasCompletedSubagent(input.session, "task-planner")
              ) {
                return {
                  behavior: "deny",
                  message: "task-planner 和任务树已经完成；这是续跑，不得重新规划。请从当前未完成节点继续。",
                  interrupt: false
                };
              }
              if (!simpleProfileLoop && profileNeedsPlanning(input.session) && !plannerCompleted) {
                if (!allowedSubagents.has("task-planner")) {
                  return {
                    behavior: "deny",
                    message: "宿主仍处于 PLAN 阶段，但当前工作流未声明 task-planner，无法安全继续。",
                    interrupt: false
                  };
                }
                if (subagentType !== "task-planner") {
                  const updatedInput = await redirectTaskToPlanner(toolInput, options.toolUseID);
                  return { behavior: "allow", updatedInput };
                }
              }
              if (!subagentType || !allowedSubagents.has(subagentType)) {
                return {
                  behavior: "deny",
                  message: `禁止调用未由当前工作流声明的 Agent：${subagentType ?? "未指定"}。可用 Agent：${[...allowedSubagents].join(", ") || "无"}。`,
                  interrupt: false
                };
              }
              if (
                simpleProfileLoop
                && subagentType === "task-executor"
                && !hasMergedCallContractPrerequisite(input.session)
              ) {
                return {
                  behavior: "deny",
                  message: getSimpleExecutorPrerequisiteGuardError(input.session, toolName, toolInput) ?? "task-executor 前置门禁未通过",
                  interrupt: false
                };
              }
              const effectiveTaskInput = augmentTaskInputWithExplorationMemory(
                augmentTaskInputWithAttachmentManifest(toolInput, input.session),
                input.session,
                capabilityCatalog
              );
              const requiredSkills = requiredSkillsForSubagent(subagentType);
              if (requiredSkills.length > 0) {
                await this.recordProgress(
                  input,
                  "runner",
                  `委托 ${subagentType} 落实 Skill：${requiredSkills.join(", ")}`,
                  "milestone"
                );
              }
              if (effectiveTaskInput !== toolInput) {
                rewrittenToolInputs.set(options.toolUseID, effectiveTaskInput);
                const recordedToolCall = input.session.tool_calls.find(
                  (toolCall) => toolCall.id === options.toolUseID
                );
                if (recordedToolCall) recordedToolCall.input = effectiveTaskInput;
              }
              const startedTask = startCurrentProfileTask(input.session);
              if (startedTask) {
                await this.recordProgress(input, "runner", `${startedTask}（宿主兜底）`, "milestone");
              }
              return { behavior: "allow", updatedInput: effectiveTaskInput };
            }
            if (
              toolName === "Skill" ||
              toolName === "mcp__ai_coder__ask_human" ||
              toolName === "mcp__ai_coder__checkpoint_exploration" ||
              toolName === "mcp__ai_coder__analyze_symbol_contract"
            ) {
              return { behavior: "allow", updatedInput: toolInput };
            }
            if (!simpleProfileLoop && profileNeedsPlanning(input.session) && ["Edit", "Write", "NotebookEdit"].includes(toolName)) {
              return {
                behavior: "deny",
                message: "宿主仍处于 PLAN 阶段：task-planner 尚未产出详细任务 DAG，禁止修改文件。",
                interrupt: false
              };
            }
            if (!simpleProfileLoop && profileNeedsPlanning(input.session) && toolName === "Bash" && isMutatingShellCommand(toolInput.command)) {
              return {
                behavior: "deny",
                message: "宿主仍处于 PLAN 阶段：禁止通过 Bash 修改工作区、分支、索引或提交历史。先完成 task-planner 并由宿主建立详细任务 DAG。",
                interrupt: false
              };
            }
            const safety = checkCommandSafety("profile", toolName, toolInput);
            if (!safety.allow) {
              await this.recordProgress(input, "tool_policy", `安全拦截：${safety.message}`, "milestone");
              return { behavior: "deny", message: safety.message, interrupt: false };
            }
            const decision = await approveOrDenyToolUse(
              input.session,
              input.workflow,
              toolName,
              toolInput,
              options.toolUseID
            );
            await this.recordProgress(
              input,
              "tool_policy",
              decision.allow ? `工具已允许：${toolName}` : `工具未允许：${toolName}（${decision.message}）`,
              decision.allow ? "transient" : "milestone"
            );
            if (decision.allow) {
              return { behavior: "allow", updatedInput: decision.updatedInput };
            }
            if (this.hasPendingToolCall(input.session, options.toolUseID)) {
              const resolved = await this.waitForToolApproval(
                input.session,
                options.toolUseID,
                abortController.signal
              );
              if (resolved === "approved") {
                const approvedDecision = await approveOrDenyToolUse(
                  input.session,
                  input.workflow,
                  toolName,
                  toolInput,
                  options.toolUseID
                );
                await this.recordProgress(
                  input,
                  "tool_policy",
                  this.describeToolDecision(toolName, approvedDecision.allow),
                  "milestone"
                );
                if (approvedDecision.allow) {
                  input.session.status = "running";
                  return { behavior: "allow", updatedInput: approvedDecision.updatedInput };
                }
                return { behavior: "deny", message: approvedDecision.message, interrupt: approvedDecision.interrupt };
              }
              input.session.status = "running";
              return {
                behavior: "deny",
                message: "Tool call was denied by the user. Continue without this tool or choose an allowed alternative.",
                interrupt: false
              };
            }
            return { behavior: "deny", message: decision.message, interrupt: decision.interrupt };
          }
        }
      } as never);
      for await (const message of queryInstance) {
        sdkMessages.push(message);
        // 从 SDK init 消息中捕获运行时实际使用的模型
        captureEffectiveModelFromInitMessage(message, (model) => {
          if (model && !effectiveModel) {
            effectiveModel = model;
          }
        });
        this.recordSdkToolUses(input.session, "profile", message);
        // SDK 对未知工具名（如损坏的 mcp__ai_c__update_task_tree、"Bash" <parameter）会直接
        // 回 "No such tool available"，绕过 canUseTool/PreToolUse，宿主的工具名校验无法触达。
        // 这里在流上检测并记录里程碑，让活动日志可见，便于排查模型工具名损坏。
        for (const toolUse of extractSdkToolUses(message)) {
          const corruption = detectCorruptedToolName(toolUse.tool);
          if (corruption) {
            await this.recordProgress(input, "tool_policy", corruption, "milestone");
            if (/update_task_tree/i.test(toolUse.tool)) {
              const repaired = await this.tryApplyCorruptedTaskTreeToolUse(input, toolUse);
              if (repaired) continue;
            }
            if (/checkpoint_exploration/i.test(toolUse.tool)) {
              const repaired = await this.tryApplyCorruptedExplorationCheckpointToolUse(input, toolUse);
              if (repaired) continue;
            }
            continue;
          }
          // Task 缺少 subagent_type 时记录里程碑。redirectTaskToPlanner 的条件
          // (subagent_type !== "task-planner") 对缺值同样成立、理论上能改写；但运行日志
          // 显示缺值调用被 SDK 以 InputValidationError 拒绝，说明 schema 校验先于 redirect 生效。
          // 本检测只记录、不拦截：若 redirect 已成功补齐，此里程碑为冗余但无害；用于排查
          // "Task 调用为何失败"。
          if (toolUse.tool === "Task") {
            const subagentType = optionalString(toolUse.input.subagent_type);
            if (!subagentType) {
              const needsPlanner = simpleProfileLoop
                ? requiresPlannerInSimpleProfile(input.session, sessionAttachments)
                : profileNeedsPlanning(input.session);
              const allowed = Object.keys(input.workflow.agents ?? {});
              const hint = needsPlanner && allowed.includes("task-planner")
                ? "当前请求需要规划，请使用 Task({ subagent_type: \"task-planner\", description: \"拆分需求\", prompt: \"...\" })"
                : `请提供有效的 subagent_type（可用：${allowed.join(", ") || "无"}）`;
              await this.recordProgress(
                input,
                "tool_policy",
                `Task 调用缺少 subagent_type；若 SDK 未由 redirectTaskToPlanner 自动补齐，将拒绝执行。${hint}`,
                "milestone"
              );
            }
          }
        }
        for (const [toolUseId, updatedInput] of rewrittenToolInputs) {
          const recordedToolCall = input.session.tool_calls.find(
            (toolCall) => toolCall.id === toolUseId
          );
          if (recordedToolCall) {
            recordedToolCall.input = updatedInput;
            rewrittenToolInputs.delete(toolUseId);
          }
        }
        this.recordToolExecutionResult(input.session, message);
        const streamedTranscript = formatClaudeTranscript([message]);
        const streamedMilestoneCheckpoint = checkpointProfileMilestoneIfNeeded(
          input.session,
          streamedTranscript
        );
        if (streamedMilestoneCheckpoint) {
          if (simpleProfileLoop) syncPhaseTaskTreeWithCheckpoint(input.session);
          await this.recordProgress(
            input,
            "status",
            streamedMilestoneCheckpoint,
            "milestone"
          );
        }
        const snippet = describeSdkMessageSnippet(message);
        if (isMeaningfulSdkProgress(snippet)) {
          await this.recordProgress(input, "runner", snippet, "transient");
        }
        // 检测 DSML 格式的工具调用：若模型输出了 DSML 标记，SDK 不会执行这些工具，
        // 它们会作为纯文本出现在对话中。记录警告便于排查。
        if (hasDsmlContent(message)) {
          await this.recordProgress(input, "runner", "⚠️ 检测到 DSML 格式工具调用（SDK 无法执行），建议切换模型", "milestone");
        }
      }

      if (abortController.signal.aborted) {
        input.session.status = "interrupted";
        return { sdkMessages, preQueryMsgCount, preQueryTcCount, finalSession: input.session };
      }

      // 缓存跨查询的有效模型
      if (effectiveModel) {
        this.resolvedEffectiveModel = effectiveModel;
      }

      return { sdkMessages, preQueryMsgCount, preQueryTcCount, effectiveModel: effectiveModel || undefined };
    } catch (error) {
      if (isAbortError(error) || abortController.signal.aborted) {
        const resolved = this.resolveInterruptedStatus(input.session);
        input.session.status = resolved === "completed" ? "interrupted" : resolved;
        return { sdkMessages, preQueryMsgCount, preQueryTcCount, finalSession: input.session };
      }
      if (hasSuccessfulSdkTerminalResult(sdkMessages)) {
        return {
          sdkMessages,
          preQueryMsgCount,
          preQueryTcCount,
          postResultProcessError: error,
          effectiveModel: effectiveModel || undefined
        };
      }
      return {
        sdkMessages,
        preQueryMsgCount,
        preQueryTcCount,
        apiError: preferSdkReportedError(sdkMessages, error),
        effectiveModel: effectiveModel || undefined
      };
    }
  }

/** 构建 Profile 模式的系统提示词 */
  private buildProfileSystemPrompt(
    profileSkills: Array<{ id: string; content: string }>,
    workflowSystemPrompt?: string,
    effectiveModel?: string,
    simpleProfileLoop = false
  ): string {
    const modelSupportsImages = isModelMultimodal(effectiveModel ?? null);
    const languageGuidance = [
      "## 语言要求（最高优先级）",
      "**必须使用简体中文**进行所有思考、分析和回复。",
      "禁止使用英文输出任何解释、总结或分析。",
      "代码、命令、文件名等技术内容保持原文不变。",
      "违反此规则将导致任务失败。"
    ].join("\n");
    const loadedSkillsSection = profileSkills.length > 0
      ? [
          "## 宿主按当前阶段注入的 Skills（执行契约）",
          "以下内容不是可选参考。先用这些契约判断当前缺口和行动方式；无需再次调用 Skill 工具加载同名 Skill，但必须在实际委托、执行和证据中体现契约。",
          ...profileSkills.map((skill) => `\n### ${skill.id}\n${skill.content}`)
        ].join("\n")
      : "";

    if (simpleProfileLoop) {
      const simpleFileGuidance = modelSupportsImages
        ? "附件只使用宿主精确清单中的路径；按当前缺失信息读取必要页面，不猜路径、不找替代副本。"
        : `当前模型（${effectiveModel || "默认"}）不支持图片输入；附件只使用宿主精确清单中的路径，并选择合适的文本提取工具。`;
      return [
        languageGuidance,
        workflowSystemPrompt ?? "",
        loadedSkillsSection,
        simpleFileGuidance,
        "提示词装配顺序：系统层持续提供谨慎程序员人设与完整 Skill 契约；每次主线程查询按“用户原始目标与输入 → 当前知识雪球 → 当前阶段任务 → 当前执行观察 → Skills/Sub-agents/Tools 能力目录”读取；每次 Task 委托也按“委托目标 → 知识雪球 → 阶段任务 → 执行观察 → 能力目录”读取。后面的执行观察只能校正知识，不能越过知识雪球直接改变目标。",
        "每轮先结合知识雪球中的缺口与当前能力目录，明确选择：已加载 Skill 契约、一个匹配的 Sub-agent，或直接工具。跨多文件追踪、独立验证或完整性审查与已注册 Sub-agent 职责匹配时优先委托；简单单点事实才直接用工具。把选择及理由归并进知识雪球。",
        "复杂入口硬规则：多附件、多需求点、跨文件或指定基线的请求在进入实现前必须委托 task-planner。planner 尚未成功启动时，根 Agent 可以做最小只读取证以解除阻塞，但不得一次性读取全部附件或重复撞同一门禁。根 Agent 只负责编排和知识归并，任何工作区修改必须委托 task-executor，并在完成后委托 task-verifier。",
        "Task 调用必须显式填写 subagent_type。复杂入口的正确格式是 `Task({ subagent_type: \"task-planner\", description: \"拆分需求\", prompt: \"只读分析并返回 R-ID 与证据\" })`；不要省略 subagent_type，也不要用 Skill 调用替代 Task。",
        "当前阶段已经注入的核心 Skill 不得再次调用 Skill 工具；应直接落实其契约。只有能力目录里未注入且确实需要的额外 Skill 才调用 Skill 工具。",
        "调用契约硬规则：拟议实现只要会调用、复用或修改已有函数、方法、Hook 或组件，第一次相关修改前必须通过 Task 使用 call-contract-investigator，并把结果归并进知识雪球；主线程自行 Read/Grep/Bash 不能替代。只有纯文案、静态数据或样式且不涉及任何既有函数/组件时才可判定不适用，并记录依据。",
        "只调用工具列表中展示的精确工具名，并使用标准 tool_use 格式。"
      ].filter(Boolean).join("\n\n");
    }

    const reactGuidance = [
      "## 工具使用指引（探索循环）",
      "",
      "你必须持续滚动 **认知→行动→观察→归并** 循环，直到目标的相关未知全部关闭：",
      "1. **认知**：先读当前探索工作记忆，找出最重要的未知、矛盾或未验证结论",
      "2. **行动**：只调用能够缩小该未知或验证该结论的最小工具（Read、Bash、Task、Skill 等）",
      "3. **观察**：区分原始工具事实、可支持的结论和仍然存在的未知",
      "4. **归并**：在重要证据、实现、验证或审查后，用 checkpoint_exploration 更新当前有效认知；已确认知识像雪球一样持续累积",
      "5. **继续**：从更新后的工作记忆选择下一步；没有阻塞未知且最终审查通过后才能结束",
      "",
      "关键规则：",
      "- 每次只读你需要的内容，不要一次性读取所有文件",
      "- 读完工具输出后必须归并或继续同一组取证，不能停在“我接下来要分析”",
      "- 每个高层行动都要能指出它正在关闭工作记忆中的哪个未知或验证哪个结论",
      "- 完成所有工作后，用一段清晰的总结收尾",
      "- 只调用工具列表中展示的精确工具名；禁止自行增删下划线、截断名称或把工具调用拼成普通文本",
      "- **调用工具时使用标准的 tool_use 格式，禁止使用 DSML 标记**（如 `<|DSML|tool_calls>`、`<|DSML|invoke>`、`Calling:` 等文本格式）"
    ].join("\n");

    const taskTreeGuidance = [
      "## 任务树（工作记忆派生出的执行投影）",
      "",
      "探索工作记忆决定为什么做和接下来探索什么；任务树只负责把当前行动可靠地排队、执行和验证。使用 `update_task_tree` MCP 工具维护执行投影：",
      "",
      "1. **启动**：task-planner 返回后，先调用 `checkpoint_exploration` 吸收其需求证据、已确认事实和 blocking unknown，再调用 `update_task_tree(action=\"bootstrap\")` 接管 DAG；不要由主 Agent 再读一遍附件或代码。",
      "   - 每个子任务必须独立可验证——改不同文件、有不同验收标准",
      "   - 声明依赖关系：A 依赖 B 意味着 A 的输出是 B 的输入",
      "   - planner 已完成的需求提取、附件阅读和代码探索是计划证据，不得再创建“重新读需求/重新探索项目”节点",
      "2. **执行**：选定任务后，先调用 `update_task_tree(action=\"update_status\", task_id=\"tN\", new_status=\"in_progress\", next_focus=\"tN\", next_reason=\"开始执行该节点\")` 将其标为 in_progress，然后：",
      "   - **复杂子任务**：使用 `Task` 工具 spawn `task-executor` sub-agent 来执行",
      "     `Task({ subagent_type: \"task-executor\", description: \"执行 tN: <描述>\", prompt: \"项目路径: <path>\\n任务: <描述>\\n验收标准: <criteria>\\n已知上下文: ...\" })`",
      "     executor 返回后先 checkpoint 归并实现结果，再调用 task-verifier；verifier 返回后再次 checkpoint，PASS 才调用 `update_task_tree(action=\"update_status\", task_id=\"tN\", new_status=\"completed\", evidence=\"<真实验证输出>\", next_focus=\"<下一节点>\", next_reason=\"<原因>\")`",
      "   - **简单或已有证据的子任务**：仍按 `in_progress → task-executor → task-verifier → completed` 推进；把已有证据传给 Agent，明确禁止重新读取相同文件",
      "   - 一次只执行一个 dependency-ready 节点；当前节点完成并验证后再进入下一个，避免并发 Agent 重复读取或修改同一上下文",
      "3. **发现**：执行中发现新的必要工作时，调用 `update_task_tree(action=\"add\")` 加入新节点，说明为什么此时发现",
      "4. **声明下一步**：每次调用都必须填 `next_focus` 和 `next_reason`——始终清楚\"我现在聚焦哪个任务、为什么、完成后去哪\"",
      "",
      "关键规则：",
      "- 任务树是执行控制器，不是认知来源；任务描述与工作记忆冲突时，先根据证据修正工作记忆，再调整任务树",
      "- completed 的证据必须来自真实的工具执行结果（或 sub-agent 返回的 evidence），不能编造",
      "- 简单任务可以只有一个任务节点，但必须在 strategy 中说明原因",
      "- 发现当前计划有误时，用 update_status 标 blocked/skipped 并说明原因，不要静默偏离",
      "- **上下文管理**：复杂子任务委托给 task-executor，主 Agent 只接收结构化结论——避免上下文膨胀"
    ].join("\n");

    const explorationGuidance = [
      "## 探索工作记忆（最高优先级的认知雪球）",
      "",
      "`checkpoint_exploration` 中的一整段 Markdown 是你跨轮工作的首要认知来源。任务树、消息历史和工具日志为它提供执行状态与原始依据，但不能代替它。不要把工作记忆写成工具流水账。",
      "在取得会改变判断的证据、完成一组相关搜索、修改代码、完成验证或审查、改变行动方向，以及准备结束前，调用一次 `checkpoint_exploration` 更新工作记忆。",
      "每次更新都要吸收最新结果。`## 已确认` 下的既有条目必须继续保留；宿主会自动补回遗漏项，让知识像雪球一样只增不丢。过程信息可以压缩，但确认知识不可以。",
      "发现旧结论有误时，不删除旧条目，新增一条带证据的“校正：旧结论 → 新结论”，让后续工作以校正后的结论为准。",
      "事实尽量附用户原话、path:line、命令输出或 sub-agent 结果；猜测必须留在待确认项，不能写成已确认事实。",
      "文件、分支或依赖发生变化后，主动检查哪些旧结论和验证已经过期，并在工作记忆中重新打开必要问题。",
      "disposition 用法：continue=继续探索或实施；verify=进入最终验证/审查；complete=最终审查通过且任务树全部关闭；blocked=缺少外部信息或无法安全继续。",
      "complete checkpoint 是完成声明，不是计划。调用后若宿主发现新的工具结果、未完成节点或缺失证据，会要求继续滚动工作记忆。"
    ].join("\n");

    return [
      languageGuidance,
      modelSupportsImages
        ? [
            "## 文件读取规则",
            "- 读取 PDF 时优先使用已拆页 PNG，避免 PDF base64 过大导致 API 400；必要时仍可自行选择其他工具",
            "- 对宿主登记的输入及其派生资源，只能逐字使用当前提示中的“宿主精确附件清单”，不得推导目录或替代路径",
            "- 每次只读取当前需要的页面，不要一次性读取所有页面",
            "- 图片已经可以直接用 Read 查看；禁止为了查看尺寸、base64 或图片文本再编写 Python/PIL 临时脚本",
            "",
            "### 附件 Read 失败处理（重要）",
            "- 如果按照“宿主精确附件清单”中列出的路径 Read 返回空内容或明显不完整：",
            "  1. 这是阻塞性问题——附件内容缺失意味着需求不完整，无法确认用户请求的具体范围",
            "  2. 立即停止尝试项目内其他路径或自行搜索同名/相似文件作为替代",
            "  3. 在 task-planner 的 blocking_unknowns 中写明哪个附件路径返回空、尝试了几次",
            "  4. 通过 ask_human 说明哪些附件无法读取，请求重新提供",
            "  5. 绝对不要：使用项目内碰巧存在的同名、相似或同类型文件作为输入资源的替代来源"
          ].join("\n")
        : [
            "## 文件读取规则",
            "- 读取 PDF 时优先使用文本提取工具，避免 PDF base64 过大导致 API 400；必要时仍可自行选择其他工具",
            `- **当前模型（${effectiveModel || "默认"}）不支持图片输入**：请使用命令行文本工具提取 PDF 内容，例如 ` + "`pdftotext <pdf路径> -` 或 `python3 -c \"import PyPDF2; ...\"`",
            "- 对宿主登记的输入及其派生资源，只能逐字使用当前提示中的“宿主精确附件清单”，并根据当前模型能力选择读取工具",
            "",
            "### 附件 Read 失败处理（重要）",
            "- 如果按照“宿主精确附件清单”中列出的路径 Read 返回空内容或明显不完整：",
            "  1. 这是阻塞性问题——附件内容缺失意味着需求不完整，无法确认用户请求的具体范围",
            "  2. 立即停止尝试项目内其他路径或自行搜索同名/相似文件作为替代",
            "  3. 在 task-planner 的 blocking_unknowns 中写明哪个附件路径返回空、尝试了几次",
            "  4. 通过 ask_human 说明哪些附件无法读取，请求重新提供",
            "  5. 绝对不要：使用项目内碰巧存在的同名、相似或同类型文件作为输入资源的替代来源"
          ].join("\n"),
      explorationGuidance,
      reactGuidance,
      simpleProfileLoop ? "" : taskTreeGuidance,
      workflowSystemPrompt ?? "",
      loadedSkillsSection
    ].filter(Boolean).join("\n\n");
  }

  private async runCurrentStage(input: AgentRunInput): Promise<AgentSession> {
    this.workflowEngine.ensureState(input.session, input.workflow);
    if (this.waitForApprovalIfNeeded(input)) {
      return input.session;
    }

    const currentStage = input.workflow.stages.find((stage) => stage.id === input.session.current_stage);
    if (!currentStage) {
      input.session.status = "failed";
      input.session.error = `Workflow stage not found: ${input.session.current_stage}`;
      return input.session;
    }

    if (
      currentStage.approval_required &&
      currentStage.allowed_tools?.includes("edit_file") &&
      !this.hasStageApproval(input.session, currentStage.id)
    ) {
      return this.requestStageApprovalIfNeeded(input, currentStage);
    }

    const stageAgentInput = buildStageAgentInput(input.session, input.workflow, currentStage);

    if (!(await shouldUseClaudeSdk())) {
      await this.recordProgress(input, "runner", "使用 Mock 模式生成阶段结果。", "milestone");
      return this.runMock(input, stageAgentInput);
    }

    const sdkMessages: unknown[] = [];
    const abortController = new AbortController();
    this.abortControllers.set(input.session.id, abortController);

    // 保存查询前状态，用于重试时回滚
    const preQueryMsgCount = input.session.messages.length;
    const preQueryTcCount = input.session.tool_calls.length;
    const MAX_API_RETRIES = 3;
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
      if (attempt > 0) {
        // 回滚会话状态到查询前
        sdkMessages.length = 0;
        input.session.messages = input.session.messages.slice(0, preQueryMsgCount);
        input.session.tool_calls = input.session.tool_calls.slice(0, preQueryTcCount);
        input.session.error = undefined;
        input.session.status = "running";
        const delay = Math.min(2000 * Math.pow(2, attempt - 1), 15000);
        await new Promise((r) => setTimeout(r, delay));
        await this.recordProgress(input, "status", `API 调用失败，正在第 ${attempt} 次重试（最多 ${MAX_API_RETRIES} 次）...`, "milestone");
      }

      try {
        const query = await this.resolveQuery();
        const mcpServer = await this.resolveMcpServer(input);

        const loadedSkills = await this.loadRequiredSkills(currentStage);
        if (attempt === 0) {
          for (const skill of loadedSkills) {
            this.appendAssistantMessage(input.session, `宿主已加载核心 Skill：\`${skill.id}\``, "skill_usage");
            await this.recordProgress(input, "runner", `强制加载核心 Skill：${skill.id}`, "milestone");
          }
        }
        const instructions = [
          buildStageInstructions(stageAgentInput),
          loadedSkills.length > 0
            ? [
                "---",
                "## 宿主强制加载的核心心智",
                "以下 Skill 是当前阶段的执行契约，不是参考材料。必须在行动和最终产出中逐条体现。",
                ...loadedSkills.map((skill) => `\n### ${skill.id}\n${skill.content}`)
              ].join("\n")
            : ""
        ].filter(Boolean).join("\n\n");
        await this.recordProgress(input, "runner", attempt > 0 ? `开始重试阶段：${currentStage.name || currentStage.id}（第 ${attempt} 次）` : `开始执行阶段：${currentStage.name || currentStage.id}`, "milestone");
      const claudeCodeExecutable = resolveBundledClaudeCodeExecutable();
      const sdkEnv = buildClaudeSdkEnv();

      // 构建 SDK agents 配置：将 YAML 中定义的 sub-agent 映射为 SDK AgentDefinition
      const sdkAgents: Record<string, { description: string; tools?: string[]; prompt: string; model?: string }> = {};
      if (currentStage.agents) {
        for (const [name, def] of Object.entries(currentStage.agents)) {
          sdkAgents[name] = {
            description: def.description,
            prompt: def.prompt,
            ...(def.tools && def.tools.length > 0 ? { tools: def.tools } : {}),
            ...(def.model ? { model: def.model } : {})
          };
        }
      }

      for await (const message of query({
        prompt: instructions,
        options: {
          cwd: input.session.project_path,
          ...(claudeCodeExecutable ? { pathToClaudeCodeExecutable: claudeCodeExecutable } : {}),
          env: sdkEnv,
          abortController,
          mcpServers: mcpServer ? { ai_coder: mcpServer } : undefined,
          ...(this.options.pluginPaths?.length
            ? { plugins: this.options.pluginPaths.map((pluginPath) => ({ type: "local" as const, path: pluginPath })) }
            : {}),
          tools: buildAllowedClaudeTools(input.workflow, currentStage),
          disallowedTools: buildDisallowedClaudeTools(input.workflow),
          permissionMode: "default",
          // 只使用 ai-coder 自己的权限策略，避免用户/项目 hooks 形成第二套审批链。
          settingSources: [],
          outputFormat: buildStageOutputFormat(currentStage),
          ...(Object.keys(sdkAgents).length > 0 ? { agents: sdkAgents } : {}),
          canUseTool: async (toolName: string, toolInput: Record<string, unknown>, options: { toolUseID: string }) => {
            if (toolName === "Skill") {
              const skillName = String(toolInput.skill ?? toolInput.name ?? "unknown");
              this.appendAssistantMessage(input.session, `正在加载 Skill：\`${skillName}\``, "skill_usage");
              await this.recordProgress(input, "runner", `加载 Skill：${skillName}`, "milestone");
            }
            if (
              toolName === "Skill" ||
              toolName === "Task" ||
              toolName === "mcp__ai_coder__ask_human" ||
              toolName === "mcp__ai_coder__update_task_tree"
            ) {
              return { behavior: "allow", updatedInput: toolInput };
            }
            const safety = checkCommandSafety(currentStage.id, toolName, toolInput);
            if (!safety.allow) {
              await this.recordProgress(input, "tool_policy", `安全拦截：${safety.message}`, "milestone");
              return { behavior: "deny", message: safety.message, interrupt: false };
            }
            if (currentStage.hooks) {
              const hookDecision = evaluateHook(currentStage, input.session, toolName, toolInput);
              if (!hookDecision.allow) {
                await this.recordProgress(input, "tool_policy", `工序闸门：${hookDecision.message}`, "milestone");
                return { behavior: "deny", message: hookDecision.message, interrupt: false };
              }
            }
            const decision = await approveOrDenyToolUse(
              input.session,
              input.workflow,
              toolName,
              toolInput,
              options.toolUseID
            );
            if (decision.allow) {
              return { behavior: "allow", updatedInput: decision.updatedInput };
            }
            if (this.hasPendingToolCall(input.session, options.toolUseID)) {
              const resolved = await this.waitForToolApproval(
                input.session,
                options.toolUseID,
                abortController.signal
              );
              if (resolved === "approved") {
                const approvedDecision = await approveOrDenyToolUse(
                  input.session,
                  input.workflow,
                  toolName,
                  toolInput,
                  options.toolUseID
                );
                if (approvedDecision.allow) {
                  input.session.status = "running";
                  return { behavior: "allow", updatedInput: approvedDecision.updatedInput };
                }
                return { behavior: "deny", message: approvedDecision.message, interrupt: approvedDecision.interrupt };
              }
              input.session.status = "running";
              return {
                behavior: "deny",
                message: "Tool call was denied by the user. Continue without this tool or choose an allowed alternative.",
                interrupt: false
              };
            }
            return { behavior: "deny", message: decision.message, interrupt: decision.interrupt };
          }
        }
      } as never) as AsyncIterable<unknown>) {
        sdkMessages.push(message);
        this.recordSdkToolUses(input.session, currentStage.id, message);
        this.recordToolExecutionResult(input.session, message);
        await this.recordDiscoveredSkills(input, message);
        const snippet = this.describeSdkMessage(message);
        if (isMeaningfulSdkProgress(snippet)) {
          await this.recordProgress(input, "sdk_message", snippet, "transient");
        }
      }

      // 若 abort 信号触发但 SDK 是优雅退出而不抛错，仍需走中止路径
      if (abortController.signal.aborted) {
        if (sdkMessages.length > 0) {
          const transcript = formatClaudeTranscript(sdkMessages);
          this.appendAssistantMessage(input.session, transcript);
        }
        input.session.status = this.resolveInterruptedStatus(input.session);
        if (input.session.status === "completed") input.session.status = "interrupted";
        await this.recordProgress(input, "status", "已由用户手动中止。", "milestone");
        if (this.abortControllers.get(input.session.id) === abortController) {
          this.abortControllers.delete(input.session.id);
        }
        return input.session;
      }

      const stageOutput = extractClaudeStageOutput(sdkMessages);
      const transcript = formatClaudeTranscript(sdkMessages) || formatStructuredOutput(stageOutput.structuredOutput);

      if (
        this.hasPendingHumanQuestion(input.session) ||
        input.session.tool_calls.some((toolCall) => toolCall.status === "pending_approval")
      ) {
        // 有待审批工具或待回答问题：push transcript 后中断
        this.appendAssistantMessage(input.session, transcript);
        input.session.status = "waiting_approval";
        await this.recordProgress(input, "status", `阶段已中断：${input.session.status}`, "milestone");
        if (this.abortControllers.get(input.session.id) === abortController) {
          this.abortControllers.delete(input.session.id);
        }
        return input.session;
      }
      if (stageOutput.error) {
        input.session.status = "failed";
        input.session.error = stageOutput.error;
        await this.recordProgress(input, "status", "阶段执行失败。", "milestone");
        if (this.abortControllers.get(input.session.id) === abortController) {
          this.abortControllers.delete(input.session.id);
        }
        return input.session;
      }

      // 先 applyStageResult（可能触发 retry 或推进到下一阶段），再根据实际状态变化决定 push 什么消息
      const activeRunBeforeApply = this.workflowEngine.getActiveStageRun(input.session);
      this.workflowEngine.applyStageResult(
        input.session,
        input.workflow,
        parseBestStageAgentResult(stageOutput.resultText, transcript, stageOutput.structuredOutput)
      );
      const statusAfterApply = input.session.status;
      const activeRunAfterApply = this.workflowEngine.getActiveStageRun(input.session);
      const isRetryOfSameStage =
        statusAfterApply === "running" &&
        Boolean(activeRunAfterApply?.retry_reason) &&
        activeRunAfterApply?.id === activeRunBeforeApply?.id;

      // 终态（completed/waiting_approval/blocked/failed）：push 完整 transcript
      // 正常推进到下一阶段也可能是 running，此时仍应保留当前阶段真实 transcript。
      // 只有同一 stageRun 原地 retry 时才 push 简短摘要，避免重复塞入大段无效输出。
      if (isRetryOfSameStage) {
        const retryReason = input.session.error ?? "required_outputs 缺失或断言失败";
        this.appendAssistantMessage(input.session, `[阶段重试：${retryReason}]`);
      } else {
        this.appendAssistantMessage(input.session, transcript);
      }
      // 阶段终态决定 milestone 文案：completed / waiting_approval 是正向终态；
      // blocked / failed 是异常终态（断言挡回、超过 retry 限、缺必填等），需要明确告诉用户。
      // running 是 retry 中——只是无声继续到下一轮，无需 milestone。
      const stageName = currentStage.name || currentStage.id;
      const status = input.session.status;
      const error = input.session.error;
      if (status === "waiting_approval") {
        await this.recordProgress(input, "status", `等待用户回答：${stageName}`, "milestone");
      } else if (status === "blocked") {
        await this.recordProgress(input, "status", `阶段被拦截：${stageName}${error ? `（${error}）` : ""}`, "milestone");
      } else if (status === "failed") {
        await this.recordProgress(input, "status", `阶段失败：${stageName}${error ? `（${error}）` : ""}`, "milestone");
      } else if (status === "running") {
        await this.recordProgress(input, "status", `阶段重试中：${stageName}${error ? `（${error}）` : ""}`, "transient");
      } else {
        await this.recordProgress(input, "status", `阶段已完成：${stageName}`, "milestone");
      }

      // 成功完成，跳出重试循环
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      // 用户主动中止：保留已写入的消息和工具调用，根据是否有未决问题决定终态
      if (abortController.signal.aborted || isAbortError(error)) {
        if (sdkMessages.length > 0) {
          const transcript = formatClaudeTranscript(sdkMessages);
          this.appendAssistantMessage(input.session, transcript);
        }
        const resolved = this.resolveInterruptedStatus(input.session);
        input.session.status = resolved === "completed" ? "interrupted" : resolved;
        await this.recordProgress(input, "status", "已由用户手动中止。", "milestone");
        if (this.abortControllers.get(input.session.id) === abortController) {
          this.abortControllers.delete(input.session.id);
        }
        return input.session;
      }
      if (!isRetriableApiError(error)) {
        // "process exited" 等错误本身不可重试，但若 SDK 消息中已有 API 400/429/5xx 错误，则根因是 API 问题，应重试
        if (!sdkMessages.some((m) => /(?:400|429|5\d{2}).*error|API Error/i.test(typeof m === "string" ? m : JSON.stringify(m)))) break;
      }
      // 继续下一轮重试
    }
  }

  // 清理 abort controller（重试循环外）
  if (this.abortControllers.get(input.session.id) === abortController) {
    this.abortControllers.delete(input.session.id);
  }

  if (lastError) {
    const failed = this.failFromSdkError(input, sdkMessages, lastError);
    await this.recordProgress(input, "status", `Claude Agent SDK 调用失败（已重试 ${MAX_API_RETRIES} 次）。`, "milestone");
    return failed;
  }

  return input.session;
}

  private runMock(input: AgentRunInput, stageAgentInput: ReturnType<typeof buildStageAgentInput>): AgentSession {
    const result = createMockStageAgentResult(stageAgentInput);
    const content = JSON.stringify(result, null, 2);
    // Mock 模式下写入阶段结果摘要，而不是原始 JSON
    this.appendAssistantMessage(input.session, result.output_summary);
    this.workflowEngine.applyStageResult(input.session, input.workflow, result);
    return input.session;
  }

  private waitForApprovalIfNeeded(input: AgentRunInput): boolean {
    const approval = input.session.approvals.find(
      (item) => item.kind === "stage" && item.status === "pending" && item.stage_id === input.session.current_stage
    );
    if (!approval) {
      return false;
    }

    const stage = input.workflow.stages.find((item) => item.id === approval.stage_id);
    input.session.status = "waiting_approval";
    input.session.current_stage = approval.stage_id;
    const content = `已为"${input.session.task_prompt}"准备工作流计划。等待审批后继续执行${stage?.name ?? "下一阶段"}。`;
    this.appendAssistantMessage(input.session, content);
    return true;
  }

  private hasStageApproval(session: AgentSession, stageId: string): boolean {
    return session.approvals.some(
      (approval) => approval.kind === "stage" && approval.stage_id === stageId && approval.status === "approved"
    );
  }

  private requestStageApprovalIfNeeded(input: AgentRunInput, stage: WorkflowStage): AgentSession {
    const existing = input.session.approvals.find(
      (approval) => approval.kind === "stage" && approval.stage_id === stage.id && approval.status === "pending"
    );
    if (existing) {
      input.session.status = "waiting_approval";
      return input.session;
    }

    input.session.approvals.push({
      id: randomUUID(),
      stage_id: stage.id,
      kind: "stage",
      status: "pending",
      message: `阶段"${stage.name}"需要授权才能继续执行。该阶段需要使用文件编辑工具，请确认是否允许。`,
      created_at: new Date().toISOString()
    });
    input.session.status = "waiting_approval";
    this.appendAssistantMessage(
      input.session,
      `阶段"${stage.name}"需要授权才能继续执行。该阶段将使用文件编辑工具写入项目文件，请审批。`
    );
    return input.session;
  }

  private appendAssistantMessage(session: AgentSession, content: string, kind?: AgentMessage["kind"]): void {
    if (!isMeaningfulAgentText(content)) return;
    const normalized = normalizeAssistantMessageContent(content);
    const recentDuplicate = session.messages
      .slice(-10)
      .some((message) => message.role === "assistant" && message.kind === kind && normalizeAssistantMessageContent(message.content) === normalized);
    if (recentDuplicate) return;
    session.messages.push({
      role: "assistant",
      content,
      created_at: new Date().toISOString(),
      ...(kind ? { kind } : {})
    });
  }

  private async recordProgress(
    input: AgentRunInput,
    type: SessionProgressEvent["type"],
    message: string,
    visibility: SessionProgressEvent["visibility"]
  ): Promise<void> {
    const progress = input.session.progress_events ?? [];
    progress.push({
      id: randomUUID(),
      type,
      message,
      visibility,
      created_at: new Date().toISOString()
    });
    input.session.progress_events = progress.slice(-2000);
    await input.onProgress?.(input.session);
  }

  private describeToolDecision(toolName: string, allowed: boolean): string {
    return allowed ? `工具已允许：${toolName}` : `工具需要审批或已被拦截：${toolName}`;
  }

  private describeSdkMessage(message: unknown): string {
    return describeSdkMessageSnippet(message);
  }

  private buildHumanQuestion(session: AgentSession, toolInput: Record<string, unknown>, toolUseID: string): HumanQuestion | null {
    const question = typeof toolInput.question === "string" ? toolInput.question.trim() : "";
    const requestedType = toolInput.type;
    if (!question || (requestedType !== "single" && requestedType !== "multi" && requestedType !== "text")) {
      return null;
    }
    let questionType: HumanQuestion["question_type"] = requestedType;
    let options: HumanQuestionOption[] | undefined;
    if ((requestedType === "single" || requestedType === "multi") && Array.isArray(toolInput.options)) {
      options = toolInput.options
        .map((item) => {
          if (item && typeof item === "object" && "value" in item && "label" in item) {
            const value = String((item as { value: unknown }).value);
            const label = String((item as { label: unknown }).label);
            return value && label ? { value, label } : null;
          }
          if (typeof item === "string" && item.trim()) {
            return { value: item.trim(), label: item.trim() };
          }
          return null;
        })
        .filter((item): item is HumanQuestionOption => item !== null);
    }
    // 模型偶尔会声明 single/multi 却漏传 options。不能让用户面对一张无法回答的灰色表单：
    // 降级为文本问题，保留原问题并让人类直接作答；下轮模型会从 answer 获得该信息。
    if ((requestedType === "single" || requestedType === "multi") && (!options || options.length === 0)) {
      questionType = "text";
      options = undefined;
    }
    return {
      id: toolUseID,
      stage_id: session.current_stage,
      question,
      question_type: questionType,
      options,
      status: "pending",
      created_at: new Date().toISOString()
    };
  }

  private hasPendingToolCall(session: AgentSession, toolCallId?: string): boolean {
    return session.tool_calls.some(
      (toolCall) => toolCall.status === "pending_approval" && (!toolCallId || toolCall.id === toolCallId)
    );
  }

  private async waitForToolApproval(
    session: AgentSession,
    toolCallId: string,
    signal: AbortSignal
  ): Promise<ToolApprovalResolution> {
    return new Promise<ToolApprovalResolution>((resolve) => {
      if (signal.aborted) {
        resolve("denied");
        return;
      }
      const pendingForSession = this.pendingToolApprovals.get(session.id) ?? new Map<string, PendingToolApproval>();
      pendingForSession.set(toolCallId, { session, resolve });
      this.pendingToolApprovals.set(session.id, pendingForSession);
      signal.addEventListener(
        "abort",
        () => {
          const toolCall = session.tool_calls.find(
            (item) => item.id === toolCallId && item.status === "pending_approval"
          );
          if (toolCall) {
            toolCall.status = "cancelled";
            toolCall.resolved_at = new Date().toISOString();
          }
          session.status = "interrupted";
          pendingForSession.delete(toolCallId);
          if (pendingForSession.size === 0) {
            this.pendingToolApprovals.delete(session.id);
          }
          resolve("denied");
        },
        { once: true }
      );
    });
  }

  private hasPendingHumanQuestion(session: AgentSession): boolean {
    return (session.pending_human_questions ?? []).some((q) => q.status === "pending");
  }

  private resolveInterruptedStatus(session: AgentSession): AgentSession["status"] {
    if (
      this.hasPendingHumanQuestion(session) ||
      session.tool_calls.some((toolCall) => toolCall.status === "pending_approval")
    ) {
      return "waiting_approval";
    }
    return "completed";
  }

  private failFromSdkError(input: AgentRunInput, sdkMessages: unknown[], error: unknown): AgentSession {
    const fallbackError = error instanceof Error ? error.message : String(error);
    const errorName = error instanceof Error ? error.name : typeof error;
    // 诊断信息：仅保留可追溯但不含敏感内容的字段（不要 stringify input —— 会泄露 task_prompt / 附件路径）。
    const errorDetails = [
      `错误：${fallbackError}`,
      `错误类型：${errorName}`,
      `SDK 消息数：${sdkMessages.length}`,
      `会话 ID: ${input.session.id}`,
      `阶段：${input.session.current_stage}`,
      `工作流：${input.workflow.id}`
    ].join('\n');

    if (sdkMessages.length > 0) {
      const stageOutput = extractClaudeStageOutput(sdkMessages);
      const transcript = formatClaudeTranscript(sdkMessages);
      // 仅当 transcript 含有真正内容时才写入消息，避免 (no content) / SDK 内部 transcript 污染
      if (isMeaningfulAgentText(transcript)) {
        this.appendAssistantMessage(input.session, transcript);
      }
      this.workflowEngine.applyStageResult(input.session, input.workflow, {
        status: "failed",
        output_summary: stageOutput.error ?? fallbackError,
        error: stageOutput.error ?? fallbackError
      });
    } else {
      // SDK 调用失败且没有消息，记录详细错误
      this.workflowEngine.applyStageResult(input.session, input.workflow, {
        status: "failed",
        output_summary: `Claude SDK 调用失败：${fallbackError}`,
        error: errorDetails
      });
    }
    // 记录详细错误到进度事件
    void this.recordProgress(input, "status", errorDetails, "milestone");
    return input.session;
  }

  private async resolveQuery(): Promise<ClaudeQuery> {
    if (this.options.queryOverride) {
      return this.options.queryOverride;
    }

    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const query = (sdk as { query?: unknown }).query;
    if (typeof query !== "function") {
      throw new Error("Claude Agent SDK does not expose query()");
    }
    return query as ClaudeQuery;
  }

  private async loadRequiredSkills(stage: WorkflowStage): Promise<Array<{ id: string; content: string }>> {
    const required = stage.required_skills ?? [];
    if (required.length === 0) return [];
    if (!this.options.pluginPaths?.length) {
      throw new Error(`阶段 ${stage.id} 要求核心 Skill，但运行器未配置 Plugin 路径：${required.join(", ")}`);
    }

    const loaded: Array<{ id: string; content: string }> = [];
    for (const id of required) {
      const [namespace, skillName] = id.includes(":") ? id.split(":", 2) : [undefined, id];
      if (!/^[a-z0-9-]+$/.test(skillName)) throw new Error(`非法 required_skills 名称：${id}`);
      let content: string | undefined;
      for (const pluginPath of this.options.pluginPaths) {
        if (namespace && path.basename(pluginPath) !== namespace) continue;
        try {
          content = await readFile(path.join(pluginPath, "skills", skillName, "SKILL.md"), "utf8");
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (!content) throw new Error(`找不到阶段 ${stage.id} 必需的 Skill：${id}`);
      loaded.push({ id: namespace ? id : `careful-coder:${skillName}`, content });
    }
    return loaded;
  }

  /** Profile 模式：宿主加载完整 Skill 内容，避免把关键执行契约交给模型自行决定是否读取。 */
  private async loadProfileSkills(skillIds: string[]): Promise<Array<{ id: string; content: string }>> {
    if (skillIds.length === 0) return [];
    if (!this.options.pluginPaths?.length) return [];

    const loaded: Array<{ id: string; content: string }> = [];
    for (const id of skillIds) {
      const [namespace, skillName] = id.includes(":") ? id.split(":", 2) : [undefined, id];
      if (!/^[a-z0-9-]+$/.test(skillName)) continue;
      for (const pluginPath of this.options.pluginPaths) {
        if (namespace && path.basename(pluginPath) !== namespace) continue;
        try {
          const fullContent = await readFile(path.join(pluginPath, "skills", skillName, "SKILL.md"), "utf8");
          loaded.push({
            id: namespace ? id : `careful-coder:${skillName}`,
            content: fullContent
          });
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    return loaded;
  }

  private async discoverProfileSkills(): Promise<Array<{ id: string; description: string }>> {
    if (!this.options.pluginPaths?.length) return [];
    const discovered: Array<{ id: string; description: string }> = [];
    for (const pluginPath of this.options.pluginPaths) {
      const namespace = path.basename(pluginPath);
      let entries: import("node:fs").Dirent[];
      try {
        entries = await readdir(path.join(pluginPath, "skills"), { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const content = await readFile(path.join(pluginPath, "skills", entry.name, "SKILL.md"), "utf8");
          const metadata = extractSkillCatalogMetadata(content, entry.name);
          discovered.push({
            id: `${namespace}:${metadata.name}`,
            description: metadata.description
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    return discovered.sort((left, right) => left.id.localeCompare(right.id));
  }

  private async buildProfileCapabilityCatalog(workflow: WorkflowTemplate, hasMcpServer: boolean): Promise<string> {
    this.discoveredSkillCatalog ??= this.discoverProfileSkills();
    const skills = await this.discoveredSkillCatalog;
    const agents = Object.entries(workflow.agents ?? {}).sort(([left], [right]) => left.localeCompare(right));
    const tools = buildAllowedClaudeTools(workflow);
    const toolDescriptions: Record<string, string> = {
      Read: "读取已知文件或图片",
      Grep: "按内容搜索",
      Glob: "按路径模式查找文件",
      LS: "查看已知目录",
      Skill: "按当前缺失信息加载专项方法",
      Edit: "精确修改现有文件",
      MultiEdit: "批量精确修改",
      Write: "创建或重写文件",
      Bash: "执行检查、测试或命令",
      Task: "按需委托给下列 Sub-agent"
    };
    const mcpTools = hasMcpServer
      ? [
          ["mcp__ai_coder__checkpoint_exploration", "归并知识、声明 phase 与 next_action"],
          ["mcp__ai_coder__update_task_tree", "维护传统全局任务树；简单模式通常无需调用"],
          ["mcp__ai_coder__analyze_symbol_contract", "只读分析函数/组件及静态调用契约"],
          ["mcp__ai_coder__ask_human", "仅在外部信息确实阻塞时询问用户"]
        ] as const
      : [];
    return [
      "## 当前可用能力（与知识雪球、阶段任务同时生效）",
      "先根据当前缺失信息明确选择 Skill、Sub-agent 或直接工具，并把选择理由写回知识雪球。跨多文件追踪、独立验证或完整性审查与某个 Sub-agent 职责匹配时优先委托；简单单点事实直接用工具。只选能推进当前阶段任务的最小能力。",
      "硬规则：凡拟议实现会调用、复用或修改已有函数、方法、Hook 或组件，第一次相关修改前必须通过 Task 使用 call-contract-investigator；主线程搜索不能替代。纯文案、静态数据或样式且不涉及既有函数/组件时才可记录依据后判定不适用。",
      "",
      "### Skills（工作流核心项已由宿主加载；目录中的其他项可用 Skill 加载）",
      ...(skills.length > 0
        ? skills.map((skill) => `- ${skill.id}: ${skill.description}`)
        : ["- 当前没有宿主可枚举的 Skill；仍以 SDK 实际展示的 Skill 工具结果为准。"]),
      "",
      "### Sub-agents（通过 Task 调用）",
      ...(agents.length > 0
        ? agents.map(([name, definition]) => `- ${name}: ${definition.description}`)
        : ["- 当前工作流没有注册 Sub-agent。"]),
      "",
      "### Tools（必须使用精确名称）",
      ...tools.map((name) => `- ${name}: ${toolDescriptions[name] ?? "按工具说明使用"}`),
      ...mcpTools.map(([name, description]) => `- ${name}: ${description}`),
      "",
      "phase 只是进度标签，不限制工具；仍需遵守项目权限和危险操作审批。"
    ].join("\n");
  }

  private async recordDiscoveredSkills(input: AgentRunInput, message: unknown): Promise<void> {
    if (!isPlainObject(message) || message.type !== "system" || message.subtype !== "init") return;
    const data = isPlainObject(message.data) ? message.data : {};
    const skills = Array.isArray(message.skills) ? message.skills : Array.isArray(data.skills) ? data.skills : [];
    const plugins = Array.isArray(message.plugins) ? message.plugins : Array.isArray(data.plugins) ? data.plugins : [];
    if (skills.length === 0 && plugins.length === 0) return;
    await this.recordProgress(
      input,
      "runner",
      `SDK 已发现 Plugins：${plugins.map(formatSdkCatalogItem).join(", ") || "无"}；Skills：${skills.map(formatSdkCatalogItem).join(", ") || "无"}`,
      "milestone"
    );
  }

  /**
   * SDK 可能因版本或设置行为未调用 canUseTool。直接从真实 tool_use 消息补记请求，
   * 作为审计韧性兜底；若策略层已创建同 id 记录则不重复。
   */
  private recordSdkToolUses(session: AgentSession, stageId: string, message: unknown): void {
    for (const toolUse of extractSdkToolUses(message)) {
      if (session.tool_calls.some((item) => item.id === toolUse.id)) continue;
      session.tool_calls.push({
        id: toolUse.id,
        stage_id: stageId,
        tool: toolUse.tool,
        input: toolUse.input,
        status: "requested",
        created_at: new Date().toISOString()
      });
    }
  }

  /**
   * Unknown MCP tool names bypass canUseTool and therefore bypass the normal task-tree
   * implementation. If the model only damaged the tool name but produced valid
   * update_task_tree arguments, apply the mutation here so execution can continue.
   */
  private async tryApplyCorruptedTaskTreeToolUse(input: AgentRunInput, toolUse: SdkToolUse): Promise<boolean> {
    try {
      let normalizedMutation = normalizeTaskTreeMutationArgs(toolUse.input, input.session);
      normalizedMutation = repairIncompleteTaskStatusMutation(input.session, normalizedMutation);
      normalizedMutation = normalizePrematureTaskCompletion(input.session, normalizedMutation);
      const result = applyTaskTreeMutation(input.session, normalizedMutation);
      const recordedToolCall = input.session.tool_calls.find((item) => item.id === toolUse.id);
      if (recordedToolCall) {
        recordedToolCall.tool = "mcp__ai_coder__update_task_tree";
        recordedToolCall.input = taskTreeMutationToToolInput(normalizedMutation);
        recordedToolCall.status = "completed";
        recordedToolCall.output_summary = result;
        recordedToolCall.resolved_at = new Date().toISOString();
      }
      await this.recordProgress(
        input,
        "runner",
        `${result.split("\n")[0] || "任务树已更新"}（宿主从损坏工具名恢复）`,
        "milestone"
      );
      return true;
    } catch (error) {
      await this.recordProgress(
        input,
        "tool_policy",
        `损坏任务树工具名的参数无法恢复：${error instanceof Error ? error.message : String(error)}`,
        "milestone"
      );
      return false;
    }
  }

  /**
   * checkpoint 是中断恢复的认知边界。工具名轻微损坏时，只要参数仍满足完整 schema，
   * 宿主直接保存文本，避免成功取得的认知随 SDK unknown-tool 错误一起丢失。
   */
  private async tryApplyCorruptedExplorationCheckpointToolUse(
    input: AgentRunInput,
    toolUse: SdkToolUse
  ): Promise<boolean> {
    try {
      const normalizedCheckpoint = normalizeExplorationCheckpointArgs(toolUse.input);
      const recordedToolCall = input.session.tool_calls.find((item) => item.id === toolUse.id);
      if (recordedToolCall) {
        recordedToolCall.tool = "mcp__ai_coder__checkpoint_exploration";
        recordedToolCall.input = summarizeExplorationCheckpointToolInput(normalizedCheckpoint);
      }
      const result = applyExplorationCheckpoint(input.session, normalizedCheckpoint);
      if (input.workflow.simple_profile_loop === true) {
        syncPhaseTaskTreeWithCheckpoint(input.session);
      }
      if (recordedToolCall) {
        recordedToolCall.status = "completed";
        recordedToolCall.output_summary = result;
        recordedToolCall.resolved_at = new Date().toISOString();
      }
      await this.recordProgress(
        input,
        "runner",
        `${result}（宿主从损坏工具名恢复）`,
        "milestone"
      );
      return true;
    } catch (error) {
      await this.recordProgress(
        input,
        "tool_policy",
        `损坏探索 checkpoint 工具名的参数无法恢复：${error instanceof Error ? error.message : String(error)}`,
        "milestone"
      );
      return false;
    }
  }

  /** 将 SDK 的工具执行反馈关联回审批或 tool_use 时创建的记录。 */
  private recordToolExecutionResult(session: AgentSession, message: unknown): void {
    const result = extractToolExecutionResult(message);
    if (!result) return;
    const toolCall = session.tool_calls.find((item) => item.id === result.toolUseId);
    if (!toolCall) return;
    const taskFailedSemantically = toolCall.tool === "Task"
      && (
        isSemanticallyFailedTaskResult(result.outputSummary)
        || isSemanticallyFailedTaskMessage(message)
        || isNegativeReviewTaskResult(toolCall, result.outputSummary)
        || isNegativeReviewTaskMessage(toolCall, message)
      );
    if (result.exitCode !== undefined) {
      toolCall.exit_code = result.exitCode;
    } else if (toolCall.tool === "Bash" && result.executionSucceeded === true) {
      // Claude Agent SDK 的 Bash 成功结果通常只有 stdout/stderr/interrupted，未必提供 exit_code。
      // tool_result 已明确完成且没有错误/中断时，将其规范化为 0，供证据门槛使用。
      toolCall.exit_code = 0;
    }
    const recoveredCorruptedTaskTreeResult = toolCall.tool === "mcp__ai_coder__update_task_tree"
      && toolCall.status === "completed"
      && /No such tool available|No such tool/i.test(result.outputSummary ?? "");
    if (recoveredCorruptedTaskTreeResult) {
      return;
    }
    const recoveredCorruptedCheckpointResult = toolCall.tool === "mcp__ai_coder__checkpoint_exploration"
      && toolCall.status === "completed"
      && /No such tool available|No such tool/i.test(result.outputSummary ?? "");
    if (recoveredCorruptedCheckpointResult) {
      return;
    }
    if (result.outputSummary) toolCall.output_summary = result.outputSummary;
    if (result.executionSucceeded === false || taskFailedSemantically) {
      // SDK 执行失败（参数校验、ENOENT、子代理 API 错误等）不是宿主安全策略阻断。
      // blocked 只保留给 projectPolicy 等宿主策略拒绝，避免 UI 隐藏真实故障性质。
      toolCall.status = "failed";
      toolCall.resolved_at = new Date().toISOString();
    } else if (toolCall.status === "approved" || toolCall.status === "requested") {
      toolCall.status = "completed";
      toolCall.resolved_at = new Date().toISOString();
    }
    if (
      toolCall.tool === "Task"
      && toolCall.status === "completed"
      && isPlainObject(toolCall.input)
      && toolCall.input.subagent_type === "task-planner"
      && profileNeedsPlanning(session)
    ) {
      const plannerMutation = extractPlannerTaskTreeMutation(message, session);
      if (plannerMutation) {
        try {
          applyTaskTreeMutation(session, plannerMutation);
        } catch {
          // 计划结果不符合 DAG 契约时保持 host-goal，要求下一轮重新规划，不能让结果记录中断查询。
        }
      }
    }
  }

  private async resolveMcpServer(input: AgentRunInput): Promise<unknown | null> {
    const cached = this.mcpServerCache.get(input);
    if (cached) return cached.server;
    try {
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      const createSdkMcpServer = (sdk as { createSdkMcpServer?: unknown }).createSdkMcpServer;
      const tool = (sdk as { tool?: unknown }).tool;
      const { z } = await import("zod");
      if (typeof createSdkMcpServer !== "function" || typeof tool !== "function") {
        return null;
      }
      // ask_human 是业务信息询问工具，不属于权限审批。它在自身 handler 中记录问题并中止
      // 当前 query；用户回答后会话恢复。其余工具仍必须经过宿主项目策略。
      const askHumanTool = (tool as (
        name: string,
        description: string,
        schema: Record<string, unknown>,
        handler: (...args: unknown[]) => Promise<unknown>
      ) => unknown)(
        "ask_human",
        "仅在用户原话、附件、既有回答、项目规则和代码证据都无法回答，且不同答案会改变实现、安全或验收时，向用户询问一个决策并暂停。禁止把多个问题合并成问卷。",
        {
          question: z.string().describe("只包含一个待决策事项的问题文本，支持 Markdown"),
          type: z.enum(["single", "multi", "text"]).describe("问题类型"),
          already_checked: z.array(z.string()).min(1).describe("提问前已核对的用户原话、附件、既有回答、项目规则或代码证据"),
          why_needed: z.string().min(12).describe("不同回答将如何实质改变实现、安全边界或验收结果"),
          options: z.array(z.object({ value: z.string(), label: z.string() })).optional().describe("single/multi 时必填")
        },
        async (args) => {
          const session = input.session;
          const toolInput = args as Record<string, unknown>;
          const qualityFailure = evaluateHumanQuestionRequest(toolInput);
          if (qualityFailure) {
            return { content: [{ type: "text", text: `提问准入失败：${qualityFailure}` }] };
          }
          const question = this.buildHumanQuestion(session, toolInput, randomUUID());
          if (!question) {
            return { content: [{ type: "text", text: "ask_human 输入格式错误。" }] };
          }
          const existing = (session.pending_human_questions ?? []).find(
            (item) => item.question === question.question && item.stage_id === question.stage_id
          );
          if (existing?.status === "answered") {
            return { content: [{ type: "text", text: "此问题已回答，请基于已有回答继续。" }] };
          }
          if (!existing) {
            session.pending_human_questions = [...(session.pending_human_questions ?? []), question];
          }
          session.status = "waiting_approval";
          this.abortControllers.get(session.id)?.abort();
          return { content: [{ type: "text", text: "已向用户提问并暂停，等待回答。" }] };
        }
      );
      const taskTreeTool = (tool as (
        name: string,
        description: string,
        schema: Record<string, unknown>,
        handler: (...args: unknown[]) => Promise<unknown>
      ) => unknown)(
        "update_task_tree",
        "维护动态任务树——贯穿整个执行过程：初始化任务拆分、标记任务状态（附工具执行证据）、发现新任务时添加节点、声明当前聚焦与下一步。任务树是你的执行控制器，不是文档。",
        {
          action: z.enum(["bootstrap", "add", "update_status"]).describe("操作类型：bootstrap=首次建立任务树，add=执行中发现新子任务，update_status=更新任务状态"),
          tasks: z.array(z.object({
            id: z.string().describe("任务唯一标识，如 t1、t2"),
            description: z.string().describe("要完成什么"),
            dependencies: z.array(z.string()).describe("依赖的任务 ID 列表"),
            acceptance: z.array(z.string()).optional().describe("验收标准：每条可独立核对的断言，task-verifier 据此逐条核对"),
          })).optional().describe("bootstrap 时必填：初始任务列表"),
          goal_restated: z.string().optional().describe("bootstrap 时必填：重述的用户可观测目标"),
          strategy: z.string().optional().describe("bootstrap 时必填：拆分策略说明（如'按模块边界拆分'）"),
          new_tasks: z.array(z.object({
            id: z.string().describe("新任务唯一标识"),
            description: z.string().describe("要完成什么"),
            dependencies: z.array(z.string()).describe("依赖的任务 ID"),
            acceptance: z.array(z.string()).optional().describe("验收标准：每条可独立核对的断言"),
          })).optional().describe("add 时必填：新发现的子任务"),
          add_reason: z.string().optional().describe("add 时必填：为什么此时发现这些任务"),
          task_id: z.string().optional().describe("update_status 时必填：要更新的任务 ID"),
          new_status: z.enum(["in_progress", "completed", "blocked", "skipped"]).optional().describe("update_status 时必填：新状态"),
          status_reason: z.string().optional().describe("状态变更原因"),
          evidence: z.string().optional().describe("completed 时必填：验证证据（工具输出、命令结果等）"),
          next_focus: z.string().optional().describe("下一步聚焦的 task_id"),
          next_reason: z.string().optional().describe("为什么聚焦此任务"),
        },
        async (args) => {
          const session = input.session;
          try {
            const repairedMutation = repairIncompleteTaskStatusMutation(
              session,
              normalizeTaskTreeMutationArgs(args, session)
            );
            const normalizedMutation = normalizePrematureTaskCompletion(session, repairedMutation);
            const result = applyTaskTreeMutation(session, normalizedMutation);
            await this.recordProgress(input, "runner", result.split("\n")[0] || "任务树已更新", "milestone");
            return { content: [{ type: "text", text: result }] };
          } catch (err) {
            return { content: [{ type: "text", text: `任务树更新失败：${err instanceof Error ? err.message : String(err)}` }] };
          }
        }
      );
      const explorationCheckpointTool = (tool as (
        name: string,
        description: string,
        schema: Record<string, unknown>,
        handler: (...args: unknown[]) => Promise<unknown>
      ) => unknown)(
        "checkpoint_exploration",
        "更新当前探索工作记忆。Markdown 中既有的“## 已确认”条目会由宿主自动带入，形成只增不丢的知识雪球；错误结论用带证据的校正说明覆盖语义。",
        {
          memory: z.string().max(30_000).optional().describe("最新工作记忆；省略或只提供简短补充时由宿主与上一版合并"),
          disposition: z.enum(["continue", "verify", "complete", "blocked"]).optional().describe("下一阶段意图；省略时按 continue 处理"),
          phase: z.enum(["investigate", "implement", "verify", "complete"]).optional()
            .describe("进度标签，仅用于表达当前工作状态，不限制工具"),
          next_action: z.string().max(2_000).optional().describe("准备执行的下一项具体行动；省略时继承上一版")
        },
        async (args) => {
          try {
            const result = applyExplorationCheckpoint(input.session, normalizeExplorationCheckpointArgs(args));
            if (input.workflow.simple_profile_loop === true) {
              syncPhaseTaskTreeWithCheckpoint(input.session);
            }
            await this.recordProgress(input, "runner", result, "milestone");
            const immediateContext = input.workflow.simple_profile_loop === true && input.session.task_tree
              ? [
                  result,
                  buildExplorationPromptSection(input.session),
                  buildPhaseTaskTreePromptSection(input.session.task_tree),
                  buildExecutionProgressPromptSection(input.session),
                  await this.buildProfileCapabilityCatalog(input.workflow, true),
                  "下一轮开始时宿主还会再次注入完整知识雪球和阶段任务。"
                ].join("\n\n")
              : result;
            return { content: [{ type: "text", text: immediateContext }] };
          } catch (error) {
            return {
              content: [{
                type: "text",
                text: `探索 checkpoint 更新失败：${error instanceof Error ? error.message : String(error)}`
              }],
              isError: true
            };
          }
        }
      );
      const analyzeSymbolContractTool = (tool as (
        name: string,
        description: string,
        schema: Record<string, unknown>,
        handler: (...args: unknown[]) => Promise<unknown>
      ) => unknown)(
        "analyze_symbol_contract",
        "只读分析 TypeScript/JavaScript/React 中已有函数、方法或组件的定义契约、全部静态调用点、参数组合、局部前置条件、公共封装函数和非直接调用引用。调用点按页返回，必须继续请求直到 next_offset 为 null。",
        {
          target_file: z.string().min(1).describe("目标符号定义文件，相对于项目根目录"),
          symbol: z.string().min(1).describe("函数、方法、类或组件的精确符号名"),
          target_line: z.number().int().min(1).optional().describe("同一文件存在同名符号时，用定义所在行消歧"),
          section: z.enum(["all", "contract", "calls", "wrappers", "references"]).optional()
            .describe("返回部分；调用点很多时优先分部分请求"),
          offset: z.number().int().min(0).optional().describe("calls 分页起始位置"),
          limit: z.number().int().min(1).max(100).optional().describe("calls 每页数量，默认 50，最大 100")
        },
        async (args) => {
          const toolInput = args as {
            target_file: string;
            symbol: string;
            target_line?: number;
            section?: "all" | "contract" | "calls" | "wrappers" | "references";
            offset?: number;
            limit?: number;
          };
          try {
            await assertPathInsideProject(input.session.project_path, toolInput.target_file);
            const result = analyzeSymbolContract({
              projectPath: input.session.project_path,
              targetFile: toolInput.target_file,
              symbol: toolInput.symbol,
              targetLine: toolInput.target_line,
              section: toolInput.section,
              offset: toolInput.offset,
              limit: toolInput.limit
            });
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
          } catch (error) {
            return {
              content: [{
                type: "text",
                text: `调用契约分析失败：${error instanceof Error ? error.message : String(error)}`
              }],
              isError: true
            };
          }
        }
      );
      const server = (createSdkMcpServer as (opts: { name: string; tools: unknown[] }) => unknown)({
        name: "ai_coder",
        tools: [askHumanTool, taskTreeTool, explorationCheckpointTool, analyzeSymbolContractTool]
      });
      this.mcpServerCache.set(input, { server });
      return server;
    } catch {
      this.mcpServerCache.set(input, { server: null });
      return null;
    }
  }
}

export function evaluateHumanQuestionRequest(toolInput: Record<string, unknown>): string | null {
  const question = typeof toolInput.question === "string" ? toolInput.question.trim() : "";
  const whyNeeded = typeof toolInput.why_needed === "string" ? toolInput.why_needed.trim() : "";
  const checked = Array.isArray(toolInput.already_checked)
    ? toolInput.already_checked.filter((item) => typeof item === "string" && item.trim().length > 0)
    : [];

  if (!question) return "缺少 question";
  if (question.length > 800) return "问题过长；只保留缺失决策及其直接影响，不要复述整份需求";
  if (checked.length === 0) return "already_checked 为空，尚未证明已检查用户原话、附件、项目规则或代码证据";
  if (whyNeeded.length < 12) return "why_needed 不具体，尚未说明不同回答会导致什么不同动作或结果";

  const questionMarks = (question.match(/[?？]/g) ?? []).length;
  if (questionMarks > 1) return `一次只能询问一个决策，当前包含 ${questionMarks} 个问句`;

  const numberedPrompts = question.match(/(?:^|\n)\s*\d+[.、)]\s*\*{0,2}[^\n]{0,80}(?:[：:?？]|\*{2})/g) ?? [];
  if (numberedPrompts.length > 1) return `一次只能询问一个决策，当前包含 ${numberedPrompts.length} 个编号议题`;

  return null;
}

export function validateHierarchicalContractToolEvidence(
  session: AgentSession,
  operation: Extract<HierarchicalNextOperation, { kind: "run_phase" | "run_alignment_batch" | "run_planner" | "run_integrator" }>,
  events: HierarchicalEvent[],
  stageId: string
): void {
  if (operation.kind !== "run_phase" || operation.phase !== "prepare") return;
  const passed = events.find((event): event is Extract<HierarchicalEvent, { type: "phase_passed" }> => (
    event.type === "phase_passed"
  ));
  if (!passed) return;
  const callContract = isPlainObject(passed.handoff?.call_contract) ? passed.handoff.call_contract : undefined;
  const targets = Array.isArray(callContract?.analyzed_targets) ? callContract.analyzed_targets : [];
  for (const rawTarget of targets) {
    if (!isPlainObject(rawTarget)) continue;
    const targetFile = optionalString(rawTarget.target_file);
    const symbol = optionalString(rawTarget.symbol);
    const method = optionalString(rawTarget.analysis_method);
    if (!targetFile || !symbol) continue;

    if (method === "manual-static-analysis") {
      const absoluteTarget = path.resolve(session.project_path, targetFile);
      if (!existsSync(absoluteTarget)) {
        throw new Error(`手工静态分析目标不存在：${targetFile}#${symbol}`);
      }
      if (!/\.[cm]?[jt]sx?$/i.test(absoluteTarget)) continue;
      try {
        analyzeSymbolContract({
          projectPath: session.project_path,
          targetFile,
          symbol,
          section: "contract"
        });
      } catch {
        continue;
      }
      throw new Error(
        `目标 ${targetFile}#${symbol} 可由符号契约分析器解析，不得用 manual-static-analysis 绕过完整调用点调查`
      );
    }
    if (method !== "symbol-analyzer") continue;

    const targetPath = path.resolve(session.project_path, targetFile);
    const calls = session.tool_calls.filter((call) => {
      if (call.stage_id !== stageId || call.tool !== "mcp__ai_coder__analyze_symbol_contract") return false;
      if (call.status !== "completed" || !isPlainObject(call.input)) return false;
      const calledFile = optionalString(call.input.target_file);
      return Boolean(
        calledFile
        && path.resolve(session.project_path, calledFile) === targetPath
        && optionalString(call.input.symbol) === symbol
      );
    });
    const contractCalled = calls.some((call) => (
      isPlainObject(call.input) && optionalString(call.input.section) === "contract"
    ));
    if (!contractCalled) {
      throw new Error(`目标 ${targetFile}#${symbol} 未实际执行 contract 符号契约分析`);
    }

    const actual = analyzeSymbolContract({
      projectPath: session.project_path,
      targetFile,
      symbol,
      section: "all"
    });
    const totals: Record<"calls" | "wrappers" | "references", number> = {
      calls: actual.coverage.total_call_sites,
      wrappers: actual.coverage.total_public_wrappers,
      references: actual.coverage.total_non_call_references
    };
    for (const section of ["calls", "wrappers", "references"] as const) {
      const pages = calls
        .filter((call) => isPlainObject(call.input) && optionalString(call.input.section) === section)
        .map((call) => {
          const input = call.input as Record<string, unknown>;
          const offset = typeof input.offset === "number" ? Math.max(0, input.offset) : 0;
          const limit = typeof input.limit === "number" ? Math.min(100, Math.max(1, input.limit)) : 50;
          return { offset, limit };
        });
      if (!coversPaginatedContractSection(totals[section], pages)) {
        throw new Error(
          `目标 ${targetFile}#${symbol} 的 ${section} 调查未覆盖全部分页（总数 ${totals[section]}）`
        );
      }
    }
  }
}

export function validateHierarchicalBehaviorObligationContinuity(
  session: AgentSession,
  operation: Extract<HierarchicalNextOperation, {
    kind: "run_phase" | "run_alignment_batch" | "run_planner" | "run_integrator"
  }>,
  events: HierarchicalEvent[]
): void {
  const state = session.hierarchical_state;
  if (!state) return;

  if (operation.kind === "run_integrator") {
    const passedIntegration = events.find((event): event is Extract<HierarchicalEvent, {
      type: "integration_passed"
    }> => event.type === "integration_passed");
    if (!passedIntegration) return;
    for (const requirement of state.requirements) {
      const prepare = latestHierarchicalArtifact(state, requirement.id, "prepare");
      const verify = latestHierarchicalArtifact(state, requirement.id, "verify");
      if (!prepare || !verify) {
        throw new Error(`全局审计缺少 ${requirement.id} 的 prepare 行为契约或 verify 契约结果`);
      }
      assertObligationResultClosure(
        prepare.handoff.behavior_obligations,
        passedIntegration.contract_results.filter((result) => result.requirement_id === requirement.id),
        `${requirement.id}/integrate-final-workspace`,
        ["pass"]
      );
    }
    return;
  }

  if (operation.kind !== "run_phase") return;
  const passed = events.find((event): event is Extract<HierarchicalEvent, { type: "phase_passed" }> => (
    event.type === "phase_passed"
  ));
  if (!passed) return;

  if (operation.phase === "prepare") {
    const investigate = latestHierarchicalArtifact(state, operation.requirement_id, "investigate");
    if (!investigate) throw new Error("prepare 缺少 investigate 同功能入口交接物");
    const referenceAnalysis = isPlainObject(investigate.handoff.reference_analysis)
      ? investigate.handoff.reference_analysis
      : undefined;
    const selectedLocation = optionalString(referenceAnalysis?.selected_location);
    const noReferenceReason = optionalString(referenceAnalysis?.no_reference_reason);
    if (!selectedLocation && !noReferenceReason) {
      throw new Error("prepare 前必须由 investigate 选定同一业务功能的既有入口");
    }
    const selectedFile = selectedLocation
      ? evidenceLocationFile(selectedLocation, session.project_path)
      : null;
    const selectedAnchor = selectedLocation
      ? evidenceLocationAnchor(selectedLocation, session.project_path)
      : null;
    const callContract = isPlainObject(passed.handoff?.call_contract)
      ? passed.handoff.call_contract
      : undefined;
    const targets = Array.isArray(callContract?.analyzed_targets)
      ? callContract.analyzed_targets.filter(isPlainObject)
      : [];
    const analyzedFiles = new Set(targets
      .map((target) => optionalString(target.target_file))
      .filter((value): value is string => Boolean(value))
      .map((value) => path.resolve(session.project_path, value)));
    if (selectedFile && !analyzedFiles.has(selectedFile)) {
      throw new Error(
        `prepare 必须分析 investigate 选中的同功能入口文件：${selectedLocation}`
      );
    }
    const codeAllowedFiles = (passed.allowed_files ?? [])
      .filter((filePath) => /\.[cm]?[jt]sx?$/i.test(filePath))
      .map((filePath) => path.resolve(
        session.project_path,
        normalizeHierarchicalLeasePath(session.project_path, filePath)
      ));
    const missingChangeFiles = codeAllowedFiles.filter((filePath) => !analyzedFiles.has(filePath));
    if (missingChangeFiles.length > 0) {
      throw new Error(
        `prepare 的 analyzed_targets 未覆盖实际代码修改文件：${missingChangeFiles
          .map((filePath) => path.relative(session.project_path, filePath))
          .join(", ")}`
      );
    }
    const obligations = Array.isArray(passed.handoff?.behavior_obligations)
      ? passed.handoff.behavior_obligations.filter(isPlainObject)
      : [];
    if (selectedFile) {
      for (const obligation of obligations) {
        const evidence = Array.isArray(obligation.evidence_refs)
          ? obligation.evidence_refs.filter((item): item is string => typeof item === "string")
          : [];
        if (!evidence.some((item) => evidenceLocationFile(item, session.project_path) === selectedFile)) {
          throw new Error(
            `行为义务 ${optionalString(obligation.id) ?? "<unknown>"} 未引用选定同功能入口 ${selectedLocation}`
          );
        }
        if (
          selectedAnchor
          && !evidence.some((item) => {
            const anchor = evidenceLocationAnchor(item, session.project_path);
            return Boolean(anchor && anchor !== selectedAnchor);
          })
        ) {
          throw new Error(
            `行为义务 ${optionalString(obligation.id) ?? "<unknown>"} 缺少当前目标代码的独立 path:line 证据`
          );
        }
      }
    }
    if (passed.handoff?.change_disposition === "already_satisfied") {
      const satisfaction = Array.isArray(passed.handoff.satisfaction_evidence)
        ? passed.handoff.satisfaction_evidence.filter((item): item is string => typeof item === "string")
        : [];
      if (satisfaction.length < obligations.length) {
        throw new Error("already_satisfied 必须为每条行为义务提供独立 satisfaction_evidence");
      }
    }
    return;
  }

  if (operation.phase === "investigate") return;
  const prepare = latestHierarchicalArtifact(state, operation.requirement_id, "prepare");
  if (!prepare) throw new Error(`${operation.phase} 缺少 prepare 冻结行为契约`);
  if (operation.phase === "implement") {
    assertObligationResultClosure(
      prepare.handoff.behavior_obligations,
      passed.handoff?.obligation_results,
      `${operation.requirement_id}/implement`,
      ["applied", "already-satisfied"]
    );
  } else if (operation.phase === "verify") {
    assertObligationResultClosure(
      prepare.handoff.behavior_obligations,
      passed.handoff?.contract_results,
      `${operation.requirement_id}/verify`,
      ["pass"]
    );
  }
}

function latestHierarchicalArtifact(
  state: HierarchicalExecutionState,
  requirementId: string,
  phase: "investigate" | "prepare" | "implement" | "verify"
): HierarchicalExecutionState["phase_artifacts"][number] | undefined {
  return [...state.phase_artifacts].reverse().find((artifact) =>
    artifact.requirement_id === requirementId && artifact.phase === phase
  );
}

function assertObligationResultClosure(
  rawObligations: unknown,
  rawResults: unknown,
  label: string,
  passingStatuses: string[]
): void {
  const obligations = Array.isArray(rawObligations) ? rawObligations.filter(isPlainObject) : [];
  const expected = obligations
    .map((obligation) => optionalString(obligation.id))
    .filter((id): id is string => Boolean(id));
  const requiredBehaviorById = new Map(obligations.map((obligation) => [
    optionalString(obligation.id) ?? "",
    optionalString(obligation.required_behavior) ?? ""
  ]));
  if (expected.length === 0) throw new Error(`${label} 缺少 prepare behavior_obligations`);
  const results = Array.isArray(rawResults) ? rawResults.filter(isPlainObject) : [];
  const actual = results
    .map((result) => optionalString(result.obligation_id))
    .filter((id): id is string => Boolean(id));
  const missing = expected.filter((id) => !actual.includes(id));
  const unexpected = actual.filter((id) => !expected.includes(id));
  if (missing.length > 0 || unexpected.length > 0 || new Set(actual).size !== actual.length) {
    throw new Error(
      `${label} 行为义务 ID 未闭环；missing=${missing.join(",") || "none"}；unexpected=${unexpected.join(",") || "none"}`
    );
  }
  for (const result of results) {
    const status = optionalString(result.status) ?? "";
    const obligationId = optionalString(result.obligation_id) ?? "";
    if (!passingStatuses.includes(status)) {
      throw new Error(`${label} 行为义务 ${obligationId || "<unknown>"} 未通过：${status}`);
    }
    const requiredBehavior = normalizeBehaviorStatement(requiredBehaviorById.get(obligationId) ?? "");
    const observedBehavior = normalizeBehaviorStatement(optionalString(result.observed_behavior) ?? "");
    if (!requiredBehavior || observedBehavior !== requiredBehavior) {
      throw new Error(
        `${label} 行为义务 ${obligationId || "<unknown>"} 的最终观察与冻结契约不一致`
      );
    }
  }
}

function normalizeBehaviorStatement(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function evidenceLocationFile(value: string, projectPath: string): string | null {
  const trimmed = value.trim().replace(/^["'`(]+|["'`),.;]+$/g, "");
  const match = /^(.*\.[A-Za-z0-9]+):\d+(?::\d+)?(?:\b|$)/.exec(trimmed);
  if (!match?.[1]) return null;
  return path.resolve(projectPath, match[1]);
}

function evidenceLocationAnchor(value: string, projectPath: string): string | null {
  const trimmed = value.trim().replace(/^["'`(]+|["'`),.;]+$/g, "");
  const match = /^(.*\.[A-Za-z0-9]+):(\d+)(?::\d+)?(?:\b|$)/.exec(trimmed);
  if (!match?.[1] || !match[2]) return null;
  return `${path.resolve(projectPath, match[1])}:${Number(match[2])}`;
}

export function validateHierarchicalPlannerEnumeratedCoverage(
  session: AgentSession,
  operation: Extract<HierarchicalNextOperation, { kind: "run_phase" | "run_alignment_batch" | "run_planner" | "run_integrator" }>,
  structured: unknown
): void {
  if (operation.kind !== "run_planner") return;
  if (!isPlainObject(structured) || !session.hierarchical_state) return;
  const coverageContract = buildHierarchicalPlannerCoverageContract(
    session.task_prompt,
    session.hierarchical_state
  );
  if (!coverageContract) return;
  const covered = new Set<number>();
  const requirements = Array.isArray(structured.requirements) ? structured.requirements : [];
  for (const rawRequirement of requirements) {
    if (!isPlainObject(rawRequirement)) continue;
    const id = optionalString(rawRequirement.id) ?? "";
    const numericId = /^R0*(\d+)$/i.exec(id)?.[1];
    if (numericId) covered.add(Number(numericId));
    const evidenceText = [
      optionalString(rawRequirement.source_anchor),
      optionalString(rawRequirement.observable_result)
    ].filter(Boolean).join("\n");
    for (const sequence of extractBusinessSequenceNumbers(evidenceText)) covered.add(sequence);
  }
  const missing = coverageContract.required_sequences
    .filter((sequence) => !covered.has(sequence));
  if (missing.length > 0) {
    throw new Error(`planner 需求账本遗漏用户范围内业务序号：${missing.join(", ")}`);
  }
}

function coversPaginatedContractSection(
  total: number,
  pages: Array<{ offset: number; limit: number }>
): boolean {
  if (pages.length === 0) return false;
  if (total === 0) return pages.some((page) => page.offset === 0);
  const sorted = [...pages].sort((left, right) => left.offset - right.offset);
  let coveredUntil = 0;
  for (const page of sorted) {
    if (page.offset > coveredUntil) return false;
    coveredUntil = Math.max(coveredUntil, page.offset + page.limit);
    if (coveredUntil >= total) return true;
  }
  return false;
}

function hierarchicalErrorFingerprint(scope: string, message: string): string {
  return createHash("sha256")
    .update(`${scope}\n${message.replace(/\s+/g, " ").trim()}`)
    .digest("hex")
    .slice(0, 16);
}

function countConsecutiveHierarchicalPhaseFailures(
  session: AgentSession,
  workUnitId: string,
  fingerprint: string
): number {
  let count = 0;
  for (let index = (session.hierarchical_state?.phase_runs.length ?? 0) - 1; index >= 0; index -= 1) {
    const run = session.hierarchical_state?.phase_runs[index];
    if (!run || run.work_unit_id !== workUnitId) continue;
    if (run.status === "running") continue;
    if (run.status !== "failed" || run.error_fingerprint !== fingerprint) break;
    count += 1;
  }
  return count;
}

function hierarchicalPhaseSelfHealRoute(
  phase: Exclude<HierarchicalWorkPhase, "close">
): "retry" | "investigate" | "prepare" | "implement" {
  if (phase === "prepare") return "investigate";
  if (phase === "implement") return "prepare";
  if (phase === "verify") return "implement";
  return "retry";
}

async function captureHierarchicalWorkUnitSnapshot(
  session: AgentSession
): Promise<HierarchicalWorkUnitSnapshot> {
  const workUnit = session.hierarchical_state?.active_work_unit;
  if (!workUnit || workUnit.phase !== "implement" || workUnit.status !== "running") {
    throw new Error("无法为非运行中的 implement 工作单元建立恢复快照");
  }
  const files: HierarchicalWorkUnitSnapshot["files"] = [];
  for (const rawPath of workUnit.allowed_files) {
    const relativePath = normalizeHierarchicalLeasePath(session.project_path, rawPath);
    const absolutePath = path.resolve(session.project_path, relativePath);
    await assertPathInsideProject(session.project_path, absolutePath);
    try {
      const [content, fileStat] = await Promise.all([readFile(absolutePath), stat(absolutePath)]);
      files.push({ path: absolutePath, existed: true, content, mode: fileStat.mode });
    } catch (error) {
      const code = isPlainObject(error) && typeof error.code === "string" ? error.code : "";
      if (code !== "ENOENT") throw error;
      files.push({ path: absolutePath, existed: false });
    }
  }
  return { work_unit_id: workUnit.id, files };
}

async function restoreHierarchicalWorkUnitSnapshot(
  projectPath: string,
  snapshot: HierarchicalWorkUnitSnapshot
): Promise<void> {
  for (const file of snapshot.files) {
    await assertPathInsideProject(projectPath, file.path);
    if (file.existed) {
      await writeFile(file.path, file.content ?? new Uint8Array());
      if (file.mode !== undefined) await chmod(file.path, file.mode);
      continue;
    }
    try {
      await unlink(file.path);
    } catch (error) {
      const code = isPlainObject(error) && typeof error.code === "string" ? error.code : "";
      if (code !== "ENOENT") throw error;
    }
  }
}

async function assertHierarchicalWorkUnitIntegrity(snapshot: HierarchicalWorkUnitSnapshot): Promise<void> {
  for (const file of snapshot.files) {
    if (!file.existed) continue;
    let current: Uint8Array;
    try {
      current = await readFile(file.path);
    } catch {
      throw new Error(`implement 删除或破坏了既有租约文件：${file.path}`);
    }
    const previousSize = file.content?.byteLength ?? 0;
    if (previousSize >= 1_024 && current.byteLength < previousSize * 0.5) {
      throw new Error(
        `implement 导致既有文件异常缩减：${file.path}（${previousSize} → ${current.byteLength} bytes）`
      );
    }
  }
}

function getHierarchicalCapabilityLeaseError(
  session: AgentSession,
  toolName: string,
  toolInput: Record<string, unknown>
): string | null {
  if (toolName !== "Edit" && toolName !== "Write" && toolName !== "NotebookEdit") return null;
  const workUnit = session.hierarchical_state?.active_work_unit;
  if (!workUnit || workUnit.phase !== "implement" || workUnit.status !== "running") {
    return `当前分层阶段没有 ${toolName} 写权限租约。`;
  }
  const suppliedPath = optionalString(toolInput.file_path ?? toolInput.notebook_path);
  if (!suppliedPath) return `${toolName} 缺少文件路径，无法核对阶段写权限租约。`;
  const normalizeLeasePath = (value: string): string => path.normalize(
    path.isAbsolute(value) ? value : path.resolve(session.project_path, value)
  );
  const target = normalizeLeasePath(suppliedPath);
  const allowed = workUnit.allowed_files.map(normalizeLeasePath);
  if (allowed.length === 0 || !allowed.includes(target)) {
    return [
      `当前工作单元 ${workUnit.id} 不允许修改 ${suppliedPath}。`,
      `允许文件：${workUnit.allowed_files.join(", ") || "无（必须退回 prepare 建立文件边界）"}`
    ].join(" ");
  }
  return null;
}

async function getHierarchicalWriteSafetyError(
  session: AgentSession,
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<string | null> {
  if (toolName !== "Write") return null;
  const suppliedPath = optionalString(toolInput.file_path);
  if (!suppliedPath) return null;
  const target = path.isAbsolute(suppliedPath)
    ? path.normalize(suppliedPath)
    : path.resolve(session.project_path, suppliedPath);
  try {
    await access(target);
    return [
      `禁止使用 Write 覆盖现有文件：${suppliedPath}。`,
      "请保留现有内容并使用 Edit 做最小局部修改；宿主不会把整文件重写当作自愈手段。"
    ].join(" ");
  } catch (error) {
    const code = isPlainObject(error) && typeof error.code === "string" ? error.code : "";
    return code === "ENOENT"
      ? null
      : `宿主无法确认 Write 目标是否为新文件：${suppliedPath}；为避免覆盖现有内容，请改用 Edit 或先修复路径。`;
  }
}

export function normalizeHierarchicalLeasePath(projectPath: string, value: string): string {
  let normalized = value.trim();
  normalized = normalized
    .replace(/^\s*(?:[-*]|\d+[.)、])\s+/, "")
    .replace(/^[`'\"“”‘’*]+|[`'\"“”‘’*]+$/g, "")
    .replace(/[“”‘’`]/g, "")
    .trim();
  if (!normalized || /[\r\n]/.test(normalized)) {
    throw new Error(`allowed_files 包含无法安全规范化的路径：${value}`);
  }
  const absolute = path.isAbsolute(normalized)
    ? path.normalize(normalized)
    : path.resolve(projectPath, normalized);
  const projectRoot = path.resolve(projectPath);
  if (!isPathInsideRoot(projectRoot, absolute)) {
    throw new Error(`allowed_files 路径越出当前项目：${value}`);
  }
  return path.relative(projectRoot, absolute) || ".";
}

/**
 * 分层角色必须围绕会话登记的唯一项目根目录工作。SDK 的 cwd 已经正确设置，但模型仍
 * 可能沿用训练语料中的 /workspace 或 /home/user/workspace。这里在工具执行前明确拒绝
 * 越界路径，并把真实根目录回传给同一角色纠正，避免无意义地访问/修改另一个位置。
 */
export function getHierarchicalProjectPathError(
  session: AgentSession,
  toolName: string,
  toolInput: Record<string, unknown>
): string | null {
  const projectRoot = path.resolve(session.project_path);
  if (toolName === "Bash") {
    const command = optionalString(toolInput.command);
    if (!command) return null;
    const cdPattern = /(?:^|[;&|]\s*)cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
    for (const match of command.matchAll(cdPattern)) {
      const destination = match[1] ?? match[2] ?? match[3];
      if (!destination || !path.isAbsolute(destination)) continue;
      if (!isPathInsideRoot(projectRoot, path.resolve(destination))) {
        return hierarchicalProjectPathMessage("Bash cd", destination, projectRoot);
      }
    }
    return null;
  }
  const pathField = toolName === "NotebookEdit"
    ? "notebook_path"
    : toolName === "Read" || toolName === "Edit" || toolName === "Write"
      ? "file_path"
      : null;
  if (!pathField) return null;
  const suppliedPath = optionalString(toolInput[pathField]);
  if (!suppliedPath) return null;

  const target = path.resolve(projectRoot, suppliedPath);
  if (isPathInsideRoot(projectRoot, target)) return null;
  return hierarchicalProjectPathMessage(toolName, suppliedPath, projectRoot);
}

function isPathInsideRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function hierarchicalProjectPathMessage(toolName: string, suppliedPath: string, projectRoot: string): string {
  return [
    `${toolName} 路径越出当前项目：${suppliedPath}。`,
    `唯一项目根目录是 ${projectRoot}；请使用该目录下的项目相对路径，或以该目录逐字开头的绝对路径。`,
    "不得改用 /workspace、/home/user/workspace 或省略项目目录的路径。"
  ].join(" ");
}

function buildLlmDecisionContext(
  errorName: string,
  errorMessage: string,
  partialTranscript: string,
  completedToolCalls: AgentSession["tool_calls"] = []
): string {
  const parts: string[] = [];

  parts.push("## ⚠️ API 调用中断");
  parts.push(`上一次执行因 API 错误中断：**${errorName}**`);
  parts.push(`\`\`\`\n${errorMessage.slice(0, 500)}\n\`\`\``);

  if (partialTranscript) {
    parts.push("## 中断前的对话摘要");
    parts.push(partialTranscript.slice(0, 6000));
  }

  if (completedToolCalls.length > 0) {
    parts.push("## 中断前已成功完成的工具调用");
    parts.push(...completedToolCalls.map((toolCall) => {
      const input = isPlainObject(toolCall.input) ? toolCall.input : {};
      const summary = sanitizeToolOutputSummary(toolCall.output_summary)?.slice(0, 240);
      return `- ${describeToolAttempt(toolCall.tool, input)}${summary ? `：${summary}` : ""}`;
    }));
    parts.push("这些调用已经成功，不要重复调用；先核对并把可确认结论归并进 checkpoint_exploration。");
  }

  parts.push("## 你的决策");
  parts.push("请根据以上信息判断：");
  parts.push("1. **可以继续**：基于已完成的工具结果，换一种方式继续完成任务（例如用 pdftotext 代替读图）");
  parts.push("2. **无法继续**：如果已完成的工具结果不足以继续，简要说明原因，任务将标记为中断");
  parts.push("");
  parts.push("**⚠️ 工具调用格式要求（必读）**：调用工具时必须使用标准的 tool_use 格式，**绝对禁止**使用 DSML 标记（`<|DSML|tool_calls>`、`<|DSML|invoke>`、`Calling:` 等）。DSML 格式的工具调用会被忽略，导致任务失败。");

  return parts.join("\n\n");
}

function retainSettledProfileToolCalls(
  session: AgentSession,
  firstToolCallIndex: number
): AgentSession["tool_calls"] {
  const beforeQuery = session.tool_calls.slice(0, firstToolCallIndex);
  const settled = session.tool_calls.slice(firstToolCallIndex).filter((toolCall) =>
    toolCall.status === "completed"
    || toolCall.status === "failed"
    || toolCall.status === "blocked"
    || toolCall.exit_code !== undefined
  );
  session.tool_calls = [...beforeQuery, ...settled];
  return settled;
}

function checkpointInterruptedProfileProgress(
  session: AgentSession,
  completedToolCalls: AgentSession["tool_calls"],
  partialTranscript: string,
  errorMessage: string
): void {
  const latest = getLatestExplorationCheckpoint(session);
  const observations = completedToolCalls.map((toolCall) => {
    const input = isPlainObject(toolCall.input) ? toolCall.input : {};
    const summary = sanitizeToolOutputSummary(toolCall.output_summary)?.slice(0, 240);
    return `- ${describeToolAttempt(toolCall.tool, input)} → ${toolCall.status}${summary ? ` / ${summary}` : ""}`;
  });
  const transcript = partialTranscript.replace(/\s+/g, " ").trim().slice(-3_000);
  const recoverySection = [
    "## SDK 中断恢复观察（宿主自动保全，待模型核对）",
    `- 中断原因：${errorMessage.replace(/\s+/g, " ").slice(0, 240)}`,
    ...(observations.length > 0 ? ["- 中断前已完成的工具调用：", ...observations] : []),
    ...(transcript ? ["- 中断前助手结论：", `  ${transcript}`] : []),
    "- 上述成功调用不得重复；下一步先核对这些观察并归并可确认事实。"
  ].join("\n");
  const memory = [latest?.text?.trim(), recoverySection].filter(Boolean).join("\n\n");
  applyExplorationCheckpoint(session, {
    memory,
    disposition: "continue",
    phase: latest?.phase ?? "investigate",
    next_action: "核对并归并 SDK 中断前已完成的工具结果，不重复调用已经成功的相同工具"
  });
}

function checkpointProfileMilestoneIfNeeded(
  session: AgentSession,
  transcript: string
): string | null {
  const latest = getLatestExplorationCheckpoint(session);
  if (!latest || !isCheckpointWorthyProfileTranscript(transcript)) return null;

  const completedToolCalls = session.tool_calls
    .slice(Math.min(latest.observed_tool_call_count, session.tool_calls.length))
    .filter((toolCall) =>
      !isExplorationControlTool(toolCall.tool)
      && (
        toolCall.status === "completed"
        || toolCall.status === "failed"
        || toolCall.status === "blocked"
        || toolCall.exit_code !== undefined
      )
    );
  if (completedToolCalls.length === 0) return null;

  const callObservations = completedToolCalls
    .slice(-8)
    .map((toolCall) => {
      const input = isPlainObject(toolCall.input) ? toolCall.input : {};
      const summary = sanitizeToolOutputSummary(toolCall.output_summary)?.slice(0, 240);
      return `- ${describeToolAttempt(toolCall.tool, input)} → ${toolCall.status}${summary ? ` / ${summary}` : ""}`;
    })
    .filter((observation) => !latest.text.includes(observation));
  const compactTranscript = transcript.replace(/\s+/g, " ").trim().slice(-2_000);
  const transcriptAlreadyCaptured = compactTranscript.length > 0
    && latest.text.includes(compactTranscript.slice(-Math.min(800, compactTranscript.length)));
  const additions = [
    ...(callObservations.length > 0 ? ["- 本轮已完成的工具观察：", ...callObservations] : []),
    ...(!transcriptAlreadyCaptured && compactTranscript
      ? ["- 本轮助手关键发现（宿主原样保全，待下一步核对）：", `  ${compactTranscript}`]
      : [])
  ];
  const memory = additions.length > 0
    ? [
        latest.text.trim(),
        "## 最新关键观察（宿主自动保全）",
        ...additions,
        "- 下一步先核对这些观察，把确认项归入已有知识；不得重新获取已经成功取得的相同证据。"
      ].join("\n")
    : latest.text;
  const priorNextAction = latest.next_action && !latest.next_action.startsWith("核对并归并宿主保全的关键观察")
    ? latest.next_action
    : undefined;
  const checkpointResult = applyExplorationCheckpoint(session, {
    memory,
    disposition: "continue",
    phase: latest.phase ?? "investigate",
    next_action: [
      "核对并归并宿主保全的关键观察，不重复调用已经成功的相同工具",
      priorNextAction ? `随后继续：${priorNextAction}` : ""
    ].filter(Boolean).join("；")
  });
  return `${checkpointResult}；宿主已保全本轮结论及最近 ${Math.min(completedToolCalls.length, 8)} 个证据来源`;
}

export function isCheckpointWorthyProfileTranscript(transcript: string): boolean {
  if (!transcript.trim()) return false;
  const compact = transcript.replace(/\s+/g, " ").trim();
  const hasStrongConclusion = /(?:根因|调用契约|差异|校正|验证通过|测试通过|构建通过|审查通过|部分实现|尚缺|缺少|不一致|冲突|映射为|对应到|确定为|最后一项)/i.test(compact);
  const hasEvidenceBackedFinding = /(?:已经|已)(?:找到|发现|确认|完成|实现|验证|通过)|(?:结论|定义|结果)/i.test(compact)
    && /(?:[A-Za-z0-9_.-]+\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+|\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b|第\s*\d+\s*页|\d+\s*(?:个|项|条|页|处)|：|:)/.test(compact);
  if (!hasStrongConclusion && !hasEvidenceBackedFinding) return false;
  const onlyProgressNarration = /^(?:我需要|让我|接下来|继续|现在我(?:需要|将)|已经读取|已读取)/.test(compact)
    && !hasStrongConclusion;
  return !onlyProgressNarration;
}

export function evaluateProfileCompletion(session: AgentSession, requireTaskTree = true): string[] {
  const tree = session.task_tree;
  if (requireTaskTree && (!tree || tree.tasks.length === 0)) {
    return ["尚未建立任务树"];
  }

  const reasons: string[] = [];
  if (!requireTaskTree && hasCodeChangeActivity(session)) {
    if (!hasMergedTaskVerifierAfterLastCodeChange(session)) {
      reasons.push("代码已修改，但修改后尚未由 task-verifier 独立核对，或 verifier 结果尚未归并进知识雪球");
    }
    if (!hasSuccessfulValidationAfterLastCodeChange(session)) {
      reasons.push("代码已修改，但修改后没有成功的测试、构建、类型检查、lint、语法检查或 git diff --check 证据");
    }
    if (!hasFinalAuditAfterLastCodeChange(session)) {
      reasons.push("代码已修改，但修改后尚未由 completeness-checker 独立核对原始需求、输入依据、指定基线、最终 diff 和验证结果");
    }
  }
  if (requireTaskTree && tree) {
    const unfinished = tree.tasks.filter((task) => task.status !== "completed" && task.status !== "skipped");
    if (unfinished.length > 0) {
      reasons.push(`仍有未完成任务：${unfinished.map((task) => `${task.id}(${task.status})`).join(", ")}`);
    }
    const completedWithoutEvidence = tree.tasks.filter(
      (task) => task.status === "completed" && !task.evidence?.trim()
    );
    if (completedWithoutEvidence.length > 0) {
      reasons.push(`完成节点缺少证据：${completedWithoutEvidence.map((task) => task.id).join(", ")}`);
    }
  }
  const checkpoint = getLatestExplorationCheckpoint(session);
  if (!checkpoint) {
    reasons.push("尚未建立探索工作记忆 checkpoint");
  } else {
    const isHostBaseline = checkpoint.source === "host";
    if (checkpoint.disposition !== "complete" && (!isHostBaseline || !requireTaskTree)) {
      reasons.push(`探索工作记忆尚未声明完成：revision ${checkpoint.revision} 为 ${checkpoint.disposition}`);
    }
    if (!isExplorationCheckpointFresh(session, checkpoint)) {
      reasons.push(
        "checkpoint 后仍有未归并的工具结果或状态变化"
      );
    }
  }
  return reasons;
}

function hasCodeChangeActivity(session: AgentSession): boolean {
  return (session.file_changes?.length ?? 0) > 0 || (session.tool_calls ?? []).some(isCodeChangingToolCall);
}

function isCodeChangingToolCall(toolCall: AgentSession["tool_calls"][number]): boolean {
  if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(toolCall.tool)) return true;
  return toolCall.tool === "Task"
    && isPlainObject(toolCall.input)
    && toolCall.input.subagent_type === "task-executor"
    && toolCall.status === "completed";
}

function lastCodeChangeToolIndex(session: AgentSession): number {
  let lastIndex = -1;
  (session.tool_calls ?? []).forEach((toolCall, index) => {
    if (isCodeChangingToolCall(toolCall)) lastIndex = index;
  });
  return lastIndex;
}

function hasSuccessfulValidationAfterLastCodeChange(session: AgentSession): boolean {
  return lastSuccessfulValidationIndexAfterLastCodeChange(session) >= 0;
}

function hasMergedTaskVerifierAfterLastCodeChange(session: AgentSession): boolean {
  const checkpoint = getLatestExplorationCheckpoint(session);
  if (!checkpoint) return false;
  const hasVerifierConclusionInMemory = /(?:task-verifier|独立验证|独立核对)[\s\S]{0,800}(?:PASS|通过|证据|命令|路径|path:line|无回归)/i.test(checkpoint.text);
  if (!hasVerifierConclusionInMemory) return false;
  const lastChange = lastCodeChangeToolIndex(session);
  return (session.tool_calls ?? []).some((toolCall, index) =>
    index > lastChange
    && index < checkpoint.observed_tool_call_count
    && toolCall.tool === "Task"
    && toolCall.status === "completed"
    && isPlainObject(toolCall.input)
    && toolCall.input.subagent_type === "task-verifier"
    && Boolean(toolCall.output_summary?.trim())
  );
}

function lastSuccessfulValidationIndexAfterLastCodeChange(session: AgentSession): number {
  const lastChange = lastCodeChangeToolIndex(session);
  let lastValidation = -1;
  (session.tool_calls ?? []).forEach((toolCall, index) => {
    if (index <= lastChange || toolCall.tool !== "Bash" || toolCall.status !== "completed" || toolCall.exit_code !== 0) {
      return;
    }
    const command = isPlainObject(toolCall.input) ? optionalString(toolCall.input.command) ?? "" : "";
    if (/(?:^|\s)(?:test|check|lint|typecheck|build)(?:\s|$)|\b(?:vitest|jest|pytest|mocha|eslint|tsc|cargo\s+test|go\s+test|gradle\w*\s+test|mvn\s+test|node\s+--check)\b|git\s+diff\s+--check/i.test(command)) {
      lastValidation = index;
    }
  });
  return lastValidation;
}

function hasFinalAuditAfterLastCodeChange(session: AgentSession): boolean {
  const lastValidation = lastSuccessfulValidationIndexAfterLastCodeChange(session);
  if (lastValidation < 0) return false;
  return (session.tool_calls ?? []).some((toolCall, index) =>
    index > lastValidation
    && toolCall.tool === "Task"
    && toolCall.status === "completed"
    && isPlainObject(toolCall.input)
    && toolCall.input.subagent_type === "completeness-checker"
  );
}

const MAX_EXPLORATION_CHECKPOINTS = 40;

export interface ExplorationCheckpointArgs {
  memory: string;
  disposition: ExplorationDisposition;
  phase?: ExplorationPhase;
  next_action?: string;
}

export function ensureExplorationCheckpoint(session: AgentSession): boolean {
  if (getLatestExplorationCheckpoint(session)) return false;
  const goal = session.task_prompt.trim() || "完成用户请求";
  const attachmentManifest = formatProfileAttachmentList(collectSessionAttachments(session), session.project_path);
  const confirmed = [
    "- 用户原始目标（保持范围与措辞）：",
    ...goal.split(/\r?\n/).map((line) => `  ${line}`),
    ...(attachmentManifest
      ? ["- 宿主精确附件清单（后续必须复用，不得猜测或寻找替代副本）：", ...attachmentManifest.split(/\r?\n/).map((line) => `  ${line}`)]
      : ["- 当前没有宿主附件。"])
  ];
  session.exploration_checkpoints = [{
    revision: 1,
    text: [
      "## 当前目标",
      goal,
      "",
      "## 已确认",
      ...confirmed,
      "",
      "## 仍缺少",
      "- 尚未确认最相似既有实现、有效基线、相关代码、实现状态和验证入口。",
      "",
      "## 最相似既有实现",
      "- 位置：待确认",
      "- 可复用模式：待确认",
      "- 与本需求的差异：待确认",
      "",
      "## 当前判断",
      "任务尚未完成。",
      "",
      "## 下一步",
      "第一优先级：在指定基线中寻找最相似功能的既有实现，记录位置、可复用模式和差异。若任务从某个序号、版本或步骤继续，先检查边界前最近的已完成项，再按需向前追踪；确实没有时记录搜索范围。"
    ].join("\n"),
    disposition: "continue",
    phase: "investigate",
    next_action: "在指定基线中寻找最相似功能的既有实现；连续序列优先检查边界前最近的已完成项，记录位置、模式和差异",
    source: "host",
    observed_tool_call_count: session.tool_calls.length,
    observed_tool_state: buildExplorationToolStateFingerprint(session),
    created_at: new Date().toISOString()
  }];
  return true;
}

function normalizeExplorationCheckpointArgs(value: unknown): ExplorationCheckpointArgs {
  if (!isPlainObject(value)) throw new Error("checkpoint 参数必须是对象");
  const memory = optionalString(value.memory) ?? "";
  if (memory.length > 30_000) {
    throw new Error("memory 超过 30000 字符；请压缩过程信息，只保留当前有效认知");
  }
  const disposition = isExplorationDisposition(value.disposition) ? value.disposition : "continue";
  const nextAction = optionalString(value.next_action);
  const phase = value.phase;
  return {
    memory,
    disposition,
    ...(isExplorationPhase(phase) ? { phase } : {}),
    next_action: nextAction
  };
}

export function applyExplorationCheckpoint(
  session: AgentSession,
  args: ExplorationCheckpointArgs
): string {
  const checkpoints = session.exploration_checkpoints ?? [];
  const latest = checkpoints.at(-1);
  const phase = args.disposition === "verify" || args.disposition === "complete"
    ? phaseFromDisposition(args.disposition)
    : args.phase ?? latest?.phase ?? phaseFromDisposition(args.disposition);
  const proposedMemory = args.memory.trim()
    ? latest && args.memory.trim().length < 40
      ? `${latest.text.trimEnd()}\n\n## 最新补充\n${args.memory.trim()}`
      : args.memory
    : latest?.text ?? "## 已确认\n- 尚未开始取证。";
  const nextAction = args.next_action
    ?? extractNextActionFromMemory(proposedMemory)
    ?? (args.disposition === "blocked" ? "需要外部信息或状态变化" : undefined)
    ?? (args.disposition === "complete" ? "任务已完成" : undefined)
    ?? latest?.next_action
    ?? "继续根据当前知识雪球推进";
  const reconciled = preserveConfirmedKnowledge(
    latest?.text,
    proposedMemory
  );
  if (reconciled.memory.length > 30_000) {
    throw new Error("保全既有已确认知识后 memory 超过 30000 字符；请压缩过程信息，不能删除确认项");
  }
  if (
    latest
    && latest.text === reconciled.memory
    && latest.disposition === args.disposition
    && latest.phase === phase
    && latest.next_action === nextAction
  ) {
    latest.source = "agent";
    latest.observed_tool_call_count = session.tool_calls.length;
    latest.observed_tool_state = buildExplorationToolStateFingerprint(session);
    return `探索工作记忆 revision ${latest.revision} 内容未变化，已刷新工具观察边界`;
  }
  const checkpoint: ExplorationCheckpoint = {
    revision: (latest?.revision ?? 0) + 1,
    text: reconciled.memory,
    disposition: args.disposition,
    phase,
    next_action: nextAction,
    source: "agent",
    observed_tool_call_count: session.tool_calls.length,
    observed_tool_state: buildExplorationToolStateFingerprint(session),
    created_at: new Date().toISOString()
  };
  session.exploration_checkpoints = [...checkpoints, checkpoint].slice(-MAX_EXPLORATION_CHECKPOINTS);
  const preservationNote = reconciled.restoredCount > 0
    ? `；宿主补回 ${reconciled.restoredCount} 条遗漏的已确认知识`
    : "";
  return `探索工作记忆已更新至 revision ${checkpoint.revision}（${checkpoint.disposition}${preservationNote}）`;
}

function extractNextActionFromMemory(memory: string): string | undefined {
  const lines = memory.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^#{1,6}\s+(?:下一步|next[_ ]?action)\s*>?\s*$/i.test(line.trim()));
  if (headingIndex < 0) return undefined;
  return lines.slice(headingIndex + 1).find((line) => line.trim() && !/^#{1,6}\s+/.test(line.trim()))?.trim();
}

const TRANSIENT_CONFIRMED_PLACEHOLDERS = new Set(["- 尚未开始取证。", "尚未开始取证。"]);

function isConfirmedHeading(line: string): boolean {
  return /^#{1,6}\s+已确认(?:事实|内容)?\s*$/.test(line.trim());
}

function extractConfirmedEntries(memory: string | undefined): string[] {
  if (!memory) return [];
  const lines = memory.split(/\r?\n/);
  const headingIndex = lines.findIndex(isConfirmedHeading);
  if (headingIndex < 0) return [];
  const entries: string[] = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (/^#{1,6}\s+/.test(line)) break;
    if (line && !TRANSIENT_CONFIRMED_PLACEHOLDERS.has(line)) entries.push(line);
  }
  return [...new Set(entries)];
}

function insertConfirmedEntries(memory: string, entries: string[]): string {
  if (entries.length === 0) return memory;
  const lines = memory.split(/\r?\n/);
  const headingIndex = lines.findIndex(isConfirmedHeading);
  if (headingIndex < 0) {
    return `${memory.trimEnd()}\n\n## 已确认\n${entries.join("\n")}`;
  }
  lines.splice(headingIndex + 1, 0, ...entries);
  return lines.join("\n");
}

function preserveConfirmedKnowledge(
  previousMemory: string | undefined,
  proposedMemory: string
): { memory: string; restoredCount: number } {
  const previousEntries = extractConfirmedEntries(previousMemory);
  if (previousEntries.length === 0) return { memory: proposedMemory, restoredCount: 0 };
  const proposedEntries = new Set(extractConfirmedEntries(proposedMemory));
  const missingEntries = previousEntries.filter((entry) => !proposedEntries.has(entry));
  return {
    memory: insertConfirmedEntries(proposedMemory, missingEntries),
    restoredCount: missingEntries.length
  };
}

function summarizeExplorationCheckpointToolInput(
  args: ExplorationCheckpointArgs
): Record<string, unknown> {
  return {
    disposition: args.disposition,
    ...(args.phase ? { phase: args.phase } : {}),
    ...(args.next_action ? { next_action: args.next_action } : {}),
    memory_chars: args.memory.length
  };
}

function getLatestExplorationCheckpoint(session: AgentSession): ExplorationCheckpoint | undefined {
  return session.exploration_checkpoints?.at(-1);
}

function isExplorationDisposition(value: unknown): value is ExplorationDisposition {
  return value === "continue" || value === "verify" || value === "complete" || value === "blocked";
}

function isExplorationPhase(value: unknown): value is ExplorationPhase {
  return value === "investigate" || value === "implement" || value === "verify" || value === "complete";
}

function phaseFromDisposition(disposition: ExplorationDisposition): ExplorationPhase {
  if (disposition === "verify") return "verify";
  if (disposition === "complete") return "complete";
  return "investigate";
}

export function getExplorationActionGuardError(
  session: AgentSession,
  toolName: string,
  toolInput: Record<string, unknown>,
  currentToolUseID?: string
): string | null {
  if (!requiresFreshExplorationCheckpoint(session, toolName, toolInput)) return null;
  const checkpoint = getLatestExplorationCheckpoint(session);
  if (checkpoint && isExplorationCheckpointFresh(session, checkpoint, currentToolUseID)) return null;
  return [
    "探索工作记忆落后于最新工具结果，已暂停新的高层行动。",
    "请先调用 mcp__ai_coder__checkpoint_exploration，把新证据、被修正的结论、新问题和下一步归并进完整工作记忆；",
    "然后重新发起当前行动。不要用普通回复代替 checkpoint。"
  ].join("");
}

/**
 * Simple-profile mode has one deliberately narrow knowledge boundary:
 * after new evidence is gathered, it must be folded into the snowball before
 * the first mutation. Once an implementation edit has actually completed,
 * subsequent edits belong to the same batch and are not interrupted.
 */
export function getSimpleKnowledgeBoundaryGuardError(
  session: AgentSession,
  toolName: string,
  toolInput: Record<string, unknown>,
  currentToolUseID?: string
): string | null {
  if (!isKnowledgeBoundaryMutation(toolName, toolInput)) return null;

  const checkpoint = getLatestExplorationCheckpoint(session);
  if (checkpoint && isExplorationCheckpointFresh(session, checkpoint, currentToolUseID)) return null;

  if (checkpoint) {
    const callsAfterCheckpoint = session.tool_calls.slice(
      Math.min(checkpoint.observed_tool_call_count, session.tool_calls.length)
    );
    const implementationBatchStarted = callsAfterCheckpoint.some((toolCall) =>
      toolCall.id !== currentToolUseID
      && toolCall.status === "completed"
      && isCodeChangingToolCall(toolCall)
    );
    if (implementationBatchStarted) return null;
  }

  return [
    "最新读取或调查结果尚未归并进知识雪球。",
    "开始修改前先调用 mcp__ai_coder__checkpoint_exploration，更新已确认事实、仍缺少内容和下一步；",
    "phase 与 Markdown 格式不作限制。"
  ].join("");
}

/**
 * 简洁 Profile 中根 Agent 只负责编排和归并认知。真正的工作区修改必须由
 * task-executor 完成，避免“提示词要求委托、实际却由根线程直接 Edit”的旁路。
 */
export function getSimpleDelegationGuardError(
  toolName: string,
  toolInput: Record<string, unknown>
): string | null {
  const isDirectMutation = ["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(toolName)
    || (toolName === "Bash" && isMutatingShellCommand(optionalString(toolInput.command) ?? ""));
  if (!isDirectMutation) return null;
  return [
    "简洁 Profile 的根 Agent 只负责编排、知识归并与结果交付，禁止直接修改工作区。",
    "请把当前单个独立需求点通过 Task 委托给 task-executor；executor 完成后再委托 task-verifier 独立核对。"
  ].join("");
}

function requiresPlannerInSimpleProfile(session: AgentSession, attachments: Attachment[]): boolean {
  if (hasCompletedSubagent(session, "task-planner")) return false;
  const prompt = session.task_prompt ?? "";
  return attachments.length > 1
    || /(?:多个|几个|所有|全部|分别|逐个|从.+开始|重新从.+分支|跨文件|附件)/i.test(prompt);
}

export function getSimplePlannerGuardError(
  session: AgentSession,
  attachments: Attachment[],
  toolName: string,
  toolInput: Record<string, unknown>
): string | null {
  if (!requiresPlannerInSimpleProfile(session, attachments)) return null;
  if (toolName === "Task" && optionalString(toolInput.subagent_type) === "task-planner") return null;
  if (toolName === "Task" && optionalString(toolInput.subagent_type) === "task-executor") {
    return "当前请求包含多附件、多需求点、跨文件或指定基线。进入实现前必须先委托 task-planner 提取需求、拆分独立 R-ID 并给出证据；根 Agent 仍可做最小只读取证。";
  }
  return null;
}

function hasMergedCallContractPrerequisite(session: AgentSession): boolean {
  const checkpoint = getLatestExplorationCheckpoint(session);
  if (!checkpoint) return false;
  if (/调用契约不适用[\s\S]{0,240}(?:纯文案|静态数据|纯样式|不调用|不复用|不修改)/i.test(checkpoint.text)) {
    return true;
  }
  const hasContractConclusionInMemory = /(?:调用契约|契约调查)[\s\S]{0,800}(?:证据|文件|路径|组件|函数|方法|参数|调用方|返回值|副作用|path:line)/i.test(checkpoint.text);
  if (!hasContractConclusionInMemory) return false;
  return session.tool_calls.some((toolCall, index) =>
    index < checkpoint.observed_tool_call_count
    && toolCall.tool === "Task"
    && isPlainObject(toolCall.input)
    && optionalString(toolCall.input.subagent_type) === "call-contract-investigator"
    && toolCall.status === "completed"
    && Boolean(toolCall.output_summary?.trim())
  );
}

export function getSimpleExecutorPrerequisiteGuardError(
  session: AgentSession,
  toolName: string,
  toolInput: Record<string, unknown>
): string | null {
  if (toolName !== "Task" || optionalString(toolInput.subagent_type) !== "task-executor") return null;
  if (hasMergedCallContractPrerequisite(session)) return null;
  return [
    "task-executor 前置门禁未通过：当前知识雪球中没有已归并且带证据的 call-contract-investigator 独立调查结果。",
    "调查 Task 必须 completed 且返回非空结论，随后 checkpoint 必须实际写入调用契约证据。",
    "若任务确实只涉及纯文案、静态数据或纯样式，请先在 checkpoint 中记录“调用契约不适用”及具体依据。"
  ].join("");
}

function isKnowledgeBoundaryMutation(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(toolName)) return true;
  if (toolName === "Task") return optionalString(toolInput.subagent_type) === "task-executor";
  return toolName === "Bash" && isMutatingShellCommand(optionalString(toolInput.command) ?? "");
}

function requiresFreshExplorationCheckpoint(
  session: AgentSession,
  toolName: string,
  toolInput: Record<string, unknown>
): boolean {
  if (
    toolName === "mcp__ai_coder__checkpoint_exploration"
    || toolName === "Skill"
    || ["Read", "Grep", "Glob", "LS"].includes(toolName)
    || toolName === "mcp__ai_coder__analyze_symbol_contract"
  ) {
    return false;
  }
  if (toolName === "Task" && optionalString(toolInput.subagent_type) === "task-planner") {
    return false;
  }
  if (toolName === "mcp__ai_coder__update_task_tree") {
    const action = optionalString(toolInput.action);
    if (action === "bootstrap") {
      return hasCompletedSubagent(session, "task-planner");
    }
    return !profileNeedsPlanning(session);
  }
  return toolName === "Task"
    || toolName === "Bash"
    || ["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(toolName)
    || toolName === "mcp__ai_coder__ask_human";
}

function isExplorationCheckpointFresh(
  session: AgentSession,
  checkpoint: ExplorationCheckpoint,
  ignoredToolUseID?: string
): boolean {
  if (checkpoint.observed_tool_state !== undefined) {
    return checkpoint.observed_tool_state === buildExplorationToolStateFingerprint(session, ignoredToolUseID);
  }
  return !session.tool_calls
    .slice(Math.min(checkpoint.observed_tool_call_count, session.tool_calls.length))
    .some((toolCall) => toolCall.id !== ignoredToolUseID && isMeaningfulToolCallAfterCheckpoint(toolCall));
}

function isMeaningfulToolCallAfterCheckpoint(toolCall: AgentSession["tool_calls"][number]): boolean {
  if (isExplorationControlTool(toolCall.tool)) return false;
  return toolCall.status === "completed"
    || toolCall.status === "failed"
    || toolCall.status === "blocked"
    || toolCall.exit_code !== undefined;
}

function buildExplorationToolStateFingerprint(session: AgentSession, ignoredToolUseID?: string): string {
  const state = JSON.stringify(session.tool_calls
    .filter((toolCall) =>
      toolCall.id !== ignoredToolUseID
      && !isExplorationControlTool(toolCall.tool)
    )
    .map((toolCall) => ({
      id: toolCall.id,
      tool: toolCall.tool,
      status: toolCall.status,
      exitCode: toolCall.exit_code,
      output: toolCall.output_summary ?? ""
    })));
  return createHash("sha256").update(state).digest("hex");
}

function isExplorationControlTool(toolName: string): boolean {
  return toolName === "mcp__ai_coder__checkpoint_exploration"
    || toolName === "mcp__ai_coder__update_task_tree"
    || toolName === "Skill";
}

export function ensureProfileTaskTree(session: AgentSession): boolean {
  if (session.task_tree) return false;
  const now = new Date().toISOString();
  session.task_tree = {
    goal_restated: session.task_prompt.trim() || "完成用户请求",
    strategy: "宿主根任务：由 Agent 根据代码与附件证据细化，并在实现、验证完成后附证据关闭。",
    current_focus: "host-goal",
    focus_reason: "先建立可审计的执行状态，避免遗漏任务树导致无法完成。",
    tasks: [{
      id: "host-goal",
      description: "完成用户请求并提供实现与验证证据",
      dependencies: [],
      status: "in_progress"
    }],
    created_at: now,
    updated_at: now
  };
  return true;
}

const PHASE_TASK_TREE_STRATEGY = "阶段性任务树：只落实当前知识雪球的 next_action；checkpoint 更新后由宿主自动替换。";

/** 简洁 Profile 模式只保留当前知识雪球下一步，不建立覆盖整个目标的全局 DAG。 */
export function syncPhaseTaskTreeWithCheckpoint(session: AgentSession): boolean {
  const checkpoint = getLatestExplorationCheckpoint(session);
  if (!checkpoint) return false;
  const taskId = `knowledge-r${checkpoint.revision}`;
  const phase = checkpoint.phase ?? phaseFromDisposition(checkpoint.disposition);
  const description = checkpoint.next_action
    ?? (checkpoint.disposition === "complete" ? "汇总已完成目标与验证证据" : "根据当前知识雪球决定下一步");
  const status = checkpoint.disposition === "complete"
    ? "completed"
    : checkpoint.disposition === "blocked"
      ? "blocked"
      : "in_progress";
  const existing = session.task_tree;
  const current = existing?.tasks[0];
  if (
    existing?.strategy === PHASE_TASK_TREE_STRATEGY
    && existing.tasks.length === 1
    && current?.id === taskId
    && current.description === description
    && current.status === status
  ) {
    return false;
  }
  const now = new Date().toISOString();
  session.task_tree = {
    goal_restated: session.task_prompt.trim() || "完成用户请求",
    strategy: PHASE_TASK_TREE_STRATEGY,
    ...(status === "completed" ? {} : { current_focus: taskId }),
    ...(status === "completed" ? {} : { focus_reason: "落实知识雪球中当前最重要的下一步" }),
    tasks: [{
      id: taskId,
      description,
      dependencies: [],
      status,
      status_reason: `由 checkpoint revision ${checkpoint.revision} / ${checkpoint.disposition} / ${phase} 自动生成`,
      ...(status === "completed"
        ? { evidence: `checkpoint revision ${checkpoint.revision} 已归并最终实现与验证结论` }
        : {})
    }],
    created_at: now,
    updated_at: now
  };
  return true;
}

function profileNeedsPlanning(session: AgentSession): boolean {
  return !session.task_tree
    || (session.task_tree.tasks.length === 1 && session.task_tree.tasks[0]?.id === "host-goal");
}

export function buildProfileProgressFingerprint(session: AgentSession): string {
  const taskState = (session.task_tree?.tasks ?? []).map((task) => ({
    id: task.id,
    status: task.status,
    evidence: task.evidence ?? "",
    reason: task.status_reason ?? ""
  }));
  const toolState = session.tool_calls.map((toolCall) => ({
    id: toolCall.id,
    status: toolCall.status,
    exitCode: toolCall.exit_code
  }));
  const fileChanges = [...new Set(
    session.file_changes.map((change) => `${change.operation}:${change.path}`)
  )].sort();
  const checkpoint = getLatestExplorationCheckpoint(session);
  const explorationState = checkpoint
    ? {
        revision: checkpoint.revision,
        disposition: checkpoint.disposition,
        phase: checkpoint.phase ?? "",
        text: checkpoint.text,
        nextAction: checkpoint.next_action ?? ""
      }
    : null;
  return JSON.stringify({ taskState, toolState, fileChanges, explorationState });
}

export function formatProfileAttachmentList(attachments: Attachment[], projectPath?: string): string {
  if (attachments.length === 0) return "";
  const entries = attachments.map((attachment) => {
    if (attachment.type === "file_ref") {
      const exactPath = projectPath
        ? path.normalize(path.isAbsolute(attachment.path) ? attachment.path : path.resolve(projectPath, attachment.path))
        : attachment.path;
      return `- [可读取文件] ${exactPath}（显示名: ${attachment.display_name}）`;
    }
    if (attachment.type === "image") {
      return `- [内联图片] ${attachment.display_name}（没有磁盘路径）`;
    }
    return `- [未落盘文件] ${attachment.display_name}`;
  });
  return [
    `宿主提供了 ${attachments.length} 个附件条目。只能逐字复制下列完整路径：`,
    ...entries,
    "禁止猜测、缩写、补写页码或修改目录 UUID；列表外路径一律视为不存在。"
  ].join("\n");
}

function collectSessionAttachments(session: AgentSession): Attachment[] {
  const collected = [
    ...(session.initial_user_message?.attachments ?? []),
    ...(session.messages ?? []).flatMap((message) => message.attachments ?? [])
  ];
  const seen = new Set<string>();
  return collected.filter((attachment) => {
    const key = attachment.type === "file_ref"
      ? `file_ref:${path.normalize(attachment.path)}`
      : `${attachment.type}:${attachment.display_name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function migrateHierarchicalAlignmentState(state: HierarchicalExecutionState, projectPath: string): void {
  const migratable = state as HierarchicalExecutionState & {
    alignment_batches?: HierarchicalExecutionState["alignment_batches"];
    phase_artifacts?: HierarchicalExecutionState["phase_artifacts"];
    workspace_revision?: number;
  };
  migratable.alignment_batches ??= [];
  migratable.phase_artifacts ??= [];
  migratable.workspace_revision ??= 0;
  for (const artifact of migratable.phase_artifacts) {
    artifact.workspace_revision ??= 0;
  }
  migratable.workspace_contract ??= {
    project_path: path.resolve(projectPath),
    owner: "host",
    locked: true,
    initialized_at: new Date().toISOString()
  };
  for (const batch of migratable.alignment_batches) {
    batch.consecutive_failure_count ??= 0;
  }
}

function getHierarchicalAttachmentReadError(
  session: AgentSession,
  operation: Extract<HierarchicalNextOperation, {
    kind: "run_alignment_batch" | "run_planner" | "run_phase" | "run_integrator"
  }>,
  toolName: string,
  toolInput: Record<string, unknown>
): string | null {
  if (operation.kind === "run_alignment_batch") {
    if (toolName !== "Read" || typeof toolInput.file_path !== "string") return null;
    if (operation.source_refs.includes(toolInput.file_path)) return null;
    return [
      `附件摄取批次 ${operation.batch_id} 只能读取本批次的精确路径：${toolInput.file_path}`,
      ...operation.source_refs.map((source) => `- ${source}`),
      "请逐字复制其中一个路径；不得读取代码、搜索附件或猜测替代路径。"
    ].join("\n");
  }
  const registeredSources = session.hierarchical_state?.alignment_batches
    .flatMap((batch) => batch.source_refs) ?? [];
  if (registeredSources.length === 0) return null;
  const serializedInput = JSON.stringify(toolInput).replace(/\\\\/g, "/");
  const mentionsRegisteredSource = registeredSources.some((source) =>
    serializedInput.includes(source.replace(/\\/g, "/"))
    || serializedInput.includes(path.basename(source))
  );
  const mentionsUploadArea = /\.?ai-coder\/uploads(?:\/|\*|\b)/.test(serializedInput);
  const searchesAttachmentFormats = operation.kind === "run_planner" && (
    (toolName === "Glob" && /\.(?:png|jpe?g|webp|pdf)\b/i.test(serializedInput))
    || (toolName === "Bash" && /\bfind\b[\s\S]*\.(?:png|jpe?g|webp|pdf)\b/i.test(serializedInput))
  );
  if (mentionsRegisteredSource || mentionsUploadArea || searchesAttachmentFormats) {
    return "原始附件已由宿主分批摄取；当前角色必须使用持久化摘要，禁止再次 Read 或猜测附件路径。";
  }
  return null;
}

function augmentTaskInputWithAttachmentManifest(
  toolInput: Record<string, unknown>,
  session: AgentSession
): Record<string, unknown> {
  const attachments = collectSessionAttachments(session);
  const manifest = formatProfileAttachmentList(attachments, session.project_path);
  const marker = "## 宿主精确附件清单";
  const existingPrompt = optionalString(toolInput.prompt) ?? optionalString(toolInput.description) ?? "";
  if (!manifest || existingPrompt.includes(marker)) {
    return toolInput;
  }
  return {
    ...toolInput,
    prompt: [
      existingPrompt,
      `${marker}\n${manifest}`
    ].filter(Boolean).join("\n\n")
  };
}

export function augmentTaskInputWithExplorationMemory(
  toolInput: Record<string, unknown>,
  session: AgentSession,
  capabilityCatalog = ""
): Record<string, unknown> {
  const checkpoint = getLatestExplorationCheckpoint(session);
  const subagentType = optionalString(toolInput.subagent_type);
  const requiredSkills = requiredSkillsForSubagent(subagentType);
  const skillMarker = "## 本次委托必须落实的 Skill";
  const marker = checkpoint ? `## 宿主当前探索工作记忆（revision ${checkpoint.revision}）` : "";
  const existingPrompt = optionalString(toolInput.prompt) ?? optionalString(toolInput.description) ?? "";
  if ((marker && existingPrompt.includes(marker)) || existingPrompt.includes(skillMarker)) return toolInput;
  const memory = checkpoint ? boundExplorationMemoryForHandoff(checkpoint.text) : "";
  return {
    ...toolInput,
    prompt: [
      existingPrompt,
      requiredSkills.length > 0
        ? `${skillMarker}\n${requiredSkills.map((skill) => `- ${skill}`).join("\n")}\n必须在执行和返回证据中体现这些契约，而不是只声称“已加载”。`
        : "",
      marker,
      checkpoint ? `状态：${checkpoint.disposition}` : "",
      checkpoint ? `阶段：${checkpoint.phase ?? phaseFromDisposition(checkpoint.disposition)}` : "",
      checkpoint?.next_action ? `主线程记录的下一步：${checkpoint.next_action}` : "",
      memory,
      session.task_tree
        ? session.task_tree.strategy === PHASE_TASK_TREE_STRATEGY
          ? buildPhaseTaskTreePromptSection(session.task_tree)
          : buildTaskTreePromptSection(session.task_tree)
        : "",
      buildExecutionProgressPromptSection(session),
      capabilityCatalog,
      [
        "把以上文本当作当前有效认知，而不是绝对真理；用你的独立工具结果核对它。",
        "如果发现冲突、失效结论、新未知或验证失败，必须在返回中明确写出，供主 Agent 回流到下一版 checkpoint。"
      ].join("\n")
    ].filter(Boolean).join("\n\n")
  };
}

function requiredSkillsForSubagent(subagentType?: string): string[] {
  const mapping: Record<string, string[]> = {
    "task-planner": [
      "careful-coder:exploring-codebase",
      "careful-coder:planning-complex-changes",
      "careful-coder:task-decomposition"
    ],
    "call-contract-investigator": [
      "careful-coder:cautious-calling",
      "careful-coder:investigating-call-contracts"
    ],
    "task-executor": [
      "careful-coder:preserving-existing-behavior",
      "careful-coder:safe-git-operations",
      "careful-coder:task-decomposition"
    ],
    "task-verifier": ["careful-coder:verification-before-completion"],
    "completeness-checker": ["careful-coder:verification-before-completion"]
  };
  return subagentType ? (mapping[subagentType] ?? []) : [];
}

function selectProfileSkillsForPhase<T extends { id: string }>(
  skills: T[],
  phase: ExplorationPhase
): T[] {
  const suffixesByPhase: Record<ExplorationPhase, string[]> = {
    investigate: [
      "clarifying-requirements",
      "exploring-codebase",
      "planning-complex-changes",
      "task-decomposition",
      "cautious-calling",
      "investigating-call-contracts"
    ],
    implement: [
      "preserving-existing-behavior",
      "safe-git-operations",
      "task-decomposition",
      "cautious-calling",
      "investigating-call-contracts"
    ],
    verify: ["verification-before-completion", "systematic-debugging"],
    complete: ["verification-before-completion"]
  };
  const suffixes = suffixesByPhase[phase] ?? suffixesByPhase.investigate;
  const knownSuffixes = new Set(Object.values(suffixesByPhase).flat());
  return skills.filter((skill) => {
    const shortId = skill.id.includes(":") ? skill.id.slice(skill.id.lastIndexOf(":") + 1) : skill.id;
    return !knownSuffixes.has(shortId) || suffixes.includes(shortId);
  });
}

function boundExplorationMemoryForHandoff(memory: string): string {
  if (memory.length <= 12_000) return memory;
  return [
    memory.slice(0, 4_000),
    "\n\n[中间过程已由宿主压缩省略]\n\n",
    memory.slice(-8_000)
  ].join("");
}

export function buildQueuedUserMessageContext(messages: AgentMessage[], projectPath?: string): string {
  const entries = messages.map((message, index) => {
    const attachments = formatProfileAttachmentList(message.attachments ?? [], projectPath);
    return [
      `### 补充消息 ${index + 1}（${message.created_at}）`,
      "<user-follow-up>",
      message.content || "（用户仅补充了附件）",
      "</user-follow-up>",
      attachments ? `附件：\n${attachments}` : ""
    ].filter(Boolean).join("\n");
  });
  return [
    "## 运行中收到的用户补充消息",
    "以下消息属于当前任务，是新约束、纠正或补充信息，不是新会话。",
    "按时间顺序处理，较新的内容可以修正先前假设；不要因此重新启动 task-planner，也不要重读已经取得的证据。",
    "先判断它们对当前任务树的影响：需要新增工作时添加任务节点；只影响当前工作时直接应用到当前节点。",
    "处理完这些补充内容后再判断完成门禁，不能沿用接收消息前的“已完成”结论直接结束。",
    "",
    ...entries
  ].join("\n");
}

async function findUnreadableProfileAttachments(session: AgentSession): Promise<string[]> {
  const attachments = collectSessionAttachments(session);
  const failures: string[] = [];
  for (const attachment of attachments) {
    if (attachment.type !== "file_ref") continue;
    const resolvedPath = path.isAbsolute(attachment.path)
      ? attachment.path
      : path.resolve(session.project_path, attachment.path);
    try {
      await assertPathInsideProject(session.project_path, resolvedPath);
      await access(resolvedPath);
    } catch {
      failures.push(`- 无法读取附件：${attachment.path}（${attachment.display_name}）`);
    }
  }
  return failures;
}

function collectRecentAssistantContext(messages: AgentMessage[]): string {
  return messages
    .filter((message) => message.role === "assistant" && isMeaningfulAgentText(message.content))
    .slice(-6)
    .map((message) => message.content)
    .join("\n\n")
    .slice(-12_000);
}

function appendBoundedAssistantContext(current: string, next: string): string {
  if (!isMeaningfulAgentText(next)) return current;
  return [current, next].filter(Boolean).join("\n\n").slice(-12_000);
}

export function buildCompletionContinuationContext(
  incompleteReasons: string[],
  partialTranscript: string,
  recoveredFromPostResultCrash = false
): string {
  return [
    "## 这是同一任务的续跑，不是新任务",
    recoveredFromPostResultCrash
      ? "上一轮 SDK 已经返回 success，只是在清理子进程时崩溃；上一轮分析、工具结果、任务树和探索工作记忆全部有效。"
      : "上一轮已经完成的分析、工具结果、任务树和探索工作记忆全部有效。",
    "以当前知识雪球为准，不要把本轮当成新任务。",
    "续跑时以当前探索工作记忆为首要认知，不以最后一段助手回复或任务树标签代替它：",
    "1. 先对照 checkpoint 和当前工作区，识别 checkpoint 之后的新事实或状态变化；",
    "2. 若存在新结果，先调用 checkpoint_exploration 归并，再启动 Task/Bash/修改/任务状态推进；",
    "3. 从工作记忆中最重要的未解决问题选择下一步，再映射到第一个 dependency-ready 节点；",
    "4. 根据当前缺失信息选择一个最小行动；需要工具时正常调用，不需要时不要调用。",
    "",
    "## 宿主完成闸门未通过",
    ...incompleteReasons.map((reason) => `- ${reason}`),
    "",
    partialTranscript ? `## 上一轮结论（作为续跑输入，不要重新获取）\n${partialTranscript.slice(-6000)}` : "",
    "",
    "当前回复不能作为任务完成。请立即继续执行剩余工作：维护 update_task_tree 和 checkpoint_exploration，完成实现与验证，",
    "并确保每个 completed 节点都包含真实工具输出或文件位置作为 evidence；最终审查通过后写入 disposition=complete 的 checkpoint。",
    "不要只输出下一步计划。"
  ].filter(Boolean).join("\n");
}

/**
 * A bounded observation window for a fresh SDK query or a sub-agent handoff.
 * It is intentionally placed after knowledge/task context: observations may
 * correct the snowball, but must not silently replace confirmed knowledge.
 */
export function buildExecutionProgressPromptSection(session: AgentSession): string {
  const checkpoint = getLatestExplorationCheckpoint(session);
  const start = checkpoint
    ? Math.min(checkpoint.observed_tool_call_count, session.tool_calls.length)
    : Math.max(0, session.tool_calls.length - 12);
  const calls = session.tool_calls
    .slice(start)
    .filter((toolCall) => !isExplorationControlTool(toolCall.tool))
    .slice(-12);
  const changes = (session.file_changes ?? []).slice(-12);
  if (calls.length === 0 && changes.length === 0) {
    return [
      "## 当前执行观察",
      "- 暂无尚待核对的工具执行或文件变更。"
    ].join("\n");
  }
  return [
    "## 当前执行观察（原始状态，不代替知识雪球）",
    `- 会话状态：${session.status ?? "unknown"}；当前阶段：${session.current_stage ?? "unknown"}`,
    ...calls.map((toolCall) => {
      const summary = sanitizeToolOutputSummary(toolCall.output_summary)?.slice(0, 300);
      const input = isPlainObject(toolCall.input) ? toolCall.input : {};
      return `- 工具 ${describeToolAttempt(toolCall.tool, input)} → ${toolCall.status}${toolCall.exit_code !== undefined ? ` / exit ${toolCall.exit_code}` : ""}${summary ? ` / ${summary}` : ""}`;
    }),
    ...changes.map((change) => `- 文件 ${change.operation}: ${change.path}`),
    "完成一个可独立认定的工作单元后，立即核对目标、实际结果、验证证据和新未知；核对结论写入 checkpoint 后才能推进下一项。"
  ].join("\n");
}

function sanitizeToolOutputSummary(outputSummary: string | undefined): string | undefined {
  if (!outputSummary) return undefined;
  if (
    /"type"\s*:\s*"image"|"base64"\s*:|data:image\/|iVBORw0KGgo|\/9j\/|JVBERi0/i.test(outputSummary)
    || /[A-Za-z0-9+/]{300,}={0,2}/.test(outputSummary)
  ) {
    return undefined;
  }
  return outputSummary.replace(/\s+/g, " ").trim().slice(0, 2_000);
}

function enrichImageReadEvidence(
  session: AgentSession,
  firstToolCallIndex: number,
  transcript: string
): void {
  if (
    !isMeaningfulAgentText(transcript)
    || !/(?:已(?:经)?(?:读取|查看|确认|获取|分析)|根据.+(?:确认|可见)|结论|包括[:：]|confirmed|identified|found)/i.test(transcript)
  ) {
    return;
  }
  const conclusion = transcript.replace(/\s+/g, " ").trim().slice(-4_000);
  for (const toolCall of session.tool_calls.slice(firstToolCallIndex)) {
    if (toolCall.tool !== "Read" || toolCall.status !== "completed" || !isPlainObject(toolCall.input)) continue;
    const filePath = optionalString(toolCall.input.file_path);
    if (!filePath || !/\.(?:png|jpe?g|webp|gif|bmp)$/i.test(filePath)) continue;
    if (toolCall.output_summary && sanitizeToolOutputSummary(toolCall.output_summary)) continue;
    toolCall.output_summary = `图片已成功读取；同轮助手结论（可能涵盖同批附件）：${conclusion}`;
  }
}

export function extractSdkTerminalError(messages: unknown[]): string | null {
  const terminal = [...messages].reverse().find(
    (message) => isPlainObject(message) && message.type === "result"
  );
  if (!isPlainObject(terminal)) return null;
  const subtype = typeof terminal.subtype === "string" ? terminal.subtype : "unknown";
  if (terminal.is_error !== true && subtype === "success") return null;

  const details = [
    typeof terminal.result === "string" ? terminal.result.trim() : "",
    Array.isArray(terminal.errors)
      ? terminal.errors.filter((item): item is string => typeof item === "string").join("; ")
      : ""
  ].filter(Boolean).join("; ");
  return details ? `${subtype}: ${details}` : `SDK result subtype=${subtype}`;
}

export function hasSuccessfulSdkTerminalResult(messages: unknown[]): boolean {
  const terminal = [...messages].reverse().find(
    (message) => isPlainObject(message) && message.type === "result"
  );
  return isPlainObject(terminal)
    && terminal.subtype === "success"
    && terminal.is_error !== true;
}

/** 从 SDK system/init 消息中提取运行时实际使用的模型名。 */
function captureEffectiveModelFromInitMessage(
  message: unknown,
  onModel: (model: string) => void
): void {
  if (!isPlainObject(message)) return;
  if (message.type !== "system" || message.subtype !== "init") return;

  // Agent SDK 0.1.x 的 SDKSystemMessage 把实际模型直接放在顶层。
  // 优先读取该字段；旧版/测试夹具的 data.models 仅作为兼容兜底。
  if (typeof message.model === "string" && message.model.trim()) {
    onModel(message.model.trim());
    return;
  }

  const data = isPlainObject(message.data) ? message.data : {};
  const models = Array.isArray(data.models) ? (data.models as Array<{ value?: string }>) : [];
  if (models.length === 0) return;
  const effective = typeof models[0].value === "string" ? models[0].value : "";
  if (effective) onModel(effective);
}

/**
 * Claude 子进程经常在已经产出具体 API 错误消息后，再以 code 1 退出。
 * 后者只是进程级包装；应优先展示并分类 SDK 消息里的真正原因。
 */
function preferSdkReportedError(sdkMessages: unknown[], processError: unknown): unknown {
  const sdkError = extractClaudeStageOutput(sdkMessages).error?.trim();
  if (!sdkError) return processError;
  const error = new Error(sdkError);
  error.name = processError instanceof Error ? processError.name : "ClaudeSdkError";
  return error;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError";
}

/** 检测 SDK 消息中是否包含 DSML 格式的工具调用标记（纯文本，非 tool_use content block） */
function hasDsmlContent(message: unknown): boolean {
  if (!isPlainObject(message)) return false;
  const msg = message as Record<string, unknown>;
  if (msg.type !== "assistant") return false;
  const inner = isPlainObject(msg.message) ? (msg.message as Record<string, unknown>) : undefined;
  const content = Array.isArray(inner?.content) ? inner!.content : [];
  // 先检查是否有真正的 tool_use block——如果有，那 DSML 标记可能是文档内容，不报警
  const hasToolUse = content.some((b: unknown) => isPlainObject(b) && (b as Record<string, unknown>).type === "tool_use");
  if (hasToolUse) return false;
  // 检查 text block 中是否包含 DSML 标记
  for (const block of content) {
    if (!isPlainObject(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      const text = block.text as string;
      if (/<\|DSML\|(?:tool_calls|invoke|parameter)>/i.test(text) ||
          /<\/\|DSML\|(?:tool_calls|invoke)>/i.test(text) ||
          /^\s*Calling:\s*$/m.test(text)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 检测工具名是否损坏（协议标记泄漏、MCP 前缀截断等）。返回面向模型的纠正提示。
 * SDK 对未知工具名会直接回 "No such tool available" 并绕过 canUseTool/PreToolUse，
 * 因此本检测在流处理（profile 查询循环）和参数校验（validateProfileToolInput）两处都调用。
 */
export function detectCorruptedToolName(toolName: string): string | null {
  if (/<\/?parameter\b/i.test(toolName) || /<\|DSML\|/i.test(toolName)) {
    return `工具名包含损坏的协议标记：${toolName}；请使用工具列表中的精确工具名重新发起`;
  }
  if (/update_task_tree/i.test(toolName) && toolName !== "mcp__ai_coder__update_task_tree") {
    return `任务树工具名损坏：${toolName}；请使用精确工具名 mcp__ai_coder__update_task_tree`;
  }
  if (/checkpoint_exploration/i.test(toolName) && toolName !== "mcp__ai_coder__checkpoint_exploration") {
    return `探索 checkpoint 工具名损坏：${toolName}；请使用精确工具名 mcp__ai_coder__checkpoint_exploration`;
  }
  return null;
}

/**
 * 在进入 SDK 工具实现前拦住明显损坏的工具协议和 Read 参数。
 * 不猜测或自动修复路径，避免把模型生成错误悄悄改成另一个有效文件。
 */
export async function validateProfileToolInput(
  toolName: string,
  toolInput: Record<string, unknown>,
  projectPath?: string,
  attachments: Attachment[] = [],
  _phase?: ExplorationPhase
): Promise<string | null> {
  const nameCorruption = detectCorruptedToolName(toolName);
  if (nameCorruption) return nameCorruption;
  if (toolName === "Bash") {
    const command = toolInput.command;
    if (typeof command !== "string" || !command.trim()) {
      return "Bash 缺少必需的 command 参数";
    }
    const protocolMarker = command.match(
      /<\/?parameter\b(?:[^>\r\n]*)>?|<\|DSML\|(?:tool_calls|invoke|parameter)>?|<\/\|DSML\|(?:tool_calls|invoke)>?/i
    )?.[0];
    if (protocolMarker) {
      return `Bash command 包含损坏的工具协议标记 ${protocolMarker}，已在执行前拒绝`;
    }
    if (/(?:^|\n)\s*<\/\s*$/.test(command)) {
      return "Bash command 末尾包含损坏的工具协议尾标 </，已在执行前拒绝";
    }
    if (/\bfind\b[\s\S]*?-name\s+["']\.(?:[cm]?[jt]sx?)["']/i.test(command)) {
      return "Bash find 的 -name 模式疑似丢失通配符（例如 \".ts\"）；请使用精确、完整的模式重新发起请求";
    }
    return null;
  }
  if (toolName !== "Read") return null;

  const filePath = toolInput.file_path;
  if (typeof filePath !== "string" || !filePath.trim()) {
    const suppliedKeys = Object.keys(toolInput);
    const keyHint = suppliedKeys.length > 0 ? `；收到字段：${suppliedKeys.join(", ")}` : "";
    return `Read 缺少必需的 file_path 参数${keyHint}`;
  }
  try {
    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(projectPath ?? process.cwd(), filePath);
    const normalizedPath = path.normalize(resolvedPath);
    if (normalizedPath.includes(`${path.sep}.ai-coder${path.sep}uploads${path.sep}`)) {
      const allowedAttachmentPaths = attachments.flatMap((attachment) => {
        if (attachment.type !== "file_ref" || !attachment.path) return [];
        return [path.normalize(
          path.isAbsolute(attachment.path)
            ? attachment.path
            : path.resolve(projectPath ?? process.cwd(), attachment.path)
        )];
      });
      if (allowedAttachmentPaths.length > 0 && !allowedAttachmentPaths.includes(normalizedPath)) {
        return [
          `Read 附件路径不在宿主精确清单：${filePath}。`,
          "禁止猜测 UUID、目录或页码；必须逐字复制以下路径之一：",
          ...allowedAttachmentPaths.map((allowedPath) => `- ${allowedPath}`)
        ].join("\n");
      }
    }
    await access(resolvedPath);
    return null;
  } catch {
    return `Read 目标文件不存在或不可访问：${filePath}`;
  }
}

function isSubprocessCrashError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /terminated by signal SIG(?:SEGV|ABRT|BUS|ILL)|signal SIG(?:SEGV|ABRT|BUS|ILL)/i.test(message);
}

function captureBoundedSdkStderr(target: string[], chunk: string): void {
  const sanitized = chunk
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\bsk-ant-[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/((?:ANTHROPIC_(?:API_KEY|AUTH_TOKEN)|CLAUDE_CODE_OAUTH_TOKEN)\s*[=:]\s*)\S+/gi, "$1[REDACTED]")
    .trim();
  if (!sanitized) return;
  target.push(sanitized);
  while (target.join("\n").length > 8_000 && target.length > 1) target.shift();
}

function formatSdkStderrSuffix(stderr: string[]): string {
  if (stderr.length === 0) return "";
  const tail = stderr.join("\n").replace(/\s+/g, " ").trim().slice(-600);
  return tail ? `；CLI stderr：${tail}` : "";
}

function enrichClaudeSdkProcessError(error: unknown, stderr: string[]): Error {
  const base = error instanceof Error ? error : new Error(String(error));
  const enriched = new Error(`${base.message}${formatSdkStderrSuffix(stderr)}`);
  enriched.name = base.name;
  return enriched;
}

function isServiceUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b503\b|no available workers|service temporarily unavailable/i.test(message);
}

function formatRetryDelay(delayMs: number): string {
  if (delayMs <= 0) return "立即";
  if (delayMs % 1_000 === 0) return `${delayMs / 1_000} 秒`;
  return `${delayMs} 毫秒`;
}

async function waitForAbortableDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  if (delayMs <= 0) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 判断 API 错误是否可重试。只对已知的瞬时性错误放行，未知错误不走重试。 */
function isRetriableApiError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  const message = error instanceof Error ? error.message : String(error);
  // 鉴权错误不可重试。
  if (/\b401\b/.test(message) || /\b403\b/.test(message)) return false;
  if (/authentication|unauthorized|invalid.*api.*key|\/login/i.test(message)) return false;
  // SDK 子进程在终态前崩溃时可用全新进程进行有限重试。成功终态后的崩溃由
  // hasSuccessfulSdkTerminalResult 单独处理，不会进入这里。
  if (isSubprocessCrashError(error)) return true;
  if (/exited with code|process exited/i.test(message)) return false;
  // 已知瞬时性错误：HTTP 状态码、限流、超时、网络中断
  if (/\b400\b/.test(message)) return true;
  if (/\b429\b/.test(message)) return true;
  if (/\b5\d{2}\b/.test(message)) return true;
  if (/rate.?limit|overloaded|too many requests/i.test(message)) return true;
  if (/timeout|timed.?out|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|network|fetch failed/i.test(message)) return true;
  // 兼容第三方 Anthropic Provider/模型在流式 JSON 行中途断开；Profile 循环会用新进程有限重试。
  if (
    /Unterminated string in JSON/i.test(message)
    || /Unexpected end of JSON input/i.test(message)
    || /JSON[^\n]*(?:unexpected EOF|unexpected end|end of input)/i.test(message)
  ) return true;
  return false;
}

interface ToolExecutionResult {
  toolUseId: string;
  exitCode?: number;
  executionSucceeded?: boolean;
  outputSummary?: string;
}

interface SdkToolUse {
  id: string;
  tool: string;
  input: Record<string, unknown>;
}

/** 提取 SDK assistant 消息里的标准 tool_use block，供审计兜底与测试使用。 */
export function extractSdkToolUses(message: unknown): SdkToolUse[] {
  if (!isPlainObject(message)) return [];
  const content = isPlainObject(message.message) ? message.message.content : undefined;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block): SdkToolUse[] => {
    if (!isPlainObject(block) || block.type !== "tool_use") return [];
    const id = String(block.id ?? block.tool_use_id ?? "");
    const tool = String(block.name ?? block.tool_name ?? "");
    if (!id || !tool) return [];
    return [{ id, tool, input: isPlainObject(block.input) ? block.input : {} }];
  });
}

/**
 * Agent SDK 将工具结果包装为 synthetic user message，并在 tool_use_result 中保留工具特有 JSON。
 * 测试/SDK 版本也可能只提供标准 tool_result block，故同时兼容两种形态。
 */
export function extractToolExecutionResult(message: unknown): ToolExecutionResult | null {
  if (!isPlainObject(message)) return null;
  const content = isPlainObject(message.message) ? message.message.content : undefined;
  const blocks = Array.isArray(content) ? content : [];
  const block = blocks.find((item) => isPlainObject(item) && item.type === "tool_result");
  const source = message.tool_use_result ?? block;
  if (!source) return null;
  const result = isPlainObject(source) ? source : {};
  const toolUseId = String(
    result.tool_use_id ?? result.toolUseId ?? (isPlainObject(block) ? block.tool_use_id ?? block.toolUseId : "") ?? ""
  );
  if (!toolUseId) return null;
  const exitCode = findExitCode(source) ?? findExitCode(block);
  const executionSucceeded = exitCode !== undefined
    ? exitCode === 0
    : inferToolExecutionSucceeded(message, source, block);
  const outputSummary = summarizeToolResult(source);
  return {
    toolUseId,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(executionSucceeded !== undefined ? { executionSucceeded } : {}),
    ...(outputSummary ? { outputSummary } : {})
  };
}

function inferToolExecutionSucceeded(message: Record<string, unknown>, source: unknown, block: unknown): boolean | undefined {
  const records = [message, source, block].filter(isPlainObject);
  if (records.some((record) => record.is_error === true || record.isError === true || record.interrupted === true)) return false;
  if (records.some((record) => record.is_error === false || record.isError === false || record.interrupted === false)) return true;
  // 收到标准 tool_result 且未标记错误，本身就是 SDK 对工具正常返回的确认。
  if (isPlainObject(block) && block.type === "tool_result") return true;
  return undefined;
}

export function describeToolAttempt(toolName: string, toolInput: Record<string, unknown>): string {
  const raw = toolName === "Bash"
    ? String(toolInput.command ?? "")
    : String(toolInput.file_path ?? toolInput.path ?? "");
  const summary = raw.replace(/\s+/g, " ").trim();
  return `${toolName}${summary ? `: ${summary.slice(0, 220)}` : ""}`;
}

function findExitCode(value: unknown, depth = 0): number | undefined {
  if (depth > 4 || !isPlainObject(value)) return undefined;
  for (const key of ["exit_code", "exitCode", "return_code", "returnCode"]) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  for (const key of ["tool_response", "result", "content", "output"]) {
    const nested = value[key];
    for (const item of Array.isArray(nested) ? nested : [nested]) {
      const found = findExitCode(item, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function summarizeToolResult(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text || text === "{}") return undefined;
  return text.replace(/\s+/g, " ").trim().slice(0, 2_000);
}

function isSemanticallyFailedTaskResult(outputSummary: string | undefined): boolean {
  if (!outputSummary) return false;
  // 标准 tool_result block 会把子代理 JSON 放进 content 字符串，摘要中引号因此被转义。
  const normalized = outputSummary.replace(/\\"/g, "\"");
  return [
    /\bAPI Error:/i,
    /\bModel not found\b/i,
    /\bInputValidationError\b/i,
    /"status"\s*:\s*"(?:failed|error|blocked)"/i,
    /"is_error"\s*:\s*true/i
  ].some((pattern) => pattern.test(normalized));
}

function isNegativeReviewTaskResult(
  toolCall: AgentSession["tool_calls"][number],
  outputSummary: string | undefined
): boolean {
  if (!outputSummary || !isPlainObject(toolCall.input)) return false;
  const subagentType = optionalString(toolCall.input.subagent_type);
  const normalized = outputSummary.replace(/\\"/g, "\"");
  return isNegativeReviewText(subagentType, normalized);
}

function isNegativeReviewTaskMessage(
  toolCall: AgentSession["tool_calls"][number],
  message: unknown
): boolean {
  if (!isPlainObject(toolCall.input)) return false;
  const candidates: string[] = [];
  collectTextCandidates(message, candidates);
  return isNegativeReviewText(
    optionalString(toolCall.input.subagent_type),
    candidates.join("\n")
  );
}

function isNegativeReviewText(subagentType: string | undefined, text: string): boolean {
  if (subagentType === "task-verifier") {
    return /"verdict"\s*:\s*"FAIL"/i.test(text);
  }
  if (subagentType === "completeness-checker") {
    return [
      /"covered"\s*:\s*"(?:NO|UNCLEAR)"/i,
      /"(?:uncovered|unclear)"\s*:\s*[1-9]\d*/i,
      /"verdict"\s*:\s*"(?:FAIL|CONTINUE)"/i
    ].some((pattern) => pattern.test(text));
  }
  return false;
}

function isSemanticallyFailedTaskMessage(message: unknown): boolean {
  if (!isPlainObject(message)) return false;
  const source = isPlainObject(message.tool_use_result) ? message.tool_use_result : undefined;
  if (source) {
    const status = typeof source.status === "string" ? source.status.toLowerCase() : "";
    if (status === "failed" || status === "error" || status === "blocked") return true;
    const contentText = typeof source.content === "string"
      ? source.content
      : source.content === undefined
        ? ""
        : JSON.stringify(source.content);
    if (isSemanticallyFailedTaskResult(contentText)) return true;
  }
  const blocks = isPlainObject(message.message) && Array.isArray(message.message.content)
    ? message.message.content
    : [];
  const toolResultText = blocks
    .filter((block) => isPlainObject(block) && block.type === "tool_result")
    .map((block) => JSON.stringify(block))
    .join("\n");
  return isSemanticallyFailedTaskResult(toolResultText);
}

function isMutatingShellCommand(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const command = value
    .replace(/\b(?:\d*>)\s*\/dev\/null\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!command) return false;
  return [
    /(?:^|[;&|]\s*)git(?:\s+(?:-[cC]\s+\S+|--(?:git-dir|work-tree)=\S+))*\s+(?:add|am|apply|branch\s+(?:-[dDmM]|--delete|--move)|checkout|cherry-pick|clean|commit|merge|mv|pull|push|rebase|reset|restore|revert|rm|stash|switch|tag)\b/i,
    /(?:^|[;&|]\s*)(?:rm|mv|cp|install|mkdir|rmdir|touch|truncate|tee|patch)\b/i,
    /(?:^|[;&|]\s*)(?:sed|perl)\b[^;&|]*(?:\s-i(?:\s|$)|\s--in-place(?:[=\s]|$))/i,
    /(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+(?:add|install|remove|uninstall|update|upgrade)\b/i,
    /(?:^|[;&|]\s*)(?:cargo\s+(?:add|remove)|go\s+mod\s+(?:edit|tidy)|pip(?:3)?\s+install)\b/i,
    /(^|[^<])>>?(?![>&])/,
    /<<\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/
  ].some((pattern) => pattern.test(command));
}

function normalizeAssistantMessageContent(content: string): string {
  return content.trim().replace(/\s+/g, " ");
}

export function parseBestStageAgentResult(resultText: string, transcript: string, structuredOutput?: unknown): StageAgentResult {
  const candidates = [
    {
      text: formatStructuredOutput(structuredOutput),
      result: structuredOutput !== undefined ? parseStageAgentResult(formatStructuredOutput(structuredOutput)) : null
    },
    { text: resultText, result: resultText.trim() ? parseStageAgentResult(resultText) : null },
    { text: transcript, result: transcript.trim() ? parseStageAgentResult(transcript) : null }
  ].filter((candidate): candidate is { text: string; result: StageAgentResult } => candidate.result !== null);

  if (candidates.length === 0) {
    return parseStageAgentResult("");
  }

  return candidates.reduce((best, candidate) => (
    scoreStageResult(candidate.result) > scoreStageResult(best.result) ? candidate : best
  )).result;
}

export function buildClaudeSdkEnv(nodeEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...nodeEnv,
    // SDK 0.1.77 stops before consuming the result of the attempt that reaches
    // its limit. Leave enough headroom for a corrected final submission.
    MAX_STRUCTURED_OUTPUT_RETRIES: process.env.MAX_STRUCTURED_OUTPUT_RETRIES?.trim() || "10"
  };
}

function formatStructuredOutput(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

function scoreStageResult(result: StageAgentResult): number {
  switch (result.parse_diagnostics?.parse_strategy) {
    case "single_json_object":
      return 5;
    case "repaired_single_json_object":
      return 4;
    case "embedded_json":
      return 3;
    case "relaxed_fields":
      return 2;
    case "none":
    default:
      return 0;
  }
}

/**
 * 把一条 SDK 消息摘要成活动流可读的片段——assistant 文本前 80 字 / tool_use 工具名+关键参数，
 * 让实时活动流能看出"在干嘛"，而非只显示"收到 Claude SDK 消息：assistant"。
 *
 * SDK 消息结构假设与 extractClaudeStageOutput 一致：assistant message 的内容在
 * `message.message.content`（content blocks：text / tool_use）。
 */
export function describeSdkMessageSnippet(message: unknown): string {
  if (typeof message !== "object" || message === null) return "收到 Claude SDK 消息。";
  const msg = message as Record<string, unknown>;
  const type = typeof msg.type === "string" ? msg.type : "";

  if (type === "system" && msg.subtype === "init") {
    const model = typeof msg.model === "string" && msg.model.trim() ? msg.model.trim() : "未知";
    return `SDK 初始化：模型 ${model}`;
  }

  if (type === "assistant") {
    const inner = isPlainObject(msg.message) ? (msg.message as Record<string, unknown>) : undefined;
    const content = Array.isArray(inner?.content) ? inner!.content : [];
    const parts: string[] = [];
    for (const block of content) {
      if (!isPlainObject(block)) continue;
      if (block.type === "text" && typeof block.text === "string") {
        const snippet = block.text.replace(/\s+/g, " ").trim().slice(0, 500);
        if (snippet && !/^\(no content\)$/i.test(snippet)) parts.push(snippet);
      } else if (block.type === "tool_use") {
        const name = String(block.name ?? "unknown");
        parts.push(`请求 ${name}${describeToolInputSnippet(block.input)}`);
      }
    }
    return parts.length > 0 ? parts.join(" | ") : "助手消息（无文本）";
  }
  // Claude SDK 把每次工具返回包装为 user 消息；工具请求/结果已由专用审计流记录，
  // 再显示 SDK:user 只会制造几十条没有语义的活动噪声。
  if (type === "user") return "";
  if (type === "tool_result") return "工具结果";
  if (type === "result") {
    const subtype = typeof msg.subtype === "string" ? msg.subtype : "unknown";
    const suffix = msg.is_error === true ? "，错误" : "";
    return `SDK 查询结束：${subtype}${suffix}`;
  }
  return type ? `SDK:${type}` : "收到 Claude SDK 消息。";
}

export function formatSdkCatalogItem(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isPlainObject(value)) return String(value);
  for (const key of ["name", "id", "path", "type"] as const) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "未知";
  }
}

function describeToolInputSnippet(input: unknown): string {
  if (!isPlainObject(input)) return "";
  const filePath = input.file_path ?? input.path;
  if (typeof filePath === "string") return `(${filePath})`;
  const cmd = input.command;
  if (typeof cmd === "string") return `(${cmd.replace(/\s+/g, " ").trim().slice(0, 60)})`;
  return "";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMeaningfulSdkProgress(snippet: string): boolean {
  const trimmed = snippet.trim();
  if (!trimmed) return false;
  if (trimmed === "助手消息（无文本）") return false;
  if (trimmed === "收到 Claude SDK 消息。") return false;
  return true;
}

// ── 任务树 mutation 辅助类型与函数 ──

interface TaskTreeMutationArgs {
  action: "bootstrap" | "add" | "update_status";
  tasks?: { id: string; description: string; dependencies: string[]; acceptance?: string[] }[];
  goal_restated?: string;
  strategy?: string;
  new_tasks?: { id: string; description: string; dependencies: string[]; acceptance?: string[] }[];
  add_reason?: string;
  task_id?: string;
  new_status?: "in_progress" | "completed" | "blocked" | "skipped";
  status_reason?: string;
  evidence?: string;
  next_focus?: string;
  next_reason?: string;
}

function extractPlannerTaskTreeMutation(
  message: unknown,
  session: AgentSession
): TaskTreeMutationArgs | null {
  const candidates: string[] = [];
  collectTextCandidates(message, candidates);
  for (const text of candidates) {
    const jsonCandidates = [
      ...[...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1] ?? ""),
      text
    ];
    for (const candidate of jsonCandidates) {
      const parsed = parsePlannerJson(candidate);
      const tasks = normalizeTaskItems(parsed?.tasks);
      if (!tasks?.length) continue;
      return {
        action: "bootstrap",
        tasks,
        goal_restated: optionalString(parsed?.goal_restated) ?? (session.task_prompt.trim() || "完成用户请求"),
        strategy: optionalString(parsed?.strategy) ?? "采用 task-planner 输出的需求契约、影响地图与依赖 DAG",
        next_focus: pickDefaultFocusTaskId(tasks),
        next_reason: "从第一个依赖就绪的计划节点开始"
      };
    }
  }
  return null;
}

function collectTextCandidates(value: unknown, target: string[], depth = 0): void {
  if (depth > 8 || target.length > 200) return;
  if (typeof value === "string") {
    if (value.trim()) target.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTextCandidates(item, target, depth + 1);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const nested of Object.values(value)) {
    collectTextCandidates(nested, target, depth + 1);
  }
}

function parsePlannerJson(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function normalizeTaskTreeMutationArgs(value: unknown, session?: AgentSession): TaskTreeMutationArgs {
  if (!isPlainObject(value)) {
    throw new Error("任务树参数必须是对象");
  }
  const explicitAction = value.action;
  const action = explicitAction === "bootstrap" || explicitAction === "add" || explicitAction === "update_status"
    ? explicitAction
    : (value.task_id !== undefined || value.new_status !== undefined)
      ? "update_status"
      : value.new_tasks !== undefined
        ? "add"
      : value.tasks !== undefined
          ? "bootstrap"
          : session?.task_tree
            ? "update_status"
          : undefined;
  if (!action) throw new Error(`未知 action: ${String(explicitAction)}`);
  return {
    action,
    tasks: normalizeTaskItems(value.tasks),
    goal_restated: optionalString(value.goal_restated),
    strategy: optionalString(value.strategy),
    new_tasks: normalizeTaskItems(value.new_tasks),
    add_reason: optionalString(value.add_reason),
    task_id: optionalString(value.task_id),
    new_status: normalizeTaskStatus(value.new_status),
    status_reason: optionalString(value.status_reason),
    evidence: optionalString(value.evidence),
    next_focus: optionalString(value.next_focus),
    next_reason: optionalString(value.next_reason)
  };
}

function normalizePrematureTaskCompletion(
  session: AgentSession,
  args: TaskTreeMutationArgs
): TaskTreeMutationArgs {
  if (args.action !== "update_status" || args.new_status !== "completed" || !args.task_id) return args;
  const task = session.task_tree?.tasks.find((item) => item.id === args.task_id);
  if (task?.status !== "pending") return args;
  return {
    ...args,
    new_status: "in_progress",
    status_reason: "收到 pending→completed 请求；宿主先进入 in_progress，完成 executor/verifier 门禁后再标记 completed",
    evidence: undefined
  };
}

function repairIncompleteTaskStatusMutation(
  session: AgentSession,
  args: TaskTreeMutationArgs
): TaskTreeMutationArgs {
  if (args.action !== "update_status" || (args.task_id && args.new_status)) return args;
  const tree = session.task_tree;
  if (!tree) throw new Error("任务树尚未初始化，无法补齐 update_status");

  if (!args.task_id && !args.new_status) {
    const active = tree.tasks.filter((task) => task.status === "in_progress");
    if (active.length === 1) {
      return {
        ...args,
        task_id: active[0]!.id,
        new_status: "in_progress",
        status_reason: args.status_reason ?? `宿主安全补齐：当前唯一活动任务为 ${active[0]!.id}`
      };
    }
  }

  if (args.task_id && !args.new_status) {
    const task = tree.tasks.find((item) => item.id === args.task_id);
    if (!task) throw new Error(`任务 ${args.task_id} 不存在`);
    if (task.status === "pending" || task.status === "in_progress") {
      return {
        ...args,
        new_status: "in_progress",
        status_reason: args.status_reason ?? "宿主安全补齐：已指定任务但缺少状态，保持或进入 in_progress"
      };
    }
    throw new Error(`任务 ${args.task_id} 当前为 ${task.status}，无法安全推断 new_status`);
  }

  if (args.new_status && args.new_status !== "in_progress") {
    const active = tree.tasks.filter((task) => task.status === "in_progress");
    if (active.length === 1) {
      return {
        ...args,
        task_id: active[0]!.id,
        status_reason: args.status_reason ?? `宿主安全补齐：当前唯一活动任务为 ${active[0]!.id}`
      };
    }
    throw new Error(`缺少 task_id 时不能安全推断 ${args.new_status} 的目标任务；请明确提供 task_id 和 new_status`);
  }

  const dependencyReady = tree.tasks.filter((task) =>
    task.status === "pending"
    && task.dependencies.every((dependencyId) =>
      tree.tasks.some((dependency) => dependency.id === dependencyId && dependency.status === "completed")
    )
  );
  const focused = dependencyReady.find((task) => task.id === tree.current_focus);
  const candidate = focused ?? (dependencyReady.length === 1 ? dependencyReady[0] : undefined);
  if (!candidate) {
    if (dependencyReady.length > 1) {
      throw new Error(
        `同时有多个 dependency-ready 任务（${dependencyReady.map((task) => task.id).join(", ")}）；请明确提供 task_id 和 new_status`
      );
    }
    throw new Error("没有唯一可进入 in_progress 的 dependency-ready 任务；请明确提供 task_id 和 new_status");
  }
  return {
    ...args,
    task_id: candidate.id,
    new_status: "in_progress",
    status_reason: args.status_reason ?? `宿主安全补齐：唯一 dependency-ready 任务为 ${candidate.id}`
  };
}

/**
 * 模型在工具名损坏（如 mcp__ai_c__update_task_tree）或 SDK 拒绝后重试 bootstrap 时，
 * 常会丢掉 tasks 参数而只重发 action/goal_restated/strategy，导致执行卡在
 * "bootstrap 需要至少一个任务节点"。前序尝试携带的 tasks 已记录在 session.tool_calls，
 * 这里复用它们，让重试能真正建立任务树。
 */
function reusePriorBootstrapTasks(
  session: AgentSession,
  args: TaskTreeMutationArgs,
  currentToolUseID: string
): TaskTreeMutationArgs {
  if (args.action !== "bootstrap") return args;
  if (args.tasks && args.tasks.length > 0) return args;
  // 仅在尚未真正 bootstrap（只有 host-goal 占位）时复用，避免覆盖已建立的 DAG。
  const existingIsHostRoot = session.task_tree?.tasks.length === 1
    && session.task_tree.tasks[0]?.id === "host-goal";
  if (session.task_tree && !existingIsHostRoot) return args;

  for (let i = session.tool_calls.length - 1; i >= 0; i -= 1) {
    const prior = session.tool_calls[i];
    if (!prior || prior.id === currentToolUseID) continue;
    // 前序尝试的工具名可能本身已损坏（如 mcp__ai_c__update_task_tree），用宽松匹配。
    if (!/update_task_tree/i.test(prior.tool)) continue;
    const priorInput = isPlainObject(prior.input) ? prior.input : null;
    if (!priorInput || optionalString(priorInput.action) !== "bootstrap") continue;
    const priorTasks = normalizeTaskItems(priorInput.tasks);
    if (!priorTasks || priorTasks.length === 0) continue;
    return {
      ...args,
      tasks: priorTasks,
      goal_restated: args.goal_restated ?? optionalString(priorInput.goal_restated),
      strategy: args.strategy ?? optionalString(priorInput.strategy),
      next_focus: args.next_focus ?? optionalString(priorInput.next_focus),
      next_reason: args.next_reason ?? optionalString(priorInput.next_reason)
    };
  }
  return args;
}

function taskTreeMutationToToolInput(args: TaskTreeMutationArgs): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(([, value]) => value !== undefined)
  );
}

function normalizeTaskItems(value: unknown): TaskTreeMutationArgs["tasks"] {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return undefined;
    }
  }
  if (isPlainObject(candidate)) {
    const nested = candidate.items ?? candidate.tasks;
    if (Array.isArray(nested)) {
      candidate = nested;
    } else if (typeof candidate.id === "string") {
      candidate = [candidate];
    } else {
      candidate = Object.entries(candidate).map(([id, item]) => (
        isPlainObject(item) ? { id, ...item } : item
      ));
    }
  }
  if (!Array.isArray(candidate)) return undefined;
  const tasks = candidate.flatMap((item) => {
    if (!isPlainObject(item)) return [];
    const id = optionalString(item.id);
    const description = optionalString(item.description);
    if (!id || !description) return [];
    const dependencies = Array.isArray(item.dependencies)
      ? item.dependencies.filter((dependency): dependency is string => typeof dependency === "string")
      : typeof item.dependencies === "string" && item.dependencies.trim()
        ? item.dependencies.split(",").map((dependency) => dependency.trim()).filter(Boolean)
        : [];
    const acceptance: string[] | undefined = Array.isArray(item.acceptance)
      ? item.acceptance.filter((a): a is string => typeof a === "string" && a.trim() !== "").map((a) => a.trim())
      : undefined;
    return [{ id, description, dependencies, ...(acceptance && acceptance.length > 0 ? { acceptance } : {}) }];
  });
  return tasks.length > 0 ? tasks : undefined;
}

function normalizeTaskStatus(value: unknown): TaskTreeMutationArgs["new_status"] {
  return value === "in_progress" || value === "completed" || value === "blocked" || value === "skipped"
    ? value
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function repairConcurrentProfileTasks(session: AgentSession): string | null {
  const tree = session.task_tree;
  if (!tree) return null;
  const active = tree.tasks.filter((task) => task.status === "in_progress");
  if (active.length <= 1) return null;
  const dependencyReady = active.filter((task) =>
    task.dependencies.every((dependencyId) =>
      tree.tasks.some((dependency) => dependency.id === dependencyId && dependency.status === "completed")
    )
  );
  const retained = dependencyReady.find((task) => task.id === tree.current_focus)
    ?? dependencyReady[0]
    ?? active.find((task) => task.id === tree.current_focus)
    ?? active[0]!;
  for (const task of active) {
    if (task.id === retained.id) continue;
    task.status = "pending";
    task.status_reason = `宿主修复：等待 ${retained.id} 完成后串行执行`;
  }
  tree.current_focus = retained.id;
  tree.focus_reason = "宿主修复了旧会话中的并发活动节点，按单节点模式继续";
  tree.updated_at = new Date().toISOString();
  return `任务树检测到 ${active.length} 个 in_progress，已保留 ${retained.id} 并将其余节点恢复为 pending。`;
}

function startCurrentProfileTask(session: AgentSession): string | null {
  const tree = session.task_tree;
  if (!tree) return null;
  if (tree.tasks.some((item) => item.status === "in_progress")) return null;
  const focusedTask = tree.tasks.find((item) => item.id === tree.current_focus);
  const task = (focusedTask?.status === "pending" ? focusedTask : undefined)
    ?? tree.tasks.find((item) =>
      item.status === "pending"
      && item.dependencies.every((dependencyId) =>
        tree.tasks.some((dependency) => dependency.id === dependencyId && dependency.status === "completed")
      )
    );
  if (!task || task.status !== "pending") return null;
  task.status = "in_progress";
  task.status_reason = "委托 Task 子代理时由宿主自动开始";
  tree.current_focus = task.id;
  tree.updated_at = new Date().toISOString();
  return `${task.id} → in_progress`;
}

/**
 * 选默认 current_focus：优先首个无依赖的入口任务，与 startCurrentProfileTask 的兜底一致。
 * 不能直接取 tasks[0]--它可能依赖未完成的节点，而 startCurrentProfileTask 的聚焦分支
 * 不校验依赖，会把带未完成依赖的 tasks[0] 直接标 in_progress，跳过 DAG 顺序。
 * 合法 DAG 必存在至少一个无依赖节点，故 find 命中；tasks[0] 仅作兜底。
 */
function pickDefaultFocusTaskId(tasks: { id: string; dependencies: string[] }[]): string | undefined {
  return tasks.find((t) => t.dependencies.length === 0)?.id ?? tasks[0]?.id;
}

function applyTaskTreeMutation(session: AgentSession, args: TaskTreeMutationArgs): string {
  const now = new Date().toISOString();

  if (args.action === "bootstrap") {
    const existingIsHostRoot = session.task_tree?.tasks.length === 1
      && session.task_tree.tasks[0]?.id === "host-goal";
    if (session.task_tree && !existingIsHostRoot) {
      return formatTaskTreeResponse(session.task_tree, "任务树已存在，忽略重复 bootstrap");
    }
    if (!args.tasks || args.tasks.length === 0) {
      throw new Error(
        "bootstrap 需要 tasks 参数（至少一个任务节点）；请把 task-planner 刚产出的 DAG 作为 tasks 传入，不要重发空的 bootstrap"
      );
    }
    if (!args.goal_restated || !args.strategy) {
      throw new Error("bootstrap 需要 goal_restated 和 strategy；请同时提供这两项与 tasks");
    }
    const seen = new Set(args.tasks.map((t) => t.id));
    if (seen.size !== args.tasks.length) {
      throw new Error("任务 ID 重复");
    }
    for (const t of args.tasks) {
      for (const dep of t.dependencies) {
        if (!seen.has(dep)) {
          throw new Error(`任务 ${t.id} 依赖了不存在的任务 ${dep}`);
        }
      }
    }
    // 检测循环依赖：拓扑排序——能全部排完则无环
    if (!hasValidTopologicalOrder(args.tasks)) {
      throw new Error("任务依赖存在循环——无法确定执行顺序，请消除循环依赖");
    }
    const plannedTasks = appendFinalAuditTask(args.tasks);
    // next_focus 必须指向真实任务 id；模型重试时常会写出分支名等非任务标识。
    const focusIsRealTask = args.next_focus ? seen.has(args.next_focus) : false;
    const currentFocus = focusIsRealTask ? args.next_focus : pickDefaultFocusTaskId(args.tasks);
    // focus 被纠正时丢弃模型为原（无效）focus 写的 reason，避免理由与焦点不符。
    const focusReason = focusIsRealTask
      ? (args.next_reason ?? "从首个依赖就绪的计划节点开始")
      : "从首个依赖就绪的计划节点开始";
    session.task_tree = {
      tasks: plannedTasks.map((t) => ({
        id: t.id,
        description: t.description,
        dependencies: t.dependencies,
        ...(t.acceptance && t.acceptance.length > 0 ? { acceptance: t.acceptance } : {}),
        status: "pending" as const,
      })),
      goal_restated: args.goal_restated,
      strategy: args.strategy,
      current_focus: currentFocus,
      focus_reason: focusReason,
      created_at: now,
      updated_at: now,
    };
    const provenance = hasCompletedSubagent(session, "task-planner")
      ? "task-planner 计划已由宿主校验并接管"
      : "主 Agent 计划已由宿主降级校验并接管";
    return formatTaskTreeResponse(session.task_tree, `任务树已初始化（${provenance}）`);
  }

  if (!session.task_tree) {
    throw new Error("任务树尚未初始化，请先调用 action=bootstrap");
  }

  if (args.action === "add") {
    if (!args.new_tasks || args.new_tasks.length === 0) {
      throw new Error("add 需要 new_tasks");
    }
    const existing = new Set(session.task_tree.tasks.map((t) => t.id));
    for (const t of args.new_tasks) {
      if (existing.has(t.id)) {
        throw new Error(`任务 ID ${t.id} 已存在`);
      }
      existing.add(t.id);
      for (const dep of t.dependencies) {
        if (!existing.has(dep) && !args.new_tasks.some((nt) => nt.id === dep)) {
          throw new Error(`新任务 ${t.id} 依赖了不存在的任务 ${dep}`);
        }
      }
    }
    for (const t of args.new_tasks) {
      session.task_tree.tasks.push({
        id: t.id,
        description: t.description,
        dependencies: t.dependencies,
        ...(t.acceptance && t.acceptance.length > 0 ? { acceptance: t.acceptance } : {}),
        status: "pending",
      });
    }
    session.task_tree.updated_at = now;
    if (args.next_focus) {
      session.task_tree.current_focus = args.next_focus;
      session.task_tree.focus_reason = args.next_reason;
    }
    const reasonText = args.add_reason ? `（原因：${args.add_reason}）` : "";
    return formatTaskTreeResponse(session.task_tree, `已添加 ${args.new_tasks.length} 个任务节点${reasonText}`);
  }

  if (args.action === "update_status") {
    if (!args.task_id || !args.new_status) {
      throw new Error("update_status 需要 task_id 和 new_status");
    }
    const node = session.task_tree.tasks.find((t) => t.id === args.task_id);
    if (!node) {
      throw new Error(`任务 ${args.task_id} 不存在`);
    }
    if (node.status === args.new_status) {
      if (args.status_reason) node.status_reason = args.status_reason;
      if (args.evidence) node.evidence = args.evidence;
      session.task_tree.updated_at = now;
      return formatTaskTreeResponse(session.task_tree, `${args.task_id} 已是 ${args.new_status}`);
    }

    if (args.new_status === "in_progress") {
      const active = session.task_tree.tasks.find(
        (task) => task.status === "in_progress" && task.id !== node.id
      );
      if (active) {
        throw new Error(
          `当前任务 ${active.id} 正在执行；一次只能有一个 in_progress，请先完成或阻塞 ${active.id}`
        );
      }
    }

    // 校验状态迁移合法性
    const validTransitions: Record<string, string[]> = {
      pending: ["in_progress", "skipped"],
      in_progress: ["completed", "blocked"],
      completed: [],
      blocked: ["in_progress", "skipped"],
      skipped: [],
    };
    const allowed = validTransitions[node.status];
    if (!allowed || !allowed.includes(args.new_status)) {
      throw new Error(`不允许从 ${node.status} 迁移到 ${args.new_status}`);
    }

    if (args.new_status === "completed" && node.id === "host-final-audit") {
      if (!hasCompletedSubagentForTask(session, "completeness-checker", node.id)) {
        throw new Error("FINAL_AUDIT 门禁未通过：必须先成功运行 completeness-checker，并在调用中明确关联 host-final-audit");
      }
    } else if (args.new_status === "completed") {
      if (!hasCompletedSubagentForTask(session, "task-executor", node.id)) {
        throw new Error(`EXECUTE_ONE 门禁未通过：必须先成功运行 task-executor，并在调用中明确关联 ${node.id}`);
      }
      if (!hasCompletedSubagentForTask(session, "task-verifier", node.id)) {
        throw new Error(`VERIFY_ONE 门禁未通过：必须先成功运行 task-verifier，并在调用中明确关联 ${node.id}`);
      }
    }
    // 先报告 executor/verifier 门禁，使模型得到可执行的下一步；只有执行链完整后才要求 evidence。
    if (args.new_status === "completed" && !args.evidence) {
      throw new Error("标记 completed 必须提供 evidence（task-executor/task-verifier 的真实输出、验证命令输出或文件路径）");
    }

    // completed 时校验依赖：所有依赖必须先 completed
    if (args.new_status === "completed") {
      const incompleteDeps = node.dependencies.filter((depId) => {
        const dep = session.task_tree!.tasks.find((t) => t.id === depId);
        return !dep || dep.status !== "completed";
      });
      if (incompleteDeps.length > 0) {
        throw new Error(`不能完成 ${args.task_id}：依赖任务 ${incompleteDeps.join(", ")} 尚未完成`);
      }
    }

    node.status = args.new_status;
    node.status_reason = args.status_reason;
    if (args.evidence) node.evidence = args.evidence;
    session.task_tree.updated_at = now;
    if (args.next_focus) {
      session.task_tree.current_focus = args.next_focus;
      session.task_tree.focus_reason = args.next_reason;
    }
    return formatTaskTreeResponse(session.task_tree, `${args.task_id} → ${args.new_status}`);
  }

  throw new Error(`未知 action: ${args.action}`);
}

function appendFinalAuditTask(
  tasks: NonNullable<TaskTreeMutationArgs["tasks"]>
): NonNullable<TaskTreeMutationArgs["tasks"]> {
  if (tasks.some((task) => task.id === "host-final-audit")) return tasks;
  return [
    ...tasks,
    {
      id: "host-final-audit",
      description: "调用 completeness-checker 对全部 R-ID、最终 diff 和验证证据做独立完整性审计",
      dependencies: tasks.map((task) => task.id)
    }
  ];
}

function hasCompletedSubagent(session: AgentSession, subagentType: string): boolean {
  return session.tool_calls.some((toolCall) =>
    toolCall.tool === "Task"
    && toolCall.status === "completed"
    && isPlainObject(toolCall.input)
    && toolCall.input.subagent_type === subagentType
  );
}

function hasCompletedSubagentForTask(
  session: AgentSession,
  subagentType: string,
  taskId: string
): boolean {
  return session.tool_calls.some((toolCall) => {
    if (
      toolCall.tool !== "Task"
      || toolCall.status !== "completed"
      || !isPlainObject(toolCall.input)
      || toolCall.input.subagent_type !== subagentType
    ) {
      return false;
    }
    const assignment = [
      toolCall.input.description,
      toolCall.input.prompt,
      toolCall.input.task_id
    ].filter((value): value is string => typeof value === "string").join("\n");
    return new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(taskId)}([^A-Za-z0-9_-]|$)`).test(assignment);
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTaskTreePromptSection(tree: TaskTree): string {
  const statusIcon: Record<string, string> = {
    pending: "⏳",
    in_progress: "🔄",
    completed: "✅",
    blocked: "🚫",
    skipped: "⏭️",
  };
  const lines = [
    "## 当前任务树（由探索工作记忆派生的执行投影）",
    "",
    `目标：${tree.goal_restated}`,
    `策略：${tree.strategy}`,
    "",
    "任务节点：",
  ];
  for (const t of tree.tasks) {
    const icon = statusIcon[t.status] ?? "❓";
    const focus = t.id === tree.current_focus ? " ← 当前聚焦" : "";
    const evidence = t.evidence ? ` [证据: ${t.evidence.slice(0, 120)}]` : "";
    const deps = t.dependencies.length > 0 ? ` (依赖: ${t.dependencies.join(", ")})` : "";
    const reason = t.status_reason ? ` — ${t.status_reason}` : "";
    const acceptance = t.acceptance && t.acceptance.length > 0
      ? `\n      验收: ${t.acceptance.slice(0, 3).map((a) => a.slice(0, 100)).join(" | ")}${t.acceptance.length > 3 ? ` (+${t.acceptance.length - 3})` : ""}`
      : "";
    lines.push(`  ${icon} ${t.id}: ${t.description}${deps}${evidence}${reason}${acceptance}${focus}`);
  }
  if (tree.current_focus && tree.focus_reason) {
    lines.push("", `当前聚焦：${tree.current_focus}——${tree.focus_reason}`);
  }
  lines.push(
    "",
    "操作规则：",
    "- 先从探索工作记忆确定要关闭的未知或要验证的结论，再选择对应节点",
    "- 开始任务：update_task_tree(action=\"update_status\", task_id=\"tN\", new_status=\"in_progress\", next_focus=\"tN\", next_reason=\"开始执行\")",
    "- 委托执行：Task({ subagent_type: \"task-executor\", ... }) → checkpoint 归并实现结果 → Task(task-verifier)",
    "- 完成任务：verifier PASS → checkpoint 归并验证结论 → update_task_tree(action=\"update_status\", task_id=\"tN\", new_status=\"completed\", evidence=\"真实验证输出\", next_focus=\"下一节点\", next_reason=\"当前节点已验证\")",
    "- 如果发现当前任务需要先做其他事，加新节点并声明依赖",
    "- 始终让 next_focus 指向你正在做或即将做的任务"
  );
  return lines.join("\n");
}

function buildPhaseTaskTreePromptSection(tree: TaskTree): string {
  const task = tree.tasks[0];
  if (!task) return "";
  return [
    "## 当前阶段任务（知识雪球的执行投影）",
    `- ${task.id}: ${task.description}`,
    `- 状态：${task.status}`,
    "这不是全局计划。只落实这一项；获得结果后更新 checkpoint_exploration，宿主会按新的 next_action 自动替换阶段任务。",
    "完成这一项后先核对：目标是否满足、证据是否对应、验证是否通过、是否产生新未知。未完成核对不得更换 next_action 或开始下一项。",
    "不要为维护任务树本身调用 update_task_tree。"
  ].join("\n");
}

export function buildExplorationPromptSection(session: AgentSession): string {
  const checkpoint = getLatestExplorationCheckpoint(session);
  if (!checkpoint) return "";
  return [
    `## 当前探索工作记忆（revision ${checkpoint.revision} / ${checkpoint.disposition}）`,
    `进度标签：${checkpoint.phase ?? phaseFromDisposition(checkpoint.disposition)}（仅描述状态，不限制工具）`,
    "",
    checkpoint.text,
    "",
    checkpoint.next_action ? `记录的下一步：${checkpoint.next_action}` : "",
    "",
    "这是一份持续滚动的知识雪球。`## 已确认` 中的既有条目会自动继承，禁止静默删除；发现错误时新增带证据的“校正：旧结论 → 新结论”。",
    "知识雪球至少维护：用户目标与范围、宿主精确输入资源路径及派生关系、最相似既有实现（位置、可复用模式、与本需求的差异）、仓库/分支/基线、带证据的代码事实、已做改动、验证结果、校正记录、仍缺少的信息和唯一下一步。无同类参照时必须记录搜索范围。不要记录无结论的工具流水账。",
    "每完成一个调查结论、实现单元、独立需求点或验证动作，立即做四项核对：原目标、实际结果、验证证据、新未知。只有核对通过并写入本知识雪球，才把该项标为已完成并推进 next_action。",
    "取得重要证据、完成实现或验证、审查产生新问题、改变方向或准备结束时，调用 checkpoint_exploration 更新；过程可压缩，确认项不可丢失。",
    "不要仅在回复文本中声称已更新；只有 checkpoint_exploration 成功写入才会进入恢复状态和完成门禁。"
  ].filter(Boolean).join("\n");
}

/** 拓扑排序检测循环依赖：能全部排完返回 true；存在循环返回 false */
function hasValidTopologicalOrder(tasks: { id: string; dependencies: string[] }[]): boolean {
  const idSet = new Set(tasks.map((t) => t.id));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const t of tasks) {
    inDegree.set(t.id, 0);
    adjacency.set(t.id, []);
  }
  for (const t of tasks) {
    for (const dep of t.dependencies) {
      if (!idSet.has(dep)) continue; // 不存在的依赖已在前置校验中拦截
      adjacency.get(dep)!.push(t.id);
      inDegree.set(t.id, (inDegree.get(t.id) ?? 0) + 1);
    }
  }
  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  let sorted = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted += 1;
    for (const neighbor of adjacency.get(node) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }
  return sorted === tasks.length;
}

function formatTaskTreeResponse(tree: TaskTree, header: string): string {
  const statusIcon: Record<string, string> = {
    pending: "⏳",
    in_progress: "🔄",
    completed: "✅",
    blocked: "🚫",
    skipped: "⏭️",
  };
  const lines = [header, "", `目标：${tree.goal_restated}`, `策略：${tree.strategy}`, ""];
  for (const t of tree.tasks) {
    const icon = statusIcon[t.status] ?? "❓";
    const focus = t.id === tree.current_focus ? " ← 当前聚焦" : "";
    const evidence = t.evidence ? ` [证据: ${t.evidence.slice(0, 80)}]` : "";
    const deps = t.dependencies.length > 0 ? ` (依赖: ${t.dependencies.join(", ")})` : "";
    const acceptance = t.acceptance && t.acceptance.length > 0 ? ` [验收${t.acceptance.length}条]` : "";
    lines.push(`${icon} ${t.id}: ${t.description}${deps}${evidence}${acceptance}${focus}`);
  }
  if (tree.current_focus && tree.focus_reason) {
    lines.push(`\n当前聚焦：${tree.current_focus}——${tree.focus_reason}`);
  }
  return lines.join("\n");
}

import { randomUUID } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage, AgentSession, Attachment, HumanQuestion, HumanQuestionOption, SessionProgressEvent, StageAgentResult, TaskTree, WorkflowStage, WorkflowTemplate } from "../../shared/types.js";
import { isMeaningfulAgentText } from "../../shared/agentMessages.js";
import { analyzeSymbolContract } from "../analysis/symbolContractAnalyzer.js";
import {
  approveOrDenyToolUse,
  assertPathInsideProject,
  buildAllowedClaudeTools,
  buildDisallowedClaudeTools
} from "../security/projectPolicy.js";
import { WorkflowEngine } from "../workflows/workflowEngine.js";
import { buildStageInstructions } from "./workflowPrompt.js";
import { buildStageOutputFormat } from "./stageOutputFormat.js";
import { evaluateHook, checkCommandSafety } from "./stageHookEnforcer.js";
import { buildStageAgentInput, createMockStageAgentResult, parseStageAgentResult } from "./stageAgentProtocol.js";
import { extractClaudeStageOutput, formatClaudeTranscript } from "./claudeMessageAdapter.js";
import { resolveNodeExecutable, shouldUseClaudeSdk } from "./claudeRuntime.js";

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

export class ClaudeAgentRunner {
  private readonly workflowEngine = new WorkflowEngine();
  private readonly maxStageIterations = 50;
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly activeRuns = new Map<string, Promise<AgentSession>>();
  private readonly pendingToolApprovals = new Map<string, Map<string, PendingToolApproval>>();
  private readonly options: ClaudeAgentRunnerOptions;
  private resolvedEffectiveModel: string | null = null;

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

    // Profile 模式：workflow 无阶段管线，单次 query() 完成整个 session
    if (input.workflow.stages.length === 0) {
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

  private async runProfileMode(input: AgentRunInput): Promise<AgentSession> {
    input.session.status = "running";
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
    const taskTreeBootstrapped = ensureProfileTaskTree(input.session);
    const taskTreeRepair = repairConcurrentProfileTasks(input.session);
    await input.onProgress?.(input.session);
    if (taskTreeBootstrapped) {
      await this.recordProgress(input, "status", "宿主已建立 Profile 根任务，等待执行与验证证据。", "milestone");
    }
    if (taskTreeRepair) {
      await this.recordProgress(input, "status", taskTreeRepair, "milestone");
    }

    const abortController = new AbortController();
    this.abortControllers.set(input.session.id, abortController);
    const completedToolCache = new Map<string, { outputSummary?: string; exitCode?: number }>();
    this.saveCompletedToolsToCache(input.session, completedToolCache);
    const persistedEvidenceCache = new Map(completedToolCache);
    const maxProfileQueries = 24;
    const maxRuntimeFollowUpQueries = 8;
    let profileQueryLimit = maxProfileQueries;
    const maxStalledQueries = 3;
    const maxSubprocessCrashRetries = 2;
    let stalledQueries = 0;
    let subprocessCrashRetries = 0;
    let consecutiveServiceUnavailableFailures = 0;
    let recentAssistantContext = collectRecentAssistantContext(input.session.messages);
    let continuationContext = persistedEvidenceCache.size > 0
      ? buildCompletionContinuationContext(
          evaluateProfileCompletion(input.session),
          recentAssistantContext,
          persistedEvidenceCache,
          false
        )
      : "";

    try {
      for (let attempt = 0; attempt < profileQueryLimit; attempt += 1) {
        const queuedBeforeQuery = await this.takeQueuedUserMessages(input);
        if (queuedBeforeQuery.length > 0) {
          continuationContext = [
            buildQueuedUserMessageContext(queuedBeforeQuery),
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
          completedToolCache,
          attempt > 0 || Boolean(continuationContext),
          continuationContext
        );
        if (result.finalSession) return result.finalSession;

        const transcript = formatClaudeTranscript(result.sdkMessages);
        if (transcript) {
          enrichImageReadEvidence(input.session, result.preQueryTcCount, transcript);
          this.saveCompletedToolsToCache(input.session, completedToolCache);
          this.appendAssistantMessage(input.session, transcript);
          recentAssistantContext = appendBoundedAssistantContext(recentAssistantContext, transcript);
          await this.recordProgress(input, "runner", transcript, "milestone");
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
          this.saveCompletedToolsToCache(input.session, completedToolCache);
          const errorMessage = result.apiError instanceof Error
            ? result.apiError.message
            : String(result.apiError);
          const errorName = result.apiError instanceof Error
            ? result.apiError.name
            : typeof result.apiError;
          input.session.messages = input.session.messages.slice(0, result.preQueryMsgCount);
          input.session.tool_calls = input.session.tool_calls.slice(0, result.preQueryTcCount);
          input.session.status = "running";
          input.session.error = undefined;
          await this.recordProgress(input, "status", `API 调用失败：${errorMessage.slice(0, 120)}`, "milestone");
          continuationContext = buildLlmDecisionContext(
            errorName,
            errorMessage,
            transcript,
            completedToolCache
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
          this.saveCompletedToolsToCache(input.session, completedToolCache);
          continuationContext = buildQueuedUserMessageContext(queuedAfterQuery);
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

        const incompleteReasons = evaluateProfileCompletion(input.session);
        if (incompleteReasons.length === 0) {
          input.session.status = "completed";
          input.session.error = undefined;
          await this.recordProgress(input, "status", "Profile 模式执行完成（完成闸门已通过）", "milestone");
          return input.session;
        }

        this.saveCompletedToolsToCache(input.session, completedToolCache);
        continuationContext = buildCompletionContinuationContext(
          incompleteReasons,
          recentAssistantContext,
          completedToolCache,
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
            `连续 ${maxStalledQueries} 轮没有任务状态、非重复工具证据或文件改动，已暂停以避免空转。可使用断点恢复继续。`,
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

      const incompleteReasons = evaluateProfileCompletion(input.session);
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
    completedToolCache: Map<string, { outputSummary?: string; exitCode?: number }>,
    isLlmRetry: boolean,
    llmDecisionContext: string
  ): Promise<ProfileQueryResult> {
    const sdkMessages: unknown[] = [];
    const rewrittenToolInputs = new Map<string, Record<string, unknown>>();
    // 只把前序 query 的成功结果视为跨轮缓存；本轮刚完成的同名操作仍可能是合法复核。
    // 本轮并发重复由 inFlightToolKeys 单独拦截。
    const priorQueryToolKeys = new Set(completedToolCache.keys());
    const preQueryMsgCount = input.session.messages.length;
    const preQueryTcCount = input.session.tool_calls.length;
    // 运行时解析的有效模型只来自 SDK init；宿主不指定或切换模型。
    let effectiveModel = "";

    try {
      const query = await this.resolveQuery();
      const mcpServer = await this.resolveMcpServer(input);

      const skillIds = input.workflow.skills ?? [];
      const profileSkills = await this.loadProfileSkills(skillIds);
      if (!isLlmRetry) {
        for (const skill of profileSkills) {
          await this.recordProgress(input, "runner", `宿主强制加载 Skill：${skill.id}`, "milestone");
        }
      }

      const carefulCoderInstructions = this.buildProfileSystemPrompt(profileSkills, input.workflow.system_prompt, isLlmRetry ? effectiveModel : undefined);

      const taskPrompt = input.session.task_prompt ?? "";
      const humanQaHistory = (input.session.pending_human_questions ?? [])
        .filter((q) => q.status === "answered")
        .map((q) => `- 问：${q.question}\n  答：${Array.isArray(q.answer) ? q.answer.join(", ") : (q.answer ?? "")}`)
        .join("\n");

      const initialMessage = input.session.initial_user_message ?? input.session.messages.find((m) => m.role === "user");
      const sessionAttachments = collectSessionAttachments(input.session);
      const attachmentList = formatProfileAttachmentList(sessionAttachments);

      let instructions = [
        taskPrompt || "（无任务描述）",
        attachmentList ? `\n附件：\n${attachmentList}` : "",
        humanQaHistory ? `\n人类问答历史：\n${humanQaHistory}` : "",
        input.session.task_tree
          ? buildTaskTreePromptSection(input.session.task_tree)
          : ""
      ].filter(Boolean).join("\n\n");

      if (isLlmRetry && llmDecisionContext) {
        instructions = llmDecisionContext + "\n\n" + instructions;
      }

      await this.recordProgress(input, "runner", isLlmRetry ? "LLM 判断后继续执行（Profile 模式）" : "开始执行（Profile 模式）", "milestone");
      const nodeInfo = await resolveNodeExecutable();
      const sdkEnv = buildClaudeSdkEnv(nodeInfo?.env);

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
      const inFlightToolKeys = new Map<string, string>();
      const duplicateRequestsByKey = new Map<string, number>();
      const countedDuplicateToolUses = new Set<string>();
      let duplicateRequestTotal = 0;
      let duplicateVolumeWarned = false;
      const noteDuplicateRequest = async (
        cacheKey: string,
        toolUseID: string,
        reason: string
      ): Promise<string> => {
        const duplicateIdentity = toolUseID ? `${cacheKey}::${toolUseID}` : "";
        if (duplicateIdentity && countedDuplicateToolUses.has(duplicateIdentity)) return reason;
        if (duplicateIdentity) countedDuplicateToolUses.add(duplicateIdentity);
        const duplicateCount = (duplicateRequestsByKey.get(cacheKey) ?? 0) + 1;
        duplicateRequestsByKey.set(cacheKey, duplicateCount);
        duplicateRequestTotal += 1;
        if (duplicateRequestTotal >= 10 && !duplicateVolumeWarned) {
          duplicateVolumeWarned = true;
          const message = `本轮累计命中 ${duplicateRequestTotal} 个已完成工具；这些调用已逐项跳过，但不会暂停会话。`;
          await this.recordProgress(input, "status", message, "milestone");
          return `${reason} ${message}`;
        }
        if (duplicateCount === 3) {
          const message = `同一操作重复 ${duplicateCount} 次，本轮累计重复 ${duplicateRequestTotal} 次；本轮禁止再次调用，请使用已返回的结果或改做下一个任务。`;
          await this.recordProgress(input, "status", message, "milestone");
          return `${reason} ${message}`;
        }
        if (duplicateCount > 3) {
          return `${reason} 此操作本轮已被软熔断，禁止再次调用；请继续其他工作。`;
        }
        return reason;
      };
      const inspectToolUse = async (
        toolName: string,
        toolInput: Record<string, unknown>,
        toolUseID: string
      ): Promise<string | null> => {
        const cacheKey = makeToolCacheKey(toolName, toolInput);
        const canReuseCurrentQueryResult = ["Read", "Grep", "Glob", "LS"].includes(toolName);
        const cached = (
          priorQueryToolKeys.has(cacheKey)
          || (canReuseCurrentQueryResult && completedToolCache.has(cacheKey))
        )
          ? completedToolCache.get(cacheKey)
          : undefined;
        if (cached) {
          const safeSummary = safeCachedToolOutput(cached.outputSummary);
          const resultHint = safeSummary
            ? `前序结果：${safeSummary.slice(0, 1_200)}`
            : ["Read", "Glob", "Grep", "LS"].includes(toolName)
              ? "前序读取已成功；二进制或超大内容未重新注入"
              : `退出码：${cached.exitCode ?? 0}`;
          return noteDuplicateRequest(
            cacheKey,
            toolUseID,
            `此操作已在本会话中成功完成，无需重复执行。${resultHint}。请基于该结果继续。`
          );
        }
        const inFlightToolUseID = inFlightToolKeys.get(cacheKey);
        if (inFlightToolUseID && inFlightToolUseID !== toolUseID) {
          return noteDuplicateRequest(
            cacheKey,
            toolUseID,
            "相同工具调用仍在执行中，已跳过重复请求。请等待现有调用结果。"
          );
        }
        // 必须在第一个异步校验前原子占位，否则同一批并发 hook 会一起穿过检查。
        if (toolUseID) {
          inFlightToolKeys.set(cacheKey, toolUseID);
        }
        const validationError = await validateProfileToolInput(
          toolName,
          toolInput,
          input.session.project_path,
          sessionAttachments
        );
        if (validationError) {
          if (inFlightToolKeys.get(cacheKey) === toolUseID) {
            inFlightToolKeys.delete(cacheKey);
          }
          return validationError;
        }
        return null;
      };
      const reserveToolUse = (
        toolName: string,
        toolInput: Record<string, unknown>,
        toolUseID: string
      ): void => {
        if (toolUseID) {
          inFlightToolKeys.set(makeToolCacheKey(toolName, toolInput), toolUseID);
        }
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
          executable: nodeInfo?.command ?? undefined,
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
                const repeatsCompletedPlanner = hookToolName === "Task"
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
                if (activeProfileSubagents.size > 0 || !profileNeedsPlanning(input.session)) {
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
                  reserveToolUse(hookToolName, hookToolInput, hookToolUseID);
                  return { continue: true };
                }
                const plannerCompleted = hasCompletedSubagent(input.session, "task-planner");
                if (!plannerCompleted && hookToolName === "Task") {
                  const subagentType = optionalString(hookToolInput.subagent_type);
                  if (subagentType !== "task-planner") {
                    const updatedInput = await redirectTaskToPlanner(hookToolInput, hookToolUseID);
                    reserveToolUse(hookToolName, updatedInput, hookToolUseID);
                    return {
                      continue: true,
                      hookSpecificOutput: {
                        hookEventName: "PreToolUse",
                        permissionDecision: "allow",
                        updatedInput
                      }
                    };
                  }
                  reserveToolUse(hookToolName, hookToolInput, hookToolUseID);
                  return { continue: true };
                }
                if (
                  hookToolName === "Skill"
                  || (plannerCompleted && hookToolName === "mcp__ai_coder__update_task_tree")
                ) {
                  reserveToolUse(hookToolName, hookToolInput, hookToolUseID);
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
            const rootNeedsTaskDag = !options.agentID && profileNeedsPlanning(input.session);
            const plannerCompleted = hasCompletedSubagent(input.session, "task-planner");
            if (
              rootNeedsTaskDag
              && toolName !== "Skill"
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
              && !profileNeedsPlanning(input.session)
              && hasCompletedSubagent(input.session, "task-planner")
            ) {
              return {
                behavior: "deny",
                message: "task-planner 和任务树已经完成；这是续跑，不得重新规划。请从当前未完成节点继续。",
                interrupt: false
              };
            }
            const guardError = await inspectToolUse(toolName, toolInput, options.toolUseID);
            if (guardError) {
              await this.recordProgress(input, "tool_policy", `工具调用失败：${guardError}`, "milestone");
              return { behavior: "deny", message: guardError, interrupt: false };
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
              reserveToolUse(toolName, effectiveInput, options.toolUseID);
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
              if (profileNeedsPlanning(input.session) && !plannerCompleted) {
                if (!allowedSubagents.has("task-planner")) {
                  return {
                    behavior: "deny",
                    message: "宿主仍处于 PLAN 阶段，但当前工作流未声明 task-planner，无法安全继续。",
                    interrupt: false
                  };
                }
                if (subagentType !== "task-planner") {
                  const updatedInput = await redirectTaskToPlanner(toolInput, options.toolUseID);
                  reserveToolUse(toolName, updatedInput, options.toolUseID);
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
              const effectiveTaskInput = augmentTaskInputWithAttachmentManifest(toolInput, input.session);
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
              reserveToolUse(toolName, effectiveTaskInput, options.toolUseID);
              return { behavior: "allow", updatedInput: effectiveTaskInput };
            }
            if (
              toolName === "Skill" ||
              toolName === "mcp__ai_coder__ask_human" ||
              toolName === "mcp__ai_coder__analyze_symbol_contract"
            ) {
              reserveToolUse(toolName, toolInput, options.toolUseID);
              return { behavior: "allow" };
            }
            if (profileNeedsPlanning(input.session) && ["Edit", "Write", "NotebookEdit"].includes(toolName)) {
              return {
                behavior: "deny",
                message: "宿主仍处于 PLAN 阶段：task-planner 尚未产出详细任务 DAG，禁止修改文件。",
                interrupt: false
              };
            }
            if (profileNeedsPlanning(input.session) && toolName === "Bash" && isMutatingShellCommand(toolInput.command)) {
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
              reserveToolUse(toolName, decision.updatedInput, options.toolUseID);
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
                  reserveToolUse(toolName, approvedDecision.updatedInput, options.toolUseID);
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
              const needsPlanner = profileNeedsPlanning(input.session);
              const allowed = Object.keys(input.workflow.agents ?? {});
              const hint = needsPlanner && allowed.includes("task-planner")
                ? "当前处于 PLAN 阶段，请使用 subagent_type=task-planner"
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
        this.saveCompletedToolsToCache(input.session, completedToolCache);
        for (const [cacheKey, toolUseID] of inFlightToolKeys) {
          const recordedToolCall = input.session.tool_calls.find((toolCall) => toolCall.id === toolUseID);
          if (recordedToolCall?.resolved_at) {
            inFlightToolKeys.delete(cacheKey);
          }
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

  /** 将已成功执行的工具保存到跨重试缓存中 */
  private saveCompletedToolsToCache(
    session: AgentSession,
    cache: Map<string, { outputSummary?: string; exitCode?: number }>
  ): void {
    for (const tc of session.tool_calls) {
      if (tc.status === "completed" || (tc.exit_code === 0 && tc.status === "approved")) {
        const key = makeToolCacheKey(tc.tool, tc.input);
        const existing = cache.get(key);
        const existingSafeSummary = safeCachedToolOutput(existing?.outputSummary);
        const nextSafeSummary = safeCachedToolOutput(tc.output_summary);
        if (!existing || (nextSafeSummary && !existingSafeSummary)) {
          cache.set(key, { outputSummary: tc.output_summary, exitCode: tc.exit_code });
        }
      }
    }
  }

/** 构建 Profile 模式的系统提示词 */
  private buildProfileSystemPrompt(
    profileSkills: Array<{ id: string; content: string }>,
    workflowSystemPrompt?: string,
    effectiveModel?: string
  ): string {
    const modelSupportsImages = isModelMultimodal(effectiveModel ?? null);
    const languageGuidance = [
      "## 语言要求（最高优先级）",
      "**必须使用简体中文**进行所有思考、分析和回复。",
      "禁止使用英文输出任何解释、总结或分析。",
      "代码、命令、文件名等技术内容保持原文不变。",
      "违反此规则将导致任务失败。"
    ].join("\n");

    const reactGuidance = [
      "## 工具使用指引（ReAct 循环）",
      "",
      "你必须在 **思考→行动→观察** 循环中工作，直到任务完成：",
      "1. **分析**当前状态和已有信息",
      "2. **调用工具**执行下一步（Read、Bash、Task、Skill 等）",
      "3. **观察**工具返回结果，判断是否达成目标",
      "4. 如果未完成，**回到步骤 1** 继续；如果完成，总结并结束",
      "",
      "关键规则：",
      "- 每次只读你需要的内容，不要一次性读取所有文件",
      "- 读完工具输出后，你必须继续行动——不要停在第 1 步",
      "- 完成所有工作后，用一段清晰的总结收尾",
      "- 只调用工具列表中展示的精确工具名；禁止自行增删下划线、截断名称或把工具调用拼成普通文本",
      "- **调用工具时使用标准的 tool_use 格式，禁止使用 DSML 标记**（如 `<|DSML|tool_calls>`、`<|DSML|invoke>`、`Calling:` 等文本格式）"
    ].join("\n");

    const taskTreeGuidance = [
      "## 任务树驱动（贯穿全程的工作方式）",
      "",
      "你的行动必须由一个动态维护的**任务树**驱动。使用 `update_task_tree` MCP 工具：",
      "",
      "1. **启动**：task-planner 返回后，立即调用 `update_task_tree(action=\"bootstrap\")` 接管其 DAG；不要由主 Agent 再读一遍附件或代码。",
      "   - 每个子任务必须独立可验证——改不同文件、有不同验收标准",
      "   - 声明依赖关系：A 依赖 B 意味着 A 的输出是 B 的输入",
      "   - planner 已完成的需求提取、附件阅读和代码探索是计划证据，不得再创建“重新读需求/重新探索项目”节点",
      "2. **执行**：选定任务后，先调用 `update_task_tree(action=\"update_status\", task_id=\"tN\", new_status=\"in_progress\", next_focus=\"tN\", next_reason=\"开始执行该节点\")` 将其标为 in_progress，然后：",
      "   - **复杂子任务**：使用 `Task` 工具 spawn `task-executor` sub-agent 来执行",
      "     `Task({ subagent_type: \"task-executor\", description: \"执行 tN: <描述>\", prompt: \"项目路径: <path>\\n任务: <描述>\\n验收标准: <criteria>\\n已知上下文: ...\" })`",
      "     sub-agent 返回结构化 JSON（status + evidence）后，调用 `update_task_tree(action=\"update_status\", task_id=\"tN\", new_status=\"completed\", evidence=\"<真实验证输出>\", next_focus=\"<下一节点>\", next_reason=\"<原因>\")`",
      "   - **简单或已有证据的子任务**：仍按 `in_progress → task-executor → task-verifier → completed` 推进；把已有证据传给 Agent，明确禁止重新读取相同文件",
      "   - 一次只执行一个 dependency-ready 节点；当前节点完成并验证后再进入下一个，避免并发 Agent 重复读取或修改同一上下文",
      "3. **发现**：执行中发现新的必要工作时，调用 `update_task_tree(action=\"add\")` 加入新节点，说明为什么此时发现",
      "4. **声明下一步**：每次调用都必须填 `next_focus` 和 `next_reason`——始终清楚\"我现在聚焦哪个任务、为什么、完成后去哪\"",
      "",
      "关键规则：",
      "- 任务树是**执行控制器**，不是文档——工具调用时机取决于树的状态",
      "- completed 的证据必须来自真实的工具执行结果（或 sub-agent 返回的 evidence），不能编造",
      "- 简单任务可以只有一个任务节点，但必须在 strategy 中说明原因",
      "- 发现当前计划有误时，用 update_status 标 blocked/skipped 并说明原因，不要静默偏离",
      "- **上下文管理**：复杂子任务委托给 task-executor，主 Agent 只接收结构化结论——避免上下文膨胀"
    ].join("\n");

    return [
      languageGuidance,
      modelSupportsImages
        ? [
            "## 文件读取规则",
            "- 读取 PDF 时优先使用已拆页 PNG，避免 PDF base64 过大导致 API 400；必要时仍可自行选择其他工具",
            "- PDF 上传后已自动拆页；只能逐字使用当前提示中的“宿主精确附件清单”，不得推导目录、页码或替代路径",
            "- 每次只读取当前需要的页面，不要一次性读取所有页面",
            "- 图片已经可以直接用 Read 查看；禁止为了查看尺寸、base64 或图片文本再编写 Python/PIL 临时脚本",
            "",
            "### 附件 Read 失败处理（重要）",
            "- 如果按照“宿主精确附件清单”中列出的路径 Read 返回空内容或明显不完整：",
            "  1. 这是阻塞性问题——附件内容缺失意味着需求不完整，无法确认用户请求的具体范围",
            "  2. 立即停止尝试项目内其他路径或自行搜索同名/相似文件作为替代",
            "  3. 在 task-planner 的 blocking_unknowns 中写明哪个附件路径返回空、尝试了几次",
            "  4. 通过 ask_human 说明哪些附件无法读取，请求重新提供",
            "  5. 绝对不要：使用项目内碰巧存在的 img/、assets/ 等目录下的同名或相似文件作为需求来源"
          ].join("\n")
        : [
            "## 文件读取规则",
            "- 读取 PDF 时优先使用文本提取工具，避免 PDF base64 过大导致 API 400；必要时仍可自行选择其他工具",
            `- **当前模型（${effectiveModel || "默认"}）不支持图片输入**：请使用命令行文本工具提取 PDF 内容，例如 ` + "`pdftotext <pdf路径> -` 或 `python3 -c \"import PyPDF2; ...\"`",
            "- PDF 上传后已自动拆页；只能逐字使用当前提示中的“宿主精确附件清单”，并用文本工具而非 Read 获取内容",
            "",
            "### 附件 Read 失败处理（重要）",
            "- 如果按照“宿主精确附件清单”中列出的路径 Read 返回空内容或明显不完整：",
            "  1. 这是阻塞性问题——附件内容缺失意味着需求不完整，无法确认用户请求的具体范围",
            "  2. 立即停止尝试项目内其他路径或自行搜索同名/相似文件作为替代",
            "  3. 在 task-planner 的 blocking_unknowns 中写明哪个附件路径返回空、尝试了几次",
            "  4. 通过 ask_human 说明哪些附件无法读取，请求重新提供",
            "  5. 绝对不要：使用项目内碰巧存在的 img/、assets/ 等目录下的同名或相似文件作为需求来源"
          ].join("\n"),
      reactGuidance,
      taskTreeGuidance,
      workflowSystemPrompt ?? "",
      profileSkills.length > 0
        ? [
            "## 宿主强制加载的 Skills（执行契约）",
            "以下内容不是可选参考。必须在计划、任务状态、实现和验证证据中体现；无需再次调用 Skill 工具。",
            ...profileSkills.map((skill) => `\n### ${skill.id}\n${skill.content}`)
          ].join("\n")
        : ""
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

    // 跨重试的已完成工具结果缓存：key = `${toolName}::${normalizedInput}`
    const completedToolCache = new Map<string, { outputSummary?: string; exitCode?: number }>();

    for (let attempt = 0; attempt <= MAX_API_RETRIES; attempt++) {
      if (attempt > 0) {
        // 回滚前保存本轮已成功完成的工具结果到缓存
        for (const tc of input.session.tool_calls) {
          if (tc.status === "completed" || (tc.exit_code === 0 && tc.status === "approved")) {
            const cacheKey = makeToolCacheKey(tc.tool, tc.input);
            if (!completedToolCache.has(cacheKey)) {
              completedToolCache.set(cacheKey, {
                outputSummary: tc.output_summary,
                exitCode: tc.exit_code
              });
            }
          }
        }
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
      const nodeInfo = await resolveNodeExecutable();
      const sdkEnv = buildClaudeSdkEnv(nodeInfo?.env);

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
          executable: nodeInfo?.command ?? undefined,
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
              return { behavior: "allow" };
            }
            const cached = completedToolCache.get(makeToolCacheKey(toolName, toolInput));
            if (cached) {
              const resultHint = cached.outputSummary
                ? `结果摘要：${cached.outputSummary.slice(0, 500)}`
                : `退出码：${cached.exitCode ?? 0}`;
              await this.recordProgress(input, "tool_policy", `跳过重复工具（已缓存）：${toolName}`, "transient");
              return {
                behavior: "deny",
                message: `此操作已在前序尝试中成功完成，无需重复执行。${resultHint}。请基于该结果继续。`,
                interrupt: false
              };
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

  private async recordDiscoveredSkills(input: AgentRunInput, message: unknown): Promise<void> {
    if (!isPlainObject(message) || message.type !== "system" || message.subtype !== "init") return;
    const data = isPlainObject(message.data) ? message.data : {};
    const skills = Array.isArray(message.skills) ? message.skills : Array.isArray(data.skills) ? data.skills : [];
    const plugins = Array.isArray(message.plugins) ? message.plugins : Array.isArray(data.plugins) ? data.plugins : [];
    if (skills.length === 0 && plugins.length === 0) return;
    await this.recordProgress(
      input,
      "runner",
      `SDK 已发现 Plugins：${plugins.join(", ") || "无"}；Skills：${skills.join(", ") || "无"}`,
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
      );
    const duplicateWasSkipped = isSkippedDuplicateToolResult(result.outputSummary);
    if (result.exitCode !== undefined) {
      toolCall.exit_code = result.exitCode;
    } else if (toolCall.tool === "Bash" && result.executionSucceeded === true) {
      // Claude Agent SDK 的 Bash 成功结果通常只有 stdout/stderr/interrupted，未必提供 exit_code。
      // tool_result 已明确完成且没有错误/中断时，将其规范化为 0，供证据门槛使用。
      toolCall.exit_code = 0;
    }
    if (result.outputSummary) toolCall.output_summary = result.outputSummary;
    if (duplicateWasSkipped) {
      toolCall.status = "skipped";
      toolCall.resolved_at = new Date().toISOString();
    } else if (result.executionSucceeded === false || taskFailedSemantically) {
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
      return (createSdkMcpServer as (opts: { name: string; tools: unknown[] }) => unknown)({
        name: "ai_coder",
        tools: [askHumanTool, taskTreeTool, analyzeSymbolContractTool]
      });
    } catch {
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

/** 将已成功执行的工具保存到跨重试缓存中 */
function buildLlmDecisionContext(
  errorName: string,
  errorMessage: string,
  partialTranscript: string,
  completedToolCache: Map<string, { outputSummary?: string; exitCode?: number }>
): string {
  const parts: string[] = [];

  parts.push("## ⚠️ API 调用中断");
  parts.push(`上一次执行因 API 错误中断：**${errorName}**`);
  parts.push(`\`\`\`\n${errorMessage.slice(0, 500)}\n\`\`\``);

  if (completedToolCache.size > 0) {
    parts.push("## 已成功完成的工具（禁止重复执行）");
    for (const [key, result] of completedToolCache.entries()) {
      const [toolName, inputSnippet] = key.split("::", 2);
      const safeSummary = safeCachedToolOutput(result.outputSummary);
      const outputInfo = safeSummary
        ? ` → ${safeSummary.slice(0, 1_200)}`
        : (result.exitCode === 0 ? " → 执行成功" : "");
      parts.push(`- **${toolName}**(\`${inputSnippet.slice(0, 150)}\`)${outputInfo}`);
    }
  }

  if (partialTranscript) {
    parts.push("## 中断前的对话摘要");
    parts.push(partialTranscript.slice(0, 6000));
  }

  parts.push("## 你的决策");
  parts.push("请根据以上信息判断：");
  parts.push("1. **可以继续**：基于已完成的工具结果，换一种方式继续完成任务（例如用 pdftotext 代替读图）");
  parts.push("2. **无法继续**：如果已完成的工具结果不足以继续，简要说明原因，任务将标记为中断");
  parts.push("");
  parts.push("**⚠️ 工具调用格式要求（必读）**：调用工具时必须使用标准的 tool_use 格式，**绝对禁止**使用 DSML 标记（`<|DSML|tool_calls>`、`<|DSML|invoke>`、`Calling:` 等）。DSML 格式的工具调用会被忽略，导致任务失败。");

  return parts.join("\n\n");
}

export function evaluateProfileCompletion(session: AgentSession): string[] {
  const tree = session.task_tree;
  if (!tree || tree.tasks.length === 0) {
    return ["尚未建立任务树"];
  }

  const reasons: string[] = [];
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
  return reasons;
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
  const completedTools = [...new Set(
    session.tool_calls
      .filter((toolCall) => toolCall.status === "completed" || toolCall.exit_code === 0)
      .map((toolCall) => makeToolCacheKey(toolCall.tool, toolCall.input))
  )].sort();
  const fileChanges = [...new Set(
    session.file_changes.map((change) => `${change.operation}:${change.path}`)
  )].sort();
  return JSON.stringify({ taskState, completedTools, fileChanges });
}

export function formatProfileAttachmentList(attachments: Attachment[]): string {
  if (attachments.length === 0) return "";
  const entries = attachments.map((attachment) => {
    if (attachment.type === "file_ref") {
      return `- [可读取文件] ${attachment.path}（显示名: ${attachment.display_name}）`;
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
    ...session.messages.flatMap((message) => message.attachments ?? [])
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

function augmentTaskInputWithAttachmentManifest(
  toolInput: Record<string, unknown>,
  session: AgentSession
): Record<string, unknown> {
  const attachments = collectSessionAttachments(session);
  const manifest = formatProfileAttachmentList(attachments);
  const marker = "## 宿主精确附件清单";
  const evidenceMarker = "## 宿主可复用证据";
  const existingPrompt = optionalString(toolInput.prompt) ?? optionalString(toolInput.description) ?? "";
  const evidence = formatReusableAgentEvidence(session, attachments);
  if (
    (!manifest || existingPrompt.includes(marker))
    && (!evidence || existingPrompt.includes(evidenceMarker))
  ) {
    return toolInput;
  }
  return {
    ...toolInput,
    prompt: [
      existingPrompt,
      manifest && !existingPrompt.includes(marker) ? `${marker}\n${manifest}` : "",
      evidence && !existingPrompt.includes(evidenceMarker) ? `${evidenceMarker}\n${evidence}` : ""
    ].filter(Boolean).join("\n\n")
  };
}

/**
 * 给新 Agent 的通用证据胶囊。只移交安全的文字结论，不转发二进制/base64；
 * 若资源只被读取但尚无文字语义，明确要求重读原始注册路径，避免寻找替代副本。
 */
function formatReusableAgentEvidence(session: AgentSession, attachments: Attachment[]): string {
  const registeredPaths = resolveRegisteredResourcePaths(session.project_path, attachments);
  const entries: string[] = [];
  for (const toolCall of session.tool_calls) {
    if (toolCall.status !== "completed" && toolCall.exit_code !== 0) continue;
    if (toolCall.tool === "Task") {
      const summary = safeCachedToolOutput(toolCall.output_summary);
      if (summary) {
        const subagentType = isPlainObject(toolCall.input)
          ? optionalString(toolCall.input.subagent_type)
          : undefined;
        entries.push(`- Agent ${subagentType ?? "任务"}：${summary.slice(0, 1_500)}`);
      }
      continue;
    }
    if (toolCall.tool !== "Read" || !isPlainObject(toolCall.input)) continue;
    const filePath = optionalString(toolCall.input.file_path);
    if (!filePath) continue;
    const resolvedPath = path.resolve(session.project_path, filePath);
    if (!registeredPaths.has(path.normalize(resolvedPath))) continue;
    const summary = safeCachedToolOutput(toolCall.output_summary);
    entries.push(summary
      ? `- 注册资源 ${filePath}：${summary.slice(0, 1_500)}`
      : `- 注册资源 ${filePath} 已读取，但尚无可移交的文字语义；如确需内容，只能重读该原始注册路径，不得猜测、搜索或创建替代副本。`);
  }
  if (entries.length === 0) return "";
  return [
    "以下是前序工具或 Agent 已取得的证据。先复用，再做最小必要验证；不得把“读取成功”冒充为已理解内容。",
    ...entries.slice(-20)
  ].join("\n").slice(-10_000);
}

export function buildQueuedUserMessageContext(messages: AgentMessage[]): string {
  const entries = messages.map((message, index) => {
    const attachments = formatProfileAttachmentList(message.attachments ?? []);
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
  completedToolCache: Map<string, { outputSummary?: string; exitCode?: number }> = new Map(),
  recoveredFromPostResultCrash = false
): string {
  const completedEvidence = formatCompletedToolEvidence(completedToolCache);
  return [
    "## 这是同一任务的续跑，不是新任务",
    recoveredFromPostResultCrash
      ? "上一轮 SDK 已经返回 success，只是在清理子进程时崩溃；上一轮分析、工具结果和任务树全部有效。"
      : "上一轮已经完成的分析、工具结果和任务树全部有效。",
    "不得重新规划，不得从第一页或项目根目录重新勘察，不得换一个 preview/original 路径重复读取同一附件内容。",
    "在调用任何新的 Read/Grep/Glob/Bash/Task 前，先对照下方续跑证据：",
    "1. 若 pending 节点已被上一轮证据满足，先调用 update_task_tree 标记 in_progress；再把已有证据交给 task-executor 和 task-verifier，验证通过后才标记 completed，禁止直接跨状态；",
    "2. 若节点已是 in_progress 且已有证据，直接委托 task-executor/task-verifier 核对该证据，不要重读同一文件；",
    "3. 只有缺少完成当前节点所必需的具体证据时，才执行一个最小化的新工具调用；",
    "4. 从第一个真正未满足的 dependency-ready 节点继续，禁止再次调用 task-planner。",
    "",
    "## 宿主完成闸门未通过",
    ...incompleteReasons.map((reason) => `- ${reason}`),
    "",
    completedEvidence ? `## 已完成的跨轮工具证据（禁止重复勘察）\n${completedEvidence}` : "",
    "",
    partialTranscript ? `## 上一轮结论（作为续跑输入，不要重新获取）\n${partialTranscript.slice(-6000)}` : "",
    "",
    "当前回复不能作为任务完成。请立即继续执行剩余工作：维护 update_task_tree，完成实现与验证，",
    "并确保每个 completed 节点都包含真实工具输出或文件位置作为 evidence。",
    "不要重复已经完成的勘察，不要只输出下一步计划。"
  ].filter(Boolean).join("\n");
}

function formatCompletedToolEvidence(
  completedToolCache: Map<string, { outputSummary?: string; exitCode?: number }>
): string {
  const entries = [...completedToolCache.entries()].slice(-60);
  if (entries.length === 0) return "";
  return entries.map(([key, result]) => {
    const separator = key.indexOf("::");
    const toolName = separator >= 0 ? key.slice(0, separator) : key;
    const input = separator >= 0 ? key.slice(separator + 2) : "";
    const safeSummary = safeCachedToolOutput(result.outputSummary);
    const output = safeSummary
      ? ` → ${safeSummary.slice(0, 1_200)}`
      : result.exitCode === 0
        ? " → 成功"
        : "";
    return `- ${toolName} ${input.slice(0, 240)}${output}`;
  }).join("\n");
}

function safeCachedToolOutput(outputSummary: string | undefined): string | undefined {
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
    if (toolCall.output_summary && safeCachedToolOutput(toolCall.output_summary)) continue;
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

/** 将工具名和输入规范化为缓存键，用于跨重试的去重。 */
function makeToolCacheKey(toolName: string, toolInput: unknown): string {
  const normalized = isPlainObject(toolInput) ? normalizeToolInputForCache(toolInput) : JSON.stringify(toolInput);
  return `${toolName}::${normalized}`;
}

/** 从工具输入中提取稳定、有序的规范化字符串。忽略无关字段如 description。 */
function normalizeToolInputForCache(input: Record<string, unknown>): string {
  const relevant = Object.entries(input)
    .filter(([key]) => !["description", "timeout", "run_in_background", "dangerouslyDisableSandbox", "toolUseID"].includes(key))
    .map(([key, value]) => [
      key,
      key === "file_path" && typeof value === "string"
        ? path.normalize(value)
        : value
    ] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(relevant);
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
  attachments: Attachment[] = []
): Promise<string | null> {
  const nameCorruption = detectCorruptedToolName(toolName);
  if (nameCorruption) return nameCorruption;
  const resourceError = validateManagedResourceReference(toolName, toolInput, projectPath, attachments);
  if (resourceError) return resourceError;
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
    await access(resolvedPath);
    return null;
  } catch {
    return `Read 目标文件不存在或不可访问：${filePath}`;
  }
}

function resolveRegisteredResourcePaths(projectPath: string, attachments: Attachment[]): Set<string> {
  return new Set(attachments
    .filter((attachment): attachment is Extract<Attachment, { type: "file_ref" }> =>
      attachment.type === "file_ref"
    )
    .map((attachment) => path.normalize(path.isAbsolute(attachment.path)
      ? attachment.path
      : path.resolve(projectPath, attachment.path))));
}

/**
 * `.ai-coder/uploads` 是宿主管理的资源命名空间，不是可供 Agent 枚举或猜测的普通源码目录。
 * 工作区其他目录仍按 coding agent 的常规探索规则处理。
 */
function validateManagedResourceReference(
  toolName: string,
  toolInput: Record<string, unknown>,
  projectPath: string | undefined,
  attachments: Attachment[]
): string | null {
  if (!projectPath) return null;
  const managedRoot = path.normalize(path.resolve(projectPath, ".ai-coder", "uploads"));
  const registeredPaths = resolveRegisteredResourcePaths(projectPath, attachments);
  const isManaged = (candidate: string): boolean => {
    const normalized = path.normalize(path.isAbsolute(candidate)
      ? candidate
      : path.resolve(projectPath, candidate));
    return normalized === managedRoot || normalized.startsWith(`${managedRoot}${path.sep}`);
  };
  const isRegistered = (candidate: string): boolean => {
    const normalized = path.normalize(path.isAbsolute(candidate)
      ? candidate
      : path.resolve(projectPath, candidate));
    return registeredPaths.has(normalized);
  };
  const reject = (candidate: string): string =>
    `工具引用了不属于当前会话的已注册资源：${candidate}。宿主管理目录不可枚举、猜测或使用替代副本；请逐字使用“宿主精确附件清单”中的完整路径。`;

  if (["Read", "Grep", "Glob", "LS"].includes(toolName)) {
    for (const key of ["file_path", "path"]) {
      const candidate = optionalString(toolInput[key]);
      if (candidate && isManaged(candidate) && !isRegistered(candidate)) return reject(candidate);
    }
  }
  if (toolName !== "Bash") return null;
  const command = optionalString(toolInput.command);
  if (!command || !/(?:^|[\\/])\.ai-coder[\\/]uploads(?:[\\/]|$)/.test(command)) return null;
  const references = command.match(/(?:[A-Za-z]:)?[^\s"'`|;&<>]*[\\/]\.ai-coder[\\/]uploads[\\/][^\s"'`|;&<>]+/g)
    ?? command.match(/\.ai-coder[\\/]uploads[\\/][^\s"'`|;&<>]+/g)
    ?? [];
  if (references.length === 0) {
    return reject(".ai-coder/uploads");
  }
  for (const reference of references) {
    const cleaned = reference.replace(/[),\]}]+$/g, "");
    if (isManaged(cleaned) && !isRegistered(cleaned)) return reject(cleaned);
  }
  return null;
}

function isSubprocessCrashError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /terminated by signal SIG(?:SEGV|ABRT|BUS|ILL)|signal SIG(?:SEGV|ABRT|BUS|ILL)/i.test(message);
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
  // 兼容第三方 Anthropic Provider/模型在流式 JSON 行中途断开。此类错误通常保留了
  // 已完成工具结果；Profile 循环会回滚本轮记录、缓存成功工具并用新进程续跑。
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
  return [
    /\bAPI Error:/i,
    /\bModel not found\b/i,
    /\bInputValidationError\b/i,
    /"status"\s*:\s*"(?:failed|error|blocked)"/i,
    /"is_error"\s*:\s*true/i
  ].some((pattern) => pattern.test(outputSummary));
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

function isSkippedDuplicateToolResult(outputSummary: string | undefined): boolean {
  if (!outputSummary) return false;
  return /此操作已在本会话中成功完成，无需重复执行|相同工具调用仍在执行中，已跳过重复请求/.test(
    outputSummary
  );
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
    /(?:^|[;&|]\s*)(?:sed|perl)\s+[^;&|]*\s-i(?:\s|$)/i,
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
        if (snippet) parts.push(snippet);
      } else if (block.type === "tool_use") {
        const name = String(block.name ?? "unknown");
        parts.push(`请求 ${name}${describeToolInputSnippet(block.input)}`);
      }
    }
    return parts.length > 0 ? parts.join(" | ") : "助手消息（无文本）";
  }
  if (type === "tool_result") return "工具结果";
  if (type === "result") {
    const subtype = typeof msg.subtype === "string" ? msg.subtype : "unknown";
    const suffix = msg.is_error === true ? "，错误" : "";
    return `SDK 查询结束：${subtype}${suffix}`;
  }
  return type ? `SDK:${type}` : "收到 Claude SDK 消息。";
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
    "## 当前任务树（你的执行路线图——每次工具调用后审视是否需要更新）",
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
    "- 开始任务：update_task_tree(action=\"update_status\", task_id=\"tN\", new_status=\"in_progress\", next_focus=\"tN\", next_reason=\"开始执行\")",
    "- 委托执行：Task({ subagent_type: \"task-executor\", ... }) → 根据返回的 evidence 调 update_task_tree 标 completed",
    "- 完成任务：update_task_tree(action=\"update_status\", task_id=\"tN\", new_status=\"completed\", evidence=\"真实验证输出\", next_focus=\"下一节点\", next_reason=\"当前节点已验证\")",
    "- 如果发现当前任务需要先做其他事，加新节点并声明依赖",
    "- 始终让 next_focus 指向你正在做或即将做的任务"
  );
  return lines.join("\n");
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

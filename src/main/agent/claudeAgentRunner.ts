import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage, AgentSession, HumanQuestion, HumanQuestionOption, SessionProgressEvent, StageAgentResult, TaskTree, WorkflowStage, WorkflowTemplate } from "../../shared/types.js";
import { isMeaningfulAgentText } from "../../shared/agentMessages.js";
import {
  approveOrDenyToolUse,
  buildAllowedClaudeTools,
  buildDisallowedClaudeTools,
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
}

type ClaudeQuery = (params: unknown) => AsyncIterable<unknown>;
type ToolApprovalResolution = "approved" | "denied";

export interface ClaudeAgentRunnerOptions {
  queryOverride?: ClaudeQuery;
  pluginPaths?: string[];
}

interface ProfileQueryResult {
  sdkMessages: unknown[];
  preQueryMsgCount: number;
  preQueryTcCount: number;
  apiError?: unknown;
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

function isModelDeepSeek(model: string | undefined | null): boolean {
  if (!model) return false;
  return model.toLowerCase().includes("deepseek");
}

export class ClaudeAgentRunner {
  private readonly workflowEngine = new WorkflowEngine();
  private readonly maxStageIterations = 50;
  private readonly maxPdfPageImageReadsPerStage = 8;
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly pendingToolApprovals = new Map<string, Map<string, PendingToolApproval>>();
  private mcpServerCache: unknown | null = null;
  private activeSession: AgentSession | null = null;
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
    const toolCall = pending.session.tool_calls.find((item) => item.id === toolCallId && item.status === "pending_approval");
    if (toolCall) {
      toolCall.status = status;
      toolCall.resolved_at = new Date().toISOString();
      pending.session.status = status === "approved" ? "running" : "blocked";
    }
    pending.resolve(status);
    pendingForSession?.delete(toolCallId);
    // 顺带唤醒所有排队等待的其他工具：它们已在 projectPolicy 中以 pending_approval
    // 状态入队，但可能因并行调用被排在了同一个审批窗口后面。用户审批第一个工具后，
    // 所有排队的工具一并唤醒——它们重新走 approveOrDenyToolUse，届时若 auto_approve
    // 已开启或命令已命中自主安全白名单，则直接通过。
    if (status === "approved" && pendingForSession && pendingForSession.size > 0) {
      for (const [queuedId, queued] of pendingForSession) {
        const queuedCall = pending.session.tool_calls.find((item) => item.id === queuedId && item.status === "pending_approval");
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

  async run(input: AgentRunInput): Promise<AgentSession> {
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
    await input.onProgress?.(input.session);

    const abortController = new AbortController();
    this.abortControllers.set(input.session.id, abortController);

    // 跨重试的已完成工具结果缓存：key = `${toolName}::${normalizedInput}`
    // 当 API 错误后 LLM 决定重试时，已完成的工具结果不会丢失，
    // 后续若模型再次请求相同工具，canUseTool 会直接返回缓存结果，跳过重复审批和执行。
    const completedToolCache = new Map<string, { outputSummary?: string; exitCode?: number }>();

    // ── 第一次执行 ──
    const firstResult = await this.runProfileQuery(input, abortController, completedToolCache, false, "");
    if (firstResult.finalSession) return firstResult.finalSession;
    if (!firstResult.apiError) {
      // 正常完成或等待审批
      const transcript = formatClaudeTranscript(firstResult.sdkMessages);
      this.appendAssistantMessage(input.session, transcript);
      if (transcript) {
        await this.recordProgress(input, "runner", transcript, "milestone");
      }
      if (this.hasPendingToolCall(input.session) || this.hasPendingHumanQuestion(input.session)) {
        input.session.status = "waiting_approval";
        await this.recordProgress(input, "status", "等待审批或用户回答", "milestone");
      } else {
        input.session.status = "completed";
        await this.recordProgress(input, "status", "Profile 模式执行完成", "milestone");
      }
      return input.session;
    }

    // ── API 错误：保存已完成的工具，让 LLM 决定如何处理 ──
    this.saveCompletedToolsToCache(input.session, completedToolCache);
    const partialTranscript = formatClaudeTranscript(firstResult.sdkMessages);

    const errorMessage = firstResult.apiError instanceof Error
      ? firstResult.apiError.message
      : String(firstResult.apiError);
    const errorName = firstResult.apiError instanceof Error
      ? firstResult.apiError.name
      : typeof firstResult.apiError;

    // 回滚会话状态到查询前
    input.session.messages = input.session.messages.slice(0, firstResult.preQueryMsgCount);
    input.session.tool_calls = input.session.tool_calls.slice(0, firstResult.preQueryTcCount);
    input.session.error = undefined;
    input.session.status = "running";

    await this.recordProgress(input, "status", `API 调用失败：${errorMessage.slice(0, 120)}`, "milestone");
    await this.recordProgress(input, "status", "将错误信息呈现给 LLM，由其判断是否继续...", "milestone");

    // ── 第二次执行：让 LLM 根据错误决定下一步 ──
    // 检测运行的真实模型（session.model 可能为空/undefined，实际默认是系统级配置）：
    //   1. session.model 显式指定
    //   2. 第一次查询时从 SDK init 消息中捕获的有效模型
    //   3. API 错误消息中暴露的模型名（如 "DeepSeek-V4 is not a multimodal model"）
    const effectiveModel = firstResult.effectiveModel
      ?? input.session.model
      ?? this.resolvedEffectiveModel;
    const errorModelHint = /deepseek/i.test(errorMessage) ? "deepseek" : "";
    const isDeepSeek = isModelDeepSeek(effectiveModel)
      || isModelDeepSeek(errorModelHint);
    const retryModel = isDeepSeek ? "claude-sonnet-5" : (effectiveModel || "");
    if (isDeepSeek) {
      const reason = !effectiveModel
        ? "从 API 错误中检测到 DeepSeek"
        : effectiveModel !== input.session.model
          ? `当前模型 ${effectiveModel} 不支持多模态（API 错误提示），切换到 Claude`
          : "检测到 DeepSeek，切换到 Claude（避免 DSML 格式不兼容及多模态限制）";
      await this.recordProgress(input, "status", `${reason}，改用 ${retryModel} 重试`, "milestone");
    }
    const savedModel = input.session.model;
    input.session.model = retryModel;

    const secondResult = await this.runProfileQuery(
      input, abortController, completedToolCache, true,
      buildLlmDecisionContext(errorName, errorMessage, partialTranscript, completedToolCache)
    );

    // 恢复模型
    input.session.model = savedModel;

    // 清理
    if (this.abortControllers.get(input.session.id) === abortController) {
      this.abortControllers.delete(input.session.id);
    }

    if (secondResult.finalSession) return secondResult.finalSession;
    if (secondResult.apiError) {
      // LLM 重试也失败了
      const transcript = formatClaudeTranscript(secondResult.sdkMessages);
      if (transcript) this.appendAssistantMessage(input.session, transcript);
      const secondError = secondResult.apiError instanceof Error
        ? secondResult.apiError.message
        : String(secondResult.apiError);
      input.session.error = secondError;
      input.session.status = "interrupted";
      await this.recordProgress(input, "status", `LLM 重试后仍失败：${secondError.slice(0, 120)}`, "milestone");
      await this.recordProgress(input, "status", "你可以发送消息继续，或点击「断点恢复」重新执行", "milestone");
      return input.session;
    }

    // LLM 决定继续后正常完成
    const transcript = formatClaudeTranscript(secondResult.sdkMessages);
    this.appendAssistantMessage(input.session, transcript);
    if (transcript) {
      await this.recordProgress(input, "runner", transcript, "milestone");
    }
    if (this.hasPendingToolCall(input.session) || this.hasPendingHumanQuestion(input.session)) {
      input.session.status = "waiting_approval";
      await this.recordProgress(input, "status", "等待审批或用户回答", "milestone");
    } else {
      input.session.status = "completed";
      await this.recordProgress(input, "status", "Profile 模式执行完成", "milestone");
    }
    return input.session;
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
    const pdfPageImageReads = new Set<string>();
    const preQueryMsgCount = input.session.messages.length;
    const preQueryTcCount = input.session.tool_calls.length;
    // 运行时解析的有效模型：初始用 session.model，init 消息到达后更新
    let effectiveModel = input.session.model || "";

    this.activeSession = input.session;

    try {
      const query = await this.resolveQuery();
      const mcpServer = await this.resolveMcpServer();

      const skillIds = input.workflow.skills ?? [];
      const skillSummaries = await this.loadSkillSummaries(skillIds);
      if (!isLlmRetry) {
        for (const s of skillSummaries) {
          await this.recordProgress(input, "runner", `加载 Skill 摘要：${s.id}`, "milestone");
        }
      }

      const carefulCoderInstructions = this.buildProfileSystemPrompt(skillSummaries, input.workflow.system_prompt, isLlmRetry ? effectiveModel : undefined);

      const taskPrompt = input.session.task_prompt ?? "";
      const humanQaHistory = (input.session.pending_human_questions ?? [])
        .filter((q) => q.status === "answered")
        .map((q) => `- 问：${q.question}\n  答：${Array.isArray(q.answer) ? q.answer.join(", ") : (q.answer ?? "")}`)
        .join("\n");

      const initialMessage = input.session.initial_user_message ?? input.session.messages.find((m) => m.role === "user");
      const attachmentList = (initialMessage?.attachments ?? [])
        .map((a) => `- ${a.display_name ?? ("path" in a ? (a as { path: string }).path : "附件")}`)
        .join("\n");

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

      for await (const message of query({
        prompt: instructions,
        options: {
          model: input.session.model,
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
          tools: buildAllowedClaudeTools(input.workflow, undefined),
          disallowedTools: buildDisallowedClaudeTools(input.workflow),
          hooks: {
            PreToolUse: [{
              hooks: [async (hookInput: unknown) => {
                const hi = hookInput as { tool_name?: string; tool_input?: unknown };
                if (hi.tool_name === "Read") {
                  const ti = hi.tool_input as Record<string, unknown> | undefined;
                  const fp = String(ti?.file_path ?? ti?.path ?? "");
                  if (/\.pdf(?:$|[?#])/i.test(fp)) {
                    return {
                      continue: true,
                      hookSpecificOutput: {
                        hookEventName: "PreToolUse" as const,
                        permissionDecision: "deny" as const,
                        permissionDecisionReason: "请读取已拆页 PNG，不要直接 Read PDF。PDF base64 太大会导致 API 400 错误。"
                      }
                    };
                  }
                }
                return {
                  continue: true,
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    permissionDecision: "ask" as const,
                    permissionDecisionReason: "Route every tool through the host policy and audit callback."
                  }
                };
              }]
            }]
          },
          settingSources: ["user", "project", "local"],
          ...(Object.keys(sdkAgents).length > 0 ? { agents: sdkAgents } : {}),
          canUseTool: async (toolName: string, toolInput: Record<string, unknown>, options: { toolUseID: string }) => {
            if (toolName === "Task") {
              await this.recordProgress(input, "tool_policy", "允许 Task（sub-agent）调用", "transient");
              return { behavior: "allow" };
            }
            if (toolName === "Skill") {
              const skillName = String(toolInput.skill ?? toolInput.name ?? "unknown");
              this.appendAssistantMessage(input.session, `正在加载 Skill：\`${skillName}\``, "skill_usage");
              await this.recordProgress(input, "runner", `加载 Skill：${skillName}`, "milestone");
            }
            if (completedToolCache.size > 0) {
              const cacheKey = makeToolCacheKey(toolName, toolInput);
              const cached = completedToolCache.get(cacheKey);
              if (cached) {
                await this.recordProgress(input, "tool_policy", `跳过重复工具（已缓存）：${toolName}`, "transient");
                const resultHint = cached.outputSummary
                  ? `\n\n该工具已在上一次尝试中成功完成。结果摘要：\n${cached.outputSummary.slice(0, 500)}`
                  : "\n\n该工具已在上一次尝试中成功完成（退出码 0）。";
                return { behavior: "deny", message: `此操作已在前序尝试中完成，无需重复执行。${resultHint}\n\n请基于此结果继续，不要再次调用相同工具。`, interrupt: false };
              }
            }
            if (isPdfPageImageRead(toolName, toolInput)) {
              const filePath = String(toolInput.file_path ?? toolInput.path ?? "");
              // 非多模态模型（如 DeepSeek）无法处理图片 → 拒绝读 PNG，提示用文本工具
              if (!isModelMultimodal(effectiveModel)) {
                await this.recordProgress(input, "tool_policy", `拒绝 PNG 读取（${effectiveModel || "当前模型"}不支持多模态）：${filePath}`, "milestone");
                return {
                  behavior: "deny",
                  message: [
                    `${effectiveModel || "当前模型"}不支持多模态（图片）输入，无法处理 PNG 拆页。`,
                    "请使用纯文本方式获取 PDF 内容，例如：",
                    "- `pdftotext <pdf路径> -` 提取文本",
                    "- `python3 -c \"import PyPDF2; ...\"` 读取文本",
                    "- 其他命令行文本提取工具",
                    "如果以上工具不可用，请切换到支持多模态的模型（如 claude-sonnet-5）再试。"
                  ].join("\n"),
                  interrupt: false
                };
              }
              pdfPageImageReads.add(filePath);
              if (pdfPageImageReads.size > this.maxPdfPageImageReadsPerStage) {
                return { behavior: "deny", message: `已读取 ${this.maxPdfPageImageReadsPerStage} 张 PDF 拆页图片，请基于已读取内容继续。`, interrupt: false };
              }
            }
            if (isUnsupportedDocumentRead(toolName, toolInput)) {
              return { behavior: "deny", message: "请读取已拆页 PNG，不要直接 Read PDF。PDF base64 太大会导致 API 400 错误。", interrupt: false };
            }
            if (toolName === "mcp__ai_coder__update_task_tree") {
              return { behavior: "allow" };
            }
            if (toolName === "mcp__ai_coder__ask_human") {
              const qualityFailure = evaluateHumanQuestionRequest(toolInput);
              if (qualityFailure) {
                return { behavior: "deny", message: `提问准入失败：${qualityFailure}`, interrupt: false };
              }
              const question = this.buildHumanQuestion(input.session, toolInput, options.toolUseID);
              if (question) {
                input.session.pending_human_questions = [...(input.session.pending_human_questions ?? []), question];
                await this.recordProgress(input, "tool_policy", `等待用户回答：${question.question.slice(0, 60)}`, "milestone");
                return { behavior: "deny", message: "等待用户回答，已暂停执行", interrupt: true };
              }
              input.session.status = "failed";
              input.session.error = "ask_human 工具输入格式错误";
              return { behavior: "deny", message: input.session.error, interrupt: true };
            }
            const safetyCheck = checkCommandSafety("profile", toolName, toolInput);
            if (!safetyCheck.allow) {
              return { behavior: "deny", message: safetyCheck.message, interrupt: false };
            }
            const decision = await approveOrDenyToolUse(input.session, input.workflow, toolName, toolInput, options.toolUseID);
            if (decision.allow) {
              return { behavior: "allow", updatedInput: decision.updatedInput };
            }
            if (this.hasPendingToolCall(input.session, options.toolUseID)) {
              const approvalPromise = this.waitForToolApproval(input.session, options.toolUseID, abortController.signal);
              await this.recordProgress(input, "tool_policy", this.describeToolDecision(toolName, false), "milestone");
              const resolved = await approvalPromise;
              if (resolved === "approved") {
                const approvedDecision = await approveOrDenyToolUse(input.session, input.workflow, toolName, toolInput, options.toolUseID);
                if (approvedDecision.allow) {
                  input.session.status = "running";
                  return { behavior: "allow", updatedInput: approvedDecision.updatedInput };
                }
                return { behavior: "deny", message: approvedDecision.message, interrupt: approvedDecision.interrupt };
              }
              input.session.status = "running";
              return { behavior: "deny", message: "Tool call was denied by the user.", interrupt: false };
            }
            return { behavior: "deny", message: decision.message, interrupt: decision.interrupt };
          }
        }
      } as never) as AsyncIterable<unknown>) {
        sdkMessages.push(message);
        // 从 SDK init 消息中捕获运行时实际使用的模型
        captureEffectiveModelFromInitMessage(message, (model) => {
          if (model && !effectiveModel) {
            effectiveModel = model;
          }
        });
        this.recordSdkToolUses(input.session, "profile", message);
        this.recordToolExecutionResult(input.session, message);
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

      // 缓存跨查询的有效模型
      if (effectiveModel) {
        this.resolvedEffectiveModel = effectiveModel;
      }

      return { sdkMessages, preQueryMsgCount, preQueryTcCount, effectiveModel: effectiveModel || undefined };
    } catch (error) {
      if (isAbortError(error) || abortController.signal.aborted) {
        input.session.status = "interrupted";
        return { sdkMessages, preQueryMsgCount, preQueryTcCount, finalSession: input.session };
      }
      return { sdkMessages, preQueryMsgCount, preQueryTcCount, apiError: error };
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
        if (!cache.has(key)) {
          cache.set(key, { outputSummary: tc.output_summary, exitCode: tc.exit_code });
        }
      }
    }
  }

/** 构建 Profile 模式的系统提示词 */
  private buildProfileSystemPrompt(
    skillSummaries: Array<{ id: string; content: string }>,
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
      "- **调用工具时使用标准的 tool_use 格式，禁止使用 DSML 标记**（如 `<|DSML|tool_calls>`、`<|DSML|invoke>`、`Calling:` 等文本格式）"
    ].join("\n");

    const taskTreeGuidance = [
      "## 任务树驱动（贯穿全程的工作方式）",
      "",
      "你的行动必须由一个动态维护的**任务树**驱动。使用 `update_task_tree` MCP 工具：",
      "",
      "1. **启动**：理解任务后，先读相关代码了解项目结构，然后调用 `update_task_tree(action=\"bootstrap\")` 建立初始任务树。",
      "   - 每个子任务必须独立可验证——改不同文件、有不同验收标准",
      "   - 声明依赖关系：A 依赖 B 意味着 A 的输出是 B 的输入",
      "2. **执行**：选定任务后，先调用 `update_task_tree(action=\"update_status\", new_status=\"in_progress\")` 将其标为 in_progress，然后：",
      "   - **复杂子任务**：使用 `Task` 工具 spawn `task-executor` sub-agent 来执行",
      "     `Task({ subagent_type: \"task-executor\", description: \"执行 tN: <描述>\", prompt: \"项目路径: <path>\\n任务: <描述>\\n验收标准: <criteria>\\n已知上下文: ...\" })`",
      "     sub-agent 返回结构化 JSON（status + evidence）后，根据 evidence 调用 update_task_tree 标记 completed/blocked",
      "   - **简单子任务**（如\"确认文件 X 存在\"、\"读取配置 Y\"）：直接在主上下文执行，完成后立即调用 update_task_tree 标 completed 并附 evidence",
      "   - **多个无依赖的子任务可以并行 spawn 多个 task-executor**，加速执行",
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
            "- **禁止直接 Read PDF 文件**：PDF base64 编码太大会导致 API 400 错误。请改用 Read 读取已拆页的 PNG 图片",
            "- PDF 上传后已自动拆为 .ai-coder/uploads/<id>/page-*.png，每页一张图片",
            "- 每次只读取当前需要的页面，不要一次性读取所有页面"
          ].join("\n")
        : [
            "## 文件读取规则",
            "- **禁止直接 Read PDF 文件**：PDF base64 编码太大会导致 API 400 错误",
            `- **当前模型（${effectiveModel || "默认"}）不支持图片输入**：请使用命令行文本工具提取 PDF 内容，例如 ` + "`pdftotext <pdf路径> -` 或 `python3 -c \"import PyPDF2; ...\"`",
            "- PDF 上传后已自动拆为 .ai-coder/uploads/<id>/page-*.png，但你必须用文本工具而非 Read 来获取其内容"
          ].join("\n"),
      reactGuidance,
      taskTreeGuidance,
      workflowSystemPrompt ?? "",
      skillSummaries.length > 0
        ? [
            "## 可用 Skills（摘要，按需通过 Skill 工具加载完整内容）",
            ...skillSummaries.map((s) => `- **${s.id}**: ${s.content.slice(0, 200)}`)
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

    // 检查阶段是否需要预先授权（仅针对需要写权限的阶段，如 write_memory）
    // 只有当阶段配置了 approval_required 且包含 edit_file 工具时，才需要在开始前授权
    if (currentStage.approval_required && currentStage.allowed_tools?.includes("edit_file") && !this.hasStageApproval(input.session, currentStage.id)) {
      return this.requestStageApprovalIfNeeded(input, currentStage);
    }

    const stageAgentInput = buildStageAgentInput(input.session, input.workflow, currentStage);

    if (!(await shouldUseClaudeSdk())) {
      await this.recordProgress(input, "runner", "使用 Mock 模式生成阶段结果。", "milestone");
      return this.runMock(input, stageAgentInput);
    }

    const sdkMessages: unknown[] = [];
    const pdfPageImageReads = new Set<string>();
    const abortController = new AbortController();
    this.abortControllers.set(input.session.id, abortController);

    // 保存查询前状态，用于重试时回滚
    const preQueryMsgCount = input.session.messages.length;
    const preQueryTcCount = input.session.tool_calls.length;
    const MAX_API_RETRIES = 3;
    let lastError: unknown = null;

    // 跨重试的已完成工具结果缓存：key = `${toolName}::${normalizedInput}`
    const completedToolCache = new Map<string, { outputSummary?: string; exitCode?: number }>();

    this.activeSession = input.session;

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
        pdfPageImageReads.clear();
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
        const mcpServer = await this.resolveMcpServer();

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
          model: input.session.model,
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
          // 项目/用户 settings 可能预授权工具并绕过 canUseTool。PreToolUse 一律要求宿主裁决，
          // 保证安全策略、阶段 hooks 与工具审计对每一次调用都生效。
          hooks: {
            PreToolUse: [{
              hooks: [async (hookInput: unknown) => {
                // Hook 层拦截 PDF Read：belt and suspenders —— SDK 可能不调 canUseTool
                const hi = hookInput as { tool_name?: string; tool_input?: unknown };
                if (hi.tool_name === "Read") {
                  const ti = hi.tool_input as Record<string, unknown> | undefined;
                  const fp = String(ti?.file_path ?? ti?.path ?? "");
                  if (/\.pdf(?:$|[?#])/i.test(fp)) {
                    return {
                      continue: true,
                      hookSpecificOutput: {
                        hookEventName: "PreToolUse" as const,
                        permissionDecision: "deny" as const,
                        permissionDecisionReason: "请读取已拆页 PNG，不要直接 Read PDF。PDF base64 太大会导致 API 400 错误。"
                      }
                    };
                  }
                }
                return {
                  continue: true,
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    permissionDecision: "ask" as const,
                    permissionDecisionReason: "Route every tool through the host policy and audit callback."
                  }
                };
              }]
            }]
          },
          // permissionMode 不设置，使用 SDK 默认行为；PreToolUse 会把最终裁决交给 canUseTool。
          settingSources: ["user", "project", "local"],
          outputFormat: buildStageOutputFormat(currentStage),
          ...(Object.keys(sdkAgents).length > 0 ? { agents: sdkAgents } : {}),
          canUseTool: async (toolName: string, toolInput: Record<string, unknown>, options: { toolUseID: string }) => {
            // SDK 原生 Task 工具：sub-agent 调用由 SDK 内部管理，直接放行
            if (toolName === "Task") {
              await this.recordProgress(input, "tool_policy", "允许 Task（sub-agent）调用", "transient");
              return { behavior: "allow" };
            }

            if (toolName === "Skill") {
              const skillName = String(toolInput.skill ?? toolInput.name ?? "unknown");
              this.appendAssistantMessage(input.session, `正在加载 Skill：\`${skillName}\``, "skill_usage");
              await this.recordProgress(input, "runner", `加载 Skill：${skillName}`, "milestone");
            }

            // 重试缓存检测：如果该工具已在前序尝试中成功完成，直接返回缓存结果
            if (completedToolCache.size > 0) {
              const cacheKey = makeToolCacheKey(toolName, toolInput);
              const cached = completedToolCache.get(cacheKey);
              if (cached) {
                await this.recordProgress(input, "tool_policy", `跳过重复工具（已缓存）：${toolName}`, "transient");
                const resultHint = cached.outputSummary
                  ? `\n\n该工具已在上一次尝试中成功完成。结果摘要：\n${cached.outputSummary.slice(0, 500)}`
                  : "\n\n该工具已在上一次尝试中成功完成（退出码 0）。";
                return { behavior: "deny", message: `此操作已在前序尝试中完成，无需重复执行。${resultHint}\n\n请基于此结果继续，不要再次调用相同工具。`, interrupt: false };
              }
            }

            if (isPdfPageImageRead(toolName, toolInput)) {
              const filePath = String(toolInput.file_path ?? toolInput.path ?? "");
              // 非多模态模型无法处理图片 → 拒绝读 PNG
              const stageEffectiveModel = input.session.model || this.resolvedEffectiveModel;
              if (!isModelMultimodal(stageEffectiveModel)) {
                await this.recordProgress(input, "tool_policy", `拒绝 PNG 读取（${stageEffectiveModel || "当前模型"}不支持多模态）：${filePath}`, "milestone");
                return {
                  behavior: "deny",
                  message: [
                    `${stageEffectiveModel || "当前模型"}不支持多模态（图片）输入，无法处理 PNG 拆页。`,
                    "请使用 `pdftotext`、`python3 -c \"import PyPDF2; ...\"` 等命令行文本工具提取 PDF 内容，",
                    "或切换到支持多模态的模型（如 claude-sonnet-5）再试。"
                  ].join("\n"),
                  interrupt: false
                };
              }
              pdfPageImageReads.add(filePath);
              if (pdfPageImageReads.size > this.maxPdfPageImageReadsPerStage) {
                const message = [
                  `本阶段已读取 ${this.maxPdfPageImageReadsPerStage} 张 PDF 拆页图片，继续读取会导致模型上下文过大。`,
                  "请停止继续 Read page-*.png，基于已读取页面完成当前阶段 required_outputs；",
                  "未覆盖的页码或需求请写入 assumptions/unknown，不要为了补全而继续读图。"
                ].join("");
                await this.recordProgress(input, "tool_policy", `限制 PDF 拆页读取：${filePath}`, "milestone");
                return { behavior: "deny", message, interrupt: false };
              }
            }

            if (isUnsupportedDocumentRead(toolName, toolInput)) {
              await this.recordProgress(input, "tool_policy", "拦截 PDF Read：请读取已拆页 PNG 或用 shell 文本工具查看，不要直接 Read PDF。", "milestone");
              return {
                behavior: "deny",
                message: "当前后端不支持 PDF document content block。PDF 上传时已拆成 .ai-coder/uploads/.../page-*.png，请改用 Read 读取对应 PNG 页面，或用只读 shell 工具提取文本后继续。",
                interrupt: false
              };
            }
            // 拦截 update_task_tree：MCP handler 自行处理校验与持久化
            if (toolName === "mcp__ai_coder__update_task_tree") {
              return { behavior: "allow" };
            }
            // 拦截 ask_human：作为 HumanQuestion 挂起，等待用户回答后继续
            if (toolName === "mcp__ai_coder__ask_human") {
              const qualityFailure = evaluateHumanQuestionRequest(toolInput);
              if (qualityFailure) {
                await this.recordProgress(input, "tool_policy", `拒绝低质量问题：${qualityFailure}`, "milestone");
                return {
                  behavior: "deny",
                  message: `提问准入失败：${qualityFailure}。请先自行取证；若仍需询问，只问一个会实质改变决策的问题。`,
                  interrupt: false
                };
              }
              const question = this.buildHumanQuestion(input.session, toolInput, options.toolUseID);
              if (question) {
                // 去重：相同 question 文本 + 相同 stage_id 不重复创建
                const existing = (input.session.pending_human_questions ?? []).find(
                  (q) => q.question === question.question && q.stage_id === question.stage_id
                );
                if (existing) {
                  if (existing.status === "answered") {
                    // 已经回答过：不重复问，不中断，让模型继续
                    await this.recordProgress(input, "tool_policy", `重复问题已跳过（已回答）：${question.question.slice(0, 60)}`, "transient");
                    return { behavior: "deny", message: "此问题已回答，请基于已有回答继续。", interrupt: false };
                  }
                  // 仍在 pending：不创建新问题，但仍需中断等待用户回答
                  await this.recordProgress(input, "tool_policy", `重复问题等待中：${question.question.slice(0, 60)}`, "transient");
                  return { behavior: "deny", message: "等待用户回答，已暂停执行", interrupt: true };
                }
                input.session.pending_human_questions = [
                  ...(input.session.pending_human_questions ?? []),
                  question
                ];
                await this.recordProgress(input, "tool_policy", `等待用户回答：${question.question.slice(0, 60)}`, "milestone");
                return { behavior: "deny", message: "等待用户回答，已暂停执行", interrupt: true };
              }
              // 工具输入非法：明确标记会话失败，避免被当作正常完成
              input.session.status = "failed";
              input.session.error = "ask_human 工具输入格式错误（缺少 question / type / options）";
              await this.recordProgress(input, "status", input.session.error, "milestone");
              return { behavior: "deny", message: input.session.error, interrupt: true };
            }
            // ── 引擎层 Bash 命令安全拦截（硬编码，不依赖 YAML 配置）──
            // 在阶段 hooks 之前执行——这是因果致效层的约束，不是 prompt 建议。
            const safetyCheck = checkCommandSafety(currentStage.id, toolName, toolInput);
            if (!safetyCheck.allow) {
              const attempted = describeToolAttempt(toolName, toolInput);
              await this.recordProgress(input, "tool_policy", `安全拦截（${attempted}）：${safetyCheck.message}`, "milestone");
              return { behavior: "deny", message: safetyCheck.message, interrupt: false };
            }
            // 阶段级工序闸门：仅当 stage.hooks 显式声明时生效；与 approveOrDenyToolUse（策略层）解耦。
            // 失败时 interrupt:false——让模型读到拒绝原因后自行补齐前置步骤，不打断整个会话。
            if (currentStage.hooks) {
              const hookDecision = evaluateHook(currentStage, input.session, toolName, toolInput);
              if (!hookDecision.allow) {
                await this.recordProgress(input, "tool_policy", `工序闸门：${hookDecision.message}`, "milestone");
                return { behavior: "deny", message: hookDecision.message, interrupt: false };
              }
            }
            const decision = await approveOrDenyToolUse(input.session, input.workflow, toolName, toolInput, options.toolUseID);
            if (decision.allow) {
              await this.recordProgress(input, "tool_policy", this.describeToolDecision(toolName, true), "milestone");
              return { behavior: "allow", updatedInput: decision.updatedInput };
            }
            if (this.hasPendingToolCall(input.session, options.toolUseID)) {
              const approvalPromise = this.waitForToolApproval(input.session, options.toolUseID, abortController.signal);
              await this.recordProgress(input, "tool_policy", this.describeToolDecision(toolName, false), "milestone");
              const resolved = await approvalPromise;
              if (resolved === "approved") {
                const approvedDecision = await approveOrDenyToolUse(input.session, input.workflow, toolName, toolInput, options.toolUseID);
                await this.recordProgress(input, "tool_policy", this.describeToolDecision(toolName, approvedDecision.allow), "milestone");
                if (approvedDecision.allow) {
                  input.session.status = "running";
                  return { behavior: "allow", updatedInput: approvedDecision.updatedInput };
                }
                return { behavior: "deny", message: approvedDecision.message, interrupt: approvedDecision.interrupt };
              }
              input.session.status = "running";
              return { behavior: "deny", message: "Tool call was denied by the user. Continue without this tool or choose an allowed alternative.", interrupt: false };
            }
            await this.recordProgress(input, "tool_policy", this.describeToolDecision(toolName, false), "milestone");
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

      if (this.hasPendingToolCall(input.session) || this.hasPendingHumanQuestion(input.session)) {
        // 有待审批工具/问题：push transcript 后中断
        this.appendAssistantMessage(input.session, transcript);
        input.session.status = this.resolveInterruptedStatus(input.session);
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
        await this.recordProgress(input, "status", `阶段已完成，等待审批：${stageName}`, "milestone");
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

    const stage = input.workflow.stages.find((item) => item.id === approval?.stage_id);
    input.session.status = "waiting_approval";
    input.session.current_stage = approval?.stage_id ?? input.session.current_stage;
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

    const approval = {
      id: randomUUID(),
      stage_id: stage.id,
      kind: "stage" as const,
      status: "pending" as const,
      message: `阶段"${stage.name}"需要授权才能继续执行。该阶段需要使用文件编辑工具，请确认是否允许。`,
      created_at: new Date().toISOString()
    };
    input.session.approvals.push(approval);
    input.session.status = "waiting_approval";

    const content = `阶段"${stage.name}"需要授权才能继续执行。该阶段将使用文件编辑工具写入项目文件，请审批。`;
    this.appendAssistantMessage(input.session, content);

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
    input.session.progress_events = progress.slice(-80);
    await input.onProgress?.(input.session);
  }

  private describeToolDecision(toolName: string, allowed: boolean): string {
    return allowed ? `工具已允许：${toolName}` : `工具需要审批或已被拦截：${toolName}`;
  }

  private describeSdkMessage(message: unknown): string {
    return describeSdkMessageSnippet(message);
  }

  private hasBlockedToolCall(session: AgentSession): boolean {
    return session.tool_calls.some((toolCall) => toolCall.status === "blocked" || toolCall.status === "denied");
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
          const toolCall = session.tool_calls.find((item) => item.id === toolCallId && item.status === "pending_approval");
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

  private hasPendingHumanQuestion(session: AgentSession): boolean {
    return (session.pending_human_questions ?? []).some((q) => q.status === "pending");
  }

  private resolveInterruptedStatus(session: AgentSession): AgentSession["status"] {
    if (this.hasPendingToolCall(session) || this.hasPendingHumanQuestion(session)) {
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

  /** Profile 模式：只加载 Skill 摘要（前 200 字），完整内容通过 Skill 工具按需加载。 */
  private async loadSkillSummaries(skillIds: string[]): Promise<Array<{ id: string; content: string }>> {
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
            content: fullContent.slice(0, 200)
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
    if (result.exitCode !== undefined) {
      toolCall.exit_code = result.exitCode;
    } else if (toolCall.tool === "Bash" && result.executionSucceeded === true) {
      // Claude Agent SDK 的 Bash 成功结果通常只有 stdout/stderr/interrupted，未必提供 exit_code。
      // tool_result 已明确完成且没有错误/中断时，将其规范化为 0，供证据门槛使用。
      toolCall.exit_code = 0;
    }
    if (result.outputSummary) toolCall.output_summary = result.outputSummary;
    if (result.executionSucceeded === false) {
      toolCall.status = "blocked";
      toolCall.resolved_at = new Date().toISOString();
    } else if (toolCall.status === "approved" || toolCall.status === "requested") {
      toolCall.status = "completed";
      toolCall.resolved_at = new Date().toISOString();
    }
  }

  private async resolveMcpServer(): Promise<unknown | null> {
    if (this.mcpServerCache) return this.mcpServerCache;
    try {
      const sdk = await import("@anthropic-ai/claude-agent-sdk");
      const createSdkMcpServer = (sdk as { createSdkMcpServer?: unknown }).createSdkMcpServer;
      const tool = (sdk as { tool?: unknown }).tool;
      const { z } = await import("zod");
      if (typeof createSdkMcpServer !== "function" || typeof tool !== "function") {
        return null;
      }
      // 注意：ask_human 是"宿主拦截工具"——SDK 看到的工具 handler 永远返回占位符 `(intercepted by host)`，
      // 因为真正的拦截发生在 canUseTool（本文件 canUseTool 回调内 `toolName === "mcp__ai_coder__ask_human"` 分支）：
      //   1. 模型尝试调用 ask_human → canUseTool 命中该分支
      //   2. 解析 toolInput 构造 HumanQuestion，挂到 session.pending_human_questions
      //   3. 返回 { behavior: "deny", interrupt: true } 暂停 SDK 循环
      //   4. 用户在前端回答后 IPC 写回 session，下一轮以问答历史形式注入 prompt
      // 为什么仍然要在 MCP 注册：SDK 只允许模型调用"已声明"的工具；不注册的话模型无法发起调用。
      // 暴露面：MCP 工具走 `mcpServers` 通道独立注册，**不**经过 buildAllowedClaudeTools 过滤
      // （后者只控制 Read/Edit/Bash 等标准工具）。所以 ask_human 对所有阶段永远可见，唯一守门人是 canUseTool。
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
        async () => ({ content: [{ type: "text", text: "(intercepted by host)" }] })
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
          })).optional().describe("bootstrap 时必填：初始任务列表"),
          goal_restated: z.string().optional().describe("bootstrap 时必填：重述的用户可观测目标"),
          strategy: z.string().optional().describe("bootstrap 时必填：拆分策略说明（如'按模块边界拆分'）"),
          new_tasks: z.array(z.object({
            id: z.string().describe("新任务唯一标识"),
            description: z.string().describe("要完成什么"),
            dependencies: z.array(z.string()).describe("依赖的任务 ID"),
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
          const session = (this as ClaudeAgentRunner).activeSession;
          if (!session) {
            return { content: [{ type: "text", text: "错误：没有活动会话。" }] };
          }
          try {
            const result = applyTaskTreeMutation(session, args as TaskTreeMutationArgs);
            return { content: [{ type: "text", text: result }] };
          } catch (err) {
            return { content: [{ type: "text", text: `任务树更新失败：${err instanceof Error ? err.message : String(err)}` }] };
          }
        }
      );
      this.mcpServerCache = (createSdkMcpServer as (opts: { name: string; tools: unknown[] }) => unknown)({
        name: "ai_coder",
        tools: [askHumanTool, taskTreeTool]
      });
      return this.mcpServerCache;
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
      const outputInfo = result.outputSummary
        ? ` → ${result.outputSummary.slice(0, 300)}`
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

/** 从 SDK system/init 消息中提取运行时实际使用的模型名。
 *  init 消息的 data.models[0] 通常是当前会话的默认模型。 */
function captureEffectiveModelFromInitMessage(
  message: unknown,
  onModel: (model: string) => void
): void {
  if (!isPlainObject(message)) return;
  if (message.type !== "system" || message.subtype !== "init") return;
  const data = isPlainObject(message.data) ? message.data : {};
  const models = Array.isArray(data.models) ? (data.models as Array<{ value?: string }>) : [];
  if (models.length === 0) return;
  // data.models[0] 是 CLI 实际使用的模型
  const effective = typeof models[0].value === "string" ? models[0].value : "";
  if (effective) onModel(effective);
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
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(relevant);
}

/** 判断 API 错误是否可重试。只对已知的瞬时性错误放行，未知错误不走重试。 */
function isRetriableApiError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  const message = error instanceof Error ? error.message : String(error);
  // 鉴权 / 进程崩溃 / SDK 内部错误不可重试
  if (/\b401\b/.test(message) || /\b403\b/.test(message)) return false;
  if (/authentication|unauthorized|invalid.*api.*key|\/login/i.test(message)) return false;
  if (/exited with code|process exited/i.test(message)) return false;
  // 已知瞬时性错误：HTTP 状态码、限流、超时、网络中断
  if (/\b400\b/.test(message)) return true;
  if (/\b429\b/.test(message)) return true;
  if (/\b5\d{2}\b/.test(message)) return true;
  if (/rate.?limit|overloaded|too many requests/i.test(message)) return true;
  if (/timeout|timed.?out|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|network|fetch failed/i.test(message)) return true;
  return false;
}

function isUnsupportedDocumentRead(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (toolName !== "Read") return false;
  const filePath = String(toolInput.file_path ?? toolInput.path ?? "");
  return /\.pdf(?:$|[?#])/i.test(filePath);
}

function isPdfPageImageRead(toolName: string, toolInput: Record<string, unknown>): boolean {
  if (toolName !== "Read") return false;
  const filePath = String(toolInput.file_path ?? toolInput.path ?? "");
  return /(?:^|[/\\])\.ai-coder[/\\]uploads[/\\].*[/\\]page-\d+\.(?:png|jpe?g|webp)$/i.test(filePath);
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
        parts.push(`调用 ${name}${describeToolInputSnippet(block.input)}`);
      }
    }
    return parts.length > 0 ? parts.join(" | ") : "助手消息（无文本）";
  }
  if (type === "tool_result") return "工具结果";
  if (type === "result") return "阶段结果";
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
  tasks?: { id: string; description: string; dependencies: string[] }[];
  goal_restated?: string;
  strategy?: string;
  new_tasks?: { id: string; description: string; dependencies: string[] }[];
  add_reason?: string;
  task_id?: string;
  new_status?: "in_progress" | "completed" | "blocked" | "skipped";
  status_reason?: string;
  evidence?: string;
  next_focus?: string;
  next_reason?: string;
}

function applyTaskTreeMutation(session: AgentSession, args: TaskTreeMutationArgs): string {
  const now = new Date().toISOString();

  if (args.action === "bootstrap") {
    if (!args.tasks || args.tasks.length === 0) {
      throw new Error("bootstrap 需要至少一个任务节点");
    }
    if (!args.goal_restated || !args.strategy) {
      throw new Error("bootstrap 需要 goal_restated 和 strategy");
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
    session.task_tree = {
      tasks: args.tasks.map((t) => ({
        id: t.id,
        description: t.description,
        dependencies: t.dependencies,
        status: "pending" as const,
      })),
      goal_restated: args.goal_restated,
      strategy: args.strategy,
      current_focus: args.next_focus,
      focus_reason: args.next_reason,
      created_at: now,
      updated_at: now,
    };
    return formatTaskTreeResponse(session.task_tree, "任务树已初始化");
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

    // completed 必须有 evidence
    if (args.new_status === "completed" && !args.evidence) {
      throw new Error("标记 completed 必须提供 evidence（验证命令输出或文件路径）");
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
    lines.push(`  ${icon} ${t.id}: ${t.description}${deps}${evidence}${reason}${focus}`);
  }
  if (tree.current_focus && tree.focus_reason) {
    lines.push("", `当前聚焦：${tree.current_focus}——${tree.focus_reason}`);
  }
  lines.push(
    "",
    "操作规则：",
    "- 开始做某个任务前，调用 update_task_tree 将其标为 in_progress（委托给 task-executor 前也要先标）",
    "- 委托执行：Task({ subagent_type: \"task-executor\", ... }) → 根据返回的 evidence 调 update_task_tree 标 completed",
    "- 简单任务可直接在主上下文完成，完成后立即调 update_task_tree 标 completed 并附 evidence",
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
    lines.push(`${icon} ${t.id}: ${t.description}${deps}${evidence}${focus}`);
  }
  if (tree.current_focus && tree.focus_reason) {
    lines.push(`\n当前聚焦：${tree.current_focus}——${tree.focus_reason}`);
  }
  return lines.join("\n");
}

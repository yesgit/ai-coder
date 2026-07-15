import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage, AgentSession, HumanQuestion, HumanQuestionOption, SessionProgressEvent, StageAgentResult, WorkflowStage, WorkflowTemplate } from "../../shared/types.js";
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

interface PendingToolApproval {
  session: AgentSession;
  resolve: (status: ToolApprovalResolution) => void;
}

export class ClaudeAgentRunner {
  private readonly workflowEngine = new WorkflowEngine();
  private readonly maxStageIterations = 50;
  private readonly maxPdfPageImageReadsPerStage = 8;
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly pendingToolApprovals = new Map<string, Map<string, PendingToolApproval>>();
  private mcpServerCache: unknown | null = null;
  private readonly options: ClaudeAgentRunnerOptions;

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
    const sdkMessages: unknown[] = [];
    const pdfPageImageReads = new Set<string>();
    const abortController = new AbortController();
    this.abortControllers.set(input.session.id, abortController);
    try {
      const query = await this.resolveQuery();
      const mcpServer = await this.resolveMcpServer();

      // 加载配置的 Skills 摘要（不加载完整内容——按需通过 Skill 工具加载）
      const skillIds = input.workflow.skills ?? [];
      const skillSummaries = await this.loadSkillSummaries(skillIds);
      for (const s of skillSummaries) {
        await this.recordProgress(input, "runner", `加载 Skill 摘要：${s.id}`, "milestone");
      }

      // 构建系统提示：使用 claude_code 预设 + 谨慎程序员方法论追加
      const carefulCoderInstructions = [
        input.workflow.system_prompt ?? "",
        skillSummaries.length > 0
          ? [
              "## 可用 Skills（摘要，按需通过 Skill 工具加载完整内容）",
              ...skillSummaries.map((s) => `- **${s.id}**: ${s.content.slice(0, 200)}`)
            ].join("\n")
          : ""
      ].filter(Boolean).join("\n\n");

      // 构建用户任务上下文：原始任务 + 人类问答历史
      const taskPrompt = input.session.task_prompt ?? "";
      const humanQaHistory = (input.session.pending_human_questions ?? [])
        .filter((q) => q.status === "answered")
        .map((q) => `- 问：${q.question}\n  答：${Array.isArray(q.answer) ? q.answer.join(", ") : (q.answer ?? "")}`)
        .join("\n");

      // 初始用户消息中的附件信息
      const initialMessage = input.session.initial_user_message ?? input.session.messages.find((m) => m.role === "user");
      const attachmentList = (initialMessage?.attachments ?? [])
        .map((a) => `- ${a.display_name ?? ("path" in a ? (a as { path: string }).path : "附件")}`)
        .join("\n");

      const instructions = [
        taskPrompt || "（无任务描述）",
        attachmentList ? `\n附件：\n${attachmentList}` : "",
        humanQaHistory ? `\n人类问答历史：\n${humanQaHistory}` : ""
      ].filter(Boolean).join("\n\n");

      await this.recordProgress(input, "runner", "开始执行（Profile 模式）", "milestone");
      const nodeInfo = await resolveNodeExecutable();
      const sdkEnv = buildClaudeSdkEnv(nodeInfo?.env);

      // 构建 SDK agents：注册顶层 sub-agents
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
          // 使用 claude_code 预设系统提示（含 ReAct 工具使用引导）+ 谨慎程序员方法论
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
              hooks: [async () => ({
                continue: true,
                hookSpecificOutput: {
                  hookEventName: "PreToolUse" as const,
                  permissionDecision: "ask" as const,
                  permissionDecisionReason: "Route every tool through the host policy and audit callback."
                }
              })]
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
            if (isPdfPageImageRead(toolName, toolInput)) {
              const filePath = String(toolInput.file_path ?? toolInput.path ?? "");
              pdfPageImageReads.add(filePath);
              if (pdfPageImageReads.size > this.maxPdfPageImageReadsPerStage) {
                return { behavior: "deny", message: `已读取 ${this.maxPdfPageImageReadsPerStage} 张 PDF 拆页图片，请基于已读取内容继续。`, interrupt: false };
              }
            }
            if (isUnsupportedDocumentRead(toolName, toolInput)) {
              return { behavior: "deny", message: "请读取已拆页 PNG，不要直接 Read PDF。", interrupt: false };
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
            // 引擎层安全拦截（profile 模式下以 "careful-coder" 作为 stage id）
            const safetyCheck = checkCommandSafety("profile", toolName, toolInput);
            if (!safetyCheck.allow) {
              return { behavior: "deny", message: safetyCheck.message, interrupt: false };
            }
            const decision = await approveOrDenyToolUse(input.session, input.workflow, toolName, toolInput, options.toolUseID);
            if (decision.allow) {
              return { behavior: "allow", updatedInput: decision.updatedInput };
            }
            if (this.hasPendingToolCall(input.session, options.toolUseID)) {
              const resolved = await this.waitForToolApproval(input.session, options.toolUseID, abortController.signal);
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
        this.recordSdkToolUses(input.session, "profile", message);
        this.recordToolExecutionResult(input.session, message);
      }

      // Profile 模式：查询结束后直接完成 session，不经过阶段引擎
      const transcript = formatClaudeTranscript(sdkMessages);
      this.appendAssistantMessage(input.session, transcript);
      input.session.status = "completed";
      await this.recordProgress(input, "status", "Profile 模式执行完成", "milestone");
    } catch (error) {
      if (isAbortError(error)) {
        input.session.status = "interrupted";
        return input.session;
      }
      input.session.status = "failed";
      input.session.error = error instanceof Error ? error.message : String(error);
      await this.recordProgress(input, "status", `执行失败：${input.session.error}`, "milestone");
    } finally {
      this.abortControllers.delete(input.session.id);
    }
    return input.session;
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
    try {
      const query = await this.resolveQuery();
      const mcpServer = await this.resolveMcpServer();

      const loadedSkills = await this.loadRequiredSkills(currentStage);
      for (const skill of loadedSkills) {
        this.appendAssistantMessage(input.session, `宿主已加载核心 Skill：\`${skill.id}\``, "skill_usage");
        await this.recordProgress(input, "runner", `强制加载核心 Skill：${skill.id}`, "milestone");
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
      await this.recordProgress(input, "runner", `开始执行阶段：${currentStage.name || currentStage.id}`, "milestone");
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
          // 项目/用户 settings 可能预授权工具并绕过 canUseTool。PreToolUse 一律要求宿主裁决，
          // 保证安全策略、阶段 hooks 与工具审计对每一次调用都生效。
          hooks: {
            PreToolUse: [{
              hooks: [async () => ({
                continue: true,
                hookSpecificOutput: {
                  hookEventName: "PreToolUse" as const,
                  permissionDecision: "ask" as const,
                  permissionDecisionReason: "Route every tool through the host policy and audit callback."
                }
              })]
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

            if (isPdfPageImageRead(toolName, toolInput)) {
              const filePath = String(toolInput.file_path ?? toolInput.path ?? "");
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
        return input.session;
      }

      const stageOutput = extractClaudeStageOutput(sdkMessages);
      const transcript = formatClaudeTranscript(sdkMessages) || formatStructuredOutput(stageOutput.structuredOutput);

      if (this.hasPendingToolCall(input.session) || this.hasPendingHumanQuestion(input.session)) {
        // 有待审批工具/问题：push transcript 后中断
        this.appendAssistantMessage(input.session, transcript);
        input.session.status = this.resolveInterruptedStatus(input.session);
        await this.recordProgress(input, "status", `阶段已中断：${input.session.status}`, "milestone");
        return input.session;
      }
      if (stageOutput.error) {
        input.session.status = "failed";
        input.session.error = stageOutput.error;
        await this.recordProgress(input, "status", "阶段执行失败。", "milestone");
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
      return input.session;
    } catch (error) {
      // 用户主动中止：保留已写入的消息和工具调用，根据是否有未决问题决定终态
      if (abortController.signal.aborted || isAbortError(error)) {
        if (sdkMessages.length > 0) {
          const transcript = formatClaudeTranscript(sdkMessages);
          this.appendAssistantMessage(input.session, transcript);
        }
        const resolved = this.resolveInterruptedStatus(input.session);
        input.session.status = resolved === "completed" ? "interrupted" : resolved;
        await this.recordProgress(input, "status", "已由用户手动中止。", "milestone");
        return input.session;
      }
      const failed = this.failFromSdkError(input, sdkMessages, error);
      await this.recordProgress(input, "status", "Claude Agent SDK 调用失败。", "milestone");
      return failed;
    } finally {
      // 仅当 map 中的 controller 仍是本次创建的才删除，避免竞争条件
      if (this.abortControllers.get(input.session.id) === abortController) {
        this.abortControllers.delete(input.session.id);
      }
    }
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
      this.mcpServerCache = (createSdkMcpServer as (opts: { name: string; tools: unknown[] }) => unknown)({
        name: "ai_coder",
        tools: [askHumanTool]
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

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError";
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
        const snippet = block.text.replace(/\s+/g, " ").trim().slice(0, 80);
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

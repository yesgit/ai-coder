import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentSession, Attachment, SessionOnboardingSnapshot, SessionRoutingSnapshot, WorkflowTemplate } from "../../shared/types.js";
import { summarizeSessionTitle } from "../../shared/sessionTitle.js";
import { WorkflowEngine } from "../workflows/workflowEngine.js";

export class SessionStore {
  private readonly writeChains = new Map<string, Promise<void>>();
  private readonly organizationOverrides = new Map<
    string,
    { pinned_at?: string | null; archived_at?: string | null }
  >();
  private readonly autoApproveOverrides = new Map<string, boolean>();
  private readonly deletedSessionIds = new Set<string>();

  constructor(private readonly storeDir = path.join(os.homedir(), ".ai-coder", "sessions")) {}

  async create(
    projectPath: string,
    workflow: WorkflowTemplate,
    taskPrompt: string,
    onboarding?: SessionOnboardingSnapshot,
    attachments?: Attachment[],
    routing?: SessionRoutingSnapshot
  ): Promise<AgentSession> {
    const now = new Date().toISOString();
    const firstStage = workflow.stages[0]?.id ?? "start";
    const initialUserMessage = { role: "user" as const, content: taskPrompt, created_at: now, attachments };
    const session: AgentSession = {
      id: randomUUID(),
      project_path: projectPath,
      workflow_id: workflow.id,
      title: summarizeSessionTitle(taskPrompt),
      task_prompt: taskPrompt,
      initial_user_message: initialUserMessage,
      status: "created",
      current_stage: firstStage,
      messages: [initialUserMessage],
      tool_calls: [],
      file_changes: [],
      approvals: [],
      progress_events: [],
      stage_runs: [],
      rework_requests: [],
      auto_approve: true,
      onboarding,
      routing,
      created_at: now,
      updated_at: now
    };
    new WorkflowEngine().ensureState(session, workflow);
    await this.save(session);
    return session;
  }

  async list(): Promise<AgentSession[]> {
    await fs.mkdir(this.storeDir, { recursive: true });
    const entries = await fs.readdir(this.storeDir);
    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map((entry) => this.readFileForList(path.join(this.storeDir, entry)))
    );
    return sessions.filter(isAgentSession).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async get(id: string): Promise<AgentSession | null> {
    assertSessionId(id);
    return this.readFile(this.filePath(id));
  }

  async save(session: AgentSession): Promise<void> {
    assertSessionId(session.id);
    await this.enqueueWrite(session.id, async () => {
      if (this.deletedSessionIds.has(session.id)) return;
      this.applyOrganizationOverrides(session);
      await this.writeSessionFile(session);
    });
  }

  async approveToolCall(id: string, toolCallId: string): Promise<AgentSession> {
    return this.resolveToolCall(id, toolCallId, "approved");
  }

  async denyToolCall(id: string, toolCallId: string): Promise<AgentSession> {
    return this.resolveToolCall(id, toolCallId, "denied");
  }

  async setPinned(id: string, pinned: boolean): Promise<AgentSession> {
    return this.updateSessionFlag(id, "pinned_at", pinned);
  }

  async setArchived(id: string, archived: boolean): Promise<AgentSession> {
    return this.updateSessionFlag(id, "archived_at", archived);
  }

  async toggleAutoApprove(id: string): Promise<AgentSession> {
    const session = await this.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }
    session.auto_approve = !session.auto_approve;
    this.autoApproveOverrides.set(id, session.auto_approve);
    await this.save(session);
    return session;
  }

  async approveStage(id: string, stageId: string): Promise<AgentSession> {
    assertSessionId(id);
    const session = await this.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }
    const approval = session.approvals.find(
      (item) => item.kind === "stage" && item.stage_id === stageId && item.status === "pending"
    );
    if (!approval) {
      throw new Error(`Pending stage approval not found: ${stageId}`);
    }
    approval.status = "approved";
    approval.resolved_at = new Date().toISOString();
    session.status = "running";
    await this.save(session);
    return session;
  }

  private async readFile(filePath: string): Promise<AgentSession | null> {
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const session = JSON.parse(raw) as AgentSession;
      // 兼容旧会话：历史版本没有持久化该字段。缺省值迁移为自动审批；
      // 用户明确切换到手动审批时会保存 false，不会被这里覆盖。
      if (session.auto_approve === undefined) {
        session.auto_approve = true;
      }
      return session;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async readFileForList(filePath: string): Promise<AgentSession | null> {
    try {
      return await this.readFile(filePath);
    } catch {
      return null;
    }
  }

  private filePath(id: string): string {
    assertSessionId(id);
    return path.join(this.storeDir, `${id}.json`);
  }

  private async resolveToolCall(
    id: string,
    toolCallId: string,
    status: "approved" | "denied"
  ): Promise<AgentSession> {
    assertSessionId(id);
    const session = await this.get(id);
    if (!session) {
      throw new Error(`Session not found: ${id}`);
    }
    const toolCall = session.tool_calls.find((item) => item.id === toolCallId && item.status === "pending_approval");
    if (!toolCall) {
      throw new Error(`Pending tool call not found: ${toolCallId}`);
    }
    toolCall.status = status;
    toolCall.resolved_at = new Date().toISOString();
    session.status = "running";
    await this.save(session);
    return session;
  }

  private async updateSessionFlag(
    id: string,
    field: "pinned_at" | "archived_at",
    enabled: boolean
  ): Promise<AgentSession> {
    assertSessionId(id);
    return this.enqueueWrite(id, async () => {
      if (this.deletedSessionIds.has(id)) throw new Error(`Session not found: ${id}`);
      const session = await this.readFile(this.filePath(id));
      if (!session) throw new Error(`Session not found: ${id}`);
      const value = enabled ? new Date().toISOString() : null;
      this.organizationOverrides.set(id, {
        ...this.organizationOverrides.get(id),
        [field]: value
      });
      if (value) session[field] = value;
      else delete session[field];
      await this.writeSessionFile(session);
      return session;
    });
  }

  async delete(id: string): Promise<void> {
    assertSessionId(id);
    await this.enqueueWrite(id, async () => {
      const filePath = this.filePath(id);
      try {
        await fs.unlink(filePath);
        this.deletedSessionIds.add(id);
        this.organizationOverrides.delete(id);
        this.autoApproveOverrides.delete(id);
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
          throw new Error(`Session not found: ${id}`);
        }
        throw error;
      }
    });
  }

  private applyOrganizationOverrides(session: AgentSession): void {
    const overrides = this.organizationOverrides.get(session.id);
    if (overrides) {
      for (const field of ["pinned_at", "archived_at"] as const) {
        if (!Object.prototype.hasOwnProperty.call(overrides, field)) continue;
        const value = overrides[field];
        if (value) session[field] = value;
        else delete session[field];
      }
    }
    const autoApprove = this.autoApproveOverrides.get(session.id);
    if (autoApprove !== undefined) {
      session.auto_approve = autoApprove;
    }
  }

  private async writeSessionFile(session: AgentSession): Promise<void> {
    await fs.mkdir(this.storeDir, { recursive: true });
    session.updated_at = new Date().toISOString();
    await fs.writeFile(this.filePath(session.id), JSON.stringify(session, null, 2), "utf8");
  }

  private async enqueueWrite<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeChains.get(id) ?? Promise.resolve();
    // 用 .catch(() => undefined) 让链路不被上一个失败的写阻断（每次 save 都是独立操作）；
    // 但本次 operation 本身的错误必须能被调用方拿到，所以 await result 时不吞错。
    const result = previous.catch(() => undefined).then(operation);
    // tail 仅用于"等下一笔写"的链路占位；rejection handler 写日志便于排查写盘失败，
    // 外层再 .catch 兜底是为了防止 console.error 自身抛错（极端情况）导致 unhandled rejection。
    // 错误已经从 result 返回给调用方，这里仅是兜底告警，避免静默丢失。
    const tail = result
      .then(
        () => undefined,
        (error) => {
          console.error(`[sessionStore] write failed for session ${id}:`, error);
        }
      )
      .catch(() => undefined);
    this.writeChains.set(id, tail);
    try {
      return await result;
    } finally {
      if (this.writeChains.get(id) === tail) this.writeChains.delete(id);
    }
  }
}

function isAgentSession(session: AgentSession | null): session is AgentSession {
  return session !== null;
}

function assertSessionId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(`Invalid session id: ${id}`);
  }
}

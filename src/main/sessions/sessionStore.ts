import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentSession, Attachment, SessionOnboardingSnapshot, WorkflowTemplate } from "../../shared/types.js";
import { WorkflowEngine } from "../workflows/workflowEngine.js";

export class SessionStore {
  constructor(private readonly storeDir = path.join(os.homedir(), ".ai-coder", "sessions")) {}

  async create(
    projectPath: string,
    workflow: WorkflowTemplate,
    taskPrompt: string,
    onboarding?: SessionOnboardingSnapshot,
    attachments?: Attachment[]
  ): Promise<AgentSession> {
    const now = new Date().toISOString();
    const firstStage = workflow.stages[0]?.id ?? "start";
    const session: AgentSession = {
      id: randomUUID(),
      project_path: projectPath,
      workflow_id: workflow.id,
      task_prompt: taskPrompt,
      status: "created",
      current_stage: firstStage,
      messages: [{ role: "user", content: taskPrompt, created_at: now, attachments }],
      tool_calls: [],
      file_changes: [],
      approvals: [],
      progress_events: [],
      stage_runs: [],
      rework_requests: [],
      onboarding,
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
    await fs.mkdir(this.storeDir, { recursive: true });
    session.updated_at = new Date().toISOString();
    await fs.writeFile(this.filePath(session.id), JSON.stringify(session, null, 2), "utf8");
  }

  async approveToolCall(id: string, toolCallId: string): Promise<AgentSession> {
    return this.resolveToolCall(id, toolCallId, "approved");
  }

  async denyToolCall(id: string, toolCallId: string): Promise<AgentSession> {
    return this.resolveToolCall(id, toolCallId, "denied");
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
      return JSON.parse(raw) as AgentSession;
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
    session.status = status === "approved" ? "running" : "blocked";
    await this.save(session);
    return session;
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

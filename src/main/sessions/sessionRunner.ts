import { randomUUID } from "node:crypto";
import { BrowserWindow } from "electron";
import type { AgentMessage, AgentSession, WorkflowTemplate } from "../../shared/types.js";
import type { ClaudeAgentRunner } from "../agent/claudeAgentRunner.js";
import type { SessionStore } from "../sessions/sessionStore.js";
import { WorkflowEngine } from "../workflows/workflowEngine.js";

/**
 * 从 ipc.ts 提取的后台会话执行器。
 * 供 IPC handler 和 SessionOrchestrator 共用同一执行路径。
 */

const backgroundSessionRuns = new Map<string, Promise<void>>();

export interface SessionRunDeps {
  runner: ClaudeAgentRunner;
  sessions: SessionStore;
  session: AgentSession;
  workflow: WorkflowTemplate;
  queuedUserMessages: Map<string, AgentMessage[]>;
  /** 工作流引擎（可选），用于 follow-up 消息的阶段管理。 */
  workflowEngine?: WorkflowEngine;
  /** 会话完成后可能的回调（如 PR 提交）。 */
  onComplete?: (session: AgentSession) => Promise<void>;
  /** 会话失败后的回调。 */
  onFailure?: (session: AgentSession, error: Error) => Promise<void>;
}

export function runSessionInBackground(deps: SessionRunDeps): void {
  const { runner, sessions, session, workflow, queuedUserMessages, workflowEngine, onComplete, onFailure } = deps;

  const backgroundRun = runner
    .run({
      session,
      workflow,
      onProgress: async (updated) => {
        await sessions.save(updated);
        broadcastSessionProgress(updated);
      },
      takeQueuedUserMessages: () => {
        const queued = queuedUserMessages.get(session.id) ?? [];
        if (queued.length > 0) {
          queuedUserMessages.delete(session.id);
        }
        return queued;
      }
    })
    .then(async (updated) => {
      const queued = queuedUserMessages.get(updated.id) ?? [];
      if (queued.length > 0) {
        queuedUserMessages.delete(updated.id);
        appendMissingMessages(updated, queued);
        updated.progress_events ??= [];
        updated.progress_events.push({
          id: randomUUID(),
          type: "status",
          message: `继续处理 ${queued.length} 条运行期间收到的用户消息。`,
          visibility: "milestone",
          created_at: new Date().toISOString()
        });
        if (updated.status !== "waiting_approval") {
          const engine = workflowEngine ?? new WorkflowEngine();
          if (!engine.getActiveStageRun(updated)) {
            engine.startFollowUp(updated, workflow, queued.at(-1)?.content || "Follow-up user message");
          } else {
            updated.status = "running";
          }
        }
        await sessions.save(updated);
        broadcastSessionProgress(updated);
        if (updated.status === "running") {
          runSessionInBackground({ ...deps, session: updated });
        }
        return;
      }
      await sessions.save(updated);
      broadcastSessionProgress(updated);

      // 触发完成回调
      if (updated.status === "completed" && onComplete) {
        await onComplete(updated);
      }
    })
    .catch(async (error) => {
      const queued = queuedUserMessages.get(session.id) ?? [];
      if (queued.length > 0) {
        queuedUserMessages.delete(session.id);
        appendMissingMessages(session, queued);
      }
      session.status = "failed";
      session.error = error instanceof Error ? error.message : String(error);
      await sessions.save(session);
      broadcastSessionProgress(session);

      // 触发失败回调
      if (onFailure) {
        await onFailure(session, error instanceof Error ? error : new Error(String(error)));
      }
    });

  backgroundSessionRuns.set(session.id, backgroundRun);
  void backgroundRun.finally(() => {
    if (backgroundSessionRuns.get(session.id) === backgroundRun) {
      backgroundSessionRuns.delete(session.id);
    }
  }).catch(() => undefined);
}

export async function stopBackgroundSession(
  runner: ClaudeAgentRunner,
  sessionId: string,
  queuedUserMessages: Map<string, AgentMessage[]>
): Promise<void> {
  while (true) {
    queuedUserMessages.delete(sessionId);
    runner.abort(sessionId);
    const active = backgroundSessionRuns.get(sessionId);
    if (!active) break;
    await active;
    if (backgroundSessionRuns.get(sessionId) === active) {
      backgroundSessionRuns.delete(sessionId);
    }
  }
  queuedUserMessages.delete(sessionId);
}

function appendMissingMessages(session: AgentSession, messages: AgentMessage[]): void {
  for (const message of messages) {
    const exists = session.messages.some(
      (item) =>
        item.role === message.role &&
        item.created_at === message.created_at &&
        item.content === message.content
    );
    if (!exists) {
      session.messages.push(message);
    }
  }
}

function broadcastSessionProgress(session: AgentSession): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("session:progress", session);
  }
}

import type { AgentSession } from "../../shared/types.js";

export interface SessionSelectionOptions {
  currentSessionId?: string | null;
  preferredSessionId?: string | null;
  projectPath?: string;
  workflowId?: string;
  preferLatestForWorkflow?: boolean;
}

export function getVisibleSessions(sessions: AgentSession[], projectPath?: string): AgentSession[] {
  if (!projectPath) {
    return sessions;
  }
  return sessions.filter((session) => session.project_path === projectPath);
}

export function resolveActiveSessionId(sessions: AgentSession[], options: SessionSelectionOptions): string | null {
  const visibleSessions = getVisibleSessions(sessions, options.projectPath);
  const preferredSession = findSession(visibleSessions, options.preferredSessionId);
  if (preferredSession) {
    return preferredSession.id;
  }

  const currentSession = findSession(visibleSessions, options.currentSessionId);
  if (currentSession && !options.preferLatestForWorkflow) {
    return currentSession.id;
  }

  const workflowSession = options.workflowId
    ? visibleSessions.find((session) => session.workflow_id === options.workflowId)
    : undefined;
  if (workflowSession) {
    return workflowSession.id;
  }

  if (options.preferLatestForWorkflow || (options.workflowId && !currentSession)) {
    return null;
  }

  return currentSession?.id ?? visibleSessions[0]?.id ?? null;
}

function findSession(sessions: AgentSession[], sessionId?: string | null): AgentSession | undefined {
  if (!sessionId) {
    return undefined;
  }
  return sessions.find((session) => session.id === sessionId);
}

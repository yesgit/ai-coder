import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import type { AgentSession, AppApi, Attachment, ResolveWorkflowInput, StartSessionInput } from "../shared/types.js";

const api: AppApi = {
  selectProjectDirectory: () => ipcRenderer.invoke("project:select"),
  authorizeSessionProject: (projectPath: string) => ipcRenderer.invoke("project:authorize-session-project", projectPath),
  getAgentRuntimeStatus: () => ipcRenderer.invoke("agent:get-status"),
  getProjectOnboardingStatus: (projectPath: string) => ipcRenderer.invoke("project:onboarding-status", projectPath),
  confirmProjectOnboarding: (projectPath: string) => ipcRenderer.invoke("project:confirm-onboarding", projectPath),
  listWorkflows: (projectPath?: string) => ipcRenderer.invoke("workflows:list", projectPath),
  resolveWorkflow: (input: ResolveWorkflowInput) => ipcRenderer.invoke("workflows:resolve", input),
  startSession: (input: StartSessionInput) => ipcRenderer.invoke("sessions:start", input),
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  getSession: (id: string) => ipcRenderer.invoke("sessions:get", id),
  approveStage: (sessionId: string, stageId: string) => ipcRenderer.invoke("sessions:approve-stage", sessionId, stageId),
  approveRework: (sessionId: string, requestId: string) => ipcRenderer.invoke("sessions:approve-rework", sessionId, requestId),
  approveToolCall: (sessionId: string, toolCallId: string) =>
    ipcRenderer.invoke("sessions:approve-tool-call", sessionId, toolCallId),
  denyToolCall: (sessionId: string, toolCallId: string) => ipcRenderer.invoke("sessions:deny-tool-call", sessionId, toolCallId),
  continueSession: (sessionId: string) => ipcRenderer.invoke("sessions:continue", sessionId),
  resumeSession: (sessionId: string) => ipcRenderer.invoke("sessions:resume", sessionId),
  abortSession: (sessionId: string) => ipcRenderer.invoke("sessions:abort", sessionId),
  restartSession: (sessionId: string) => ipcRenderer.invoke("sessions:restart", sessionId),
  resetSessionContext: (sessionId: string) => ipcRenderer.invoke("sessions:reset-context", sessionId),
  answerHumanQuestion: (sessionId: string, questionId: string, answer: string | string[]) =>
    ipcRenderer.invoke("sessions:answer-human-question", sessionId, questionId, answer),
  sendMessage: (sessionId: string, message: string, attachments?: Attachment[]) =>
    ipcRenderer.invoke("sessions:send-message", sessionId, message, attachments),
  setSessionPinned: (sessionId: string, pinned: boolean) => ipcRenderer.invoke("sessions:set-pinned", sessionId, pinned),
  setSessionArchived: (sessionId: string, archived: boolean) => ipcRenderer.invoke("sessions:set-archived", sessionId, archived),
  deleteSession: (sessionId: string) => ipcRenderer.invoke("sessions:delete", sessionId),
  listProjectFiles: (projectPath: string, query?: string) =>
    ipcRenderer.invoke("project:list-files", projectPath, query),
  readProjectFile: (projectPath: string, filePath: string) =>
    ipcRenderer.invoke("project:read-file", projectPath, filePath),
  onSessionProgress: (cb: (session: AgentSession) => void) => {
    const handler = (_event: IpcRendererEvent, session: AgentSession) => cb(session);
    ipcRenderer.on("session:progress", handler);
    return () => {
      ipcRenderer.removeListener("session:progress", handler);
    };
  }
};

contextBridge.exposeInMainWorld("aiCoder", api);

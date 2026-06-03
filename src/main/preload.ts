import { contextBridge, ipcRenderer } from "electron";
import type { AppApi, StartSessionInput } from "../shared/types.js";

const api: AppApi = {
  selectProjectDirectory: () => ipcRenderer.invoke("project:select"),
  listWorkflows: (projectPath?: string) => ipcRenderer.invoke("workflows:list", projectPath),
  startSession: (input: StartSessionInput) => ipcRenderer.invoke("sessions:start", input),
  listSessions: () => ipcRenderer.invoke("sessions:list"),
  getSession: (id: string) => ipcRenderer.invoke("sessions:get", id),
  approveStage: (sessionId: string, stageId: string) => ipcRenderer.invoke("sessions:approve-stage", sessionId, stageId),
  approveToolCall: (sessionId: string, toolCallId: string) =>
    ipcRenderer.invoke("sessions:approve-tool-call", sessionId, toolCallId),
  denyToolCall: (sessionId: string, toolCallId: string) => ipcRenderer.invoke("sessions:deny-tool-call", sessionId, toolCallId),
  continueSession: (sessionId: string) => ipcRenderer.invoke("sessions:continue", sessionId)
};

contextBridge.exposeInMainWorld("aiCoder", api);

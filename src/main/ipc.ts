import { dialog, ipcMain } from "electron";
import type { StartSessionInput } from "../shared/types.js";
import { ClaudeAgentRunner } from "./agent/claudeAgentRunner.js";
import { AuthorizedProjects } from "./security/authorizedProjects.js";
import { SessionStore } from "./sessions/sessionStore.js";
import { WorkflowRegistry } from "./workflows/workflowRegistry.js";

export function registerIpcHandlers(registry: WorkflowRegistry, sessions: SessionStore, runner: ClaudeAgentRunner): void {
  const authorizedProjects = new AuthorizedProjects();

  ipcMain.handle("project:select", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"]
    });
    return result.canceled ? null : authorizedProjects.authorize(result.filePaths[0]);
  });

  ipcMain.handle("workflows:list", async (_event, projectPath?: string) => {
    const authorizedProjectPath = projectPath ? await authorizedProjects.assertAuthorized(projectPath) : undefined;
    return registry.listWithIssues(authorizedProjectPath);
  });

  ipcMain.handle("sessions:list", async () => sessions.list());

  ipcMain.handle("sessions:get", async (_event, id: string) => {
    const session = await sessions.get(id);
    if (session) {
      await authorizedProjects.assertAuthorized(session.project_path);
    }
    return session;
  });

  ipcMain.handle("sessions:approve-stage", async (_event, sessionId: string, stageId: string) => {
    const session = await sessions.approveStage(sessionId, stageId);
    const projectPath = await authorizedProjects.assertAuthorized(session.project_path);
    const workflow = await registry.get(session.workflow_id, projectPath);
    if (!workflow) {
      throw new Error(`Workflow not found: ${session.workflow_id}`);
    }
    const updated = await runner.run({ session, workflow });
    await sessions.save(updated);
    return updated;
  });

  ipcMain.handle("sessions:approve-tool-call", async (_event, sessionId: string, toolCallId: string) => {
    const session = await sessions.approveToolCall(sessionId, toolCallId);
    await authorizedProjects.assertAuthorized(session.project_path);
    return session;
  });

  ipcMain.handle("sessions:deny-tool-call", async (_event, sessionId: string, toolCallId: string) => {
    const session = await sessions.denyToolCall(sessionId, toolCallId);
    await authorizedProjects.assertAuthorized(session.project_path);
    return session;
  });

  ipcMain.handle("sessions:continue", async (_event, sessionId: string) => {
    const session = await sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const projectPath = await authorizedProjects.assertAuthorized(session.project_path);
    const workflow = await registry.get(session.workflow_id, projectPath);
    if (!workflow) {
      throw new Error(`Workflow not found: ${session.workflow_id}`);
    }
    session.status = "running";
    const updated = await runner.run({ session, workflow });
    await sessions.save(updated);
    return updated;
  });

  ipcMain.handle("sessions:start", async (_event, input: StartSessionInput) => {
    if (!input.projectPath || !input.workflowId || !input.taskPrompt.trim()) {
      throw new Error("projectPath, workflowId, and taskPrompt are required");
    }
    const projectPath = await authorizedProjects.assertAuthorized(input.projectPath);
    const workflow = await registry.get(input.workflowId, projectPath);
    if (!workflow) {
      throw new Error(`Workflow not found: ${input.workflowId}`);
    }
    const session = await sessions.create(projectPath, workflow, input.taskPrompt.trim());
    session.status = "running";
    const updated = await runner.run({ session, workflow });
    await sessions.save(updated);
    return { session: updated };
  });
}

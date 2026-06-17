import { app, BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeAgentRunner } from "./agent/claudeAgentRunner.js";
import { registerIpcHandlers } from "./ipc.js";
import { SessionStore } from "./sessions/sessionStore.js";
import { WorkflowRegistry } from "./workflows/workflowRegistry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure PATH includes common node locations for AppImage
function setupEnvironment(): void {
  const nodePaths = [
    "/usr/bin",
    "/usr/local/bin",
    "/snap/bin",
    "/home/linuxbrew/.linuxbrew/bin",
    process.env.HOME ? path.join(process.env.HOME, ".nvm", "current", "bin") : "",
    process.env.HOME ? path.join(process.env.HOME, ".fnm", "bin") : ""
  ].filter(Boolean);

  const currentPath = process.env.PATH || "";
  const newPath = [...nodePaths, ...currentPath.split(":").filter(Boolean)].join(":");
  process.env.PATH = newPath;
}

setupEnvironment();

async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: "AI Coder 本地工作流 Agent",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await window.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

const builtinWorkflowDir = app.isPackaged
  ? path.join(process.resourcesPath, "workflows")
  : path.join(app.getAppPath(), "workflows");

registerIpcHandlers(new WorkflowRegistry(builtinWorkflowDir), new SessionStore(), new ClaudeAgentRunner());

app.whenReady().then(createWindow);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

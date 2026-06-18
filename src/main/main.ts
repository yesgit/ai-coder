import { app, BrowserWindow } from "electron";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ClaudeAgentRunner } from "./agent/claudeAgentRunner.js";
import { registerIpcHandlers } from "./ipc.js";
import { SessionStore } from "./sessions/sessionStore.js";
import { WorkflowRegistry } from "./workflows/workflowRegistry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const execFileAsync = promisify(execFile);

// AppImage launches with a minimal PATH that often misses nvm/fnm/volta/etc.
// Augment PATH so child processes (Claude Agent SDK) can find binaries.
async function setupEnvironment(): Promise<void> {
  const currentEntries = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const shellEntries = await resolveShellPath();
  const fallbackEntries = [
    "/usr/bin",
    "/usr/local/bin",
    "/snap/bin",
    "/home/linuxbrew/.linuxbrew/bin",
  ];
  // Merge instead of replace so paths the launcher injected (APPDIR, etc.) survive.
  const merged = dedupePath([...currentEntries, ...shellEntries, ...fallbackEntries]);
  process.env.PATH = merged.join(path.delimiter);
}

/** Run a login shell to read the user's PATH (includes nvm/fnm/volta etc.). */
async function resolveShellPath(): Promise<string[]> {
  const shell = process.env.SHELL || "/bin/bash";
  // Reject shells that aren't a plausible absolute path — avoids passing
  // anything weird through to execFile.
  if (!path.isAbsolute(shell)) {
    return [];
  }
  try {
    const { stdout } = await execFileAsync(shell, ["-l", "-c", 'printf "%s" "$PATH"'], {
      timeout: 5000,
      encoding: "utf-8",
    });
    return stdout.split(path.delimiter).filter((entry) => entry && entry.startsWith("/"));
  } catch {
    return [];
  }
}

function dedupePath(entries: string[]): string[] {
  return Array.from(new Set(entries.filter(Boolean)));
}

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

app.whenReady().then(async () => {
  // Run PATH discovery in parallel with the first window — never block startup.
  void setupEnvironment();
  await createWindow();
});

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

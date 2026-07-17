import { app, BrowserWindow } from "electron";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ClaudeAgentRunner } from "./agent/claudeAgentRunner.js";
import { resolveCarefulCoderPluginPath } from "./agent/carefulCoderPlugin.js";
import { normalizeAnthropicBaseUrl, selectClaudeProviderEnvironment } from "./agent/claudeRuntime.js";
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

/**
 * Claude Code normally loads ~/.claude/settings.json inside its child process.
 * Import the configured provider environment here as well so the host can fix
 * known protocol-specific base URLs before spawning the Agent SDK.
 */
async function applyClaudeSettingsEnvironment(): Promise<void> {
  try {
    const raw = await readFile(path.join(os.homedir(), ".claude", "settings.json"), "utf8");
    const parsed = JSON.parse(raw) as { env?: Record<string, unknown> };
    for (const [key, value] of Object.entries(parsed.env ?? {})) {
      if (process.env[key] === undefined && typeof value === "string") {
        process.env[key] = value;
      }
    }
  } catch {
    // Missing or malformed user settings remain Claude Code's responsibility.
  }
  const normalizedBaseUrl = normalizeAnthropicBaseUrl(process.env.ANTHROPIC_BASE_URL);
  if (normalizedBaseUrl !== undefined) {
    process.env.ANTHROPIC_BASE_URL = normalizedBaseUrl;
  }
}

async function applyMiseEnvironment(): Promise<void> {
  const home = os.homedir();
  const candidates = dedupePath([
    ...(process.env.PATH ?? "").split(path.delimiter)
      .filter(Boolean)
      .map((dir) => path.join(dir, "mise")),
    path.join(home, ".local", "bin", "mise"),
    path.join(home, ".local", "share", "mise", "bin", "mise")
  ]);
  let misePath: string | undefined;
  for (const candidate of candidates) {
    try {
      await access(candidate);
      misePath = candidate;
      break;
    } catch {
      // try next candidate
    }
  }
  if (!misePath) return;

  try {
    const { stdout } = await execFileAsync(misePath, ["env", "--json"], {
      timeout: 5000,
      encoding: "utf8"
    });
    const exported = selectClaudeProviderEnvironment(JSON.parse(stdout) as Record<string, unknown>);
    for (const [key, value] of Object.entries(exported)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    // mise is optional; Claude settings and inherited environment remain available.
  }
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
    title: "谨慎程序员",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (!app.isPackaged && process.env.VITE_DEV_SERVER_URL) {
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    await window.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

const builtinWorkflowDir = app.isPackaged
  ? path.join(process.resourcesPath, "workflows")
  : path.join(app.getAppPath(), "workflows");
const carefulCoderPluginPath = resolveCarefulCoderPluginPath({
  appPath: app.getAppPath(),
  resourcesPath: process.resourcesPath,
  isPackaged: app.isPackaged
});

const sessions = new SessionStore();

registerIpcHandlers(
  new WorkflowRegistry(builtinWorkflowDir),
  sessions,
  new ClaudeAgentRunner({ pluginPaths: [carefulCoderPluginPath] })
);

/**
 * 应用启动时把磁盘上仍然停留在 running / waiting_approval 的会话标为 interrupted。
 * 这些会话原先的 runner 已随上次进程退出而消失，再没人推进；标记后会在渲染端
 * 暴露「断点恢复」按钮，点击会走 sessions:resume 起一次新的 attempt。
 */
async function reconcileInterruptedSessions(store: SessionStore): Promise<void> {
  try {
    const all = await store.list();
    await Promise.all(
      all
        .filter((session) => session.status === "running" || session.status === "waiting_approval")
        .map(async (session) => {
          session.status = "interrupted";
          await store.save(session);
        })
    );
  } catch (error) {
    // Reconcile 不应阻塞启动；仅打印
    console.warn("Failed to reconcile interrupted sessions:", error);
  }
}

app.whenReady().then(async () => {
  // Desktop/AppImage launches do not inherit mise's activated shell environment.
  await setupEnvironment();
  await applyMiseEnvironment();
  await applyClaudeSettingsEnvironment();
  await reconcileInterruptedSessions(sessions);
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

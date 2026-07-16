import { execFile } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import type { AgentRuntimeStatus, AvailableModel } from "../../shared/types.js";

const execFileAsync = promisify(execFile);

let nodeExecutablePromise: Promise<NodeExecutableInfo | null> | undefined;

/** 从 SDK 获取的可用模型列表缓存 */
let cachedModelsPromise: Promise<AvailableModel[]> | null = null;

export interface NodeExecutableInfo {
  /** Absolute path to the binary to spawn. */
  command: string;
  /** Extra env to merge into the spawn (e.g. ELECTRON_RUN_AS_NODE=1). */
  env?: Record<string, string>;
  /** Source used for diagnostics. */
  source: "system" | "electron";
}

export async function getClaudeRuntimeStatus(): Promise<AgentRuntimeStatus> {
  const [sdkAvailable, nodeInfo, authAvailable] = await Promise.all([
    isClaudeSdkAvailable(),
    resolveNodeExecutable(),
    hasClaudeAuth()
  ]);
  const diagnostics: string[] = [];

  if (!sdkAvailable) {
    diagnostics.push("Claude Agent SDK package is not available.");
  }
  if (!nodeInfo) {
    diagnostics.push("No Node.js runtime could be located (system node missing and Electron fallback failed).");
  } else if (nodeInfo.source === "electron") {
    diagnostics.push("Using bundled Electron as Node runtime (ELECTRON_RUN_AS_NODE).");
  }
  if (!authAvailable) {
    diagnostics.push("No Claude credentials detected. Run `claude login` or set ANTHROPIC_API_KEY.");
  }

  return {
    mode: sdkAvailable ? "live" : "mock",
    sdk_available: sdkAvailable,
    node_runtime_available: Boolean(nodeInfo),
    auth_env_available: authAvailable,
    diagnostics
  };
}

export async function shouldUseClaudeSdk(): Promise<boolean> {
  return isClaudeSdkAvailable();
}

/**
 * Locate a usable node binary. The Claude Agent SDK spawns `node <sdk>/cli.js`,
 * so we need an absolute path that works under AppImage where PATH is minimal.
 *
 * Strategy:
 *  1. Try to find a real system node (PATH / login-shell / common install dirs)
 *  2. Fall back to the Electron binary with ELECTRON_RUN_AS_NODE=1
 *     — Electron embeds Node and runs as plain Node when this env is set,
 *       so the SDK's spawn always succeeds even if no node is installed.
 *
 * Concurrent callers share the same in-flight Promise so the (potentially
 * 5s) login-shell probe runs only once.
 */
export async function resolveNodeExecutable(): Promise<NodeExecutableInfo | null> {
  if (!nodeExecutablePromise) {
    nodeExecutablePromise = detectNodeExecutable();
  }
  return nodeExecutablePromise;
}

async function detectNodeExecutable(): Promise<NodeExecutableInfo | null> {
  const candidates: string[] = [];

  // process.execPath in plain Node points to node; in Electron it points to the Electron binary.
  if (process.execPath && path.basename(process.execPath).toLowerCase().includes("node")) {
    candidates.push(process.execPath);
  }

  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(dir, "node"));
  }

  const shellResolved = await resolveViaLoginShell();
  if (shellResolved) {
    candidates.push(shellResolved);
  }

  const home = os.homedir();
  if (home) {
    candidates.push(...expandNvmCandidates(path.join(home, ".nvm", "versions", "node")));
    candidates.push(path.join(home, ".local", "bin", "node"));
    candidates.push(path.join(home, ".volta", "bin", "node"));
  }
  candidates.push("/usr/bin/node", "/usr/local/bin/node", "/snap/bin/node");

  for (const candidate of dedupe(candidates)) {
    if (await isExecutableFile(candidate)) {
      return { command: candidate, source: "system" };
    }
  }

  // Final fallback: use Electron itself as a Node runtime.
  // This always works inside Electron because process.execPath IS the Electron binary,
  // which becomes a plain Node REPL when ELECTRON_RUN_AS_NODE=1 is set.
  if (process.versions.electron && process.execPath) {
    return {
      command: process.execPath,
      source: "electron",
      env: { ELECTRON_RUN_AS_NODE: "1" }
    };
  }
  return null;
}

function expandNvmCandidates(versionsDir: string): string[] {
  try {
    if (!existsSync(versionsDir)) {
      return [];
    }
    return readdirSync(versionsDir).map((entry) => path.join(versionsDir, entry, "bin", "node"));
  } catch {
    return [];
  }
}

async function resolveViaLoginShell(): Promise<string | null> {
  const shell = process.env.SHELL || "/bin/bash";
  // Refuse to invoke a shell whose path isn't absolute — keeps execFile honest
  // and avoids surprises if SHELL is unset or set to a bare name.
  if (!path.isAbsolute(shell)) {
    return null;
  }
  try {
    const { stdout } = await execFileAsync(shell, ["-l", "-c", "command -v node"], {
      timeout: 5000,
      encoding: "utf-8"
    });
    const out = stdout.trim();
    if (out.startsWith("/")) {
      return out;
    }
  } catch {
    // fall through
  }
  return null;
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) {
      return false;
    }
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function dedupe(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

async function isClaudeSdkAvailable(): Promise<boolean> {
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    return typeof (sdk as { query?: unknown }).query === "function";
  } catch {
    return false;
  }
}

async function hasClaudeAuth(): Promise<boolean> {
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return true;
  }
  const home = os.homedir();
  if (!home) {
    return false;
  }
  const credPaths = [
    path.join(home, ".claude", ".credentials.json"),
    path.join(home, ".claude", "credentials.json"),
    path.join(home, ".config", "claude", "credentials.json")
  ];
  for (const p of credPaths) {
    if (await isCredentialsFileValid(p)) {
      return true;
    }
  }
  return false;
}

/**
 * 从 Claude Agent SDK 动态获取可用模型列表。
 * 结果会被缓存，多次调用共享同一个 Promise。
 */
export async function fetchAvailableModels(): Promise<AvailableModel[]> {
  if (!cachedModelsPromise) {
    cachedModelsPromise = doFetchModels();
  }
  return cachedModelsPromise;
}

async function doFetchModels(): Promise<AvailableModel[]> {
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const queryFn = (sdk as { query?: unknown }).query;
    if (typeof queryFn !== "function") {
      return [];
    }

    const nodeInfo = await resolveNodeExecutable();
    const abortController = new AbortController();

    // 5 秒超时——获取模型列表不应该花太长时间
    const timeout = setTimeout(() => abortController.abort(), 5000);

    try {
      const q = (queryFn as (params: {
        prompt: string;
        options?: Record<string, unknown>;
      }) => AsyncIterable<unknown>)({
        prompt: ".",
        options: {
          cwd: process.cwd(),
          executable: nodeInfo?.command ?? undefined,
          env: nodeInfo?.env ? { ...process.env, ...nodeInfo.env } : undefined,
          abortController,
          // 禁用所有工具，只跑 init 即可
          tools: [],
          settingSources: ["user", "project", "local"] as string[]
        }
      });

      for await (const msg of q) {
        if (isPlainObject(msg) && (msg as Record<string, unknown>).type === "system" && (msg as Record<string, unknown>).subtype === "init") {
          const data = isPlainObject((msg as Record<string, unknown>).data)
            ? ((msg as Record<string, unknown>).data as Record<string, unknown>)
            : (msg as Record<string, unknown>);
          const models = Array.isArray(data.models) ? (data.models as AvailableModel[]) : [];
          // 中断后续处理——拿到模型列表就够了
          try { await (q as { interrupt?: () => Promise<void> }).interrupt?.(); } catch { /* ignore */ }
          return models;
        }
        break; // 第一个消息不是 init 就放弃
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    // SDK 不可用时返回空列表
  }
  return [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function isCredentialsFileValid(filePath: string): Promise<boolean> {
  try {
    const raw = await readFile(filePath, "utf-8");
    if (!raw.trim()) {
      return false;
    }
    const parsed = JSON.parse(raw) as Record<string, unknown> | undefined;
    if (!parsed || typeof parsed !== "object") {
      return false;
    }
    // Common shapes from `claude login` / API key helpers — accept if any
    // recognisable token field carries a non-empty value.
    const tokenFields = ["accessToken", "access_token", "apiKey", "api_key", "oauthToken", "claudeAiOauth"];
    return tokenFields.some((field) => {
      const value = (parsed as Record<string, unknown>)[field];
      if (typeof value === "string") {
        return value.length > 0;
      }
      return value !== undefined && value !== null;
    });
  } catch {
    return false;
  }
}

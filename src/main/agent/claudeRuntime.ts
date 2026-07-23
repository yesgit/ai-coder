import { execFile } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import type { AgentRuntimeStatus } from "../../shared/types.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

let nodeExecutablePromise: Promise<NodeExecutableInfo | null> | undefined;

export interface NodeExecutableInfo {
  /** Absolute path to the binary to spawn. */
  command: string;
  /** Extra env to merge into the spawn (e.g. ELECTRON_RUN_AS_NODE=1). */
  env?: Record<string, string>;
  /** Source used for diagnostics. */
  source: "system" | "electron";
}

export function normalizeAnthropicBaseUrl(value: string | undefined): string | undefined {
  if (!value) return value;
  try {
    const url = new URL(value);
    if (url.hostname === "api.deepseek.com" && (url.pathname === "" || url.pathname === "/")) {
      url.pathname = "/anthropic";
      return url.toString().replace(/\/$/, "");
    }
  } catch {
    // Preserve invalid/custom values so Claude Code can report them verbatim.
  }
  return value;
}

export function selectClaudeProviderEnvironment(
  source: Record<string, unknown>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) => (
      typeof value === "string"
      && (
        key.startsWith("ANTHROPIC_")
        || key === "CLAUDE_CODE_SUBAGENT_MODEL"
        || key === "CLAUDE_CODE_EFFORT_LEVEL"
      )
    ))
  ) as Record<string, string>;
}

export async function getClaudeRuntimeStatus(): Promise<AgentRuntimeStatus> {
  const nativeClaudeCode = resolveBundledClaudeCodeExecutable();
  const [sdkAvailable, nodeInfo, authAvailable] = await Promise.all([
    isClaudeSdkAvailable(),
    resolveNodeExecutable(),
    hasClaudeAuth()
  ]);
  const diagnostics: string[] = [];

  if (!sdkAvailable) {
    diagnostics.push("Claude Agent SDK package is not available.");
  }
  if (!nodeInfo && !nativeClaudeCode) {
    diagnostics.push("No Node.js runtime could be located (system node missing and Electron fallback failed).");
  } else if (nativeClaudeCode) {
    diagnostics.push("Using bundled native Claude Code runtime.");
  } else if (nodeInfo?.source === "electron") {
    diagnostics.push("Using bundled Electron as Node runtime (ELECTRON_RUN_AS_NODE).");
  }
  if (!authAvailable) {
    diagnostics.push("No Claude credentials detected. Run `claude login` or set ANTHROPIC_API_KEY.");
  }

  return {
    mode: sdkAvailable ? "live" : "mock",
    sdk_available: sdkAvailable,
    node_runtime_available: Boolean(nodeInfo || nativeClaudeCode),
    auth_env_available: authAvailable,
    diagnostics
  };
}

/**
 * SDK 0.3+ ships Claude Code as a platform-native executable. Electron cannot execute a
 * binary directly from app.asar, so packaging places it in app.asar.unpacked and this
 * resolver rewrites the virtual path to the real filesystem path.
 */
export function resolveBundledClaudeCodeExecutable(): string | undefined {
  const packageName = claudeCodePlatformPackage();
  if (!packageName) return undefined;
  try {
    const resolved = require.resolve(`${packageName}/claude${process.platform === "win32" ? ".exe" : ""}`);
    const unpacked = resolved.replace(
      `${path.sep}app.asar${path.sep}`,
      `${path.sep}app.asar.unpacked${path.sep}`
    );
    return unpacked !== resolved && existsSync(unpacked) ? unpacked : resolved;
  } catch {
    return undefined;
  }
}

function claudeCodePlatformPackage(): string | undefined {
  const arch = process.arch === "x64" || process.arch === "arm64" ? process.arch : undefined;
  if (!arch) return undefined;
  if (process.platform === "darwin") return `@anthropic-ai/claude-agent-sdk-darwin-${arch}`;
  if (process.platform === "win32") return `@anthropic-ai/claude-agent-sdk-win32-${arch}`;
  if (process.platform !== "linux") return undefined;
  const report = (typeof process.report?.getReport === "function"
    ? process.report.getReport()
    : undefined) as { header?: { glibcVersionRuntime?: string } } | undefined;
  const isMusl = Boolean(report && !report.header?.glibcVersionRuntime);
  return `@anthropic-ai/claude-agent-sdk-linux-${arch}${isMusl ? "-musl" : ""}`;
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

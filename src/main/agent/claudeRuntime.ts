import { access } from "node:fs/promises";
import path from "node:path";
import type { AgentRuntimeStatus } from "../../shared/types.js";

export async function getClaudeRuntimeStatus(): Promise<AgentRuntimeStatus> {
  const [sdkAvailable, claudeExecutableAvailable] = await Promise.all([isClaudeSdkAvailable(), isExecutableOnPath("claude")]);
  const authEnvAvailable = Boolean(process.env.ANTHROPIC_API_KEY);
  const diagnostics: string[] = [];

  if (!sdkAvailable) {
    diagnostics.push("Claude Agent SDK package is not available.");
  }
  if (!claudeExecutableAvailable) {
    diagnostics.push("Claude Code executable was not found on PATH.");
  }
  if (!authEnvAvailable) {
    diagnostics.push("ANTHROPIC_API_KEY is not set; Claude Code authentication may still be available.");
  }

  return {
    mode: sdkAvailable ? "live" : "mock",
    sdk_available: sdkAvailable,
    claude_executable_available: claudeExecutableAvailable,
    auth_env_available: authEnvAvailable,
    diagnostics
  };
}

export async function shouldUseClaudeSdk(): Promise<boolean> {
  return (await isClaudeSdkAvailable());
}

async function isClaudeSdkAvailable(): Promise<boolean> {
  try {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    return typeof (sdk as { query?: unknown }).query === "function";
  } catch {
    return false;
  }
}

async function isExecutableOnPath(command: string): Promise<boolean> {
  const pathValue = process.env.PATH ?? "";
  const candidates = pathValue
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, command));

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return true;
    } catch {
      // Continue searching PATH.
    }
  }

  return false;
}

import { describe, expect, it } from "vitest";
import { normalizeAnthropicBaseUrl, selectClaudeProviderEnvironment } from "./agent/claudeRuntime.js";

describe("normalizeAnthropicBaseUrl", () => {
  it("uses DeepSeek's Anthropic-compatible endpoint", () => {
    expect(normalizeAnthropicBaseUrl("https://api.deepseek.com")).toBe(
      "https://api.deepseek.com/anthropic"
    );
    expect(normalizeAnthropicBaseUrl("https://api.deepseek.com/")).toBe(
      "https://api.deepseek.com/anthropic"
    );
  });

  it("preserves explicit provider paths and unrelated gateways", () => {
    expect(normalizeAnthropicBaseUrl("https://api.deepseek.com/anthropic")).toBe(
      "https://api.deepseek.com/anthropic"
    );
    expect(normalizeAnthropicBaseUrl("https://gateway.example.com")).toBe(
      "https://gateway.example.com"
    );
  });
});

describe("selectClaudeProviderEnvironment", () => {
  it("imports model gateway settings from mise without unrelated variables", () => {
    expect(selectClaudeProviderEnvironment({
      ANTHROPIC_BASE_URL: "https://gateway.example.com",
      ANTHROPIC_AUTH_TOKEN: "secret",
      ANTHROPIC_MODEL: "Qwen3.5-397B",
      CLAUDE_CODE_EFFORT_LEVEL: "max",
      PATH: "/untrusted/path",
      PIP_INDEX_URL: "https://pypi.example.com"
    })).toEqual({
      ANTHROPIC_BASE_URL: "https://gateway.example.com",
      ANTHROPIC_AUTH_TOKEN: "secret",
      ANTHROPIC_MODEL: "Qwen3.5-397B",
      CLAUDE_CODE_EFFORT_LEVEL: "max"
    });
  });
});

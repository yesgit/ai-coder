import { describe, expect, it } from "vitest";
import { getClaudeRuntimeStatus, shouldUseClaudeSdk } from "./claudeRuntime.js";

describe("claude runtime", () => {
  it("detects the installed Claude Agent SDK", async () => {
    await expect(shouldUseClaudeSdk()).resolves.toBe(true);
  });

  it("returns runtime diagnostics without requiring an API key", async () => {
    const status = await getClaudeRuntimeStatus();

    expect(status.sdk_available).toBe(true);
    expect(status.mode).toBe("live");
    expect(status.diagnostics).toEqual(expect.any(Array));
  });
});

import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCarefulCoderPluginPath } from "./carefulCoderPlugin.js";

describe("resolveCarefulCoderPluginPath", () => {
  it("uses the repository Plugin in development", () => {
    expect(resolveCarefulCoderPluginPath({
      appPath: "/workspace/ai-coder",
      resourcesPath: "/ignored",
      isPackaged: false
    })).toBe(path.join("/workspace/ai-coder", "plugins", "careful-coder"));
  });

  it("uses Electron resources after packaging", () => {
    expect(resolveCarefulCoderPluginPath({
      appPath: "/ignored",
      resourcesPath: "/opt/Careful Coder/resources",
      isPackaged: true
    })).toBe(path.join("/opt/Careful Coder/resources", "plugins", "careful-coder"));
  });
});

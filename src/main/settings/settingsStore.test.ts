import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsStore } from "./settingsStore.js";
import { DEFAULT_APP_SETTINGS } from "../../shared/types.js";

describe("SettingsStore", () => {
  it("returns defaults when no settings file exists", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-settings-"));
    const store = new SettingsStore(dir);

    const settings = await store.get();
    expect(settings).toEqual(DEFAULT_APP_SETTINGS);
  });

  it("persists updates and reads them back", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-settings-"));
    const store = new SettingsStore(dir);

    const updated = await store.update({ commit_mark: "Co-authored-by: AI Coder <ai@coder.local>" });
    expect(updated.commit_mark).toBe("Co-authored-by: AI Coder <ai@coder.local>");
    expect(updated.commit_mark_enabled).toBe(true);

    const reread = await store.get();
    expect(reread.commit_mark).toBe("Co-authored-by: AI Coder <ai@coder.local>");
  });

  it("merges partial updates with existing settings", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-settings-"));
    const store = new SettingsStore(dir);

    await store.update({ commit_mark: "Custom Mark" });
    const updated = await store.update({ commit_mark_enabled: false });
    expect(updated).toEqual({
      commit_mark: "Custom Mark",
      commit_mark_enabled: false
    });
  });

  it("getCommitMark returns trimmed mark when enabled", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-settings-"));
    const store = new SettingsStore(dir);

    await store.update({ commit_mark: "  Generated-by: AI Coder  " });
    const mark = await store.getCommitMark();
    expect(mark).toBe("Generated-by: AI Coder");
  });

  it("getCommitMark returns empty string when disabled", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-settings-"));
    const store = new SettingsStore(dir);

    await store.update({ commit_mark: "Generated-by: AI Coder", commit_mark_enabled: false });
    const mark = await store.getCommitMark();
    expect(mark).toBe("");
  });

  it("getCommitMark returns empty string when mark is blank", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-settings-"));
    const store = new SettingsStore(dir);

    await store.update({ commit_mark: "   " });
    const mark = await store.getCommitMark();
    expect(mark).toBe("");
  });

  it("sanitizes unknown fields from persisted file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-settings-"));
    const store = new SettingsStore(dir);

    // Write a raw file with extra fields
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "settings.json"),
      JSON.stringify({
        commit_mark: "Custom",
        commit_mark_enabled: true,
        unknown_field: "should be ignored",
        commit_mark_bad_type: 123
      }),
      "utf8"
    );

    const settings = await store.get();
    expect(settings.commit_mark).toBe("Custom");
    expect(settings.commit_mark_enabled).toBe(true);
    expect(settings).not.toHaveProperty("unknown_field");
    expect(settings).not.toHaveProperty("commit_mark_bad_type");
  });
});

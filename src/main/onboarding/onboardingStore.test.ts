import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OnboardingStore } from "./onboardingStore.js";

describe("OnboardingStore", () => {
  it("reports not_started when CLAUDE.md is missing", async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-project-"));
    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-onboarding-"));

    await expect(new OnboardingStore(storeDir).getStatus(projectDir)).resolves.toMatchObject({
      status: "not_started",
      claude_md_exists: false
    });
  });

  it("confirms the current CLAUDE.md hash", async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-project-"));
    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-onboarding-"));
    await fs.writeFile(path.join(projectDir, "CLAUDE.md"), "# Project Context\n", "utf8");

    const store = new OnboardingStore(storeDir);
    const confirmed = await store.confirm(projectDir);

    expect(confirmed).toMatchObject({
      status: "confirmed",
      claude_md_exists: true,
      confirmed_by: "local-user"
    });
  });

  it("treats an empty CLAUDE.md as existing", async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-project-"));
    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-onboarding-"));
    await fs.writeFile(path.join(projectDir, "CLAUDE.md"), "", "utf8");

    await expect(new OnboardingStore(storeDir).getStatus(projectDir)).resolves.toMatchObject({
      status: "claude_md_exists",
      claude_md_exists: true
    });
  });

  it("returns pending_review when CLAUDE.md changes after confirmation", async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-project-"));
    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-onboarding-"));
    const claudeMdPath = path.join(projectDir, "CLAUDE.md");
    await fs.writeFile(claudeMdPath, "# Project Context\n", "utf8");

    const store = new OnboardingStore(storeDir);
    await store.confirm(projectDir);
    await fs.writeFile(claudeMdPath, "# Project Context\n\nUpdated.\n", "utf8");

    await expect(store.getStatus(projectDir)).resolves.toMatchObject({
      status: "pending_review",
      claude_md_exists: true
    });
  });
});

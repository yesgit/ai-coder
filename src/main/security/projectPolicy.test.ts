import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { approveOrDenyToolUse } from "./projectPolicy.js";
import type { AgentSession, WorkflowTemplate } from "../../shared/types.js";

const workflow: WorkflowTemplate = {
  id: "software-engineering",
  name: "Software Engineering",
  version: "1.0.0",
  description: "Test",
  source: { type: "builtin", id: "software-engineering", version: "1.0.0" },
  permissions: { filesystem: { mode: "project-only" }, shell: { approval_required: true }, network: { enabled: false } },
  stages: [{ id: "execute", name: "Execute", allowed_tools: ["read_file", "edit_file", "shell"] }]
};

function session(): AgentSession {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    project_path: "/tmp/project",
    workflow_id: workflow.id,
    task_prompt: "Fix bug",
    status: "running",
    current_stage: "execute",
    messages: [],
    tool_calls: [],
    file_changes: [],
    approvals: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
}

describe("project policy", () => {
  it("denies shell commands while shell approval UI is not implemented", async () => {
    const current = session();

    const decision = await approveOrDenyToolUse(current, workflow, "Bash", { command: "npm test" }, "tool-1");

    expect(decision.allow).toBe(false);
    expect(current.tool_calls[0].status).toBe("blocked");
  });

  it("denies file paths outside the selected project", async () => {
    const current = session();

    const decision = await approveOrDenyToolUse(current, workflow, "Read", { file_path: "/etc/passwd" }, "tool-2");

    expect(decision.allow).toBe(false);
    expect(current.tool_calls[0].status).toBe("blocked");
  });

  it("denies write tools until explicit file approval is implemented", async () => {
    const current = session();

    const decision = await approveOrDenyToolUse(current, workflow, "Edit", { file_path: "src/app.ts" }, "tool-3");

    expect(decision.allow).toBe(false);
    expect(current.tool_calls[0].status).toBe("blocked");
  });

  it("denies project symlinks that resolve outside the selected project", async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-project-"));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-outside-"));
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "secret");
    await fs.symlink(path.join(outsideDir, "secret.txt"), path.join(projectDir, "secret-link.txt"));
    const current = { ...session(), project_path: projectDir };

    const decision = await approveOrDenyToolUse(current, workflow, "Read", { file_path: "secret-link.txt" }, "tool-4");

    expect(decision.allow).toBe(false);
    expect(current.tool_calls[0].status).toBe("blocked");
  });
});

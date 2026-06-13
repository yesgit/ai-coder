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
  rework: { enabled: false, allowed_targets: [], approval_required: true, invalidate_downstream: true },
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
  it("creates pending approval for shell commands", async () => {
    const current = session();

    const decision = await approveOrDenyToolUse(current, workflow, "Bash", { command: "npm test" }, "tool-1");

    expect(decision.allow).toBe(false);
    expect(decision.allow === false ? decision.interrupt : false).toBe(true);
    expect(current.status).toBe("waiting_approval");
    expect(current.tool_calls[0].status).toBe("pending_approval");
  });

  it("denies file paths outside the selected project", async () => {
    const current = session();

    const decision = await approveOrDenyToolUse(current, workflow, "Read", { file_path: "/etc/passwd" }, "tool-2");

    expect(decision.allow).toBe(false);
    expect(decision.allow === false ? decision.interrupt : false).toBe(true);
    expect(current.tool_calls[0].status).toBe("blocked");
  });

  it("creates pending approval for write tools", async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-project-"));
    await fs.mkdir(path.join(projectDir, "src"));
    const current = { ...session(), project_path: projectDir };

    const decision = await approveOrDenyToolUse(current, workflow, "Edit", { file_path: "src/app.ts" }, "tool-3");

    expect(decision.allow).toBe(false);
    expect(current.status).toBe("waiting_approval");
    expect(current.tool_calls[0].status).toBe("pending_approval");
    expect(current.file_changes[0]).toMatchObject({
      path: "src/app.ts",
      operation: "update",
      approved: false
    });
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

  it("allows a previously approved matching tool call once", async () => {
    const current = session();
    current.tool_calls.push({
      id: "tool-5",
      stage_id: "execute",
      tool: "Bash",
      input: { command: "npm test" },
      status: "approved",
      created_at: new Date().toISOString()
    });

    const decision = await approveOrDenyToolUse(current, workflow, "Bash", { command: "npm test" }, "tool-5");

    expect(decision.allow).toBe(true);
    expect(current.tool_calls[0].status).toBe("completed");
  });

  it("allows a previously approved matching tool call even when the SDK uses a new tool id", async () => {
    const current = session();
    current.tool_calls.push({
      id: "tool-original",
      stage_id: "execute",
      tool: "Bash",
      input: { command: "npm test" },
      status: "approved",
      created_at: new Date().toISOString()
    });

    const decision = await approveOrDenyToolUse(current, workflow, "Bash", { command: "npm test" }, "tool-retry");

    expect(decision.allow).toBe(true);
    expect(current.tool_calls[0].status).toBe("completed");
  });

  it("marks a previously approved write tool as completed and approved in file changes", async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-project-"));
    await fs.mkdir(path.join(projectDir, "src"));
    const current = { ...session(), project_path: projectDir };
    current.tool_calls.push({
      id: "tool-write",
      stage_id: "execute",
      tool: "Write",
      input: { file_path: "src/new.ts" },
      status: "approved",
      created_at: new Date().toISOString()
    });
    current.file_changes.push({
      path: "src/new.ts",
      operation: "create",
      approved: false,
      created_at: new Date().toISOString()
    });

    const decision = await approveOrDenyToolUse(current, workflow, "Write", { file_path: "src/new.ts" }, "tool-write");

    expect(decision.allow).toBe(true);
    expect(current.tool_calls[0].status).toBe("completed");
    expect(current.file_changes).toHaveLength(1);
    expect(current.file_changes[0]).toMatchObject({
      path: "src/new.ts",
      operation: "create",
      approved: true
    });
  });
});

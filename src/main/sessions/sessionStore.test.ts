import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "./sessionStore.js";
import type { WorkflowTemplate } from "../../shared/types.js";

const workflow: WorkflowTemplate = {
  id: "plan-execute",
  name: "Plan Execute",
  version: "1.0.0",
  description: "Test",
  source: { type: "builtin", id: "plan-execute", version: "1.0.0" },
  permissions: { filesystem: { mode: "project-only" }, shell: { approval_required: true } },
  rework: { enabled: false, allowed_targets: [], approval_required: true, invalidate_downstream: true },
  stages: [
    { id: "plan", name: "Plan", approval_required: true },
    { id: "execute", name: "Execute" }
  ]
};

describe("SessionStore", () => {
  it("creates sessions with the first stage run", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-sessions-"));
    const store = new SessionStore(dir);

    const session = await store.create("/tmp/project", workflow, "Fix bug");

    expect(session.status).toBe("running");
    expect(session.current_stage).toBe("plan");
    expect(session.approvals).toHaveLength(0);
    expect(session.stage_runs).toHaveLength(1);
    expect(session.stage_runs?.[0]).toMatchObject({ stage_id: "plan", attempt: 1, status: "running" });
  });

  it("records onboarding admission snapshots", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-sessions-"));
    const store = new SessionStore(dir);

    const session = await store.create("/tmp/project", workflow, "Fix bug", {
      status: "pending_review",
      claude_md_hash: "abc123",
      override: true,
      checked_at: new Date().toISOString()
    });

    expect(session.onboarding).toMatchObject({
      status: "pending_review",
      claude_md_hash: "abc123",
      override: true
    });
  });

  it("rejects invalid session ids", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-sessions-"));
    const store = new SessionStore(dir);

    await expect(store.get("../outside")).rejects.toThrow("Invalid session id");
  });

  it("skips corrupt session files while listing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-sessions-"));
    const store = new SessionStore(dir);
    await store.create("/tmp/project", workflow, "Fix bug");
    await fs.writeFile(path.join(dir, "broken.json"), "{", "utf8");

    const sessions = await store.list();

    expect(sessions).toHaveLength(1);
  });

  it("approves and denies pending tool calls", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-sessions-"));
    const store = new SessionStore(dir);
    const session = await store.create("/tmp/project", workflow, "Fix bug");
    session.tool_calls.push({
      id: "tool-1",
      stage_id: "execute",
      tool: "Bash",
      input: { command: "npm test" },
      status: "pending_approval",
      created_at: new Date().toISOString()
    });
    await store.save(session);

    const approved = await store.approveToolCall(session.id, "tool-1");

    expect(approved.tool_calls[0].status).toBe("approved");
    expect(approved.status).toBe("running");
  });
});

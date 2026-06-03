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
  stages: [
    { id: "plan", name: "Plan", approval_required: true },
    { id: "execute", name: "Execute" }
  ]
};

describe("SessionStore", () => {
  it("creates sessions with pending approvals for approval stages", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-sessions-"));
    const store = new SessionStore(dir);

    const session = await store.create("/tmp/project", workflow, "Fix bug");

    expect(session.status).toBe("created");
    expect(session.current_stage).toBe("plan");
    expect(session.approvals).toHaveLength(1);
    expect(session.approvals[0].status).toBe("pending");
  });

  it("approves a pending stage", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-sessions-"));
    const store = new SessionStore(dir);
    const session = await store.create("/tmp/project", workflow, "Fix bug");

    const updated = await store.approveStage(session.id, "plan");

    expect(updated.approvals[0].status).toBe("approved");
    expect(updated.status).toBe("running");
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

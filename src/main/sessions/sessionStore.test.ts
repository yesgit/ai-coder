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
    expect(session.title).toBe("Fix bug");
    expect(session.current_stage).toBe("plan");
    expect(session.initial_user_message).toMatchObject({ role: "user", content: "Fix bug" });
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

  it("records workflow routing snapshots", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-sessions-"));
    const store = new SessionStore(dir);
    const session = await store.create("/tmp/project", workflow, "Fix bug", undefined, undefined, {
      requested_mode: "auto",
      method: "model",
      candidates: [{ workflow_id: workflow.id, name: workflow.name, score: 0.95 }],
      recommended_workflow_id: workflow.id,
      final_workflow_id: workflow.id,
      user_action: "none",
      reason: "Matches software engineering"
    });
    expect(session.routing).toMatchObject({ requested_mode: "auto", method: "model", final_workflow_id: workflow.id });
  });

  it("rejects invalid session ids", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-sessions-"));
    const store = new SessionStore(dir);

    await expect(store.get("../outside")).rejects.toThrow("Invalid session id");
  });

  it("pins, archives, and restores sessions", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-sessions-"));
    const store = new SessionStore(dir);
    const session = await store.create("/tmp/project", workflow, "Fix bug");
    expect((await store.setPinned(session.id, true)).pinned_at).toBeTruthy();
    expect((await store.setArchived(session.id, true)).archived_at).toBeTruthy();
    expect((await store.setPinned(session.id, false)).pinned_at).toBeUndefined();
    expect((await store.setArchived(session.id, false)).archived_at).toBeUndefined();
  });

  it("preserves organization metadata when a stale runner session saves", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-sessions-"));
    const store = new SessionStore(dir);
    const runnerSession = await store.create("/tmp/project", workflow, "Fix bug");
    await store.setPinned(runnerSession.id, true);
    await store.setArchived(runnerSession.id, true);
    await store.save(runnerSession);
    expect(await store.get(runnerSession.id)).toMatchObject({ pinned_at: expect.any(String), archived_at: expect.any(String) });
  });

  it("preserves cleared organization metadata when a stale runner session saves", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-sessions-"));
    const store = new SessionStore(dir);
    const session = await store.create("/tmp/project", workflow, "Fix bug");
    const staleRunnerSession = await store.setPinned(session.id, true);
    await store.setPinned(session.id, false);
    await store.save(staleRunnerSession);
    expect((await store.get(session.id))?.pinned_at).toBeUndefined();
  });

  it("does not recreate a deleted session when its runner saves again", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-sessions-"));
    const store = new SessionStore(dir);
    const runnerSession = await store.create("/tmp/project", workflow, "Fix bug");
    await store.delete(runnerSession.id);
    await store.save(runnerSession);
    expect(await store.get(runnerSession.id)).toBeNull();
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

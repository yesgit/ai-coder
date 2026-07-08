import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { approveOrDenyToolUse, isAutonomousSafeShellCommand, isReadOnlyShellCommand } from "./projectPolicy.js";
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
  it("allows common validation shell commands without per-tool approval", async () => {
    const current = session();

    const decision = await approveOrDenyToolUse(current, workflow, "Bash", { command: "npm test" }, "tool-1");

    expect(decision.allow).toBe(true);
    expect(current.status).toBe("running");
    expect(current.tool_calls[0].status).toBe("approved");
  });

  it("creates pending approval for shell commands outside the autonomous allowlist", async () => {
    const current = session();

    const decision = await approveOrDenyToolUse(current, workflow, "Bash", { command: "node script.js" }, "tool-1b");

    expect(decision.allow).toBe(false);
    expect(decision.allow === false ? decision.interrupt : false).toBe(true);
    expect(current.status).toBe("waiting_approval");
    expect(current.tool_calls[0].status).toBe("pending_approval");
  });

  it("creates pending approval for read tools outside the selected project", async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-project-"));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-outside-"));
    const outsideFile = path.join(outsideDir, "doc.pdf");
    await fs.writeFile(outsideFile, "%PDF-1.4");
    const current = { ...session(), project_path: projectDir };

    const decision = await approveOrDenyToolUse(current, workflow, "Read", { file_path: outsideFile }, "tool-2");

    expect(decision.allow).toBe(false);
    expect(decision.allow === false ? decision.interrupt : false).toBe(true);
    expect(current.status).toBe("waiting_approval");
    expect(current.tool_calls[0].status).toBe("pending_approval");
  });

  it("still blocks write tools targeting paths outside the selected project", async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-project-"));
    const current = { ...session(), project_path: projectDir };

    const decision = await approveOrDenyToolUse(
      current,
      workflow,
      "Write",
      { file_path: "/tmp/elsewhere.txt" },
      "tool-write-outside"
    );

    expect(decision.allow).toBe(false);
    expect(current.tool_calls[0].status).toBe("blocked");
  });

  it("remembers approved external reads for the rest of the session", async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-project-"));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-outside-"));
    const outsideFile = path.join(outsideDir, "doc.pdf");
    await fs.writeFile(outsideFile, "%PDF-1.4");
    const current = { ...session(), project_path: projectDir };

    // 第一轮：用户审批
    await approveOrDenyToolUse(current, workflow, "Read", { file_path: outsideFile }, "tool-read-1");
    const pendingId = current.tool_calls[0].id;
    expect(current.tool_calls[0].status).toBe("pending_approval");
    current.tool_calls[0].status = "approved";
    current.tool_calls[0].resolved_at = new Date().toISOString();

    // 第二轮：runner 重跑同一 tool_use_id，命中"approved → completed"，并写入白名单
    const second = await approveOrDenyToolUse(current, workflow, "Read", { file_path: outsideFile }, pendingId);
    expect(second.allow).toBe(true);
    expect(current.approved_external_paths).toEqual([await fs.realpath(outsideFile)]);

    // 第三轮：同一会话内对同一路径的新 Read 自动放行
    const third = await approveOrDenyToolUse(current, workflow, "Read", { file_path: outsideFile }, "tool-read-3");
    expect(third.allow).toBe(true);
    expect(current.tool_calls.at(-1)?.status).toBe("approved");
  });

  it("treats an approved external directory as covering later reads below it", async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-project-"));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-outside-"));
    const nestedDir = path.join(outsideDir, "uploads");
    await fs.mkdir(nestedDir);
    const nestedFile = path.join(nestedDir, "page-01.png");
    await fs.writeFile(nestedFile, "png");
    const current = { ...session(), project_path: projectDir };

    await approveOrDenyToolUse(current, workflow, "Glob", { path: outsideDir, pattern: "**/*.png" }, "tool-glob-1");
    current.tool_calls[0].status = "approved";
    current.tool_calls[0].resolved_at = new Date().toISOString();
    const approved = await approveOrDenyToolUse(current, workflow, "Glob", { path: outsideDir, pattern: "**/*.png" }, "tool-glob-1");

    expect(approved.allow).toBe(true);
    expect(current.approved_external_paths).toEqual([await fs.realpath(outsideDir)]);

    const nested = await approveOrDenyToolUse(current, workflow, "Read", { file_path: nestedFile }, "tool-read-nested");
    expect(nested.allow).toBe(true);
    expect(current.tool_calls.at(-1)?.status).toBe("approved");
  });

  it("creates pending approval for write tools when stage does NOT pre-authorize edit_file", async () => {
    // 注释：当阶段声明了 allowed_tools 含 edit_file 时，Edit 调用走"阶段预授权"自动放行（67d4d0c 起）。
    // 这条测试反映"未预授权"路径：把 current_stage 指向一个不存在的阶段，
    // 让自动放行短路失效，验证旧的"逐工具点 OK"路径仍然工作。
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-project-"));
    await fs.mkdir(path.join(projectDir, "src"));
    const current = { ...session(), project_path: projectDir, current_stage: "no-such-stage" };

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

  it("treats project symlinks that resolve outside as external reads (pending approval)", async () => {
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-project-"));
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-outside-"));
    await fs.writeFile(path.join(outsideDir, "secret.txt"), "secret");
    await fs.symlink(path.join(outsideDir, "secret.txt"), path.join(projectDir, "secret-link.txt"));
    const current = { ...session(), project_path: projectDir };

    const decision = await approveOrDenyToolUse(current, workflow, "Read", { file_path: "secret-link.txt" }, "tool-4");

    expect(decision.allow).toBe(false);
    expect(current.tool_calls[0].status).toBe("pending_approval");
    expect(current.status).toBe("waiting_approval");
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

describe("isReadOnlyShellCommand", () => {
  it("read-only 命令免审批", () => {
    expect(isReadOnlyShellCommand("git log --oneline -5")).toBe(true);
    expect(isReadOnlyShellCommand("git diff HEAD~1")).toBe(true);
    expect(isReadOnlyShellCommand("git show abc123")).toBe(true);
    expect(isReadOnlyShellCommand("git blame src/x.ts")).toBe(true);
    expect(isReadOnlyShellCommand("git status")).toBe(true);
    expect(isReadOnlyShellCommand("grep -rn foo src/")).toBe(true);
    expect(isReadOnlyShellCommand("ls -la")).toBe(true);
    expect(isReadOnlyShellCommand("cat README.md")).toBe(true);
    expect(isReadOnlyShellCommand("find . -name '*.ts'")).toBe(true);
    expect(isReadOnlyShellCommand("wc -l file.ts")).toBe(true);
  });

  it("危险/写命令需审批", () => {
    expect(isReadOnlyShellCommand("rm -rf node_modules")).toBe(false);
    expect(isReadOnlyShellCommand("git reset --hard")).toBe(false);
    expect(isReadOnlyShellCommand("git clean -fd")).toBe(false);
    expect(isReadOnlyShellCommand("npm test")).toBe(false);
    expect(isReadOnlyShellCommand("node script.js")).toBe(false);
    expect(isReadOnlyShellCommand("mv a b")).toBe(false);
  });

  it("含管道/重定向/分隔符的命令需审批（即使首词是 read-only）", () => {
    expect(isReadOnlyShellCommand("git log | head")).toBe(true); // 管道后是 head/tail/wc/grep 放行
    expect(isReadOnlyShellCommand("git diff > patch.txt")).toBe(false);
    expect(isReadOnlyShellCommand("grep foo; rm bar")).toBe(false);
    expect(isReadOnlyShellCommand("echo $(rm x)")).toBe(false);
    // 但允许尾随 || echo 错误处理（常见于 git 命令）
    expect(isReadOnlyShellCommand("git log || echo failed")).toBe(true);
    expect(isReadOnlyShellCommand("git diff HEAD~1 || echo Git 失败")).toBe(true);
    // 允许 cd && git 复合命令（常见安全模式）
    expect(isReadOnlyShellCommand("cd /home/user/projects && git branch --show-current")).toBe(true);
    expect(isReadOnlyShellCommand("cd /home/user/projects && git status && git branch --show-current")).toBe(true);
    // 管道后接只读过滤器放行
    expect(isReadOnlyShellCommand("git branch -a | head -20")).toBe(true);
    expect(isReadOnlyShellCommand("git log --oneline | tail -5")).toBe(true);
    expect(isReadOnlyShellCommand("ls -la | grep test")).toBe(true);
    expect(isReadOnlyShellCommand('find /home/user/projects -name "page-*.png" 2>/dev/null | head -20')).toBe(true);
    expect(isReadOnlyShellCommand('git -C /home/user/projects/huaxiafortune log --oneline -20 -- develop/aiAgentOpt 2>/dev/null || git -C /home/user/projects/huaxiafortune log --oneline -20 2>/dev/null || echo "Git 失败"')).toBe(true);
  });
});

describe("isAutonomousSafeShellCommand", () => {
  it("allows common project validation commands", () => {
    expect(isAutonomousSafeShellCommand("npm test")).toBe(true);
    expect(isAutonomousSafeShellCommand("npm run lint")).toBe(true);
    expect(isAutonomousSafeShellCommand("npm run typecheck")).toBe(true);
    expect(isAutonomousSafeShellCommand("npm run build")).toBe(true);
    expect(isAutonomousSafeShellCommand("./node_modules/.bin/vitest run src/main/security/projectPolicy.test.ts")).toBe(true);
    expect(isAutonomousSafeShellCommand("cd /home/user/projects && npm test")).toBe(true);
    expect(isAutonomousSafeShellCommand("python -m pytest tests")).toBe(true);
    expect(isAutonomousSafeShellCommand("go test ./...")).toBe(true);
    expect(isAutonomousSafeShellCommand("cargo test")).toBe(true);
  });

  it("allows dependency, publish, formatting write, and repository-state commands", () => {
    expect(isAutonomousSafeShellCommand("npm install")).toBe(true);
    expect(isAutonomousSafeShellCommand("pnpm add react")).toBe(true);
    expect(isAutonomousSafeShellCommand("npm publish")).toBe(true);
    expect(isAutonomousSafeShellCommand("npx prettier --write src")).toBe(true);
    expect(isAutonomousSafeShellCommand("git checkout develop")).toBe(true);
    expect(isAutonomousSafeShellCommand("git stash")).toBe(true);
    expect(isAutonomousSafeShellCommand("git reset --hard HEAD")).toBe(true);
    expect(isAutonomousSafeShellCommand("git clean -fd")).toBe(true);
    expect(isAutonomousSafeShellCommand("git stash && git checkout develop/aiAgent && git stash drop")).toBe(true);
  });

  it("still requires approval for commands outside the autonomous allowlist", () => {
    expect(isAutonomousSafeShellCommand("node script.js")).toBe(false);
    expect(isAutonomousSafeShellCommand("npx some-random-tool --write")).toBe(false);
    expect(isAutonomousSafeShellCommand("mv a b")).toBe(false);
  });
});

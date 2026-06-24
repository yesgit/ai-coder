import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkflowRegistry } from "./workflowRegistry.js";

describe("WorkflowRegistry", () => {
  it("loads builtin workflows", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-workflows-"));
    await fs.writeFile(
      path.join(dir, "plan.yaml"),
      [
        "id: plan-execute",
        "name: Plan Execute",
        "version: 1.0.0",
        "description: Test",
        "stages:",
        "  - id: plan",
        "    name: Plan"
      ].join("\n")
    );

    const workflows = await new WorkflowRegistry(dir).list();

    expect(workflows).toHaveLength(1);
    expect(workflows[0].source.type).toBe("builtin");
    expect(workflows[0].routing).toEqual({ enabled: false, auto_start: false, keywords: [], examples: [] });
  });

  it("loads explicit routing metadata", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-workflows-"));
    await fs.writeFile(
      path.join(dir, "review.yaml"),
      [
        "id: review",
        "name: Review",
        "version: 1.0.0",
        "routing:",
        "  enabled: true",
        "  auto_start: true",
        "  keywords: [review]",
        "  examples: [review this diff]",
        "stages:",
        "  - id: review",
        "    name: Review"
      ].join("\n")
    );
    const [loaded] = await new WorkflowRegistry(dir).list();
    expect(loaded.routing).toEqual({ enabled: true, auto_start: true, keywords: ["review"], examples: ["review this diff"] });
  });

  it("lets project workflows override builtin workflows by id", async () => {
    const builtinDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-builtin-"));
    const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-project-"));
    const projectWorkflowDir = path.join(projectDir, ".ai-coder", "workflows");
    await fs.mkdir(projectWorkflowDir, { recursive: true });

    const workflow = (name: string) =>
      [`id: plan-execute`, `name: ${name}`, "version: 1.0.0", "description: Test", "stages:", "  - id: plan", "    name: Plan"].join(
        "\n"
      );

    await fs.writeFile(path.join(builtinDir, "plan.yaml"), workflow("Builtin"));
    await fs.writeFile(path.join(projectWorkflowDir, "plan.yaml"), workflow("Project"));

    const workflows = await new WorkflowRegistry(builtinDir).list(projectDir);

    expect(workflows).toHaveLength(1);
    expect(workflows[0].name).toBe("Project");
    expect(workflows[0].source.type).toBe("project");
  });

  it("reports invalid workflow files without blocking valid workflows", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-workflows-"));
    await fs.writeFile(
      path.join(dir, "valid.yaml"),
      ["id: valid", "name: Valid", "version: 1.0.0", "stages:", "  - id: plan", "    name: Plan"].join("\n")
    );
    await fs.writeFile(path.join(dir, "invalid.yaml"), ["id: invalid", "name: Invalid", "version: 1.0.0"].join("\n"));

    const result = await new WorkflowRegistry(dir).listWithIssues();

    expect(result.workflows).toHaveLength(1);
    expect(result.workflows[0].id).toBe("valid");
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].message).toContain("stages");
  });

  it("rejects invalid permissions values", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-workflows-"));
    await fs.writeFile(
      path.join(dir, "invalid.yaml"),
      [
        "id: invalid",
        "name: Invalid",
        "version: 1.0.0",
        "permissions:",
        "  filesystem:",
        "    mode: anywhere",
        "stages:",
        "  - id: plan",
        "    name: Plan"
      ].join("\n")
    );

    const result = await new WorkflowRegistry(dir).listWithIssues();

    expect(result.workflows).toHaveLength(0);
    expect(result.issues[0].message).toContain("permissions.filesystem.mode");
  });

  it("rejects invalid routing values", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-workflows-"));
    await fs.writeFile(
      path.join(dir, "invalid.yaml"),
      ["id: invalid", "name: Invalid", "version: 1.0.0", "routing:", "  enabled: yes", "stages:", "  - id: run", "    name: Run"].join("\n")
    );
    const result = await new WorkflowRegistry(dir).listWithIssues();
    expect(result.workflows).toHaveLength(0);
    expect(result.issues[0].message).toContain("routing.enabled");
  });

  it("loads optional stage instructions", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-workflows-"));
    await fs.writeFile(
      path.join(dir, "onboarding.yaml"),
      [
        "id: project-onboarding",
        "name: Project Onboarding",
        "version: 1.0.0",
        "stages:",
        "  - id: scan_project",
        "    name: Scan Project",
        "    instructions: |",
        "      Check for an existing CLAUDE.md first."
      ].join("\n")
    );

    const workflows = await new WorkflowRegistry(dir).list();

    expect(workflows[0].stages[0].instructions).toContain("CLAUDE.md");
  });

  it("passes through stage allowed_tools, auto_retry_limit and gates", async () => {
    // 防止后续修改丢失阶段层字段的透传——auto_retry_limit 之前就是这样静默被 schema 吞掉的。
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-coder-workflows-"));
    await fs.writeFile(
      path.join(dir, "stages.yaml"),
      [
        "id: stages",
        "name: Stages",
        "version: 1.0.0",
        "stages:",
        "  - id: investigate",
        "    name: Investigate",
        "    allowed_tools:",
        "      - read_file",
        "      - shell",
        "  - id: apply",
        "    name: Apply",
        "    approval_required: true",
        "    auto_retry_limit: 2",
        "    allowed_tools:",
        "      - read_file",
        "      - edit_file",
        "    gates:",
        "      - authorized_files_only"
      ].join("\n")
    );

    const [loaded] = await new WorkflowRegistry(dir).list();
    expect(loaded.stages[0].allowed_tools).toEqual(["read_file", "shell"]);
    // 默认值：未声明时数组应为空（而不是 undefined），下游过滤逻辑依赖该不变量
    expect(loaded.stages[0].gates).toEqual([]);
    expect(loaded.stages[0].auto_retry_limit).toBeUndefined();
    expect(loaded.stages[1].allowed_tools).toEqual(["read_file", "edit_file"]);
    expect(loaded.stages[1].auto_retry_limit).toBe(2);
    expect(loaded.stages[1].gates).toEqual(["authorized_files_only"]);
    expect(loaded.stages[1].approval_required).toBe(true);
  });
});

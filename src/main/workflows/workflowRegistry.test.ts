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
});

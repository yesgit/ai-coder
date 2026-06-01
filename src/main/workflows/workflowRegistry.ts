import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import type { WorkflowSourceType, WorkflowTemplate } from "../../shared/types.js";

const WORKFLOW_FILE_PATTERN = /\.(ya?ml)$/i;

export class WorkflowRegistry {
  constructor(private readonly builtinDir: string) {}

  async list(projectPath?: string): Promise<WorkflowTemplate[]> {
    const merged = new Map<string, WorkflowTemplate>();

    for (const workflow of await this.loadFromDirectory(this.builtinDir, "builtin")) {
      merged.set(workflow.id, workflow);
    }

    for (const workflow of await this.loadFromDirectory(path.join(os.homedir(), ".ai-coder", "workflows"), "user")) {
      merged.set(workflow.id, workflow);
    }

    if (projectPath) {
      const projectWorkflowDir = path.join(projectPath, ".ai-coder", "workflows");
      for (const workflow of await this.loadFromDirectory(projectWorkflowDir, "project")) {
        merged.set(workflow.id, workflow);
      }
    }

    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string, projectPath?: string): Promise<WorkflowTemplate | null> {
    return (await this.list(projectPath)).find((workflow) => workflow.id === id) ?? null;
  }

  private async loadFromDirectory(dir: string, sourceType: WorkflowSourceType): Promise<WorkflowTemplate[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (error) {
      if (isMissingPathError(error)) {
        return [];
      }
      throw error;
    }

    const workflows: WorkflowTemplate[] = [];
    for (const entry of entries.filter((file) => WORKFLOW_FILE_PATTERN.test(file))) {
      const filePath = path.join(dir, entry);
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = YAML.parse(raw) as Partial<WorkflowTemplate>;
      workflows.push(normalizeWorkflow(parsed, sourceType, filePath));
    }
    return workflows;
  }
}

function normalizeWorkflow(input: Partial<WorkflowTemplate>, sourceType: WorkflowSourceType, filePath: string): WorkflowTemplate {
  if (!input.id || !input.name || !input.version || !Array.isArray(input.stages) || input.stages.length === 0) {
    throw new Error(`Invalid workflow file: ${filePath}`);
  }

  return {
    id: input.id,
    name: input.name,
    version: input.version,
    description: input.description ?? "",
    source: {
      type: sourceType,
      id: input.source?.id ?? input.id,
      version: input.source?.version ?? input.version,
      path: filePath
    },
    permissions: input.permissions ?? {},
    stages: input.stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      approval_required: stage.approval_required ?? false,
      allowed_tools: stage.allowed_tools ?? [],
      required_outputs: stage.required_outputs ?? [],
      required_checks: stage.required_checks ?? [],
      gates: stage.gates ?? []
    }))
  };
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

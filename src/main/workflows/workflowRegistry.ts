import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { WorkflowListResult, WorkflowLoadIssue, WorkflowSourceType, WorkflowTemplate } from "../../shared/types.js";

const WORKFLOW_FILE_PATTERN = /\.(ya?ml)$/i;

export class WorkflowRegistry {
  constructor(private readonly builtinDir: string) {}

  async list(projectPath?: string): Promise<WorkflowTemplate[]> {
    return (await this.listWithIssues(projectPath)).workflows;
  }

  async listWithIssues(projectPath?: string): Promise<WorkflowListResult> {
    const merged = new Map<string, WorkflowTemplate>();
    const issues: WorkflowLoadIssue[] = [];

    const builtin = await this.loadFromDirectory(this.builtinDir, "builtin");
    issues.push(...builtin.issues);
    for (const workflow of builtin.workflows) {
      merged.set(workflow.id, workflow);
    }

    const user = await this.loadFromDirectory(path.join(os.homedir(), ".ai-coder", "workflows"), "user");
    issues.push(...user.issues);
    for (const workflow of user.workflows) {
      merged.set(workflow.id, workflow);
    }

    if (projectPath) {
      const projectWorkflowDir = path.join(projectPath, ".ai-coder", "workflows");
      const project = await this.loadFromDirectory(projectWorkflowDir, "project");
      issues.push(...project.issues);
      for (const workflow of project.workflows) {
        merged.set(workflow.id, workflow);
      }
    }

    return {
      workflows: [...merged.values()].sort((a, b) => a.name.localeCompare(b.name)),
      issues
    };
  }

  async get(id: string, projectPath?: string): Promise<WorkflowTemplate | null> {
    return (await this.list(projectPath)).find((workflow) => workflow.id === id) ?? null;
  }

  private async loadFromDirectory(
    dir: string,
    sourceType: WorkflowSourceType
  ): Promise<{ workflows: WorkflowTemplate[]; issues: WorkflowLoadIssue[] }> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (error) {
      if (isMissingPathError(error)) {
        return { workflows: [], issues: [] };
      }
      throw error;
    }

    const workflows: WorkflowTemplate[] = [];
    const issues: WorkflowLoadIssue[] = [];
    for (const entry of entries.filter((file) => WORKFLOW_FILE_PATTERN.test(file))) {
      const filePath = path.join(dir, entry);
      try {
        const raw = await fs.readFile(filePath, "utf8");
        const parsed = YAML.parse(raw);
        workflows.push(normalizeWorkflow(parsed, sourceType, filePath));
      } catch (error) {
        issues.push({
          source_type: sourceType,
          path: filePath,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return { workflows, issues };
  }
}

const stringArraySchema = z.array(z.string().min(1)).default([]);
const workflowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().default(""),
  source: z
    .object({
      id: z.string().min(1).optional(),
      version: z.string().min(1).optional()
    })
    .optional(),
  permissions: z
    .object({
      filesystem: z
        .object({
          mode: z.literal("project-only")
        })
        .optional(),
      shell: z
        .object({
          approval_required: z.boolean()
        })
        .optional(),
      network: z
        .object({
          enabled: z.boolean()
        })
        .optional()
    })
    .default({}),
  rework: z
    .object({
      enabled: z.boolean().default(false),
      allowed_targets: stringArraySchema,
      approval_required: z.boolean().default(true),
      invalidate_downstream: z.boolean().default(true)
    })
    .default({
      enabled: false,
      allowed_targets: [],
      approval_required: true,
      invalidate_downstream: true
    }),
  stages: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        instructions: z.string().optional(),
        approval_required: z.boolean().default(false),
        allowed_tools: stringArraySchema,
        required_outputs: stringArraySchema,
        required_checks: stringArraySchema,
        gates: stringArraySchema
      })
    )
    .min(1)
});

function normalizeWorkflow(input: unknown, sourceType: WorkflowSourceType, filePath: string): WorkflowTemplate {
  const parsed = workflowSchema.safeParse(input);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).join("; ");
    throw new Error(`Invalid workflow file ${filePath}: ${message}`);
  }

  const workflow = parsed.data;

  return {
    id: workflow.id,
    name: workflow.name,
    version: workflow.version,
    description: workflow.description,
    source: {
      type: sourceType,
      id: workflow.source?.id ?? workflow.id,
      version: workflow.source?.version ?? workflow.version,
      path: filePath
    },
    permissions: workflow.permissions,
    rework: workflow.rework,
    stages: workflow.stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      instructions: stage.instructions,
      approval_required: stage.approval_required,
      allowed_tools: stage.allowed_tools,
      required_outputs: stage.required_outputs,
      required_checks: stage.required_checks,
      gates: stage.gates
    }))
  };
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

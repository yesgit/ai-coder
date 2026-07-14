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
const outputSchema = z.record(z.string().min(1), z.unknown()).optional();
const postOutputAssertionSchema = z.enum([
  "review_self_consistency",
  "needs_rework_target_required",
  "unknowns_present",
  "item_matrix_when_multi",
  "investigate_structure_present",
  "confidence_levels_present",
  "callsites_inventory_present",
  "boundary_enumeration_present",
  "preflight_risks_present",
  "design_alternatives_present",
  "design_quadrant_eval_present",
  "implement_delta_check_present",
  "rollback_plan_when_irreversible",
  "hedged_findings_demoted",
  "no_trailing_unparsed_payload",
  "requirements_evidence_grounded",
  "profile_scan_respects_assessment",
  "profile_maintenance_scope_only",
  "readonly_stage_no_implementation_claim"
]);
const stageHooksSchema = z
  .object({
    pre_tool_use: z
      .array(
        z.object({
          when: z.object({
            tool: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
            command_contains: z.array(z.string().min(1)).optional()
          }),
          require: z
            .object({
              same_file_reads_min: z.number().int().min(1).optional(),
              shell_must_have_run: z.array(z.string().min(1)).optional(),
              ask_human_consent: z.boolean().optional()
            })
            .refine(
              (req) =>
                req.same_file_reads_min !== undefined ||
                (req.shell_must_have_run && req.shell_must_have_run.length > 0) ||
                req.ask_human_consent === true,
              "hook rule require must declare at least one constraint"
            ),
          on_fail: z.string().min(1)
        })
      )
      .min(1)
      .optional(),
    post_output_assertions: z.array(postOutputAssertionSchema).min(1).optional(),
    post_output_checks: z
      .array(
        z.object({
          require: z
            .object({
              commands_run: z.array(z.string().min(1)).optional(),
              successful_commands_run: z.array(z.string().min(1)).optional(),
              evidence_calls_min: z.number().int().min(1).optional(),
              successful_commands_min: z.number().int().min(1).optional(),
              files_read: z
                .array(z.object({ target: z.string().min(1), min: z.number().int().min(1) }))
                .optional()
            })
            .refine(
              (req) =>
                (req.commands_run && req.commands_run.length > 0) ||
                (req.successful_commands_run && req.successful_commands_run.length > 0) ||
                req.evidence_calls_min !== undefined ||
                req.successful_commands_min !== undefined ||
                (req.files_read && req.files_read.length > 0),
              "post_output_check require must declare at least one constraint (commands_run, successful_commands_run or files_read)"
            ),
          on_fail: z.string().min(1)
        })
      )
      .min(1)
      .optional()
  })
  .optional();

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
  routing: z
    .object({
      enabled: z.boolean().default(false),
      auto_start: z.boolean().default(false),
      keywords: stringArraySchema,
      examples: stringArraySchema
    })
    .default({ enabled: false, auto_start: false, keywords: [], examples: [] }),
  stages: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        instructions: z.string().optional(),
        approval_required: z.boolean().default(false),
        allowed_tools: stringArraySchema,
        required_skills: stringArraySchema,
        required_outputs: stringArraySchema,
        output_schema: outputSchema,
        required_checks: stringArraySchema,
        gates: stringArraySchema,
        auto_retry_limit: z.number().int().min(0).optional(),
        hooks: stageHooksSchema,
        agents: z
          .record(
            z.string(),
            z.object({
              description: z.string().min(1),
              tools: stringArraySchema,
              prompt: z.string().min(1),
              model: z.string().optional()
            })
          )
          .optional()
      }).superRefine((stage, ctx) => {
        if (!stage.output_schema) return;
        const schemaKeys = Object.keys(stage.output_schema);
        const required = new Set(stage.required_outputs);
        const schemaKeySet = new Set(schemaKeys);
        for (const key of stage.required_outputs) {
          if (!schemaKeySet.has(key)) {
            ctx.addIssue({
              code: "custom",
              path: ["output_schema"],
              message: `required_outputs key must be declared in output_schema: ${key}`
            });
          }
        }
        for (const key of schemaKeys) {
          if (!required.has(key)) {
            ctx.addIssue({
              code: "custom",
              path: ["output_schema", key],
              message: `output_schema key must also be listed in required_outputs: ${key}`
            });
          }
        }
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
    routing: workflow.routing,
    stages: workflow.stages.map((stage) => ({
      id: stage.id,
      name: stage.name,
      instructions: stage.instructions,
      approval_required: stage.approval_required,
      allowed_tools: stage.allowed_tools,
      required_skills: stage.required_skills,
      required_outputs: stage.required_outputs,
      output_schema: stage.output_schema,
      required_checks: stage.required_checks,
      gates: stage.gates,
      auto_retry_limit: stage.auto_retry_limit,
      hooks: stage.hooks,
      agents: stage.agents
    }))
  };
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

import { z } from "zod";
import type {
  WorkflowRoutingCandidate,
  WorkflowRoutingDecision,
  WorkflowTemplate
} from "../../shared/types.js";
import { extractClaudeStageOutput } from "../agent/claudeMessageAdapter.js";
import { resolveNodeExecutable, shouldUseClaudeSdk } from "../agent/claudeRuntime.js";

type ModelClassifier = (taskPrompt: string, workflows: WorkflowTemplate[], projectPath: string) => Promise<unknown>;
type ClaudeQuery = (params: unknown) => AsyncIterable<unknown>;

const modelResultSchema = z.object({
  candidates: z
    .array(
      z.object({
        workflow_id: z.string().min(1),
        score: z.number().min(0).max(1)
      })
    )
    .min(1),
  reason: z.string().min(1)
});

export class WorkflowRouter {
  constructor(private readonly classifierOverride?: ModelClassifier) {}

  async resolve(taskPrompt: string, workflows: WorkflowTemplate[], projectPath: string): Promise<WorkflowRoutingDecision> {
    const candidates = workflows.filter((workflow) => workflow.routing?.enabled === true);
    if (candidates.length === 0) {
      return {
        status: "no_candidates",
        method: "none",
        candidates: [],
        reason: "没有工作流启用了自动路由，请手动指定工作流。"
      };
    }

    const ruleMatches = this.matchRules(taskPrompt, candidates);
    if (ruleMatches.length === 1) {
      const workflow = ruleMatches[0];
      return {
        status: canAutoStart(workflow) ? "selected" : "needs_confirmation",
        method: "rule",
        recommended_workflow_id: workflow.id,
        candidates: [toRoutingCandidate(workflow, 1)],
        reason: `任务与“${workflow.name}”的明确路由关键词匹配。`
      };
    }

    try {
      const raw = this.classifierOverride
        ? await this.classifierOverride(taskPrompt, candidates, projectPath)
        : await this.classifyWithClaude(taskPrompt, candidates, projectPath);
      return this.buildModelDecision(raw, candidates);
    } catch (error) {
      const fallback = candidates.find((workflow) => workflow.id === "careful-coder") ?? candidates[0];
      return {
        status: "needs_confirmation",
        method: "model",
        recommended_workflow_id: fallback.id,
        candidates: [toRoutingCandidate(fallback, 0)],
        reason: `自动语义路由不可用，请确认工作流。${formatError(error)}`
      };
    }
  }

  private matchRules(taskPrompt: string, workflows: WorkflowTemplate[]): WorkflowTemplate[] {
    const normalizedPrompt = normalizeRuleText(taskPrompt);
    return workflows.filter((workflow) =>
      (workflow.routing?.keywords ?? []).some((keyword) => normalizedPrompt === normalizeRuleText(keyword))
    );
  }

  private buildModelDecision(raw: unknown, workflows: WorkflowTemplate[]): WorkflowRoutingDecision {
    const parsed = modelResultSchema.parse(typeof raw === "string" ? JSON.parse(extractJson(raw)) : raw);
    const byId = new Map(workflows.map((workflow) => [workflow.id, workflow]));
    const seen = new Set<string>();
    const ranked = parsed.candidates
      .filter((candidate) => byId.has(candidate.workflow_id) && !seen.has(candidate.workflow_id) && seen.add(candidate.workflow_id))
      .sort((left, right) => right.score - left.score)
      .slice(0, 3)
      .map((candidate) => toRoutingCandidate(byId.get(candidate.workflow_id)!, candidate.score));

    if (ranked.length === 0) {
      throw new Error("模型没有返回有效的工作流候选");
    }

    const top = ranked[0];
    const hasRequiredRanking = workflows.length === 1 || ranked.length >= 2;
    const secondScore = ranked[1]?.score ?? 0;
    const workflow = byId.get(top.workflow_id)!;
    const canStart = hasRequiredRanking && top.score >= 0.85 && top.score - secondScore >= 0.2 && canAutoStart(workflow);
    return {
      status: canStart ? "selected" : "needs_confirmation",
      method: "model",
      recommended_workflow_id: top.workflow_id,
      candidates: ranked,
      reason: parsed.reason
    };
  }

  private async classifyWithClaude(taskPrompt: string, workflows: WorkflowTemplate[], projectPath: string): Promise<unknown> {
    if (!(await shouldUseClaudeSdk())) {
      throw new Error("Claude Agent SDK 不可用");
    }
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const query = (sdk as { query?: unknown }).query;
    if (typeof query !== "function") {
      throw new Error("Claude Agent SDK 不提供 query() 接口");
    }
    const nodeInfo = await resolveNodeExecutable();
    const messages: unknown[] = [];
    const prompt = buildClassifierPrompt(taskPrompt, workflows);
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 15_000);
    try {
      for await (const message of (query as ClaudeQuery)({
        prompt,
        options: {
          cwd: projectPath,
          executable: nodeInfo?.command,
          env: nodeInfo?.env ? { ...process.env, ...nodeInfo.env } : undefined,
          abortController,
          tools: [],
          disallowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "WebSearch"],
          permissionMode: "dontAsk",
          settingSources: [],
          maxTurns: 1
        }
      })) {
        messages.push(message);
      }
    } finally {
      clearTimeout(timeout);
    }
    const output = extractClaudeStageOutput(messages);
    if (output.error) {
      throw new Error(output.error);
    }
    return output.resultText || output.assistantText;
  }
}

function buildClassifierPrompt(taskPrompt: string, workflows: WorkflowTemplate[]): string {
  const catalog = workflows.map((workflow) => ({
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    keywords: workflow.routing?.keywords ?? [],
    examples: workflow.routing?.examples ?? []
  }));
  return [
    "你是工作流路由器。只能根据用户任务和候选元数据排序，不要执行任务，也不要调用工具。",
    "返回严格 JSON：{\"candidates\":[{\"workflow_id\":\"id\",\"score\":0到1}],\"reason\":\"简短中文原因\"}。",
    "最多返回三个候选，score 表示与任务意图的匹配程度。只能使用候选中的 id。",
    `候选工作流：${JSON.stringify(catalog)}`,
    `用户任务：${taskPrompt}`
  ].join("\n");
}

function toRoutingCandidate(workflow: WorkflowTemplate, score: number): WorkflowRoutingCandidate {
  return { workflow_id: workflow.id, name: workflow.name, score };
}

function canAutoStart(workflow: WorkflowTemplate): boolean {
  return workflow.source.type !== "project" && workflow.routing?.auto_start === true;
}

function normalizeRuleText(value: string): string {
  return value
    .toLocaleLowerCase()
    .trim()
    .replace(/^(?:请帮我|麻烦帮我|能否帮我|可以帮我|帮我|请|麻烦)\s*/, "")
    .replace(/[。！？!?.,，；;：:]+$/g, "")
    .trim();
}

function extractJson(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) return fenced;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

function formatError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message ? `（${message}）` : "";
}

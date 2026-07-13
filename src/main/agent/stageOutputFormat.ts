import type { WorkflowStage } from "../../shared/types.js";

export function buildStageOutputFormat(stage: WorkflowStage): {
  type: "json_schema";
  schema: Record<string, unknown>;
} {
  const requiredOutputProperties = Object.fromEntries(
    (stage.required_outputs ?? []).map((name) => [
      name,
      normalizeOutputSchema(stage.output_schema?.[name])
    ])
  );

  return {
    type: "json_schema",
    schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["completed", "failed", "needs_rework"] },
        output_summary: { type: "string" },
        required_outputs: {
          type: "object",
          properties: requiredOutputProperties,
          required: stage.required_outputs ?? [],
          additionalProperties: false
        },
        rework_target_stage_id: { type: "string" },
        rework_reason: { type: "string" },
        error: { type: "string" }
      },
      required: ["status", "output_summary", "required_outputs"],
      additionalProperties: false
    }
  };
}

function normalizeOutputSchema(schema: unknown): Record<string, unknown> {
  if (typeof schema === "string") {
    const arrayShorthand = schema.trim().match(/^array\s*<\s*(.+)\s*>$/);
    if (arrayShorthand) {
      return {
        type: "array",
        items: normalizeOutputSchema(arrayShorthand[1])
      };
    }

    const alternatives = schema.split("|").map((value) => value.trim()).filter(Boolean);
    if (alternatives.length > 1) {
      return { type: "string", enum: alternatives };
    }
    if (["string", "number", "integer", "boolean", "object", "array", "null"].includes(schema)) {
      return { type: schema };
    }
    return { type: "string" };
  }

  if (!isRecord(schema)) {
    return {};
  }

  const normalized: Record<string, unknown> = {};
  for (const key of ["type", "description", "enum", "const", "format", "minimum", "maximum", "minLength", "maxLength"] as const) {
    if (schema[key] !== undefined) normalized[key] = schema[key];
  }

  if (schema.items !== undefined) {
    normalized.items = normalizeOutputSchema(schema.items);
  }

  if (isRecord(schema.properties)) {
    const properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, child]) => [name, normalizeOutputSchema(child)])
    );
    normalized.properties = properties;
    normalized.required = Array.isArray(schema.required) ? schema.required : Object.keys(properties);
    normalized.additionalProperties = false;
  }

  if (normalized.type === "object" && normalized.properties === undefined) {
    normalized.additionalProperties = true;
  }

  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

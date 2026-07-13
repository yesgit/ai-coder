import { describe, expect, it } from "vitest";
import type { WorkflowStage } from "../../shared/types.js";
import { buildStageOutputFormat } from "./stageOutputFormat.js";

describe("stage output format", () => {
  it("builds a strict SDK schema from required_outputs and shorthand workflow schemas", () => {
    const stage = {
      id: "scan_project",
      name: "扫描项目画像",
      required_outputs: ["profile_mode", "inspected_files"],
      output_schema: {
        profile_mode: { type: "string", enum: ["full", "incremental", "none"] },
        inspected_files: {
          type: "array",
          items: {
            type: "object",
            properties: { file: "string", evidence: "string" }
          }
        }
      }
    } as WorkflowStage;

    expect(buildStageOutputFormat(stage)).toEqual({
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["completed", "failed", "needs_rework"] },
          output_summary: { type: "string" },
          required_outputs: {
            type: "object",
            properties: {
              profile_mode: { type: "string", enum: ["full", "incremental", "none"] },
              inspected_files: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    file: { type: "string" },
                    evidence: { type: "string" }
                  },
                  required: ["file", "evidence"],
                  additionalProperties: false
                }
              }
            },
            required: ["profile_mode", "inspected_files"],
            additionalProperties: false
          },
          rework_target_stage_id: { type: "string" },
          rework_reason: { type: "string" },
          error: { type: "string" }
        },
        required: ["status", "output_summary", "required_outputs"],
        additionalProperties: false
      }
    });
  });

  it("converts pipe-separated enum shorthand", () => {
    const stage = {
      id: "profile",
      name: "Profile",
      required_outputs: ["action"],
      output_schema: { action: "keep | update | delete | add" }
    } as WorkflowStage;

    const schema = buildStageOutputFormat(stage).schema as {
      properties: { required_outputs: { properties: Record<string, unknown> } };
    };
    expect(schema.properties.required_outputs.properties.action).toEqual({
      type: "string",
      enum: ["keep", "update", "delete", "add"]
    });
  });
});

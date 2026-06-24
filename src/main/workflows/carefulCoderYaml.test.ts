import { describe, expect, it } from "vitest";
import path from "node:path";
import { WorkflowRegistry } from "./workflowRegistry.js";

describe("careful-coder.yaml validates", () => {
  it("parses cleanly with hooks", async () => {
    const r = new WorkflowRegistry(path.resolve(__dirname, "../../../workflows"));
    const result = await r.listWithIssues();
    const ccIssues = result.issues.filter(i => i.path.includes("careful-coder"));
    expect(ccIssues, JSON.stringify(ccIssues)).toEqual([]);
    const cc = result.workflows.find(w => w.id === "careful-coder");
    expect(cc).toBeDefined();
    const implement = cc!.stages.find(s => s.id === "implement");
    expect(implement?.hooks?.pre_tool_use?.[0].require.same_file_reads_min).toBe(3);
    expect(implement?.hooks?.pre_tool_use?.[1].require.ask_human_consent).toBe(true);
    const sr = cc!.stages.find(s => s.id === "self_review");
    expect(sr?.allowed_tools).not.toContain("edit_file");
  });
});

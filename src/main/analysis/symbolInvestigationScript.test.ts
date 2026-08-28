import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatSymbolInvestigationToolResult,
  getCachedSymbolInvestigationReport,
  investigateSymbolContract
} from "./symbolInvestigationScript.js";

describe("investigateSymbolContract", () => {
  it("consumes every page and recursively investigates public wrappers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symbol-investigation-script-"));
    await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext"
      },
      include: ["*.ts"]
    }));
    await writeFile(path.join(root, "target.ts"), [
      "/** Return the provided value. */",
      "export function target(value: string, enabled = true) {",
      "  return enabled ? value : '';",
      "}"
    ].join("\n"));
    await writeFile(path.join(root, "usage.ts"), [
      "import { target } from './target.js';",
      "export function publicWrapper(value: string) {",
      "  if (!value) return '';",
      "  return target(value);",
      "}",
      "export function outerWrapper(value: string) {",
      "  return publicWrapper(value);",
      "}",
      "export const registeredTarget = target;",
      ...Array.from({ length: 105 }, (_, index) => (
        `export const direct${index} = target('value-${index}', ${index % 2 === 0});`
      ))
    ].join("\n"));

    const report = investigateSymbolContract({
      projectPath: root,
      targetFile: "target.ts",
      symbol: "target",
      pageSize: 100
    });

    expect(report.sections_completed).toEqual(["contract", "calls", "wrappers", "references", "effects"]);
    expect(report.all_pages_consumed).toBe(true);
    expect(report.calls.coverage).toMatchObject({
      total: 106,
      returned: 106,
      requested_offsets: [0, 100],
      next_offset: null,
      all_pages_consumed: true
    });
    expect(report.calls.items).toHaveLength(106);
    expect(report.wrappers.items.map((wrapper) => wrapper.name)).toContain("publicWrapper");
    expect(report.wrapper_graph.nodes.map((node) => node.source_wrapper.name))
      .toEqual(expect.arrayContaining(["publicWrapper", "outerWrapper"]));
    expect(report.unresolved_dynamic_references).toEqual(expect.arrayContaining([
      expect.objectContaining({ expression: "target" })
    ]));
    expect(report.reference_accounting.total).toBe(
      report.reference_accounting.resolved
      + report.reference_accounting.irrelevant
      + report.reference_accounting.blocked
    );
    expect(report.reference_accounting.accounted).toBe(true);
    expect(report.reference_accounting.blocked).toBeGreaterThan(0);
    expect(report.reference_cards.every((card) => /^[a-f0-9]{20}$/.test(card.reference_id)))
      .toBe(true);
    expect(report.reference_cards).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "call",
        disposition: "resolved",
        provided_parameters: ["value", "enabled"]
      }),
      expect.objectContaining({
        kind: "non-call-reference",
        disposition: "blocked",
        expression: "target"
      })
    ]));
    expect(report.runtime_verification_required).toBe(true);
    expect(report.status).toBe("complete_with_dynamic_unknowns");
    expect(report.report_digest).toMatch(/^[a-f0-9]{64}$/);
    const toolResult = formatSymbolInvestigationToolResult(report);
    const parsedToolResult = JSON.parse(toolResult) as Record<string, unknown>;
    expect(toolResult.length).toBeLessThan(JSON.stringify(report).length);
    expect(parsedToolResult.reference_cards).toEqual(report.reference_cards);
    expect(parsedToolResult.reference_accounting).toEqual(report.reference_accounting);
    expect(getCachedSymbolInvestigationReport({
      projectPath: root,
      targetFile: "target.ts",
      symbol: "target",
      pageSize: 100
    })).toBe(report);
    expect(getCachedSymbolInvestigationReport({
      projectPath: root,
      targetFile: "target.ts",
      symbol: "target",
      pageSize: 100,
      maxWrapperDepth: 7
    })).toBeUndefined();
  });

  it("marks a bounded wrapper traversal as partial instead of claiming completeness", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symbol-investigation-bounds-"));
    await writeFile(path.join(root, "target.ts"), [
      "export function target(value: string) { return value; }",
      "export function wrapper(value: string) { return target(value); }"
    ].join("\n"));

    const report = investigateSymbolContract({
      projectPath: root,
      targetFile: "target.ts",
      symbol: "target",
      maxWrapperDepth: 0
    });

    expect(report.status).toBe("partial");
    expect(report.wrapper_graph.complete).toBe(false);
    expect(report.wrapper_graph.truncated_reasons[0]).toContain("最大深度");
    expect(report.static_analysis_limits).toContain(
      "未加载有效 TypeScript 项目配置，符号解析采用语法回退。"
    );
  });
});

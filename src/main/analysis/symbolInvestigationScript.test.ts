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
  it.each([
    {
      name: "default imports with an unrelated local name",
      symbol: "TargetWidget",
      files: {
        "target.ts": "export default function TargetWidget(value: string) { return value; }",
        "usage.ts": "import Panel from './target.js';\nPanel('hello');"
      },
      invocation: "Panel('hello')"
    },
    {
      name: "renamed re-exports",
      symbol: "TargetWidget",
      files: {
        "target.ts": "export function TargetWidget(value: string) { return value; }",
        "barrel.ts": "export { TargetWidget as Entry } from './target.js';",
        "usage.ts": "import { Entry } from './barrel.js';\nEntry('hello');"
      },
      invocation: "Entry('hello')"
    },
    {
      name: "export-star barrels",
      symbol: "TargetWidget",
      files: {
        "target.ts": "export function TargetWidget(value: string) { return value; }",
        "barrel.ts": "export * from './target.js';",
        "usage.ts": "import { TargetWidget } from './barrel.js';\nTargetWidget('hello');"
      },
      invocation: "TargetWidget('hello')"
    },
    {
      name: "short symbol names",
      symbol: "add",
      files: {
        "target.ts": "export function add(value: number) { return value + 1; }",
        "usage.ts": "import { add } from './target.js';\nadd(2);"
      },
      invocation: "add(2)"
    },
    {
      name: "common symbol names",
      symbol: "render",
      files: {
        "target.ts": "export function render(value: string) { return value; }",
        "usage.ts": "import { render as draw } from './target.js';\ndraw('hello');"
      },
      invocation: "draw('hello')"
    },
    {
      name: "namespace imports through barrels",
      symbol: "TargetWidget",
      files: {
        "target.ts": "export function TargetWidget(value: string) { return value; }",
        "barrel.ts": "export * from './target.js';",
        "usage.ts": "import * as widgets from './barrel.js';\nwidgets.TargetWidget('hello');"
      },
      invocation: "widgets.TargetWidget('hello')"
    },
    {
      name: "JSX through a renamed default export",
      symbol: "TargetWidget",
      files: {
        "target.ts": "export default function TargetWidget(props: { label: string }) { return null; }",
        "usage.tsx": "import Panel from './target.js';\nconst element = <Panel label='hello' />;"
      },
      invocation: "<Panel label='hello' />"
    }
  ])("finds callers using $name", async ({ symbol, files, invocation }) => {
    const root = await mkdtemp(path.join(tmpdir(), "symbol-module-callers-"));
    await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" }
    }));
    for (const [file, content] of Object.entries(files)) {
      await writeFile(path.join(root, file), content!);
    }
    const report = investigateSymbolContract({ projectPath: root, targetFile: "target.ts", symbol });

    expect(report.calls.items).toHaveLength(1);
    expect(report.calls.items[0]?.invocation).toBe(invocation);
    expect(report.analyzer_coverage.source_scope).toMatchObject({
      kind: "project-local-module-graph",
      files_discovered: Object.keys(files).length,
      files_selected: Object.keys(files).length,
      complete: true
    });
    expect(report.status).toBe("complete");
  });

  it("follows long chains of renamed re-exports and terminates on module cycles", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symbol-module-chain-"));
    await writeFile(path.join(root, "target.ts"), "export function TargetWidget(value: string) { return value; }");
    for (let index = 0; index < 10; index += 1) {
      const previous = index === 0 ? "target" : `barrel${index - 1}`;
      const previousSymbol = index === 0 ? "TargetWidget" : `A${index - 1}`;
      await writeFile(path.join(root, `barrel${index}.ts`),
        `export { ${previousSymbol} as A${index} } from './${previous}.js';\n`
        + (index === 0 ? "export * from './barrel9.js';" : ""));
    }
    await writeFile(path.join(root, "usage.ts"), "import { A9 as draw } from './barrel9.js';\ndraw('hello');");
    const report = investigateSymbolContract({ projectPath: root, targetFile: "target.ts", symbol: "TargetWidget" });

    expect(report.calls.items.map((call) => call.invocation)).toEqual(["draw('hello')"]);
    expect(report.analyzer_coverage.source_scope.files_selected).toBe(12);
  });

  it.each(["./missing-barrel.js", "@widgets"])(
    "keeps the unresolved local module %s visible instead of claiming complete coverage", async (specifier) => {
      const root = await mkdtemp(path.join(tmpdir(), "symbol-module-unknown-"));
      await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@widgets": ["./missing-barrel.ts"] } }
      }));
      await writeFile(path.join(root, "target.ts"), "export function TargetWidget() { return null; }");
      await writeFile(path.join(root, "usage.ts"), `import Panel from '${specifier}';\nPanel();`);
      const report = investigateSymbolContract({ projectPath: root, targetFile: "target.ts", symbol: "TargetWidget" });

      expect(report.calls.items).toHaveLength(0);
      expect(report.analyzer_coverage.source_scope.complete).toBe(false);
      expect(report.static_analysis_limits).toEqual(expect.arrayContaining([
        expect.stringContaining(`usage.ts → ${specifier}`)
      ]));
      expect(report.runtime_verification_required).toBe(true);
      expect(report.status).toBe("complete_with_dynamic_unknowns");
    }
  );

  it("resolves inherited project aliases and invalidates binding when the base config changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symbol-module-paths-"));
    await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ extends: "./tsconfig.base.json" }));
    await writeFile(path.join(root, "tsconfig.base.json"), JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@widgets": ["./target.ts"] } }
    }));
    await writeFile(path.join(root, "target.ts"), "export default function TargetWidget() { return null; }");
    await writeFile(path.join(root, "other.ts"), [
      "import TargetWidget from './target.js';",
      "export default function OtherWidget() { return null; }"
    ].join("\n"));
    await writeFile(path.join(root, "usage.ts"), "import Panel from '@widgets';\nPanel();");
    const input = { projectPath: root, targetFile: "target.ts", symbol: "TargetWidget" };

    const before = investigateSymbolContract(input);
    expect(before.calls.items.map((call) => call.invocation)).toEqual(["Panel()"]);
    await writeFile(path.join(root, "tsconfig.base.json"), JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@widgets": ["./other.ts"] } }
    }));
    const after = investigateSymbolContract(input);
    expect(after.calls.items).toHaveLength(0);
    expect(before.analyzer_coverage.source_scope.files_selected).toBe(3);
    expect(after.analyzer_coverage.source_scope.files_selected).toBe(3);
  });

  it("does not confuse identical names or include unrelated importers of a shared dependency", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symbol-module-identity-"));
    await writeFile(path.join(root, "target.ts"), [
      "import { identity } from './shared.js';",
      "export function render(value: string) { return identity(value); }"
    ].join("\n"));
    await writeFile(path.join(root, "usage.ts"), "import { render as draw } from './target.js';\ndraw('target');");
    await writeFile(path.join(root, "shared.ts"), "export function identity(value: string) { return value; }");
    await writeFile(path.join(root, "other.ts"), [
      "import { identity } from './shared.js';",
      "export function render(value: string) { return identity(value); }",
      "render('unrelated');"
    ].join("\n"));

    const report = investigateSymbolContract({ projectPath: root, targetFile: "target.ts", symbol: "render" });
    expect(report.calls.items.map((call) => call.invocation)).toEqual(["draw('target')"]);
    expect(report.analyzer_coverage.source_scope).toMatchObject({ files_discovered: 4, files_selected: 3 });
  });

  it("retains depth limits even after resolving an earlier indirect use", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symbol-indirect-depth-"));
    await writeFile(path.join(root, "tsconfig.json"), "{}");
    await writeFile(path.join(root, "target.ts"), "export function TargetWidget() { return null; }");
    await writeFile(path.join(root, "usage.ts"), [
      "import { TargetWidget } from './target.js';",
      "declare function register(value: unknown): void;",
      "declare function wrap(value: unknown): unknown;",
      "const alias0 = wrap(TargetWidget);",
      ...Array.from({ length: 15 }, (_, index) => `const alias${index + 1} = alias${index};`),
      "register(alias15);"
    ].join("\n"));
    const report = investigateSymbolContract({ projectPath: root, targetFile: "target.ts", symbol: "TargetWidget" });

    expect(report.calls.items.some((call) => call.invocation === "wrap(TargetWidget)")).toBe(true);
    expect(report.reference_accounting.blocked).toBe(0);
    expect(report.static_analysis_limits).toEqual(expect.arrayContaining([
      expect.stringContaining("间接引用追踪达到最大深度")
    ]));
    expect(report.runtime_verification_required).toBe(true);
    expect(report.status).toBe("complete_with_dynamic_unknowns");
  });

  it("retains state limits when some indirect uses were resolved", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symbol-indirect-states-"));
    await writeFile(path.join(root, "tsconfig.json"), "{}");
    await writeFile(path.join(root, "target.ts"), "export function TargetWidget() { return null; }");
    await writeFile(path.join(root, "usage.ts"), [
      "import { TargetWidget } from './target.js';",
      "declare function wrap(value: unknown): unknown;",
      "declare function register(value: unknown): void;",
      "const carrier = wrap(TargetWidget);",
      ...Array.from({ length: 110 }, () => "register(carrier);")
    ].join("\n"));
    const report = investigateSymbolContract({ projectPath: root, targetFile: "target.ts", symbol: "TargetWidget" });

    expect(report.calls.items.length).toBeGreaterThan(1);
    expect(report.calls.items.some((site) => site.target_usage.certainty === "possible")).toBe(true);
    expect(report.static_analysis_limits).toEqual(expect.arrayContaining([
      expect.stringContaining("间接引用追踪达到最大状态数")
    ]));
    expect(report.runtime_verification_required).toBe(true);
    expect(report.status).toBe("complete_with_dynamic_unknowns");
  });

  it("finds module callers of a global function without import edges", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symbol-global-callers-"));
    await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
      compilerOptions: { moduleDetection: "legacy" }
    }));
    await writeFile(path.join(root, "target.ts"), "function target(value: string) { return value; }");
    await writeFile(path.join(root, "usage.ts"), "export const result = target('hello');");
    const report = investigateSymbolContract({ projectPath: root, targetFile: "target.ts", symbol: "target" });

    expect(report.calls.items.map((call) => call.invocation)).toEqual(["target('hello')"]);
  });

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

  it("lifts a routed component reference to navigator.push with params and guards", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "symbol-investigation-component-route-"));
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
      "export function TargetPage(props: { navigator: unknown; dispatch: unknown }) {",
      "  return props;",
      "}"
    ].join("\n"));
    await writeFile(path.join(root, "entry.ts"), [
      "import { TargetPage } from './target.js';",
      "declare const navigator: { push(route: unknown): void };",
      "declare const dispatch: unknown;",
      "declare function isLoggedIn(): boolean;",
      "declare function isRealName(): boolean;",
      "export function openTarget() {",
      "  if (!isLoggedIn()) return;",
      "  if (!isRealName()) return;",
      "  const route = {",
      "    component: TargetPage,",
      "    params: { navigator, dispatch, productType: '零钱宝' }",
      "  };",
      "  navigator.push(route);",
      "}"
    ].join("\n"));

    const report = investigateSymbolContract({
      projectPath: root,
      targetFile: "target.ts",
      symbol: "TargetPage"
    });
    const routed = report.behavior_fingerprints.find((fingerprint) => (
      fingerprint.invocation.kind === "indirect"
      && fingerprint.invocation.callee === "navigator.push"
    ));

    expect(routed).toBeDefined();
    expect(routed?.invocation.target_path).toBe("component");
    expect(routed?.arguments).toMatchObject({
      "payload.component": "TargetPage",
      "payload.params": "{ navigator, dispatch, productType: '零钱宝' }"
    });
    expect(routed?.preconditions).toEqual(expect.arrayContaining([
      expect.stringContaining("isLoggedIn"),
      expect.stringContaining("isRealName")
    ]));
    expect(routed?.context).toEqual(expect.arrayContaining([
      "navigator", "dispatch", "isLoggedIn", "isRealName"
    ]));
    expect(routed?.side_effects).toEqual(expect.arrayContaining([
      "delivers:component",
      "indirect:navigator.push"
    ]));
  });
});

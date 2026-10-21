import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { investigateSymbolContract } from "./symbolInvestigationScript.js";

async function investigate(source: string, extraFiles: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "symbol-value-flow-"));
  const files = {
    "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" } }),
    "target.ts": "export function target(value: number) { return value + 1; }",
    "usage.tsx": "import { target } from './target.js';\n" + source,
    ...extraFiles
  };
  for (const [file, content] of Object.entries(files)) await writeFile(path.join(root, file), content);
  return investigateSymbolContract({ projectPath: root, targetFile: "target.ts", symbol: "target" });
}

describe("function value execution evidence", () => {
  it("resolves const aliases to their execution sites and original argument contract", async () => {
    const report = await investigate("const first = target;\nconst execute = first;\nexecute(42);");
    expect(report.calls.items).toHaveLength(1);
    expect(report.calls.items[0]).toMatchObject({ invocation: "execute(42)",
      target_usage: { kind: "execution", unresolved_reason: null },
      arguments: [{ parameter: "value", expression: "42", provided: true }] });
    expect(report.calls.items[0]!.target_usage.evidence_refs.length).toBeGreaterThan(1);
    expect(report.status).toBe("complete");
  });

  it("follows exported aliases across renamed imports", async () => {
    const report = await investigate("export const execute = target;", {
      "consumer.ts": "import { execute as run } from './usage.js';\nrun(42);"
    });
    expect(report.calls.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ invocation: "run(42)", target_usage: expect.objectContaining({ kind: "execution" }) })
    ]));
  });

  it("distinguishes unknown registration from execution", async () => {
    const report = await investigate("declare function register(cb: unknown): void;\nregister(target);");
    expect(report.calls.items).toHaveLength(1);
    expect(report.calls.items[0]).toMatchObject({ invocation: "register(target)",
      target_usage: { kind: "value-transfer", unresolved_reason: expect.any(String) } });
    expect(report.analyzer_coverage.total_execution_sites).toBe(0);
    expect(report.runtime_verification_required).toBe(true);
    expect(report.status).toBe("complete_with_dynamic_unknowns");
  });

  it("follows callback parameters through multiple source-backed forwarding functions", async () => {
    const report = await investigate([
      "function invoke(cb: (value: number) => number, value: number) { if (value > 0) return cb(value); }",
      "function forward(cb: (value: number) => number, value: number) { return invoke(cb, value); }",
      "forward(target, 42);"
    ].join("\n"));
    const execution = report.calls.items.find((site) => site.invocation === "cb(value)");
    expect(execution?.target_usage.kind).toBe("execution");
    expect(execution?.preconditions).toContain("value > 0");
    expect(report.calls.items.filter((site) => site.target_usage.kind === "value-transfer")).toHaveLength(2);
    expect(report.runtime_verification_required).toBe(false);
  });

  it.each([
    "function other(value: number) { return value; }\nlet execute = target;\nexecute = other;\nexecute(42);",
    "function other(value: number) { return value; }\nlet execute = target;\n({execute} = {execute: other});\nexecute(42);",
    "function other(value: number) { return value; }\nlet execute = target;\n[execute] = [other];\nexecute(42);",
    "function other(value: number) { return value; }\ndeclare const flag: boolean;\nconst execute = flag ? target : other;\nexecute(42);"
  ])("does not claim a mutable or conditional alias is an exact execution", async (source) => {
    const report = await investigate(source);
    expect(report.calls.items.find((site) => site.invocation === "execute(42)")?.target_usage.kind)
      .toBe("possible-execution");
    expect(report.behavior_fingerprints.some((item) => item.invocation.expression === "execute(42)"))
      .toBe(false);
    expect(report.runtime_verification_required).toBe(true);
  });

  it.each([
    "function other(value: number) { return value; }\nfunction invoke(cb: (value: number) => number) { return cb(42); }\ninvoke(target);\ninvoke(other);",
    "function other(value: number) { return value; }\nfunction invoke(cb: (value: number) => number) { cb = other; return cb(42); }\ninvoke(target);"
  ])("keeps mixed or reassigned callback bindings uncertain", async (source) => {
    const report = await investigate(source);
    expect(report.calls.items.find((site) => site.invocation === "cb(42)")?.target_usage.kind)
      .toBe("possible-execution");
    expect(report.runtime_verification_required).toBe(true);
  });

  it("proves a simple identity factory rather than assuming every factory returns its input", async () => {
    const report = await investigate([
      "function identity(cb: (value: number) => number) { return cb; }",
      "const execute = identity(target);",
      "execute(42);"
    ].join("\n"));
    expect(report.calls.items.find((site) => site.invocation === "execute(42)")?.target_usage.kind).toBe("execution");
    expect(report.runtime_verification_required).toBe(false);
  });

  it("does not follow an unrelated return value of a known factory", async () => {
    const report = await investigate([
      "function ignore(cb: unknown) { return () => 0; }",
      "const execute = ignore(target);",
      "execute();"
    ].join("\n"));
    expect(report.calls.items.map((site) => site.target_usage.kind)).toEqual(["value-transfer"]);
    expect(report.analyzer_coverage.total_execution_sites).toBe(0);
  });

  it("marks unknown factory results as possible carriers", async () => {
    const report = await investigate("declare function wrap(cb: unknown): any;\nconst execute = wrap(target);\nexecute(42);");
    expect(report.calls.items.find((site) => site.invocation === "execute(42)")?.target_usage.kind)
      .toBe("possible-execution");
    expect(report.runtime_verification_required).toBe(true);
  });

  it("preserves an escaped branch even when another branch reaches a known execution", async () => {
    const report = await investigate("const execute = target;\nexecute(42);\n(globalThis as any).saved = execute;");
    expect(report.calls.items.some((site) => site.target_usage.kind === "execution")).toBe(true);
    expect(report.unresolved_dynamic_references.some((item) => item.kind === "unresolved-value-flow")).toBe(true);
    expect(report.runtime_verification_required).toBe(true);
  });

  it("finds aliased JSX without reporting it as a mere registration", async () => {
    const report = await investigate("const Panel = target;\nconst view = <Panel value={42} />;", {
      "target.ts": "export function target(props: { value: number }) { return null; }"
    });
    expect(report.calls.items[0]).toMatchObject({ kind: "jsx", target_usage: { kind: "execution" } });
  });

  it("retains each callback call context without conjoining mutually exclusive guards", async () => {
    const report = await investigate([
      "declare const flag: boolean;",
      "function invoke(cb: (value: number) => number, value: number) { return cb(value); }",
      "if (flag) invoke(target, 1);",
      "if (!flag) invoke(target, 2);"
    ].join("\n"));
    const executions = report.calls.items.filter((site) => site.target_usage.kind === "execution");
    expect(executions).toHaveLength(1);
    expect(executions[0]!.preconditions).toEqual([]);
    expect(executions[0]!.target_usage.call_contexts).toEqual(expect.arrayContaining([
      expect.objectContaining({ invocation: "invoke(target, 1)", preconditions: ["flag"] }),
      expect.objectContaining({ invocation: "invoke(target, 2)", preconditions: ["!flag"] })
    ]));
  });

  it("keeps two callback slots at the same registration separate", async () => {
    const report = await investigate("declare function register(first: unknown, second: unknown): void;\nregister(target, target);");
    expect(report.calls.items).toHaveLength(2);
    expect(report.calls.items.map((site) => site.target_usage.argument_index)).toEqual([0, 1]);
    const cards = report.reference_cards.filter((card) => card.target_usage.kind === "value-transfer");
    expect(new Set(cards.map((card) => card.reference_id)).size).toBe(2);
  });

  it("tracks shorthand property values while preserving property mutation uncertainty", async () => {
    const report = await investigate("const handlers = {target};\nhandlers.target(42);");
    expect(report.calls.items.find((site) => site.invocation === "handlers.target(42)")?.target_usage)
      .toMatchObject({ kind: "possible-execution", certainty: "possible" });
    expect(report.runtime_verification_required).toBe(true);
  });

  it("does not freeze candidate transfers from an unknown factory into a proven target contract", async () => {
    const report = await investigate([
      "declare function wrap(cb: unknown): unknown;",
      "declare function register(cb: unknown): void;",
      "const wrapped = wrap(target);",
      "register(wrapped);"
    ].join("\n"));
    const candidate = report.reference_cards.find((card) => card.invocation === "register(wrapped)");
    expect(candidate?.target_usage).toMatchObject({ kind: "value-transfer", certainty: "possible" });
    expect(candidate?.disposition).toBe("blocked");
    expect(report.behavior_fingerprints.some((item) => item.source_reference_id === candidate?.reference_id)).toBe(false);
  });

  it.each([
    "function invoke(cb: (value: number) => number) { return cb(42); }\nconst run = invoke;\nrun(target);",
    "const run = (cb: (value: number) => number) => cb(42);\nrun(target);"
  ])("resolves stable aliases and arrow implementations of callback consumers", async (source) => {
    const report = await investigate(source);
    expect(report.calls.items.find((site) => site.invocation === "cb(42)")?.target_usage.kind).toBe("execution");
    expect(report.runtime_verification_required).toBe(false);
  });

  it.each([
    "let invoke = (cb: (value: number) => number) => cb(42);\ninvoke = () => 0;\ninvoke(target);",
    "function invoke(cb: (value: number) => number) { return cb(42); }\nfunction ignore(cb: unknown) { return 0; }\ndeclare const flag: boolean;\nconst run = flag ? invoke : ignore;\nrun(target);"
  ])("does not trust a reassigned or conditional callback consumer", async (source) => {
    const report = await investigate(source);
    expect(report.calls.items.filter((site) => site.target_usage.kind === "execution")).toHaveLength(0);
    expect(report.runtime_verification_required).toBe(true);
  });

  it("keeps a dynamic consumer uncertain even when the observed method ignores the callback", async () => {
    const report = await investigate("const consumer = { ignore(cb: unknown) { return 0; } };\nconsumer.ignore(target);");
    expect(report.runtime_verification_required).toBe(true);
    expect(report.calls.items[0]?.target_usage.unresolved_reason).toContain("动态接收者");
  });

  it.each([
    "function invoke(cb: (value: number) => number) { return arguments[0](42); }\ninvoke(target);",
    "function invoke(cb: (value: number) => number) { eval('cb = () => 0'); return cb(42); }\ninvoke(target);"
  ])("retains dynamic parameter access as an unknown", async (source) => {
    const report = await investigate(source);
    expect(report.calls.items.filter((site) => site.target_usage.kind === "execution")).toHaveLength(0);
    expect(report.runtime_verification_required).toBe(true);
    expect(report.unresolved_dynamic_references.some((item) => item.expression.includes("arguments 或 eval"))).toBe(true);
  });
});

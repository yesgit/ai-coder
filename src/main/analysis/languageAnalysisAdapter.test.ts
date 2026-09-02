import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createLanguageAnalysisAdapters,
  inspectLanguageAnalysisAvailability,
  JDTLS_CALL_HIERARCHY_ADAPTER,
  PYRIGHT_CALL_HIERARCHY_ADAPTER,
  resolveLanguageAnalysisAdapter,
  SOURCE_LEXICAL_CALLSITE_ADAPTER,
  TYPESCRIPT_JAVASCRIPT_ADAPTER
} from "./languageAnalysisAdapter.js";

describe("language analysis adapters", () => {
  it("always selects the built-in JS/TS analyzer", () => {
    expect(resolveLanguageAnalysisAdapter("src/example.ts", { PATH: "" })?.id)
      .toBe(TYPESCRIPT_JAVASCRIPT_ADAPTER);
  });

  it("uses an explicitly bounded lexical callsite census when Python/Java servers are absent", () => {
    expect(resolveLanguageAnalysisAdapter("src/example.py", { PATH: "" })?.id)
      .toBe(SOURCE_LEXICAL_CALLSITE_ADAPTER);
    expect(resolveLanguageAnalysisAdapter("src/Example.java", { PATH: "" })?.id)
      .toBe(SOURCE_LEXICAL_CALLSITE_ADAPTER);
  });

  it("enumerates every lexical Python call candidate without claiming semantic binding", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "ai-coder-lexical-python-"));
    try {
      await writeFile(path.join(projectPath, "sample.py"), [
        "def target(value):",
        "    return value",
        "",
        "def entry(enabled):",
        "    if enabled:",
        "        return target(1)",
        "",
        "# target(2) is still a lexical candidate and must be adjudicated"
      ].join("\n"));
      const adapter = resolveLanguageAnalysisAdapter("sample.py", { PATH: "" })!;
      const result = await adapter.analyze({
        projectPath,
        targetFile: "sample.py",
        symbol: "target",
        targetLine: 1
      });

      expect(result.kind).toBe("lsp-call-hierarchy");
      if (result.kind !== "lsp-call-hierarchy") return;
      expect(result.report).toMatchObject({
        adapter_id: SOURCE_LEXICAL_CALLSITE_ADAPTER,
        status: "lexical-census-with-semantic-unknowns",
        incoming_calls: [{
          symbol: "entry",
          call_sites: [{ file: "sample.py", line: 6 }, { file: "sample.py", line: 8 }]
        }],
        runtime_verification_required: true
      });
      expect(result.analyzed_target.method_reason).toContain("词法普查");
      expect(result.analyzed_target.unresolved).toEqual(expect.arrayContaining([
        expect.stringContaining("不证明重载、继承、作用域或 import 绑定")
      ]));
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("enumerates outgoing calls inside Python and Java entry owners without an LSP", async () => {
    const projectPath = await mkdtemp(path.join(os.tmpdir(), "ai-coder-lexical-outgoing-"));
    try {
      await writeFile(path.join(projectPath, "routes.py"), [
        "def open_target(enabled, navigator):",
        "    if enabled:",
        "        navigator.push(Target(mode='safe'))",
        "",
        "def unrelated():",
        "    audit()"
      ].join("\n"));
      await writeFile(path.join(projectPath, "Routes.java"), [
        "class Routes {",
        "  void openTarget(boolean enabled) {",
        "    if (enabled) navigator.push(new Target(\"safe\"));",
        "  }",
        "  void unrelated() { audit(); }",
        "}"
      ].join("\n"));

      const python = await resolveLanguageAnalysisAdapter("routes.py", { PATH: "" })!.analyze({
        projectPath,
        targetFile: "routes.py",
        symbol: "open_target",
        targetLine: 1
      });
      const java = await resolveLanguageAnalysisAdapter("Routes.java", { PATH: "" })!.analyze({
        projectPath,
        targetFile: "Routes.java",
        symbol: "openTarget",
        targetLine: 2
      });
      expect(python.kind).toBe("lsp-call-hierarchy");
      expect(java.kind).toBe("lsp-call-hierarchy");
      if (python.kind !== "lsp-call-hierarchy" || java.kind !== "lsp-call-hierarchy") return;
      expect(python.report.outgoing_calls.map((call) => call.symbol)).toEqual(expect.arrayContaining([
        "navigator.push",
        "Target"
      ]));
      expect(python.report.outgoing_calls.map((call) => call.symbol)).not.toContain("audit");
      expect(java.report.outgoing_calls.map((call) => call.symbol)).toEqual(expect.arrayContaining([
        "navigator.push",
        "Target"
      ]));
      expect(java.report.outgoing_calls.map((call) => call.symbol)).not.toContain("audit");
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it("selects explicit Pyright and JDT LS executables", () => {
    const environment = {
      PATH: "",
      AI_CODER_PYRIGHT_LANGSERVER: process.execPath,
      AI_CODER_JDTLS: process.execPath
    };
    expect(resolveLanguageAnalysisAdapter("src/example.py", environment)?.id)
      .toBe(PYRIGHT_CALL_HIERARCHY_ADAPTER);
    expect(resolveLanguageAnalysisAdapter("src/Example.java", environment)?.id)
      .toBe(JDTLS_CALL_HIERARCHY_ADAPTER);
  });

  it("diagnoses precise LSP readiness separately from target-level protocol verification", () => {
    const missing = inspectLanguageAnalysisAvailability({ PATH: "" });
    expect(missing.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        extension: ".py",
        selected_adapter_id: SOURCE_LEXICAL_CALLSITE_ADAPTER,
        degraded: true
      }),
      expect.objectContaining({
        extension: ".java",
        selected_adapter_id: SOURCE_LEXICAL_CALLSITE_ADAPTER,
        degraded: true
      })
    ]));
    expect(missing.services).toEqual(expect.arrayContaining([
      expect.objectContaining({
        adapter_id: PYRIGHT_CALL_HIERARCHY_ADAPTER,
        available: false,
        target_protocol_status: "pending-target-probe"
      })
    ]));

    const configured = inspectLanguageAnalysisAvailability({
      PATH: "",
      AI_CODER_PYRIGHT_LANGSERVER: process.execPath
    });
    expect(configured.services).toEqual(expect.arrayContaining([
      expect.objectContaining({
        adapter_id: PYRIGHT_CALL_HIERARCHY_ADAPTER,
        available: true,
        readiness_evidence: "executable-resolved",
        target_protocol_status: "pending-target-probe",
        executable: process.execPath
      })
    ]));
    expect(configured.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        extension: ".py",
        selected_adapter_id: PYRIGHT_CALL_HIERARCHY_ADAPTER,
        degraded: false,
        runtime_verification_required: true
      })
    ]));
  });

  it("normalizes LSP call topology and marks semantic unknowns explicitly", async () => {
    const projectPath = path.resolve("/tmp/ai-coder-language-adapter-test");
    const targetUri = pathToFileURL(path.join(projectPath, "sample.py")).href;
    const adapters = createLanguageAnalysisAdapters({
      PATH: "",
      AI_CODER_PYRIGHT_LANGSERVER: process.execPath
    }, async () => ({
      target: item("target", targetUri, 0),
      incoming: [{
        from: item("caller", targetUri, 3),
        fromRanges: [item("caller", targetUri, 4).range]
      }],
      outgoing: [{
        to: item("helper", targetUri, 6),
        fromRanges: [item("helper", targetUri, 1).range]
      }],
      graph: {
        nodes: [
          { id: "node-1", item: item("target", targetUri, 0), depth: 0, expanded: true },
          { id: "node-2", item: item("caller", targetUri, 3), depth: 1, expanded: true },
          { id: "node-3", item: item("helper", targetUri, 6), depth: 1, expanded: true }
        ],
        edges: [
          {
            id: "edge-1",
            from: "node-2",
            to: "node-1",
            callsiteUri: targetUri,
            fromRanges: [item("caller", targetUri, 4).range],
            discoveredAtDepth: 0
          },
          {
            id: "edge-2",
            from: "node-1",
            to: "node-3",
            callsiteUri: targetUri,
            fromRanges: [item("helper", targetUri, 1).range],
            discoveredAtDepth: 0
          }
        ],
        coverage: {
          max_depth: 2,
          max_symbols: 100,
          nodes_discovered: 3,
          nodes_expanded: 3,
          edges_discovered: 2,
          complete: true,
          truncated_reasons: []
        }
      }
    }));
    const adapter = adapters.find((item) => item.id === PYRIGHT_CALL_HIERARCHY_ADAPTER)!;
    const result = await adapter.analyze({
      projectPath,
      targetFile: "sample.py",
      symbol: "target",
      targetLine: 1
    });

    expect(result.kind).toBe("lsp-call-hierarchy");
    if (result.kind !== "lsp-call-hierarchy") return;
    expect(result.report).toMatchObject({
      adapter_id: PYRIGHT_CALL_HIERARCHY_ADAPTER,
      target: { file: "sample.py", symbol: "target", line: 1 },
      incoming_calls: [{
        file: "sample.py",
        symbol: "caller",
        line: 4,
        call_sites: [{ file: "sample.py", line: 5 }]
      }],
      outgoing_calls: [{
        file: "sample.py",
        symbol: "helper",
        line: 7,
        call_sites: [{ file: "sample.py", line: 2 }]
      }],
      call_graph: {
        coverage: {
          nodes_discovered: 3,
          nodes_expanded: 3,
          edges_discovered: 2,
          complete: true
        }
      },
      runtime_verification_required: true
    });
    expect(result.analyzed_target).toMatchObject({
      analysis_method: "language-adapter",
      adapter_id: PYRIGHT_CALL_HIERARCHY_ADAPTER,
      analyzer_sections: ["definition", "incoming-calls", "outgoing-calls", "recursive-call-graph"],
      runtime_verification_required: true
    });
    expect(result.analyzed_target.inputs).toEqual([
      expect.stringContaining("未由 LSP 证明")
    ]);
  });
});

function item(name: string, uri: string, line: number) {
  const range = { start: { line, character: 0 }, end: { line, character: 20 } };
  return { name, kind: 12, uri, range, selectionRange: range };
}

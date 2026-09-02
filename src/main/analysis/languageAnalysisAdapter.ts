import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readdirSync, readFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  runLspCallHierarchy,
  type LspCallHierarchyReport,
  type LspCallHierarchyRequest
} from "./lspCallHierarchyClient.js";
import {
  investigateSymbolContract,
  type SymbolInvestigationReport
} from "./symbolInvestigationScript.js";

export const TYPESCRIPT_JAVASCRIPT_ADAPTER = "typescript-javascript";
export const PYRIGHT_CALL_HIERARCHY_ADAPTER = "python-pyright-call-hierarchy";
export const JDTLS_CALL_HIERARCHY_ADAPTER = "java-jdtls-call-hierarchy";
export const SOURCE_LEXICAL_CALLSITE_ADAPTER = "source-lexical-callsite-census";

export interface LanguageSymbolAnalysisRequest {
  projectPath: string;
  targetFile: string;
  symbol: string;
  targetLine?: number;
  maxWrapperDepth?: number;
  maxWrapperSymbols?: number;
}

export interface LspLanguageAnalysisReport {
  schema_version: 1;
  adapter_id: string;
  report_digest: string;
  status:
    | "topology-complete-with-semantic-unknowns"
    | "topology-bounded-with-semantic-unknowns"
    | "lexical-census-with-semantic-unknowns";
  target: {
    file: string;
    symbol: string;
    line: number;
    detail?: string;
  };
  incoming_calls: Array<{
    symbol: string;
    file: string;
    line: number;
    detail?: string;
    call_sites: Array<{ file: string; line: number }>;
  }>;
  outgoing_calls: Array<{
    symbol: string;
    file: string;
    line: number;
    detail?: string;
    call_sites: Array<{ file: string; line: number }>;
  }>;
  call_graph?: {
    nodes: Array<{
      id: string;
      symbol: string;
      file: string;
      line: number;
      depth: number;
      expanded: boolean;
      detail?: string;
    }>;
    edges: Array<{
      id: string;
      from: string;
      to: string;
      call_sites: Array<{ file: string; line: number }>;
      discovered_at_depth: number;
    }>;
    coverage: {
      max_depth: number;
      max_symbols: number;
      nodes_discovered: number;
      nodes_expanded: number;
      edges_discovered: number;
      complete: boolean;
      truncated_reasons: string[];
    };
  };
  unresolved_semantics: string[];
  evidence_refs: string[];
  runtime_verification_required: true;
}

export type LanguageAnalysisResult =
  | {
      kind: "exact-symbol-contract";
      adapter_id: typeof TYPESCRIPT_JAVASCRIPT_ADAPTER;
      report: SymbolInvestigationReport;
      effective_input: LanguageSymbolAnalysisRequest;
    }
  | {
      kind: "lsp-call-hierarchy";
      adapter_id: string;
      report: LspLanguageAnalysisReport;
      analyzed_target: Record<string, unknown>;
    };

export interface LanguageAnalysisAdapter {
  id: string;
  analysis_depth: "exact-symbol-contract" | "call-topology" | "lexical-callsite-census";
  supported_extensions: readonly string[];
  precision: "host-exact" | "lsp-topology" | "lexical-candidate";
  supports(targetFile: string): boolean;
  availability(): LanguageAnalysisAdapterAvailability;
  analyze(input: LanguageSymbolAnalysisRequest): Promise<LanguageAnalysisResult>;
}

export interface LanguageAnalysisAdapterAvailability {
  available: boolean;
  readiness_evidence: "built-in" | "executable-resolved" | "built-in-fallback";
  target_protocol_status: "not-applicable" | "pending-target-probe";
  executable?: string;
  reason?: string;
}

export interface LanguageAnalysisAvailabilityDiagnostic {
  schema_version: 1;
  services: Array<{
    adapter_id: string;
    analysis_depth: LanguageAnalysisAdapter["analysis_depth"];
    precision: LanguageAnalysisAdapter["precision"];
    supported_extensions: string[];
    available: boolean;
    readiness_evidence: LanguageAnalysisAdapterAvailability["readiness_evidence"];
    target_protocol_status: LanguageAnalysisAdapterAvailability["target_protocol_status"];
    executable?: string;
    reason?: string;
  }>;
  routes: Array<{
    extension: string;
    selected_adapter_id: string;
    precision: LanguageAnalysisAdapter["precision"];
    degraded: boolean;
    runtime_verification_required: boolean;
  }>;
}

interface LspAdapterConfig {
  id: string;
  extension: string;
  languageId: string;
  environmentVariable: string;
  defaultCommand: string;
  args: string[];
}

type LspRunner = (request: LspCallHierarchyRequest) => Promise<LspCallHierarchyReport>;

/**
 * Resolve a source-language adapter without guessing. A missing external
 * language server is reported as unavailable so orchestration can use explicit
 * manual source analysis instead of creating a capability that can never run.
 */
export function resolveLanguageAnalysisAdapter(
  targetFile: string,
  environment: NodeJS.ProcessEnv = process.env
): LanguageAnalysisAdapter | undefined {
  return createLanguageAnalysisAdapters(environment).find((adapter) => (
    adapter.supports(targetFile) && adapter.availability().available
  ));
}

export function createLanguageAnalysisAdapters(
  environment: NodeJS.ProcessEnv = process.env,
  lspRunner: LspRunner = runLspCallHierarchy
): LanguageAnalysisAdapter[] {
  return [
    createTypeScriptJavaScriptAdapter(),
    createLspAdapter({
      id: PYRIGHT_CALL_HIERARCHY_ADAPTER,
      extension: ".py",
      languageId: "python",
      environmentVariable: "AI_CODER_PYRIGHT_LANGSERVER",
      defaultCommand: "pyright-langserver",
      args: ["--stdio"]
    }, environment, lspRunner),
    createLspAdapter({
      id: JDTLS_CALL_HIERARCHY_ADAPTER,
      extension: ".java",
      languageId: "java",
      environmentVariable: "AI_CODER_JDTLS",
      defaultCommand: "jdtls",
      args: []
    }, environment, lspRunner),
    createSourceLexicalCallsiteAdapter()
  ];
}

/**
 * Read-only service discovery for diagnostics and UI. External LSP entries are
 * intentionally reported as `pending-target-probe`: resolving an executable
 * is not evidence that initialize/prepareCallHierarchy succeeds for a given
 * workspace and symbol. The actual capability run performs that handshake.
 */
export function inspectLanguageAnalysisAvailability(
  environment: NodeJS.ProcessEnv = process.env
): LanguageAnalysisAvailabilityDiagnostic {
  const adapters = createLanguageAnalysisAdapters(environment);
  const extensions = unique(adapters.flatMap((adapter) => [...adapter.supported_extensions]));
  return {
    schema_version: 1,
    services: adapters.map((adapter) => {
      const availability = adapter.availability();
      return {
        adapter_id: adapter.id,
        analysis_depth: adapter.analysis_depth,
        precision: adapter.precision,
        supported_extensions: [...adapter.supported_extensions],
        available: availability.available,
        readiness_evidence: availability.readiness_evidence,
        target_protocol_status: availability.target_protocol_status,
        ...(availability.executable ? { executable: availability.executable } : {}),
        ...(availability.reason ? { reason: availability.reason } : {})
      };
    }),
    routes: extensions.map((extension) => {
      const selected = adapters.find((adapter) => (
        adapter.supported_extensions.includes(extension)
        && adapter.availability().available
      ));
      if (!selected) {
        throw new Error(`语言分析路由没有可用适配器：${extension}`);
      }
      return {
        extension,
        selected_adapter_id: selected.id,
        precision: selected.precision,
        degraded: selected.precision === "lexical-candidate",
        runtime_verification_required: selected.precision !== "host-exact"
      };
    })
  };
}

export function languageAdapterForId(
  adapterId: string,
  environment: NodeJS.ProcessEnv = process.env
): LanguageAnalysisAdapter | undefined {
  return createLanguageAnalysisAdapters(environment).find((adapter) => adapter.id === adapterId);
}

function createTypeScriptJavaScriptAdapter(): LanguageAnalysisAdapter {
  return {
    id: TYPESCRIPT_JAVASCRIPT_ADAPTER,
    analysis_depth: "exact-symbol-contract",
    supported_extensions: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"],
    precision: "host-exact",
    supports: (targetFile) => /\.(?:[cm]?[jt]sx?|mts|cts)$/i.test(targetFile),
    availability: () => ({
      available: true,
      readiness_evidence: "built-in",
      target_protocol_status: "not-applicable"
    }),
    async analyze(input) {
      let effectiveInput = { ...input };
      let report = investigateSymbolContract(input);
      if (!report.wrapper_graph.complete || report.status === "partial") {
        effectiveInput = {
          ...input,
          maxWrapperDepth: Math.max(input.maxWrapperDepth ?? 8, 20),
          maxWrapperSymbols: Math.max(input.maxWrapperSymbols ?? 100, 500)
        };
        report = investigateSymbolContract(effectiveInput);
      }
      return {
        kind: "exact-symbol-contract",
        adapter_id: TYPESCRIPT_JAVASCRIPT_ADAPTER,
        report,
        effective_input: effectiveInput
      };
    }
  };
}

function createLspAdapter(
  config: LspAdapterConfig,
  environment: NodeJS.ProcessEnv,
  lspRunner: LspRunner
): LanguageAnalysisAdapter {
  const configuredCommand = environment[config.environmentVariable]?.trim();
  const command = configuredCommand || config.defaultCommand;
  const executable = findExecutable(command, environment.PATH);
  return {
    id: config.id,
    analysis_depth: "call-topology",
    supported_extensions: [config.extension],
    precision: "lsp-topology",
    supports: (targetFile) => path.extname(targetFile).toLowerCase() === config.extension,
    availability: () => executable
      ? {
          available: true,
          readiness_evidence: "executable-resolved",
          target_protocol_status: "pending-target-probe",
          executable
        }
      : {
          available: false,
          readiness_evidence: "executable-resolved",
          target_protocol_status: "pending-target-probe",
          reason: `${config.id} 需要 ${config.environmentVariable} 或 PATH 中的 ${config.defaultCommand}`
        },
    async analyze(input) {
      if (!executable) {
        throw new Error(
          `${config.id} 不可用：请设置 ${config.environmentVariable} 或安装 ${config.defaultCommand}`
        );
      }
      const raw = await lspRunner({
        command: executable,
        args: config.args,
        projectPath: input.projectPath,
        targetFile: input.targetFile,
        symbol: input.symbol,
        targetLine: input.targetLine,
        languageId: config.languageId,
        maxDepth: 2,
        maxSymbols: Math.min(input.maxWrapperSymbols ?? 100, 200)
      });
      const report = normalizeLspReport(config.id, input, raw);
      return {
        kind: "lsp-call-hierarchy",
        adapter_id: config.id,
        report,
        analyzed_target: analyzedTargetFromLspReport(report)
      };
    }
  };
}

function createSourceLexicalCallsiteAdapter(): LanguageAnalysisAdapter {
  return {
    id: SOURCE_LEXICAL_CALLSITE_ADAPTER,
    analysis_depth: "lexical-callsite-census",
    supported_extensions: [".py", ".java"],
    precision: "lexical-candidate",
    supports: (targetFile) => /\.(?:py|java)$/i.test(targetFile),
    availability: () => ({
      available: true,
      readiness_evidence: "built-in-fallback",
      target_protocol_status: "not-applicable"
    }),
    async analyze(input) {
      const report = lexicalCallsiteReport(input);
      return {
        kind: "lsp-call-hierarchy",
        adapter_id: SOURCE_LEXICAL_CALLSITE_ADAPTER,
        report,
        analyzed_target: analyzedTargetFromLspReport(report)
      };
    }
  };
}

function lexicalCallsiteReport(input: LanguageSymbolAnalysisRequest): LspLanguageAnalysisReport {
  const targetFile = normalizeFile(input.targetFile);
  const extension = path.extname(targetFile).toLowerCase();
  const language = extension === ".py" ? "Python" : "Java";
  const definitionLine = input.targetLine ?? findLexicalDefinitionLine(
    readText(path.resolve(input.projectPath, targetFile)),
    input.symbol,
    extension
  ) ?? 1;
  const escaped = escapeRegExp(input.symbol);
  const occurrence = new RegExp(`\\b${escaped}\\s*\\(`, "g");
  const incoming: LspLanguageAnalysisReport["incoming_calls"] = [];
  for (const file of sourceFiles(input.projectPath, extension)) {
    const relative = normalizeFile(path.relative(input.projectPath, file));
    const text = readText(file);
    const lines = text.split(/\r?\n/);
    const callSites: Array<{ file: string; line: number }> = [];
    for (const [index, line] of lines.entries()) {
      occurrence.lastIndex = 0;
      if (!occurrence.test(line)) continue;
      if (relative === targetFile && index + 1 === definitionLine) continue;
      callSites.push({ file: relative, line: index + 1 });
    }
    if (callSites.length === 0) continue;
    const firstLine = callSites[0]!.line;
    const enclosing = lexicalEnclosingSymbol(lines, firstLine, extension) ?? "<module>";
    incoming.push({
      symbol: enclosing,
      file: relative,
      line: lexicalEnclosingDefinitionLine(lines, firstLine, extension) ?? firstLine,
      detail: `${language} 词法候选；尚未证明符号绑定`,
      call_sites: callSites
    });
  }
  const targetLines = readText(path.resolve(input.projectPath, targetFile)).split(/\r?\n/);
  const outgoing = lexicalOutgoingCalls(
    targetFile,
    targetLines,
    definitionLine,
    extension,
    language
  );
  const digestPayload = {
    adapter_id: SOURCE_LEXICAL_CALLSITE_ADAPTER,
    target: { file: targetFile, symbol: input.symbol, line: definitionLine },
    incoming_calls: incoming,
    outgoing_calls: outgoing
  };
  const evidenceRefs = unique([
    `${targetFile}:${definitionLine}`,
    ...incoming.flatMap((call) => call.call_sites.map((site) => `${site.file}:${site.line}`)),
    ...outgoing.flatMap((call) => call.call_sites.map((site) => `${site.file}:${site.line}`))
  ]);
  return {
    schema_version: 1,
    adapter_id: SOURCE_LEXICAL_CALLSITE_ADAPTER,
    report_digest: createHash("sha256").update(JSON.stringify(digestPayload)).digest("hex"),
    status: "lexical-census-with-semantic-unknowns",
    target: { file: targetFile, symbol: input.symbol, line: definitionLine },
    incoming_calls: incoming,
    outgoing_calls: outgoing,
    unresolved_semantics: [
      `${language} 词法普查只证明同名调用形态出现，不证明重载、继承、作用域或 import 绑定`,
      "字符串、注释和动态调用可能产生假阳性或不可枚举边界；每个候选必须由独立 AI 节点裁决",
      "参数、guard、鉴权、上下文、状态读写与副作用必须从逐调用点源码证据总结",
      "缺少语言服务器精确 Call Hierarchy，必须保留运行时验证边界"
    ],
    evidence_refs: evidenceRefs,
    runtime_verification_required: true
  };
}

function lexicalOutgoingCalls(
  targetFile: string,
  lines: string[],
  definitionLine: number,
  extension: string,
  language: string
): LspLanguageAnalysisReport["outgoing_calls"] {
  const [start, end] = lexicalDefinitionSpan(lines, definitionLine, extension);
  const calls = new Map<string, Array<{ file: string; line: number }>>();
  const ignored = new Set([
    "if", "for", "while", "switch", "catch", "return", "throw", "new",
    "def", "class", "super", "this", "synchronized", "assert"
  ]);
  const callPattern = /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/g;
  for (let index = start - 1; index < end; index += 1) {
    const line = stripLexicalComment(lines[index] ?? "", extension);
    for (const match of line.matchAll(callPattern)) {
      const callee = match[1];
      if (!callee || ignored.has(callee) || ignored.has(callee.split(".").at(-1) ?? "")) continue;
      if (index + 1 === definitionLine && lexicalLineDeclaresSymbol(line, callee, extension)) continue;
      const bucket = calls.get(callee) ?? [];
      bucket.push({ file: targetFile, line: index + 1 });
      calls.set(callee, bucket);
    }
  }
  return [...calls.entries()].map(([symbol, callSites]) => ({
    symbol,
    file: targetFile,
    line: callSites[0]?.line ?? definitionLine,
    detail: `${language} 入口函数体内的词法出调用；目标定义和动态绑定尚待逐边 AI 核对`,
    call_sites: callSites
  }));
}

function lexicalDefinitionSpan(
  lines: string[],
  definitionLine: number,
  extension: string
): [number, number] {
  const startIndex = Math.max(0, definitionLine - 1);
  if (extension === ".py") {
    const declaration = lines[startIndex] ?? "";
    const indentation = declaration.match(/^\s*/)?.[0].length ?? 0;
    let end = lines.length;
    for (let index = startIndex + 1; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (!line.trim()) continue;
      const currentIndentation = line.match(/^\s*/)?.[0].length ?? 0;
      if (currentIndentation <= indentation && !/^\s*(?:@|#)/.test(line)) {
        end = index;
        break;
      }
    }
    return [definitionLine, end];
  }
  let depth = 0;
  let opened = false;
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = stripLexicalComment(lines[index] ?? "", extension)
      .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "");
    for (const character of line) {
      if (character === "{") {
        depth += 1;
        opened = true;
      } else if (character === "}" && opened) {
        depth -= 1;
        if (depth <= 0) return [definitionLine, index + 1];
      }
    }
  }
  return [definitionLine, lines.length];
}

function stripLexicalComment(line: string, extension: string): string {
  if (extension === ".py") return line.replace(/#.*$/, "");
  return line.replace(/\/\/.*$/, "");
}

function lexicalLineDeclaresSymbol(line: string, symbol: string, extension: string): boolean {
  const leaf = symbol.split(".").at(-1) ?? symbol;
  const escaped = escapeRegExp(leaf);
  return extension === ".py"
    ? new RegExp(`\\bdef\\s+${escaped}\\s*\\(`).test(line)
    : new RegExp(`\\b${escaped}\\s*\\([^)]*\\)\\s*(?:\\{|throws\\b)`).test(line);
}

function normalizeLspReport(
  adapterId: string,
  input: LanguageSymbolAnalysisRequest,
  raw: LspCallHierarchyReport
): LspLanguageAnalysisReport {
  const targetFile = normalizeUri(raw.target.uri, input.projectPath) ?? normalizeFile(input.targetFile);
  const targetLine = raw.target.selectionRange.start.line + 1;
  const incomingCalls = raw.incoming.map(({ from, fromRanges }) => ({
    symbol: from.name,
    file: normalizeUri(from.uri, input.projectPath) ?? from.uri,
    line: from.selectionRange.start.line + 1,
    ...(from.detail ? { detail: from.detail } : {}),
    call_sites: fromRanges.map((range) => ({
      file: normalizeUri(from.uri, input.projectPath) ?? from.uri,
      line: range.start.line + 1
    }))
  }));
  const outgoingCalls = raw.outgoing.map(({ to, fromRanges }) => ({
    symbol: to.name,
    file: normalizeUri(to.uri, input.projectPath) ?? to.uri,
    line: to.selectionRange.start.line + 1,
    ...(to.detail ? { detail: to.detail } : {}),
    call_sites: fromRanges.map((range) => ({
      file: targetFile,
      line: range.start.line + 1
    }))
  }));
  const callGraph = raw.graph ? {
    nodes: raw.graph.nodes.map((node) => ({
      id: node.id,
      symbol: node.item.name,
      file: normalizeUri(node.item.uri, input.projectPath) ?? node.item.uri,
      line: node.item.selectionRange.start.line + 1,
      depth: node.depth,
      expanded: node.expanded,
      ...(node.item.detail ? { detail: node.item.detail } : {})
    })),
    edges: raw.graph.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      call_sites: edge.fromRanges.map((range) => ({
        file: normalizeUri(edge.callsiteUri, input.projectPath) ?? edge.callsiteUri,
        line: range.start.line + 1
      })),
      discovered_at_depth: edge.discoveredAtDepth
    })),
    coverage: {
      ...raw.graph.coverage,
      truncated_reasons: [...raw.graph.coverage.truncated_reasons]
    }
  } : undefined;
  const digestPayload = {
    adapter_id: adapterId,
    target: { file: targetFile, symbol: raw.target.name, line: targetLine },
    incoming_calls: incomingCalls,
    outgoing_calls: outgoingCalls,
    call_graph: callGraph
  };
  const evidenceRefs = unique([
    `${targetFile}:${targetLine}`,
    ...incomingCalls.flatMap((call) => [
      ...(isProjectRelative(call.file) ? [`${call.file}:${call.line}`] : []),
      ...call.call_sites.flatMap((site) => isProjectRelative(site.file)
        ? [`${site.file}:${site.line}`]
        : [])
    ]),
    ...outgoingCalls.flatMap((call) => [
      ...(isProjectRelative(call.file) ? [`${call.file}:${call.line}`] : []),
      ...call.call_sites.flatMap((site) => isProjectRelative(site.file)
        ? [`${site.file}:${site.line}`]
        : [])
    ]),
    ...(callGraph?.edges.flatMap((edge) => edge.call_sites.flatMap((site) => (
      isProjectRelative(site.file) ? [`${site.file}:${site.line}`] : []
    ))) ?? [])
  ]);
  return {
    schema_version: 1,
    adapter_id: adapterId,
    report_digest: createHash("sha256").update(JSON.stringify(digestPayload)).digest("hex"),
    status: callGraph?.coverage.complete
      ? "topology-complete-with-semantic-unknowns"
      : "topology-bounded-with-semantic-unknowns",
    target: {
      file: targetFile,
      symbol: raw.target.name,
      line: targetLine,
      ...(raw.target.detail ? { detail: raw.target.detail } : {})
    },
    incoming_calls: incomingCalls,
    outgoing_calls: outgoingCalls,
    ...(callGraph ? { call_graph: callGraph } : {}),
    unresolved_semantics: [
      "LSP Call Hierarchy 不证明实参表达式、缺省参数或参数转发",
      "LSP Call Hierarchy 不证明 guard、鉴权、状态读写或副作用语义",
      "反射、依赖注入、动态注册和字符串分发仍需源码检查与运行时验证",
      ...(callGraph && !callGraph.coverage.complete
        ? callGraph.coverage.truncated_reasons.map((reason) => `递归调用图未完全闭合：${reason}`)
        : [])
    ],
    evidence_refs: evidenceRefs,
    runtime_verification_required: true
  };
}

export function analyzedTargetFromLspReport(
  report: LspLanguageAnalysisReport
): Record<string, unknown> {
  const lexicalFallback = report.adapter_id === SOURCE_LEXICAL_CALLSITE_ADAPTER;
  const definitionRef = `${report.target.file}:${report.target.line}`;
  const callers = report.incoming_calls.flatMap((call) => (
    call.call_sites.length > 0
      ? call.call_sites.map((site) => (
          `${site.file}:${site.line}；caller=${call.symbol}；caller_definition=${call.file}:${call.line}`
        ))
      : [`${call.file}:${call.line}；caller=${call.symbol}；调用表达式位置未由 LSP 返回`]
  ));
  const outgoing = report.outgoing_calls.flatMap((call) => (
    call.call_sites.length > 0
      ? call.call_sites.map((site) => (
          `${site.file}:${site.line}；callee=${call.symbol}；callee_definition=${call.file}:${call.line}`
        ))
      : [`${call.file}:${call.line}；callee=${call.symbol}；调用表达式位置未由 LSP 返回`]
  ));
  return {
    target_file: report.target.file,
    symbol: report.target.symbol,
    analysis_method: "language-adapter",
    method_reason: lexicalFallback
      ? "外部语言服务器不可用；源码词法普查只枚举候选调用点，逐点 AI 调查并保留运行时边界"
      : "语言服务器只冻结调用拓扑；参数、guard、上下文和副作用由逐调用点 AI 调查补充",
    analyzer_sections: lexicalFallback
      ? ["definition", "lexical-callsite-census"]
      : report.call_graph
        ? ["definition", "incoming-calls", "outgoing-calls", "recursive-call-graph"]
        : ["definition", "incoming-calls", "outgoing-calls"],
    all_pages_consumed: true,
    definition: `${report.target.symbol}；${definitionRef}`,
    inputs: [`参数契约未由 LSP 证明，必须检查定义与调用点；${definitionRef}`],
    outputs: [`返回契约未由 LSP 证明，必须检查定义；${definitionRef}`],
    callers: callers.length > 0 ? callers : [`LSP 未发现入向调用；${definitionRef}`],
    wrappers_and_indirect_references: [
      `反射、动态注册、依赖注入和间接封装不在 LSP Call Hierarchy 完整性保证内；${definitionRef}`
    ],
    guards: [`guard 与业务前置条件未由 LSP 证明，必须逐调用点检查；${definitionRef}`],
    state_and_side_effects: outgoing.length > 0
      ? outgoing
      : [`LSP 未发现出向调用；状态变化与副作用仍需源码检查；${definitionRef}`],
    compatibility_obligations: [
      `保持已发现的入向/出向调用拓扑，并在实现前补齐参数、guard、上下文和副作用契约；${definitionRef}`
    ],
    unresolved: report.unresolved_semantics.map((item) => `${item}；${definitionRef}`),
    evidence_refs: report.evidence_refs,
    adapter_id: report.adapter_id,
    adapter_report_digest: report.report_digest,
    runtime_verification_required: true
  };
}

function normalizeUri(uri: string, projectPath: string): string | undefined {
  if (!uri.startsWith("file:")) return undefined;
  try {
    const absolute = path.resolve(fileURLToPath(uri));
    const project = path.resolve(projectPath);
    const relative = path.relative(project, absolute);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    return normalizeFile(relative);
  } catch {
    return undefined;
  }
}

function sourceFiles(projectPath: string, extension: string): string[] {
  const files: string[] = [];
  const excluded = new Set([
    ".git", ".idea", ".gradle", ".mypy_cache", ".pytest_cache", ".tox",
    ".venv", "__pycache__", "build", "dist", "node_modules", "target", "venv"
  ]);
  const visit = (directory: string) => {
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && excluded.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && path.extname(entry.name).toLowerCase() === extension) files.push(absolute);
    }
  };
  visit(path.resolve(projectPath));
  return files.sort();
}

function readText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function findLexicalDefinitionLine(
  text: string,
  symbol: string,
  extension: string
): number | undefined {
  const escaped = escapeRegExp(symbol);
  const pattern = extension === ".py"
    ? new RegExp(`^\\s*(?:(?:async\\s+)?def|class)\\s+${escaped}\\b`)
    : new RegExp(`\\b(?:class|interface|record|enum)\\s+${escaped}\\b|\\b${escaped}\\s*\\([^;]*\\)\\s*(?:throws\\s+[^\\{]+)?\\{?\\s*$`);
  const index = text.split(/\r?\n/).findIndex((line) => pattern.test(line));
  return index >= 0 ? index + 1 : undefined;
}

function lexicalEnclosingSymbol(
  lines: string[],
  callLine: number,
  extension: string
): string | undefined {
  for (let index = Math.min(callLine - 1, lines.length - 1); index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (extension === ".py") {
      const match = /^\s*(?:(?:async\s+)?def|class)\s+([A-Za-z_$][\w$]*)\b/.exec(line);
      if (match?.[1]) return match[1];
      continue;
    }
    const type = /\b(?:class|interface|record|enum)\s+([A-Za-z_$][\w$]*)\b/.exec(line);
    const method = /\b([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?:throws\s+[^\{]+)?\{?\s*$/.exec(line);
    const candidate = method?.[1] ?? type?.[1];
    if (candidate && !["if", "for", "while", "switch", "catch", "new"].includes(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function lexicalEnclosingDefinitionLine(
  lines: string[],
  callLine: number,
  extension: string
): number | undefined {
  for (let index = Math.min(callLine - 1, lines.length - 1); index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    const matches = extension === ".py"
      ? /^\s*(?:(?:async\s+)?def|class)\s+[A-Za-z_$][\w$]*\b/.test(line)
      : /\b(?:class|interface|record|enum)\s+[A-Za-z_$][\w$]*\b|\b[A-Za-z_$][\w$]*\s*\([^;]*\)\s*(?:throws\s+[^\{]+)?\{?\s*$/.test(line);
    if (matches) return index + 1;
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeFile(value: string): string {
  return value.split(path.sep).join("/").replace(/^\.\//, "");
}

function isProjectRelative(value: string): boolean {
  return !value.includes("://") && !path.isAbsolute(value) && !value.startsWith("..");
}

function findExecutable(command: string, rawPath: string | undefined): string | undefined {
  if (!command) return undefined;
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    return isExecutable(command) ? path.resolve(command) : undefined;
  }
  for (const directory of (rawPath ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

function isExecutable(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import type { SymbolInvestigationReport } from "./symbolInvestigationScript.js";
import { createBoundedTypeScriptProgram } from "./boundedTypeScriptProgram.js";

export type FeatureCandidateVerdict = "yes" | "no" | "unknown";

export interface FeatureCandidateAdjudication {
  candidate_id: string;
  verdict: Exclude<FeatureCandidateVerdict, "unknown">;
  reason: string;
  evidence_refs: string[];
}

export interface FeatureImplementationCensusInput {
  projectPath: string;
  feature: string;
  aliases?: string[];
  acceptanceClues?: string[];
  negativeClues?: string[];
  scopePaths?: string[];
  adjudications?: FeatureCandidateAdjudication[];
}

interface SourceLocation {
  file: string;
  line: number;
  column: number;
}

export interface FeatureEvidence {
  id: string;
  kind:
    | "symbol-name"
    | "file-path"
    | "declaration-text"
    | "adjacent-anchor"
    | "upstream-path"
    | "downstream-path"
    | "negative-clue"
    | "test-only"
    | "human-adjudication";
  location: SourceLocation;
  detail: string;
  term: string | null;
}

export interface FeatureGraphStep {
  from: string;
  to: string;
  location: SourceLocation;
  kind: "call" | "construct" | "jsx";
}

export interface FeatureImplementationCandidate {
  id: string;
  symbol: string;
  kind: "function" | "method" | "class" | "component";
  role: "entry" | "dispatcher-or-wrapper" | "component" | "implementation" | "service";
  definition: SourceLocation;
  why_possible: string[];
  evidence_for: FeatureEvidence[];
  evidence_against: FeatureEvidence[];
  graph_paths: FeatureGraphStep[][];
  verdict: FeatureCandidateVerdict;
  verdict_reason: string;
  adjudicated: boolean;
  call_contract: null | {
    status: SymbolInvestigationReport["status"];
    report_digest: string;
    calls: number;
    wrappers: number;
    references: number;
    unresolved_dynamic_references: number;
  };
}

export interface FeatureImplementationCensusReport {
  schema_version: 1;
  script: "feature-implementation-census";
  status: "complete" | "partial";
  query: {
    feature: string;
    aliases: string[];
    acceptance_clues: string[];
    negative_clues: string[];
    normalized_terms: string[];
    scope_paths: string[];
  };
  coverage: {
    language: "typescript-javascript";
    analysis_mode: "project-config" | "syntax-fallback";
    files_discovered: number;
    files_scanned: number;
    unsupported_matching_files: string[];
    symbols_indexed: number;
    graph_edges: number;
    search_channels_completed: readonly [
      "symbol-names",
      "file-paths",
      "declaration-text",
      "configuration-adjacency",
      "call-graph-upstream",
      "call-graph-downstream"
    ];
    excluded_paths: string[];
    warnings: string[];
    all_supported_files_scanned: true;
    graph_traversal_complete: true;
  };
  anchors: Array<{
    term: string;
    location: SourceLocation;
    text: string;
  }>;
  candidates: FeatureImplementationCandidate[];
  candidate_accounting: {
    total: number;
    yes: number;
    no: number;
    unknown: number;
    accounted: true;
  };
  selected_targets: Array<{
    candidate_id: string;
    symbol: string;
    kind: FeatureImplementationCandidate["kind"];
    definition: SourceLocation;
    role: FeatureImplementationCandidate["role"];
    call_contract_digest: string;
  }>;
  rejected_candidates: Array<{
    candidate_id: string;
    symbol: string;
    definition: SourceLocation;
    reason: string;
    evidence_refs: string[];
  }>;
  unresolved: string[];
  report_digest: string;
}

interface SearchTerm {
  value: string;
  normalized: string;
  exactOnly: boolean;
  polarity: "positive" | "negative";
}

interface InternalCandidate {
  id: string;
  symbol: string;
  kind: FeatureImplementationCandidate["kind"];
  definition: SourceLocation;
  declaration: ts.Declaration;
  symbolObject?: ts.Symbol;
  nested: boolean;
  evidence: FeatureEvidence[];
  evidenceAgainst: FeatureEvidence[];
}

interface GraphEdge {
  from: string;
  to: string;
  location: SourceLocation;
  kind: FeatureGraphStep["kind"];
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
const UNSUPPORTED_SOURCE_EXTENSIONS = [".java", ".kt", ".kts", ".swift", ".go", ".rs", ".py", ".rb", ".php", ".cs"];
const EXCLUDED_PATHS = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/release/**",
  "**/release-fixed/**",
  "**/.git/**",
  "**/coverage/**"
];
const GENERIC_TERMS = new Set([
  "页面", "功能", "组件", "函数", "实现", "新增", "修改", "支持", "跳转", "进入", "打开",
  "需求", "代码", "相关", "进行", "需要", "通过", "一个", "这个", "the", "page", "function",
  "component", "feature", "implement", "implementation", "添加", "目标", "标识", "分支", "复用",
  "相同", "对应", "以及", "或者"
]);
const SEARCH_CHANNELS = [
  "symbol-names",
  "file-paths",
  "declaration-text",
  "configuration-adjacency",
  "call-graph-upstream",
  "call-graph-downstream"
] as const;
const MAX_GRAPH_HOPS = 2;

/**
 * Host-owned feature implementation census.
 *
 * The script lexically visits every in-scope source, then performs bounded
 * semantic analysis on files with distinctive evidence. Strong candidates,
 * explicit exclusions and weak graph-only candidates are host-adjudicated;
 * callers only need to adjudicate genuinely ambiguous leftovers.
 */
export function censusFeatureImplementations(
  input: FeatureImplementationCensusInput
): FeatureImplementationCensusReport {
  const projectPath = path.resolve(input.projectPath);
  const feature = input.feature.trim();
  if (!feature) throw new Error("feature 不能为空");
  const scopePaths = normalizeScopePaths(projectPath, input.scopePaths);
  const terms = buildSearchTerms(input);
  if (terms.length === 0) throw new Error("无法从 feature、aliases 或 acceptance_clues 提取有效搜索词");

  const allSources = discoverSources(projectPath);
  const scopedSources = allSources.filter((file) => (
    isInScope(projectPath, file, scopePaths)
  ));
  if (scopedSources.length === 0) {
    throw new Error(`scope_paths 内没有可分析的 TypeScript/JavaScript 文件：${scopePaths.join(", ")}`);
  }
  const analysisSources = selectEvidenceBearingSources(
    projectPath,
    scopedSources,
    scopePaths,
    terms
  );
  const programBuild = createBoundedTypeScriptProgram(projectPath, analysisSources);
  const program = programBuild.program;
  const checker = program.getTypeChecker();
  const analysisSourceSet = new Set(analysisSources.map((file) => path.resolve(file)));
  const sourceFiles = program.getSourceFiles().filter((sourceFile) => (
    !sourceFile.isDeclarationFile
    && isInsideProject(projectPath, sourceFile.fileName)
    && analysisSourceSet.has(path.resolve(sourceFile.fileName))
  ));
  const candidates = collectCandidates(projectPath, sourceFiles, checker);
  const bySymbol = indexCandidatesBySymbol(candidates, checker);
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const anchors: FeatureImplementationCensusReport["anchors"] = [];
  const directCandidateIds = new Set<string>();

  for (const candidate of candidates) {
    const sourceFile = candidate.declaration.getSourceFile();
    const declarationText = candidate.declaration.getText(sourceFile);
    for (const term of terms) {
      if (matchesValue(candidate.symbol, term)) {
        const item = evidence(
          term.polarity === "negative" ? "negative-clue" : "symbol-name",
          candidate.definition,
          `符号名 ${candidate.symbol} 命中${term.polarity === "negative" ? "排除线索" : "功能词"} ${term.value}`,
          term.value
        );
        (term.polarity === "negative" ? candidate.evidenceAgainst : candidate.evidence).push(item);
        directCandidateIds.add(candidate.id);
      }
      if (matchesValue(candidate.definition.file, term)) {
        const item = evidence(
          term.polarity === "negative" ? "negative-clue" : "file-path",
          candidate.definition,
          `文件路径命中${term.polarity === "negative" ? "排除线索" : "功能词"} ${term.value}`,
          term.value
        );
        (term.polarity === "negative" ? candidate.evidenceAgainst : candidate.evidence).push(item);
        directCandidateIds.add(candidate.id);
      }
      if (matchesValue(declarationText, term)) {
        const item = evidence(
          term.polarity === "negative" ? "negative-clue" : "declaration-text",
          candidate.definition,
          `定义正文命中${term.polarity === "negative" ? "排除线索" : "功能词"} ${term.value}`,
          term.value
        );
        (term.polarity === "negative" ? candidate.evidenceAgainst : candidate.evidence).push(item);
        directCandidateIds.add(candidate.id);
      }
    }
  }

  for (const sourceFile of sourceFiles) {
    collectAnchorsAndAdjacentCandidates(
      projectPath,
      sourceFile,
      terms,
      checker,
      bySymbol,
      byId,
      anchors,
      directCandidateIds
    );
  }

  const edges = collectGraphEdges(projectPath, sourceFiles, checker, bySymbol, byId);
  const graph = buildGraph(edges);
  const upstream = traverseGraph(directCandidateIds, graph.incoming, "upstream-path");
  const downstream = traverseGraph(directCandidateIds, graph.outgoing, "downstream-path");
  const possibleIds = new Set<string>([
    ...directCandidateIds,
    ...upstream.keys(),
    ...downstream.keys()
  ]);
  const adjudications = validateAdjudications(projectPath, input.adjudications ?? [], possibleIds);
  const unresolved: string[] = [];
  const materialized = [...possibleIds]
    .map((id) => byId.get(id))
    .filter((candidate): candidate is InternalCandidate => Boolean(candidate))
    .sort(compareCandidateLocations)
    .map((candidate) => materializeCandidate(
      projectPath,
      candidate,
      upstream.get(candidate.id),
      downstream.get(candidate.id),
      adjudications.get(candidate.id)
    ));

  const unsupportedMatchingFiles = findUnsupportedMatchingFiles(projectPath, scopePaths, terms);
  for (const file of unsupportedMatchingFiles) {
    unresolved.push(`发现包含功能证据但当前脚本不支持语义解析的文件：${file}`);
  }
  const unknown = materialized.filter((candidate) => candidate.verdict === "unknown");
  for (const candidate of unknown) {
    unresolved.push(
      `候选尚未逐项判定：${candidate.definition.file}:${candidate.definition.line}#${candidate.symbol}`
    );
  }
  const selectedTargets = materialized
    .filter((candidate): candidate is FeatureImplementationCandidate & {
      call_contract: NonNullable<FeatureImplementationCandidate["call_contract"]>;
    } => candidate.verdict === "yes" && candidate.call_contract !== null)
    .map((candidate) => ({
      candidate_id: candidate.id,
      symbol: candidate.symbol,
      kind: candidate.kind,
      definition: candidate.definition,
      role: candidate.role,
      call_contract_digest: candidate.call_contract.report_digest
    }));
  if (selectedTargets.length === 0 && adjudications.size === 0) {
    unresolved.push(
      "没有形成强证据闭环的实现候选；请补充精确符号、协议 token、目标路径或验收线索后重试"
    );
  }
  const rejectedCandidates = materialized
    .filter((candidate) => candidate.verdict === "no")
    .map((candidate) => ({
      candidate_id: candidate.id,
      symbol: candidate.symbol,
      definition: candidate.definition,
      reason: candidate.verdict_reason,
      evidence_refs: candidate.evidence_against.map((item) => (
        `${item.location.file}:${item.location.line}`
      ))
    }));
  const counts = {
    total: materialized.length,
    yes: materialized.filter((candidate) => candidate.verdict === "yes").length,
    no: materialized.filter((candidate) => candidate.verdict === "no").length,
    unknown: unknown.length,
    accounted: true as const
  };
  const base = {
    schema_version: 1 as const,
    script: "feature-implementation-census" as const,
    status: (
      unresolved.length === 0 && counts.unknown === 0
        ? "complete"
        : "partial"
    ) as FeatureImplementationCensusReport["status"],
    query: {
      feature,
      aliases: uniqueStrings(input.aliases ?? []),
      acceptance_clues: uniqueStrings(input.acceptanceClues ?? []),
      negative_clues: uniqueStrings(input.negativeClues ?? []),
      normalized_terms: terms.map((term) => term.value),
      scope_paths: scopePaths
    },
    coverage: {
      language: "typescript-javascript" as const,
      analysis_mode: programBuild.mode,
      files_discovered: allSources.length,
      files_scanned: sourceFiles.length,
      unsupported_matching_files: unsupportedMatchingFiles,
      symbols_indexed: candidates.length,
      graph_edges: edges.length,
      search_channels_completed: SEARCH_CHANNELS,
      excluded_paths: EXCLUDED_PATHS,
      warnings: [
        ...programBuild.warnings,
        `已对范围内 ${scopedSources.length} 个源码文件完成词面普查，并对其中 ${sourceFiles.length} 个证据命中文件执行受限语义分析。`,
        `调用图候选限制在直接证据上下游 ${MAX_GRAPH_HOPS} 跳内，避免通用包装器扩散为无关候选。`
      ],
      all_supported_files_scanned: true as const,
      graph_traversal_complete: true as const
    },
    anchors: dedupeBy(anchors, (anchor) => (
      `${anchor.term}:${anchor.location.file}:${anchor.location.line}:${anchor.location.column}`
    )),
    candidates: materialized,
    candidate_accounting: counts,
    selected_targets: selectedTargets,
    rejected_candidates: rejectedCandidates,
    unresolved: uniqueStrings(unresolved)
  };
  return {
    ...base,
    report_digest: createHash("sha256").update(JSON.stringify(base)).digest("hex")
  };
}

/**
 * Actionable adjudication projection returned to the model-facing MCP tool.
 *
 * The full report can be hundreds of kilobytes because graph paths repeat
 * evidence for every candidate. Rejected candidates are represented by a
 * count; the agent only needs stable ids and evidence for selected/unknown
 * candidates. Keeping the digest near the beginning also prevents it from
 * disappearing when an SDK externalizes oversized results.
 */
export function formatFeatureImplementationCensusToolResult(
  report: FeatureImplementationCensusReport
): string {
  const unresolved = report.unresolved.filter(
    (item) => !item.startsWith("候选尚未逐项判定：")
  );
  return JSON.stringify({
    schema_version: report.schema_version,
    script: report.script,
    report_digest: report.report_digest,
    status: report.status,
    candidate_accounting: report.candidate_accounting,
    query: report.query,
    next_action: report.status === "complete"
      ? "将 selected_targets 用于后续调查并提交 investigate handoff；report_digest 与候选计数由宿主按最后一次真实调用自动回填。"
      : report.candidate_accounting.unknown > 0
        ? "仅逐项读取 candidates 中 verdict=unknown 的定义位置；下一次调用复用相同 query 并提交这些候选的 adjudications。"
        : "候选已记账但 unresolved 仍有静态分析边界；按 unresolved 补充范围或人工证据，不要重复提交相同输入。",
    candidates: report.candidates
      .filter((candidate) => candidate.verdict === "unknown")
      .map((candidate) => ({
      id: candidate.id,
      symbol: candidate.symbol,
      kind: candidate.kind,
      role: candidate.role,
      definition: candidate.definition,
      verdict: candidate.verdict,
      verdict_reason: candidate.verdict_reason,
      adjudicated: candidate.adjudicated,
      why_possible: candidate.why_possible,
      evidence_for: candidate.evidence_for.map(compactFeatureEvidence),
      evidence_against: candidate.evidence_against.map(compactFeatureEvidence),
      call_contract: candidate.call_contract
    })),
    selected_targets: report.selected_targets,
    rejected_candidate_count: report.rejected_candidates.length,
    unresolved,
    coverage: {
      language: report.coverage.language,
      analysis_mode: report.coverage.analysis_mode,
      files_scanned: report.coverage.files_scanned,
      symbols_indexed: report.coverage.symbols_indexed,
      graph_edges: report.coverage.graph_edges,
      unsupported_matching_files: report.coverage.unsupported_matching_files,
      warnings: report.coverage.warnings,
      all_supported_files_scanned: report.coverage.all_supported_files_scanned,
      graph_traversal_complete: report.coverage.graph_traversal_complete
    }
  });
}

function compactFeatureEvidence(item: FeatureEvidence): {
  kind: FeatureEvidence["kind"];
  ref: string;
  detail: string;
  term: string | null;
} {
  return {
    kind: item.kind,
    ref: `${item.location.file}:${item.location.line}`,
    detail: item.detail,
    term: item.term
  };
}

function discoverSources(projectPath: string): string[] {
  return ts.sys.readDirectory(projectPath, SOURCE_EXTENSIONS, EXCLUDED_PATHS);
}

function selectEvidenceBearingSources(
  projectPath: string,
  sources: string[],
  scopePaths: string[],
  terms: SearchTerm[]
): string[] {
  const positiveTerms = terms.filter((term) => term.polarity === "positive");
  const distinctiveTerms = new Set(positiveTerms
    .filter((term) => [...term.normalized].length >= 4)
    .map((term) => term.normalized));
  const exactFileScopes = new Set(scopePaths.filter((scope) => (
    SOURCE_EXTENSIONS.some((extension) => scope.toLowerCase().endsWith(extension))
  )));
  const matches = sources.map((file) => {
    const relativeFile = relative(projectPath, file);
    if (exactFileScopes.has(relativeFile)) {
      return { file, exactScope: true, terms: positiveTerms.map((term) => term.normalized) };
    }
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      return { file, exactScope: false, terms: [] as string[] };
    }
    const normalizedPath = normalize(relativeFile);
    const normalizedContent = normalize(content);
    return {
      file,
      exactScope: false,
      terms: positiveTerms.filter((term) => (
      normalizedPath.includes(term.normalized)
      || normalizedContent.includes(term.normalized)
      )).map((term) => term.normalized)
    };
  });
  const matched = matches.filter((item) => item.exactScope || item.terms.length > 0);
  const distinctiveMatches = matched.filter((item) => (
    item.exactScope || item.terms.some((term) => distinctiveTerms.has(term))
  ));
  const selected = (
    distinctiveMatches.length > 0 ? distinctiveMatches : matched
  ).map((item) => item.file);
  // An explicit file scope is authoritative even when the requested feature
  // describes code that has not been added yet and therefore has no token hit.
  for (const scope of exactFileScopes) {
    const file = path.resolve(projectPath, scope);
    if (existsSync(file) && !selected.includes(file)) selected.push(file);
  }
  return selected.length > 0 ? selected : [sources[0]!];
}

function collectCandidates(
  projectPath: string,
  sourceFiles: ts.SourceFile[],
  checker: ts.TypeChecker
): InternalCandidate[] {
  const result: InternalCandidate[] = [];
  for (const sourceFile of sourceFiles) {
    const visit = (node: ts.Node): void => {
      const descriptor = candidateDescriptor(node, checker);
      if (descriptor) {
        const definition = locationOf(node, projectPath);
        result.push({
          id: candidateId(definition.file, descriptor.symbol, definition.line),
          symbol: descriptor.symbol,
          kind: descriptor.kind,
          definition,
          declaration: node as ts.Declaration,
          symbolObject: descriptor.symbolObject,
          nested: hasEnclosingCandidateNode(node.parent),
          evidence: [],
          evidenceAgainst: []
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return dedupeBy(result, (candidate) => candidate.id);
}

function candidateDescriptor(
  node: ts.Node,
  checker: ts.TypeChecker
): {
  symbol: string;
  kind: InternalCandidate["kind"];
  symbolObject?: ts.Symbol;
} | null {
  let nameNode: ts.Node | undefined;
  let name: string | undefined;
  let kind: InternalCandidate["kind"] | undefined;
  if (ts.isFunctionDeclaration(node) && (node.name || hasDefaultModifier(node))) {
    nameNode = node.name ?? node;
    name = node.name?.text ?? "default";
    kind = looksLikeComponentName(name) || containsJsx(node) ? "component" : "function";
  } else if (ts.isClassDeclaration(node) && (node.name || hasDefaultModifier(node))) {
    nameNode = node.name ?? node;
    name = node.name?.text ?? "default";
    kind = looksLikeComponentClass(node) ? "component" : "class";
  } else if (ts.isMethodDeclaration(node) && node.name) {
    nameNode = node.name;
    name = node.name.getText();
    kind = "method";
  } else if (
    ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && node.initializer
    && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    nameNode = node.name;
    name = node.name.text;
    kind = looksLikeComponentName(name) || containsJsx(node.initializer) ? "component" : "function";
  } else if (
    ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && node.initializer
    && ts.isCallExpression(node.initializer)
    && looksLikeComponentName(node.name.text)
  ) {
    nameNode = node.name;
    name = node.name.text;
    kind = "component";
  } else if (
    ts.isPropertyAssignment(node)
    && node.initializer
    && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    nameNode = node.name;
    name = node.name.getText();
    kind = "method";
  }
  if (!nameNode || !name || !kind) return null;
  return {
    symbol: stripQuotes(name),
    kind,
    symbolObject: checker.getSymbolAtLocation(nameNode)
  };
}

function indexCandidatesBySymbol(
  candidates: InternalCandidate[],
  checker: ts.TypeChecker
): Map<ts.Symbol, InternalCandidate[]> {
  const index = new Map<ts.Symbol, InternalCandidate[]>();
  for (const candidate of candidates) {
    if (!candidate.symbolObject) continue;
    for (const symbol of [candidate.symbolObject, resolveAlias(candidate.symbolObject, checker)]) {
      const existing = index.get(symbol) ?? [];
      existing.push(candidate);
      index.set(symbol, existing);
    }
  }
  return index;
}

function collectAnchorsAndAdjacentCandidates(
  projectPath: string,
  sourceFile: ts.SourceFile,
  terms: SearchTerm[],
  checker: ts.TypeChecker,
  bySymbol: Map<ts.Symbol, InternalCandidate[]>,
  byId: Map<string, InternalCandidate>,
  anchors: FeatureImplementationCensusReport["anchors"],
  directIds: Set<string>
): void {
  const visit = (node: ts.Node): void => {
    if (isAnchorNode(node)) {
      const text = anchorText(node);
      for (const term of terms) {
        if (!matchesValue(text, term)) continue;
        const location = locationOf(node, projectPath);
        anchors.push({ term: term.value, location, text: text.slice(0, 240) });
        const container = containingStatementOrProperty(node);
        const related = new Map<string, InternalCandidate>();
        if (container) {
          const collect = (child: ts.Node): void => {
            if (ts.isIdentifier(child) || ts.isPropertyAccessExpression(child)) {
              const symbol = checker.getSymbolAtLocation(child);
              if (symbol) {
                for (const candidate of candidatesForSymbol(symbol, checker, bySymbol)) {
                  related.set(candidate.id, candidate);
                }
              }
            }
            ts.forEachChild(child, collect);
          };
          collect(container);
        }
        const enclosing = findEnclosingCandidate(node, byId, projectPath);
        if (enclosing) related.set(enclosing.id, enclosing);
        for (const candidate of related.values()) {
          const item = evidence(
            term.polarity === "negative" ? "negative-clue" : "adjacent-anchor",
            location,
            `与${term.polarity === "negative" ? "排除线索" : "功能证据"} ${term.value} 位于同一语句、配置项或可调用定义`,
            term.value
          );
          (term.polarity === "negative" ? candidate.evidenceAgainst : candidate.evidence).push(item);
          directIds.add(candidate.id);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function collectGraphEdges(
  projectPath: string,
  sourceFiles: ts.SourceFile[],
  checker: ts.TypeChecker,
  bySymbol: Map<ts.Symbol, InternalCandidate[]>,
  byId: Map<string, InternalCandidate>
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const sourceFile of sourceFiles) {
    const visit = (node: ts.Node): void => {
      let expression: ts.Node | undefined;
      let kind: GraphEdge["kind"] | undefined;
      if (ts.isCallExpression(node)) {
        expression = node.expression;
        kind = "call";
      } else if (ts.isNewExpression(node)) {
        expression = node.expression;
        kind = "construct";
      } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        expression = node.tagName;
        kind = "jsx";
      }
      if (expression && kind) {
        const caller = findEnclosingCandidate(node, byId, projectPath);
        const symbol = checker.getSymbolAtLocation(expression);
        if (caller && symbol) {
          for (const callee of candidatesForSymbol(symbol, checker, bySymbol)) {
            if (caller.id === callee.id) continue;
            edges.push({
              from: caller.id,
              to: callee.id,
              location: locationOf(node, projectPath),
              kind
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return dedupeBy(edges, (edge) => (
    `${edge.from}:${edge.to}:${edge.location.file}:${edge.location.line}:${edge.location.column}:${edge.kind}`
  ));
}

function buildGraph(edges: GraphEdge[]): {
  outgoing: Map<string, GraphEdge[]>;
  incoming: Map<string, GraphEdge[]>;
} {
  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge]);
  }
  return { outgoing, incoming };
}

function traverseGraph(
  seeds: Set<string>,
  adjacency: Map<string, GraphEdge[]>,
  direction: "upstream-path" | "downstream-path"
): Map<string, GraphEdge[]> {
  const paths = new Map<string, GraphEdge[]>();
  const queue = [...seeds].map((id) => ({ id, depth: 0 }));
  const visited = new Set(seeds);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= MAX_GRAPH_HOPS) continue;
    for (const edge of adjacency.get(current.id) ?? []) {
      const next = direction === "downstream-path" ? edge.to : edge.from;
      if (visited.has(next)) continue;
      visited.add(next);
      const previous = paths.get(current.id) ?? [];
      paths.set(next, direction === "downstream-path"
        ? [...previous, edge]
        : [edge, ...previous]);
      queue.push({ id: next, depth: current.depth + 1 });
    }
  }
  return paths;
}

function materializeCandidate(
  projectPath: string,
  candidate: InternalCandidate,
  upstreamPath: GraphEdge[] | undefined,
  downstreamPath: GraphEdge[] | undefined,
  adjudication: FeatureCandidateAdjudication | undefined
): FeatureImplementationCandidate {
  const graphEvidence: FeatureEvidence[] = [];
  if (upstreamPath) {
    graphEvidence.push(evidence(
      "upstream-path",
      candidate.definition,
      "该符号位于直接功能证据候选的上游调用路径",
      null
    ));
  }
  if (downstreamPath) {
    graphEvidence.push(evidence(
      "downstream-path",
      candidate.definition,
      "该符号位于直接功能证据候选的下游实现路径",
      null
    ));
  }
  const evidenceFor = dedupeBy([...candidate.evidence, ...graphEvidence], (item) => item.id);
  const testOnly = isTestLikePath(candidate.definition.file);
  const evidenceAgainst: FeatureEvidence[] = [...candidate.evidenceAgainst];
  if (testOnly) {
    evidenceAgainst.push(evidence(
        "test-only",
        candidate.definition,
        "符号位于测试、Fixture 或 Mock 路径，不能作为生产功能实现",
        null
      ));
  }
  let verdict: FeatureCandidateVerdict = "unknown";
  let verdictReason = "已被穷举为可能候选，但正反证据尚不足以安全判定";
  let adjudicated = false;
  if (testOnly) {
    verdict = "no";
    verdictReason = evidenceAgainst.find((item) => item.kind === "test-only")!.detail;
  } else if (evidenceAgainst.length > 0) {
    verdict = "no";
    verdictReason = "候选命中调用方提供的明确排除线索";
  } else if (hasStrongAutomaticEvidence(candidate, evidenceFor)) {
    verdict = "yes";
    verdictReason = "符号、定义、配置邻接或多个独立功能词形成强证据闭环";
  } else {
    verdict = "no";
    verdictReason = evidenceFor.every((item) => (
      item.kind === "upstream-path" || item.kind === "downstream-path"
    ))
      ? "仅位于相关候选的有限调用图路径，缺少自身功能证据"
      : "仅命中单一弱词面证据，不能作为目标功能实现";
  }
  if (adjudication) {
    verdict = adjudication.verdict;
    verdictReason = adjudication.reason.trim();
    adjudicated = true;
    const adjudicationEvidence = adjudication.evidence_refs.map((ref) => {
      const location = parseEvidenceRef(ref);
      return evidence(
        "human-adjudication",
        location,
        `${adjudication.verdict === "yes" ? "支持" : "排除"}候选：${verdictReason}`,
        null
      );
    });
    if (verdict === "yes") evidenceFor.push(...adjudicationEvidence);
    else evidenceAgainst.push(...adjudicationEvidence);
  }

  let callContract: FeatureImplementationCandidate["call_contract"] = null;
  if (verdict === "yes") {
    const dynamicBoundaries = findDynamicBoundaries(candidate, projectPath);
    const contractBase = {
      status: dynamicBoundaries.length > 0
        ? "complete_with_dynamic_unknowns" as const
        : "complete" as const,
      target: candidate.definition,
      calls: downstreamPath?.length ?? 0,
      wrappers: upstreamPath?.length ?? 0,
      references: evidenceFor.length,
      unresolved_dynamic_references: dynamicBoundaries.length
    };
    callContract = {
      status: contractBase.status,
      report_digest: createHash("sha256")
        .update(JSON.stringify(contractBase))
        .digest("hex"),
      calls: contractBase.calls,
      wrappers: contractBase.wrappers,
      references: contractBase.references,
      unresolved_dynamic_references: contractBase.unresolved_dynamic_references
    };
  }
  return {
    id: candidate.id,
    symbol: candidate.symbol,
    kind: candidate.kind,
    role: inferRole(candidate, upstreamPath, downstreamPath),
    definition: candidate.definition,
    why_possible: evidenceFor.map((item) => item.detail),
    evidence_for: dedupeBy(evidenceFor, (item) => item.id),
    evidence_against: dedupeBy(evidenceAgainst, (item) => item.id),
    graph_paths: [upstreamPath, downstreamPath]
      .filter((item): item is GraphEdge[] => Boolean(item?.length))
      .map((items) => items.map(publicGraphStep)),
    verdict,
    verdict_reason: verdictReason,
    adjudicated,
    call_contract: callContract
  };
}

function validateAdjudications(
  projectPath: string,
  adjudications: FeatureCandidateAdjudication[],
  candidateIds: Set<string>
): Map<string, FeatureCandidateAdjudication> {
  const result = new Map<string, FeatureCandidateAdjudication>();
  for (const adjudication of adjudications) {
    if (!candidateIds.has(adjudication.candidate_id)) {
      throw new Error(`adjudication 引用了本次普查不存在的候选：${adjudication.candidate_id}`);
    }
    if (!adjudication.reason?.trim()) {
      throw new Error(`候选 ${adjudication.candidate_id} 的 adjudication 缺少 reason`);
    }
    if (!Array.isArray(adjudication.evidence_refs) || adjudication.evidence_refs.length === 0) {
      throw new Error(`候选 ${adjudication.candidate_id} 的 adjudication 缺少 evidence_refs`);
    }
    for (const ref of adjudication.evidence_refs) {
      const location = parseEvidenceRef(ref);
      const absolute = path.resolve(projectPath, location.file);
      if (!isInsideProject(projectPath, absolute) || !existsSync(absolute)) {
        throw new Error(`adjudication 证据不存在或越出项目：${ref}`);
      }
      const lineCount = readFileSync(absolute, "utf8").split(/\r?\n/).length;
      if (location.line > lineCount) {
        throw new Error(`adjudication 证据行号越界：${ref}`);
      }
    }
    if (result.has(adjudication.candidate_id)) {
      throw new Error(`候选 adjudication 重复：${adjudication.candidate_id}`);
    }
    result.set(adjudication.candidate_id, adjudication);
  }
  return result;
}

function findUnsupportedMatchingFiles(
  projectPath: string,
  scopePaths: string[],
  terms: SearchTerm[]
): string[] {
  const files = ts.sys.readDirectory(projectPath, UNSUPPORTED_SOURCE_EXTENSIONS, EXCLUDED_PATHS)
    .filter((file) => isInScope(projectPath, file, scopePaths));
  return files
    .filter((file) => {
      try {
        const content = readFileSync(file, "utf8");
        return terms.some((term) => matchesValue(content, term));
      } catch {
        return false;
      }
    })
    .map((file) => relative(projectPath, file))
    .sort();
}

function findDynamicBoundaries(
  candidate: InternalCandidate,
  projectPath: string
): string[] {
  const boundaries: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expressionText = node.expression.getText();
      const firstArgument = node.arguments[0];
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
        && firstArgument
        && !ts.isStringLiteralLike(firstArgument);
      const isDynamicRequire = expressionText === "require"
        && firstArgument
        && !ts.isStringLiteralLike(firstArgument);
      const isRuntimeEvaluation = expressionText === "eval" || expressionText === "Function";
      const isComputedDispatch = ts.isElementAccessExpression(node.expression)
        && Boolean(node.expression.argumentExpression)
        && !ts.isStringLiteralLike(node.expression.argumentExpression!)
        && !ts.isNumericLiteral(node.expression.argumentExpression!);
      if (isDynamicImport || isDynamicRequire || isRuntimeEvaluation || isComputedDispatch) {
        const location = locationOf(node, projectPath);
        boundaries.push(
          `动态调用边界无法静态穷举：${location.file}:${location.line}#${candidate.symbol} -> ${node.getText().slice(0, 180)}`
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(candidate.declaration);
  return uniqueStrings(boundaries);
}

function buildSearchTerms(input: FeatureImplementationCensusInput): SearchTerm[] {
  const explicitAliases = uniqueStrings(input.aliases ?? []);
  const positiveText = [
    input.feature,
    ...(input.acceptanceClues ?? [])
  ];
  const values: Array<{
    value: string;
    explicit: boolean;
    polarity: SearchTerm["polarity"];
  }> = explicitAliases
    .map((value) => ({ value, explicit: true, polarity: "positive" as const }));
  const addDerived = (text: string, polarity: SearchTerm["polarity"]): void => {
    const trimmed = text.trim();
    if (trimmed) values.push({ value: trimmed, explicit: false, polarity });
    for (const token of text.match(/[A-Za-z][A-Za-z0-9_.-]*|[\p{Script=Han}]{2,}/gu) ?? []) {
      const chunks = token.split(
        /页面|功能|组件|函数|实现|新增|修改|支持|跳转|进入|打开|需求|代码|相关|进行|需要|通过|可以|一个|这个/
      );
      for (const chunk of chunks) {
        if (chunk.trim()) values.push({ value: chunk.trim(), explicit: false, polarity });
      }
    }
  };
  for (const text of positiveText) {
    addDerived(text, "positive");
  }
  for (const text of input.negativeClues ?? []) {
    addDerived(text, "negative");
  }
  return dedupeBy(
    values
      .map(({ value, explicit, polarity }) => ({
        value: value.trim(),
        normalized: normalize(value),
        exactOnly: normalize(value).length < 2,
        polarity
      }))
      .filter((term) => (
        term.normalized.length > 0
        && (explicitAliases.includes(term.value) || term.normalized.length >= 2)
        && (explicitAliases.includes(term.value) || !GENERIC_TERMS.has(term.normalized))
      )),
    (term) => `${term.polarity}:${term.normalized}`
  );
}

function normalizeScopePaths(projectPath: string, raw: string[] | undefined): string[] {
  const scopes = uniqueStrings(raw ?? []);
  if (scopes.length === 0) return ["."];
  return scopes.map((scope) => {
    const absolute = path.resolve(projectPath, scope);
    if (!isInsideProject(projectPath, absolute)) {
      throw new Error(`scope_path 越出项目：${scope}`);
    }
    return relative(projectPath, absolute) || ".";
  });
}

function isInScope(projectPath: string, file: string, scopes: string[]): boolean {
  const relativeFile = relative(projectPath, file);
  return scopes.some((scope) => (
    scope === "."
    || relativeFile === scope
    || relativeFile.startsWith(`${scope}/`)
  ));
}

function matchesValue(value: string, term: SearchTerm): boolean {
  const normalizedValue = normalize(value);
  return term.exactOnly
    ? normalizedValue === term.normalized
    : normalizedValue.includes(term.normalized);
}

function evidence(
  kind: FeatureEvidence["kind"],
  location: SourceLocation,
  detail: string,
  term: string | null
): FeatureEvidence {
  return {
    id: createHash("sha256")
      .update(`${kind}:${location.file}:${location.line}:${location.column}:${detail}:${term ?? ""}`)
      .digest("hex")
      .slice(0, 16),
    kind,
    location,
    detail,
    term
  };
}

function hasStrongAutomaticEvidence(
  candidate: InternalCandidate,
  items: FeatureEvidence[]
): boolean {
  const kinds = new Set(items.map((item) => item.kind));
  const distinctDirectTerms = new Set(items
    .filter((item) => item.kind !== "upstream-path" && item.kind !== "downstream-path")
    .map((item) => item.term)
    .filter((term): term is string => Boolean(term)));
  const hasDistinctiveSymbolEvidence = items.some((item) => (
    item.kind === "symbol-name"
    && item.term !== null
    && [...normalize(item.term)].length >= 6
  ));
  return (
    hasDistinctiveSymbolEvidence
    && (kinds.has("declaration-text") || kinds.has("file-path") || kinds.has("adjacent-anchor"))
  ) || (
    !candidate.nested
    && distinctDirectTerms.size >= 2
    && kinds.has("declaration-text")
    && kinds.has("adjacent-anchor")
  );
}

function hasEnclosingCandidateNode(node: ts.Node | undefined): boolean {
  let current = node;
  while (current) {
    if (candidateDescriptorWithoutChecker(current)) return true;
    current = current.parent;
  }
  return false;
}

function inferRole(
  candidate: InternalCandidate,
  upstream: GraphEdge[] | undefined,
  downstream: GraphEdge[] | undefined
): FeatureImplementationCandidate["role"] {
  if (candidate.kind === "component") return "component";
  if (upstream) return "entry";
  if (downstream) {
    return /service|repository|client|api|fetch|request/i.test(candidate.symbol)
      ? "service"
      : "implementation";
  }
  return /redirect|dispatch|route|wrapper|adapter/i.test(candidate.symbol)
    ? "dispatcher-or-wrapper"
    : /^(?:on|handle|go|open|push|navigate)/i.test(candidate.symbol)
      ? "entry"
      : "implementation";
}

function publicGraphStep(edge: GraphEdge): FeatureGraphStep {
  return {
    from: edge.from,
    to: edge.to,
    location: edge.location,
    kind: edge.kind
  };
}

function isAnchorNode(node: ts.Node): boolean {
  return ts.isStringLiteralLike(node)
    || ts.isIdentifier(node)
    || ts.isNumericLiteral(node)
    || ts.isNoSubstitutionTemplateLiteral(node);
}

function anchorText(node: ts.Node): string {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return node.getText();
}

function containingStatementOrProperty(node: ts.Node): ts.Node | undefined {
  let current: ts.Node | undefined = node;
  while (current) {
    if (
      ts.isStatement(current)
      || ts.isPropertyAssignment(current)
      || ts.isPropertyDeclaration(current)
      || ts.isJsxAttribute(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return undefined;
}

function findEnclosingCandidate(
  node: ts.Node,
  byId: Map<string, InternalCandidate>,
  projectPath: string
): InternalCandidate | undefined {
  let current: ts.Node | undefined = node;
  while (current) {
    const descriptor = candidateDescriptorWithoutChecker(current);
    if (descriptor) {
      const location = locationOf(current, projectPath);
      return byId.get(candidateId(location.file, descriptor.symbol, location.line));
    }
    current = current.parent;
  }
  return undefined;
}

function candidateDescriptorWithoutChecker(node: ts.Node): { symbol: string } | null {
  if (ts.isFunctionDeclaration(node) && (node.name || hasDefaultModifier(node))) {
    return { symbol: node.name?.text ?? "default" };
  }
  if (ts.isClassDeclaration(node) && (node.name || hasDefaultModifier(node))) {
    return { symbol: node.name?.text ?? "default" };
  }
  if (ts.isMethodDeclaration(node) && node.name) return { symbol: stripQuotes(node.name.getText()) };
  if (
    ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && node.initializer
    && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    return { symbol: node.name.text };
  }
  if (
    ts.isVariableDeclaration(node)
    && ts.isIdentifier(node.name)
    && node.initializer
    && ts.isCallExpression(node.initializer)
    && looksLikeComponentName(node.name.text)
  ) {
    return { symbol: node.name.text };
  }
  if (
    ts.isPropertyAssignment(node)
    && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    return { symbol: stripQuotes(node.name.getText()) };
  }
  return null;
}

function candidatesForSymbol(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  index: Map<ts.Symbol, InternalCandidate[]>
): InternalCandidate[] {
  return dedupeBy([
    ...(index.get(symbol) ?? []),
    ...(index.get(resolveAlias(symbol, checker)) ?? [])
  ], (candidate) => candidate.id);
}

function resolveAlias(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Symbol {
  if (!(symbol.flags & ts.SymbolFlags.Alias)) return symbol;
  try {
    return checker.getAliasedSymbol(symbol);
  } catch {
    return symbol;
  }
}

function looksLikeComponentClass(node: ts.ClassDeclaration): boolean {
  if (!node.name || looksLikeComponentName(node.name.text)) {
    return node.heritageClauses?.some((clause) => clause.types.some((type) => (
      /(?:^|\.)(?:Component|PureComponent)$/.test(type.expression.getText())
    ))) ?? false;
  }
  return false;
}

function hasDefaultModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword));
}

function looksLikeComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function containsJsx(node: ts.Node): boolean {
  let found = false;
  const visit = (child: ts.Node): void => {
    if (found) return;
    if (
      ts.isJsxElement(child)
      || ts.isJsxSelfClosingElement(child)
      || ts.isJsxFragment(child)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function locationOf(node: ts.Node, projectPath: string): SourceLocation {
  const sourceFile = node.getSourceFile();
  const point = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    file: relative(projectPath, sourceFile.fileName),
    line: point.line + 1,
    column: point.character + 1
  };
}

function parseEvidenceRef(ref: string): SourceLocation {
  const match = /^(.+):(\d+)(?::(\d+))?$/.exec(ref.trim());
  if (!match) throw new Error(`证据必须使用 path:line 或 path:line:column：${ref}`);
  return {
    file: match[1]!,
    line: Number(match[2]),
    column: Number(match[3] ?? 1)
  };
}

function candidateId(file: string, symbol: string, line: number): string {
  return createHash("sha256")
    .update(`${file}:${line}#${symbol}`)
    .digest("hex")
    .slice(0, 16);
}

function normalize(value: string): string {
  return (value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join("");
}

function stripQuotes(value: string): string {
  return value.replace(/^['"`]|['"`]$/g, "");
}

function isTestLikePath(file: string): boolean {
  return /(?:^|\/)(?:__tests__|test|tests|fixtures?|mocks?)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(file);
}

function compareCandidateLocations(left: InternalCandidate, right: InternalCandidate): number {
  return left.definition.file.localeCompare(right.definition.file)
    || left.definition.line - right.definition.line
    || left.symbol.localeCompare(right.symbol);
}

function relative(projectPath: string, file: string): string {
  return path.relative(projectPath, path.resolve(file)).split(path.sep).join("/");
}

function isInsideProject(projectPath: string, target: string): boolean {
  const relativePath = path.relative(projectPath, path.resolve(target));
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function dedupeBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const itemKey = key(value);
    if (seen.has(itemKey)) return false;
    seen.add(itemKey);
    return true;
  });
}

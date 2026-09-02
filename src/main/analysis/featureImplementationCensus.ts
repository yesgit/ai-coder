import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
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
    | "retrieval-pruned"
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
  source_span: {
    start_line: number;
    end_line: number;
  };
  retrieval_score: number;
  why_possible: string[];
  evidence_for: FeatureEvidence[];
  evidence_against: FeatureEvidence[];
  graph_paths: FeatureGraphStep[][];
  verdict: FeatureCandidateVerdict;
  verdict_reason: string;
  adjudicated: boolean;
  trace_summary: null | {
    status: "bounded" | "bounded_with_dynamic_unknowns";
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
    language: "typescript-javascript+python-java-lexical";
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
  review_frontier: {
    window_size: number;
    current_round: number;
    ai_review_required: number;
    retrieval_pruned: number;
    expands_when_all_rejected: true;
  };
  selected_targets: Array<{
    candidate_id: string;
    symbol: string;
    kind: FeatureImplementationCandidate["kind"];
    definition: SourceLocation;
    role: FeatureImplementationCandidate["role"];
    trace_summary_digest: string;
  }>;
  rejected_candidates: Array<{
    candidate_id: string;
    symbol: string;
    definition: SourceLocation;
    reason: string;
    evidence_refs: string[];
  }>;
  unresolved: string[];
  closure: {
    inventory_complete: boolean;
    semantic_complete: boolean;
    runtime_verification_required: boolean;
    runtime_complete: boolean;
    closeable: boolean;
  };
  report_digest: string;
}

interface SearchTerm {
  value: string;
  normalized: string;
  exactOnly: boolean;
  explicit: boolean;
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
  enclosingCandidateId?: string;
  evidence: FeatureEvidence[];
  evidenceAgainst: FeatureEvidence[];
}

interface AdjudicationCandidateScope {
  definition: SourceLocation;
  source_span: { start_line: number; end_line: number };
  evidence: FeatureEvidence[];
  evidenceAgainst: FeatureEvidence[];
}

interface LexicalLanguageCandidate extends AdjudicationCandidateScope {
  id: string;
  symbol: string;
  kind: FeatureImplementationCandidate["kind"];
  role: FeatureImplementationCandidate["role"];
  declarationText: string;
  referenceLocations: SourceLocation[];
  nested: boolean;
  enclosingCandidateId?: string;
}

interface GraphEdge {
  from: string;
  to: string;
  location: SourceLocation;
  kind: FeatureGraphStep["kind"];
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
const LEXICAL_LANGUAGE_EXTENSIONS = [".java", ".py"];
const UNSUPPORTED_SOURCE_EXTENSIONS = [".kt", ".kts", ".swift", ".go", ".rs", ".rb", ".php", ".cs"];
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
const SEMANTIC_REVIEW_WINDOW = 8;
const MAX_ADJUDICATION_BATCH = 24;
const MAX_TOOL_RESULT_BYTES = 16_000;
const MAX_TOOL_RESULT_TEXT = 240;
const MAX_AUTO_FULL_DEFINITIONS = 2;
const MAX_AUTO_FULL_DEFINITION_BYTES = 5_000;
const MAX_INLINE_SNIPPET_BYTES = 1_800;
const MAX_INLINE_SNIPPET_LINES = 16;
const READ_CONTEXT_PAGE_LINES = 160;

export interface FeatureCensusToolResultOptions {
  projectPath?: string;
  autoFullDefinitionCount?: number;
}

/**
 * Host-owned feature implementation census.
 *
 * The script lexically visits every in-scope source, then performs bounded
 * semantic analysis on files with distinctive evidence. Corpus and symbol
 * frequency remove plumbing terms from the semantic review frontier. Only
 * symbols with direct lexical/configuration evidence become candidates; the
 * call graph enriches those candidates instead of turning every reachable
 * wrapper/helper into another manual decision.
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
  const allLexicalSources = discoverLexicalLanguageSources(projectPath);
  const scopedSources = allSources.filter((file) => (
    isInScope(projectPath, file, scopePaths)
  ));
  const scopedLexicalSources = allLexicalSources.filter((file) => (
    isInScope(projectPath, file, scopePaths)
  ));
  if (scopedSources.length === 0 && scopedLexicalSources.length === 0) {
    throw new Error(`scope_paths 内没有可分析的 JavaScript/TypeScript/Python/Java 文件：${scopePaths.join(", ")}`);
  }
  const analysisSources = scopedSources.length > 0
    ? selectEvidenceBearingSources(projectPath, scopedSources, scopePaths, terms)
    : [];
  const programBuild = analysisSources.length > 0
    ? createBoundedTypeScriptProgram(projectPath, analysisSources)
    : {
        program: ts.createProgram({ rootNames: [], options: { noEmit: true } }),
        mode: "syntax-fallback" as const,
        warnings: ["当前范围没有 JavaScript/TypeScript 证据文件，跳过 TypeScript 语义图。"]
      };
  const program = programBuild.program;
  const checker = program.getTypeChecker();
  const analysisSourceSet = new Set(analysisSources.map((file) => path.resolve(file)));
  const sourceFiles = program.getSourceFiles().filter((sourceFile) => (
    !sourceFile.isDeclarationFile
    && isInsideProject(projectPath, sourceFile.fileName)
    && analysisSourceSet.has(path.resolve(sourceFile.fileName))
  ));
  const candidates = collectCandidates(projectPath, sourceFiles, checker);
  const lexicalCandidates = collectLexicalLanguageCandidates(
    projectPath,
    scopedLexicalSources,
    scopePaths,
    terms
  );
  const bySymbol = indexCandidatesBySymbol(candidates, checker);
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const candidateTermSelection = selectCandidateEvidenceTerms(candidates, terms);
  const evidenceTerms = candidateTermSelection.terms;
  const anchors: FeatureImplementationCensusReport["anchors"] = [];
  const directCandidateIds = new Set<string>();

  for (const candidate of candidates) {
    const sourceFile = candidate.declaration.getSourceFile();
    const declarationText = candidate.declaration.getText(sourceFile);
    for (const term of evidenceTerms) {
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
      // A filename match describes the file's public/top-level role, not each
      // method nested inside it. Promoting every nested method is what turned a
      // single component into dozens of manual adjudications.
      if (!candidate.nested && matchesValue(candidate.definition.file, term)) {
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
      evidenceTerms,
      checker,
      bySymbol,
      byId,
      anchors,
      directCandidateIds
    );
  }

  collapseAggregateMemberCandidates(directCandidateIds, byId);

  const edges = collectGraphEdges(projectPath, sourceFiles, checker, bySymbol, byId);
  const graph = buildGraph(edges);
  const upstream = traverseGraph(directCandidateIds, graph.incoming, "upstream-path");
  const downstream = traverseGraph(directCandidateIds, graph.outgoing, "downstream-path");
  // Call hierarchy is context for a search hit, not another search result.
  // Promoting all reachable symbols made a single dispatcher fan out into
  // hundreds of unrelated manual adjudications.
  const possibleIds = new Set<string>(directCandidateIds);
  const adjudicationCandidates = new Map<string, AdjudicationCandidateScope>();
  for (const candidate of candidates) {
    adjudicationCandidates.set(candidate.id, adjudicationScopeForInternalCandidate(candidate));
  }
  for (const candidate of lexicalCandidates) adjudicationCandidates.set(candidate.id, candidate);
  const adjudications = validateAdjudications(
    projectPath,
    input.adjudications ?? [],
    adjudicationCandidates
  );
  const unresolved: string[] = [];
  const materializedTypeScript = [...possibleIds]
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
  const materializedLexical = lexicalCandidates.map((candidate) => (
    materializeLexicalLanguageCandidate(candidate, adjudications.get(candidate.id))
  ));
  const materialized = [...materializedTypeScript, ...materializedLexical]
    .sort((left, right) => (
      left.definition.file.localeCompare(right.definition.file)
      || left.definition.line - right.definition.line
      || left.symbol.localeCompare(right.symbol)
    ));
  const reviewFrontier = applySemanticReviewFrontier(materialized);

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
      trace_summary: NonNullable<FeatureImplementationCandidate["trace_summary"]>;
    } => candidate.verdict === "yes" && candidate.trace_summary !== null)
    .map((candidate) => ({
      candidate_id: candidate.id,
      symbol: candidate.symbol,
      kind: candidate.kind,
      definition: candidate.definition,
      role: candidate.role,
      trace_summary_digest: candidate.trace_summary.report_digest
    }));
  if (selectedTargets.length === 0) {
    unresolved.push(
      adjudications.size === 0
        ? "尚未形成经语义裁决确认的实现候选；请逐项裁决未决候选"
        : "全部候选均被排除，未形成目标功能实现；请补充精确符号、协议 token、目标路径或验收线索后重试"
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
  const inventoryComplete = unsupportedMatchingFiles.length === 0;
  const semanticComplete = counts.unknown === 0 && selectedTargets.length > 0;
  const runtimeVerificationRequired = materialized.some((candidate) => (
    candidate.verdict === "yes"
    && (candidate.trace_summary?.unresolved_dynamic_references ?? 0) > 0
  ));
  const runtimeComplete = !runtimeVerificationRequired;
  const closure = {
    inventory_complete: inventoryComplete,
    semantic_complete: semanticComplete,
    runtime_verification_required: runtimeVerificationRequired,
    runtime_complete: runtimeComplete,
    closeable: inventoryComplete && semanticComplete && runtimeComplete
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
      language: "typescript-javascript+python-java-lexical" as const,
      analysis_mode: programBuild.mode,
      files_discovered: allSources.length + allLexicalSources.length,
      files_scanned: sourceFiles.length + scopedLexicalSources.length,
      unsupported_matching_files: unsupportedMatchingFiles,
      symbols_indexed: candidates.length + lexicalCandidates.length,
      graph_edges: edges.length,
      search_channels_completed: SEARCH_CHANNELS,
      excluded_paths: EXCLUDED_PATHS,
      warnings: [
        ...programBuild.warnings,
        `已对范围内 ${scopedSources.length + scopedLexicalSources.length} 个源码文件完成词面普查；`
          + `其中 ${sourceFiles.length} 个 JavaScript/TypeScript 文件执行受限语义分析，`
          + `${scopedLexicalSources.length} 个 Python/Java 文件执行声明与引用索引。`,
        candidateTermSelection.suppressed.length > 0
          ? `已用符号频率排除高频管道词：${candidateTermSelection.suppressed.join(", ")}。`
          : "未发现需要排除的高频管道词。",
        `调用图仅为直接检索候选补充 ${MAX_GRAPH_HOPS} 跳上下文，不将无直接证据的可达包装器升级为待裁决候选。`
      ],
      all_supported_files_scanned: true as const,
      graph_traversal_complete: true as const
    },
    anchors: dedupeBy(anchors, (anchor) => (
      `${anchor.term}:${anchor.location.file}:${anchor.location.line}:${anchor.location.column}`
    )),
    candidates: materialized,
    candidate_accounting: counts,
    review_frontier: reviewFrontier,
    selected_targets: selectedTargets,
    rejected_candidates: rejectedCandidates,
    unresolved: uniqueStrings(unresolved),
    closure
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
 * evidence for every candidate. Unknown candidates are returned in bounded,
 * size-capped batches; rejected decisions remain auditable in the cumulative
 * tool input and host digest, but are not echoed on every later call. Keeping
 * the digest and actionable ids inline prevents the SDK from externalizing the
 * result to a tool-results directory outside the project sandbox.
 */
export function formatFeatureImplementationCensusToolResult(
  report: FeatureImplementationCensusReport,
  options: FeatureCensusToolResultOptions = {}
): string {
  const unresolvedItems = report.unresolved.filter(
    (item) => !item.startsWith("候选尚未逐项判定：")
  );
  const unknownCandidates = report.candidates
    .filter((candidate) => candidate.verdict === "unknown")
    .sort(comparePublicCandidateRelevance)
    .slice(0, MAX_ADJUDICATION_BATCH)
    .map((candidate, index) => ({
      // Match the adjudications input field exactly. Returning this as `id`
      // previously encouraged models to guess/rename the value and caused
      // "candidate does not exist" retries.
      candidate_id: candidate.id,
      symbol: compactToolResultText(candidate.symbol),
      kind: candidate.kind,
      role: candidate.role,
      retrieval_score: candidate.retrieval_score,
      definition: {
        file: candidate.definition.file,
        line: candidate.definition.line,
        column: candidate.definition.column
      },
      verdict: candidate.verdict,
      verdict_reason: compactToolResultText(candidate.verdict_reason),
      // The definition is always valid candidate-scoped evidence. The model
      // reads this location before deciding and can submit the same path:line.
      evidence_ref: `${candidate.definition.file}:${candidate.definition.line}`,
      clue: compactToolResultText(candidate.why_possible[0] ?? ""),
      source: options.projectPath
        ? buildCandidateSourceContext(
            options.projectPath,
            candidate,
            index < (options.autoFullDefinitionCount ?? MAX_AUTO_FULL_DEFINITIONS)
          )
        : undefined
    }));
  const selectedTargets = report.selected_targets.slice(0, MAX_ADJUDICATION_BATCH);
  const base = {
    schema_version: report.schema_version,
    script: report.script,
    report_digest: report.report_digest,
    status: report.status,
    candidate_accounting: report.candidate_accounting,
    review_frontier: report.review_frontier,
    query: report.query,
    continuation_query: {
      feature: report.query.feature,
      aliases: report.query.aliases,
      acceptance_clues: report.query.acceptance_clues,
      negative_clues: report.query.negative_clues,
      scope_paths: report.query.scope_paths
    },
    next_action: report.status === "complete"
      ? "将 selected_targets 用于后续调查并提交 investigate handoff；report_digest 与候选计数由宿主按最后一次真实调用自动回填。"
      : report.candidate_accounting.unknown > 0
        ? "按 retrieval_score 检查本批 candidates。source.mode=full-definition 可直接分析完整定义；source.truncated=true 时，若判断依赖完整分支、状态或副作用，必须按 read_hint 在项目内读到 definition_end_line。把 candidate_id 原样填入 adjudications，并用 evidence_ref 提交本批 yes/no；下一次调用逐字复用 continuation_query，历史裁决由宿主自动累计，不必重传。"
        : "候选已记账但 unresolved 仍有静态分析边界；按 unresolved 补充范围或人工证据，不要重复提交相同输入。",
    selected_targets: selectedTargets,
    selected_targets_projection: {
      returned: selectedTargets.length,
      total: report.selected_targets.length
    },
    rejected_candidates_projection: {
      // Full rejection evidence remains auditable in the cumulative tool input
      // and host digest. Re-emitting every rejected row made later
      // batches grow until the SDK externalized the result outside the repo.
      returned: 0,
      total: report.rejected_candidates.length
    },
    adjudication_batch: {
      returned: 0,
      remaining_after_batch: report.candidate_accounting.unknown
    },
    unresolved: unresolvedItems.slice(0, 8).map(compactToolResultText),
    unresolved_projection: {
      returned: Math.min(unresolvedItems.length, 8),
      total: unresolvedItems.length
    },
    closure: report.closure,
    coverage: {
      language: report.coverage.language,
      analysis_mode: report.coverage.analysis_mode,
      files_scanned: report.coverage.files_scanned,
      symbols_indexed: report.coverage.symbols_indexed,
      graph_edges: report.coverage.graph_edges,
      unsupported_matching_files: report.coverage.unsupported_matching_files
        .slice(0, 8)
        .map(compactToolResultText),
      warnings: report.coverage.warnings.slice(0, 6).map(compactToolResultText),
      all_supported_files_scanned: report.coverage.all_supported_files_scanned,
      graph_traversal_complete: report.coverage.graph_traversal_complete
    }
  };
  const candidates: typeof unknownCandidates = [];
  for (const candidate of unknownCandidates) {
    const projected = {
      ...base,
      candidates: [...candidates, candidate],
      adjudication_batch: {
        returned: candidates.length + 1,
        remaining_after_batch: Math.max(
          0,
          report.candidate_accounting.unknown - candidates.length - 1
        )
      }
    };
    if (
      candidates.length > 0
      && Buffer.byteLength(JSON.stringify(projected), "utf8") > MAX_TOOL_RESULT_BYTES
    ) break;
    candidates.push(candidate);
  }
  return JSON.stringify({
    ...base,
    candidates,
    adjudication_batch: {
      returned: candidates.length,
      remaining_after_batch: Math.max(
        0,
        report.candidate_accounting.unknown - candidates.length
      )
    }
  });
}

function compactToolResultText(value: string): string {
  return value.length <= MAX_TOOL_RESULT_TEXT
    ? value
    : `${value.slice(0, MAX_TOOL_RESULT_TEXT - 1)}…`;
}

function comparePublicCandidateRelevance(
  left: FeatureImplementationCandidate,
  right: FeatureImplementationCandidate
): number {
  return right.retrieval_score - left.retrieval_score
    || left.definition.file.localeCompare(right.definition.file)
    || left.definition.line - right.definition.line
    || left.symbol.localeCompare(right.symbol);
}

function buildCandidateSourceContext(
  projectPath: string,
  candidate: FeatureImplementationCandidate,
  preferFullDefinition: boolean
): {
  mode: "full-definition" | "snippet" | "unavailable";
  path: string;
  start_line: number;
  end_line: number;
  definition_start_line: number;
  definition_end_line: number;
  truncated: boolean;
  digest: string | null;
  text: string;
  read_hint?: {
    path: string;
    offset: number;
    limit: number;
    continue_until_line: number;
  };
} {
  const relativeFile = candidate.definition.file;
  const absoluteFile = path.resolve(projectPath, relativeFile);
  if (!isInsideProject(projectPath, absoluteFile) || !existsSync(absoluteFile)) {
    return {
      mode: "unavailable",
      path: relativeFile,
      start_line: candidate.source_span.start_line,
      end_line: candidate.source_span.start_line,
      definition_start_line: candidate.source_span.start_line,
      definition_end_line: candidate.source_span.end_line,
      truncated: true,
      digest: null,
      text: ""
    };
  }
  const lines = readFileSync(absoluteFile, "utf8").split(/\r?\n/);
  const definitionStart = Math.max(1, candidate.source_span.start_line);
  const definitionEnd = Math.max(
    definitionStart,
    Math.min(lines.length, candidate.source_span.end_line)
  );
  const fullText = lines.slice(definitionStart - 1, definitionEnd).join("\n");
  const fullBytes = Buffer.byteLength(fullText, "utf8");
  const definitionLines = definitionEnd - definitionStart + 1;
  const returnFullDefinition = (
    fullBytes <= MAX_INLINE_SNIPPET_BYTES
    && definitionLines <= MAX_INLINE_SNIPPET_LINES
  ) || (
    preferFullDefinition
    && fullBytes <= MAX_AUTO_FULL_DEFINITION_BYTES
  );
  const snippetEnd = returnFullDefinition
    ? definitionEnd
    : Math.min(definitionEnd, definitionStart + MAX_INLINE_SNIPPET_LINES - 1);
  const rawText = returnFullDefinition
    ? fullText
    : lines.slice(definitionStart - 1, snippetEnd).join("\n");
  const text = returnFullDefinition
    ? rawText
    : truncateUtf8(rawText, MAX_INLINE_SNIPPET_BYTES);
  const truncated = !returnFullDefinition;
  return {
    mode: returnFullDefinition ? "full-definition" : "snippet",
    path: relativeFile,
    start_line: definitionStart,
    end_line: returnFullDefinition ? definitionEnd : snippetEnd,
    definition_start_line: definitionStart,
    definition_end_line: definitionEnd,
    truncated,
    digest: createHash("sha256").update(fullText).digest("hex"),
    text,
    ...(truncated ? {
      read_hint: {
        path: relativeFile,
        offset: definitionStart,
        limit: Math.min(READ_CONTEXT_PAGE_LINES, definitionLines),
        continue_until_line: definitionEnd
      }
    } : {})
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > Math.max(0, maxBytes - 3)) break;
    result += character;
    bytes += characterBytes;
  }
  return `${result}…`;
}

function discoverSources(projectPath: string): string[] {
  return ts.sys.readDirectory(projectPath, SOURCE_EXTENSIONS, EXCLUDED_PATHS);
}

function discoverLexicalLanguageSources(projectPath: string): string[] {
  return ts.sys.readDirectory(projectPath, LEXICAL_LANGUAGE_EXTENSIONS, EXCLUDED_PATHS);
}

interface RawLexicalDeclaration {
  symbol: string;
  kind: FeatureImplementationCandidate["kind"];
  line: number;
  column: number;
  endLine: number;
  nested: boolean;
  enclosing?: { symbol: string; line: number };
}

function collectLexicalLanguageCandidates(
  projectPath: string,
  sources: string[],
  scopePaths: string[],
  terms: SearchTerm[]
): LexicalLanguageCandidate[] {
  const files = sources.flatMap((file) => {
    try {
      const content = readFileSync(file, "utf8");
      return [{
        absolute: file,
        relative: relative(projectPath, file),
        content,
        lines: content.split(/\r?\n/)
      }];
    } catch {
      return [];
    }
  });
  const exactFileScopes = new Set(scopePaths.filter((scope) => (
    LEXICAL_LANGUAGE_EXTENSIONS.some((extension) => scope.toLowerCase().endsWith(extension))
  )));
  const all: LexicalLanguageCandidate[] = [];
  for (const file of files) {
    const declarations = file.relative.toLowerCase().endsWith(".py")
      ? parsePythonDeclarations(file.lines)
      : parseJavaDeclarations(file.lines);
    for (const declaration of declarations) {
      const definition = {
        file: file.relative,
        line: declaration.line,
        column: declaration.column
      };
      const declarationText = file.lines
        .slice(declaration.line - 1, declaration.endLine)
        .join("\n");
      const candidate: LexicalLanguageCandidate = {
        id: candidateId(file.relative, declaration.symbol, declaration.line),
        symbol: declaration.symbol,
        kind: declaration.kind,
        role: declaration.kind === "class" ? "component" : declaration.nested ? "implementation" : "entry",
        definition,
        source_span: { start_line: declaration.line, end_line: declaration.endLine },
        declarationText,
        referenceLocations: [],
        nested: declaration.nested,
        ...(declaration.enclosing
          ? { enclosingCandidateId: candidateId(file.relative, declaration.enclosing.symbol, declaration.enclosing.line) }
          : {}),
        evidence: [],
        evidenceAgainst: []
      };
      for (const term of terms) {
        const target = term.polarity === "negative"
          ? candidate.evidenceAgainst
          : candidate.evidence;
        if (matchesValue(candidate.symbol, term)) {
          target.push(evidence(
            term.polarity === "negative" ? "negative-clue" : "symbol-name",
            definition,
            `符号名 ${candidate.symbol} 命中${term.polarity === "negative" ? "排除线索" : "功能词"} ${term.value}`,
            term.value
          ));
        }
        if (!candidate.nested && matchesValue(file.relative, term)) {
          target.push(evidence(
            term.polarity === "negative" ? "negative-clue" : "file-path",
            definition,
            `文件路径命中${term.polarity === "negative" ? "排除线索" : "功能词"} ${term.value}`,
            term.value
          ));
        }
        if (matchesValue(declarationText, term)) {
          target.push(evidence(
            term.polarity === "negative" ? "negative-clue" : "declaration-text",
            definition,
            `定义正文命中${term.polarity === "negative" ? "排除线索" : "功能词"} ${term.value}`,
            term.value
          ));
        }
      }
      if (exactFileScopes.has(file.relative) && candidate.evidence.length === 0 && !candidate.nested) {
        candidate.evidence.push(evidence(
          "file-path",
          definition,
          `显式 scope_path 指向声明文件 ${file.relative}`,
          null
        ));
      }
      all.push(candidate);
    }
  }

  const bySymbol = new Map<string, LexicalLanguageCandidate[]>();
  for (const candidate of all) {
    const values = bySymbol.get(candidate.symbol) ?? [];
    values.push(candidate);
    bySymbol.set(candidate.symbol, values);
  }
  for (const file of files) {
    file.lines.forEach((lineText, index) => {
      for (const term of terms) {
        if (!matchesValue(lineText, term)) continue;
        for (const identifier of lineText.match(/[A-Za-z_$][\w$]*/g) ?? []) {
          for (const candidate of bySymbol.get(identifier) ?? []) {
            const target = term.polarity === "negative"
              ? candidate.evidenceAgainst
              : candidate.evidence;
            target.push(evidence(
              term.polarity === "negative" ? "negative-clue" : "adjacent-anchor",
              { file: file.relative, line: index + 1, column: Math.max(1, lineText.indexOf(identifier) + 1) },
              `符号 ${identifier} 与${term.polarity === "negative" ? "排除线索" : "功能证据"} ${term.value} 位于同一源码行`,
              term.value
            ));
          }
        }
      }
    });
  }

  for (const candidate of all) {
    const pattern = new RegExp(`(?<![$\\w])${escapeRegExp(candidate.symbol)}\\s*\\(`, "g");
    for (const file of files) {
      file.lines.forEach((lineText, index) => {
        if (!pattern.test(lineText)) return;
        pattern.lastIndex = 0;
        if (file.relative === candidate.definition.file && index + 1 === candidate.definition.line) return;
        candidate.referenceLocations.push({
          file: file.relative,
          line: index + 1,
          column: Math.max(1, lineText.search(pattern) + 1)
        });
        pattern.lastIndex = 0;
      });
    }
    candidate.referenceLocations = dedupeBy(candidate.referenceLocations, (location) => (
      `${location.file}:${location.line}:${location.column}`
    ));
  }

  const evidenceBearing = all.filter((candidate) => candidate.evidence.length > 0 || candidate.evidenceAgainst.length > 0);
  const evidenceIds = new Set(evidenceBearing.map((candidate) => candidate.id));
  return evidenceBearing.filter((candidate) => {
    if (!candidate.nested || candidate.evidence.some((item) => item.kind === "symbol-name")) return true;
    return !candidate.enclosingCandidateId || !evidenceIds.has(candidate.enclosingCandidateId);
  });
}

function parsePythonDeclarations(lines: string[]): RawLexicalDeclaration[] {
  const declarations: RawLexicalDeclaration[] = [];
  lines.forEach((line, index) => {
    const match = /^(\s*)(?:async\s+def|def|class)\s+([A-Za-z_]\w*)\b/.exec(line);
    if (!match?.[2]) return;
    const indent = indentationWidth(match[1] ?? "");
    const kind: RawLexicalDeclaration["kind"] = /^(?:\s*)class\b/.test(line)
      ? "class"
      : indent > 0 ? "method" : "function";
    let endLine = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = lines[cursor]!;
      if (!next.trim() || /^\s*#/.test(next)) continue;
      if (indentationWidth(/^\s*/.exec(next)?.[0] ?? "") <= indent) {
        endLine = cursor;
        break;
      }
    }
    const enclosing = declarations.slice().reverse().find((candidate) => (
      candidate.kind === "class"
      && candidate.line <= index + 1
      && candidate.endLine >= index + 1
    ));
    declarations.push({
      symbol: match[2],
      kind,
      line: index + 1,
      column: indent + 1,
      endLine: Math.max(index + 1, endLine),
      nested: indent > 0,
      ...(enclosing ? { enclosing: { symbol: enclosing.symbol, line: enclosing.line } } : {})
    });
  });
  return declarations;
}

function parseJavaDeclarations(lines: string[]): RawLexicalDeclaration[] {
  const declarations: RawLexicalDeclaration[] = [];
  const classRanges: RawLexicalDeclaration[] = [];
  lines.forEach((line, index) => {
    const classMatch = /\b(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)\b/.exec(line);
    if (!classMatch?.[1]) return;
    const declaration: RawLexicalDeclaration = {
      symbol: classMatch[1],
      kind: "class",
      line: index + 1,
      column: (classMatch.index ?? 0) + 1,
      endLine: javaDeclarationEnd(lines, index),
      nested: classRanges.some((candidate) => candidate.endLine >= index + 1)
    };
    classRanges.push(declaration);
    declarations.push(declaration);
  });
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || /^(?:if|for|while|switch|catch|return|throw|new|assert|case)\b/.test(trimmed)) return;
    if (/\b(?:class|interface|enum|record)\s+[A-Za-z_$]/.test(line)) return;
    const enclosing = classRanges.find((candidate) => (
      candidate.line < index + 1 && candidate.endLine >= index + 1
    ));
    if (!enclosing) return;
    const methodMatch = /^(?:\s*@[^\s]+\s*)*(?:\s*(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:<[^>]+>\s+)?(?:[\w$.[\]<>?,]+\s+)+([A-Za-z_$][\w$]*)\s*\(/.exec(line);
    const constructorMatch = new RegExp(
      `^(?:\\s*@[^\\s]+\\s*)*(?:\\s*(?:public|protected|private)\\s+)*${escapeRegExp(enclosing.symbol)}\\s*\\(`
    ).exec(line);
    const symbol = methodMatch?.[1] ?? (constructorMatch ? enclosing.symbol : undefined);
    if (!symbol) return;
    declarations.push({
      symbol,
      kind: "method",
      line: index + 1,
      column: Math.max(1, line.indexOf(symbol) + 1),
      endLine: javaDeclarationEnd(lines, index),
      nested: true,
      enclosing: { symbol: enclosing.symbol, line: enclosing.line }
    });
  });
  return declarations;
}

function javaDeclarationEnd(lines: string[], start: number): number {
  let balance = 0;
  let opened = false;
  for (let cursor = start; cursor < lines.length; cursor += 1) {
    const sanitized = lines[cursor]!.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, "");
    for (const character of sanitized) {
      if (character === "{") {
        balance += 1;
        opened = true;
      } else if (character === "}") {
        balance -= 1;
      }
    }
    if (opened && balance <= 0) return cursor + 1;
    if (!opened && sanitized.includes(";")) return cursor + 1;
  }
  return start + 1;
}

function indentationWidth(value: string): number {
  return [...value].reduce((total, character) => total + (character === "\t" ? 4 : 1), 0);
}

function selectEvidenceBearingSources(
  projectPath: string,
  sources: string[],
  scopePaths: string[],
  terms: SearchTerm[]
): string[] {
  const positiveTerms = terms.filter((term) => term.polarity === "positive");
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
  const termFileFrequency = new Map<string, number>();
  for (const item of matched) {
    for (const term of new Set(item.terms)) {
      termFileFrequency.set(term, (termFileFrequency.get(term) ?? 0) + 1);
    }
  }
  // Infer discriminative clues from this repository instead of maintaining a
  // domain vocabulary. A term present in a large share of the scoped files is
  // likely framework/plumbing language; when rarer positive evidence exists,
  // use that evidence to choose semantic-analysis roots. If every matching
  // term is common, retain all matches so broad-but-legitimate features still
  // receive a complete census.
  const commonTermThreshold = Math.max(8, Math.ceil(sources.length * 0.05));
  const discriminativeTerms = new Set([...termFileFrequency]
    .filter(([, frequency]) => frequency <= commonTermThreshold)
    .map(([term]) => term));
  const discriminativeMatches = matched.filter((item) => (
    item.exactScope || item.terms.some((term) => discriminativeTerms.has(term))
  ));
  const selected = (
    discriminativeMatches.length > 0 ? discriminativeMatches : matched
  ).map((item) => item.file);
  // An explicit file scope is authoritative even when the requested feature
  // describes code that has not been added yet and therefore has no token hit.
  for (const scope of exactFileScopes) {
    const file = path.resolve(projectPath, scope);
    if (existsSync(file) && !selected.includes(file)) selected.push(file);
  }
  return selected.length > 0 ? selected : [sources[0]!];
}

function selectCandidateEvidenceTerms(
  candidates: InternalCandidate[],
  terms: SearchTerm[]
): {
  terms: SearchTerm[];
  suppressed: string[];
} {
  const positiveTerms = terms.filter((term) => term.polarity === "positive");
  const negativeTerms = terms.filter((term) => term.polarity === "negative");
  const frequencies = new Map<SearchTerm, number>();
  for (const term of positiveTerms) {
    frequencies.set(term, candidates.filter((candidate) => (
      candidateMatchesSearchTerm(candidate, term)
    )).length);
  }
  const commonTermThreshold = Math.max(8, Math.ceil(candidates.length * 0.05));
  const matchedTerms = positiveTerms.filter((term) => (frequencies.get(term) ?? 0) > 0);
  const discriminativeTerms = matchedTerms.filter((term) => (
    (frequencies.get(term) ?? 0) <= commonTermThreshold
  ));
  // Suppression is only safe when the query contains at least one rarer clue.
  // If the user supplied only a broad term, keep all its hits and let the AI
  // resolve the real ambiguity instead of silently inventing precision.
  const selectedPositiveTerms = discriminativeTerms.length > 0
    ? discriminativeTerms
    : matchedTerms;
  const selectedSet = new Set(selectedPositiveTerms);
  const suppressed = discriminativeTerms.length > 0
    ? matchedTerms
        .filter((term) => !selectedSet.has(term))
        .sort((left, right) => (
          (frequencies.get(right) ?? 0) - (frequencies.get(left) ?? 0)
          || Number(right.explicit) - Number(left.explicit)
          || left.value.localeCompare(right.value)
        ))
        .slice(0, 12)
        .map((term) => `${term.value}(${frequencies.get(term) ?? 0})`)
    : [];
  return {
    terms: [...selectedPositiveTerms, ...negativeTerms],
    suppressed
  };
}

function candidateMatchesSearchTerm(
  candidate: InternalCandidate,
  term: SearchTerm
): boolean {
  const sourceFile = candidate.declaration.getSourceFile();
  return matchesValue(candidate.symbol, term)
    || (!candidate.nested && matchesValue(candidate.definition.file, term))
    || matchesValue(candidate.declaration.getText(sourceFile), term);
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
  const deduped = dedupeBy(result, (candidate) => candidate.id);
  const byId = new Map(deduped.map((candidate) => [candidate.id, candidate]));
  for (const candidate of deduped) {
    let current: ts.Node | undefined = candidate.declaration.parent;
    while (current) {
      const descriptor = candidateDescriptorWithoutChecker(current);
      if (descriptor) {
        const location = locationOf(current, projectPath);
        const enclosing = byId.get(candidateId(location.file, descriptor.symbol, location.line));
        if (enclosing) {
          candidate.enclosingCandidateId = enclosing.id;
          break;
        }
      }
      current = current.parent;
    }
  }
  return deduped;
}

function collapseAggregateMemberCandidates(
  directIds: Set<string>,
  candidates: Map<string, InternalCandidate>
): void {
  for (const id of [...directIds]) {
    const candidate = candidates.get(id);
    if (!candidate?.nested) continue;
    // An explicitly named method remains a first-class search result. Other
    // members are already covered by reading the enclosing class/component's
    // complete definition and must not become dozens of duplicate decisions.
    if (candidate.evidence.some((item) => item.kind === "symbol-name")) continue;
    let enclosingId = candidate.enclosingCandidateId;
    while (enclosingId) {
      const enclosing = candidates.get(enclosingId);
      if (!enclosing) break;
      if (
        directIds.has(enclosing.id)
        && (enclosing.kind === "class" || enclosing.kind === "component")
      ) {
        directIds.delete(candidate.id);
        break;
      }
      enclosingId = enclosing.enclosingCandidateId;
    }
  }
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
        const anchorSymbol = checker.getSymbolAtLocation(node);
        if (anchorSymbol) {
          for (const candidate of candidatesForSymbol(anchorSymbol, checker, bySymbol)) {
            related.set(candidate.id, candidate);
          }
        }
        // When the anchor itself is a function/class declaration name, walking
        // the whole declaration would incorrectly attach every nested method
        // and referenced helper. Direct symbol evidence plus the enclosing
        // callable is sufficient; only ordinary statements/config properties
        // need local identifier adjacency expansion.
        if (container && !candidateDescriptorWithoutChecker(container)) {
          const collect = (child: ts.Node): void => {
            if (child !== container && candidateDescriptorWithoutChecker(child)) return;
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
  } else {
    verdict = "unknown";
    verdictReason = hasStrongAutomaticEvidence(candidate, evidenceFor)
      ? "候选具有较强自动证据，但业务等价性仍须语义裁决"
      : evidenceFor.every((item) => (
        item.kind === "upstream-path" || item.kind === "downstream-path"
      ))
        ? "候选仅位于有限调用图路径，必须检查其是否属于真实业务链"
        : "候选只有弱词面证据，必须检查后才能确认或排除";
  }
  // Retrieval order must remain stable across adjudication rounds. Human yes
  // evidence and no evidence are audit facts, not new search-ranking signals.
  const retrievalScore = scoreFeatureCandidate(
    candidate,
    evidenceFor,
    evidenceAgainst,
    upstreamPath,
    downstreamPath
  );
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

  let traceSummary: FeatureImplementationCandidate["trace_summary"] = null;
  if (verdict === "yes") {
    const dynamicBoundaries = findDynamicBoundaries(candidate, projectPath);
    const traceBase = {
      status: dynamicBoundaries.length > 0
        ? "bounded_with_dynamic_unknowns" as const
        : "bounded" as const,
      target: candidate.definition,
      calls: downstreamPath?.length ?? 0,
      wrappers: upstreamPath?.length ?? 0,
      references: evidenceFor.length,
      unresolved_dynamic_references: dynamicBoundaries.length
    };
    traceSummary = {
      status: traceBase.status,
      report_digest: createHash("sha256")
        .update(JSON.stringify(traceBase))
        .digest("hex"),
      calls: traceBase.calls,
      wrappers: traceBase.wrappers,
      references: traceBase.references,
      unresolved_dynamic_references: traceBase.unresolved_dynamic_references
    };
  }
  const sourceFile = candidate.declaration.getSourceFile();
  const declarationEnd = sourceFile.getLineAndCharacterOfPosition(
    candidate.declaration.getEnd()
  ).line + 1;
  return {
    id: candidate.id,
    symbol: candidate.symbol,
    kind: candidate.kind,
    role: inferRole(candidate, upstreamPath, downstreamPath),
    definition: candidate.definition,
    source_span: {
      start_line: candidate.definition.line,
      end_line: Math.max(candidate.definition.line, declarationEnd)
    },
    retrieval_score: retrievalScore,
    why_possible: evidenceFor.map((item) => item.detail),
    evidence_for: dedupeBy(evidenceFor, (item) => item.id),
    evidence_against: dedupeBy(evidenceAgainst, (item) => item.id),
    graph_paths: [upstreamPath, downstreamPath]
      .filter((item): item is GraphEdge[] => Boolean(item?.length))
      .map((items) => items.map(publicGraphStep)),
    verdict,
    verdict_reason: verdictReason,
    adjudicated,
    trace_summary: traceSummary
  };
}

function materializeLexicalLanguageCandidate(
  candidate: LexicalLanguageCandidate,
  adjudication: FeatureCandidateAdjudication | undefined
): FeatureImplementationCandidate {
  const evidenceFor = dedupeBy([
    ...candidate.evidence,
    ...candidate.referenceLocations.slice(0, 24).map((location) => evidence(
      "upstream-path",
      location,
      `词面引用调用 ${candidate.symbol}；精确绑定由语言服务器 Call Hierarchy 在 prepare 前确认`,
      candidate.symbol
    ))
  ], (item) => item.id);
  const evidenceAgainst = dedupeBy([...candidate.evidenceAgainst], (item) => item.id);
  const testOnly = isTestLikePath(candidate.definition.file);
  if (testOnly) {
    evidenceAgainst.push(evidence(
      "test-only",
      candidate.definition,
      "符号位于测试、Fixture 或 Mock 路径，不能作为生产功能实现",
      null
    ));
  }
  let verdict: FeatureCandidateVerdict = testOnly || evidenceAgainst.length > 0 ? "no" : "unknown";
  let verdictReason = testOnly
    ? "候选位于测试或 Fixture 路径"
    : evidenceAgainst.length > 0
      ? "候选命中调用方提供的明确排除线索"
      : "Python/Java 声明与引用已穷举，业务等价性仍须 AI 逐项裁决";
  let adjudicated = false;
  if (adjudication) {
    verdict = adjudication.verdict;
    verdictReason = adjudication.reason.trim();
    adjudicated = true;
    const adjudicationEvidence = adjudication.evidence_refs.map((ref) => evidence(
      "human-adjudication",
      parseEvidenceRef(ref),
      `${adjudication.verdict === "yes" ? "支持" : "排除"}候选：${verdictReason}`,
      null
    ));
    if (verdict === "yes") evidenceFor.push(...adjudicationEvidence);
    else evidenceAgainst.push(...adjudicationEvidence);
  }
  const score = Math.min(100, evidenceFor.reduce((total, item) => total + (
    item.kind === "symbol-name" ? 28
      : item.kind === "file-path" ? 18
        : item.kind === "adjacent-anchor" ? 16
          : item.kind === "declaration-text" ? 12
            : item.kind === "upstream-path" ? 3
              : 0
  ), 0));
  const traceSummary = verdict === "yes"
    ? (() => {
        const base = {
          status: "bounded_with_dynamic_unknowns" as const,
          target: candidate.definition,
          calls: candidate.referenceLocations.length,
          wrappers: 0,
          references: evidenceFor.length,
          unresolved_dynamic_references: 1
        };
        return {
          status: base.status,
          report_digest: createHash("sha256").update(JSON.stringify(base)).digest("hex"),
          calls: base.calls,
          wrappers: base.wrappers,
          references: base.references,
          unresolved_dynamic_references: base.unresolved_dynamic_references
        };
      })()
    : null;
  return {
    id: candidate.id,
    symbol: candidate.symbol,
    kind: candidate.kind,
    role: candidate.role,
    definition: candidate.definition,
    source_span: { ...candidate.source_span },
    retrieval_score: score,
    why_possible: evidenceFor.map((item) => item.detail),
    evidence_for: dedupeBy(evidenceFor, (item) => item.id),
    evidence_against: dedupeBy(evidenceAgainst, (item) => item.id),
    graph_paths: [],
    verdict,
    verdict_reason: verdictReason,
    adjudicated,
    trace_summary: traceSummary
  };
}

function adjudicationScopeForInternalCandidate(
  candidate: InternalCandidate
): AdjudicationCandidateScope {
  const sourceFile = candidate.declaration.getSourceFile();
  const startLine = sourceFile.getLineAndCharacterOfPosition(
    candidate.declaration.getStart(sourceFile)
  ).line + 1;
  const endLine = sourceFile.getLineAndCharacterOfPosition(candidate.declaration.getEnd()).line + 1;
  return {
    definition: candidate.definition,
    source_span: { start_line: startLine, end_line: endLine },
    evidence: candidate.evidence,
    evidenceAgainst: candidate.evidenceAgainst
  };
}

function applySemanticReviewFrontier(
  candidates: FeatureImplementationCandidate[]
): FeatureImplementationCensusReport["review_frontier"] {
  const ranked = [...candidates].sort(comparePublicCandidateRelevance);
  const reviewEligible = ranked.filter((candidate) => (
    candidate.adjudicated || candidate.verdict === "unknown"
  ));
  const confirmedYes = reviewEligible.some((candidate) => (
    candidate.adjudicated && candidate.verdict === "yes"
  ));
  const firstUnadjudicatedIndex = reviewEligible.findIndex((candidate) => (
    !candidate.adjudicated && candidate.verdict === "unknown"
  ));
  const lastAdjudicatedIndex = reviewEligible.reduce((last, candidate, index) => (
    candidate.adjudicated ? index : last
  ), -1);
  let activeEnd: number;
  if (confirmedYes) {
    // Finish the complete ranking window in which a positive was found. This
    // prevents a partial tool payload from closing before all peers in the
    // same relevance band have been reviewed.
    activeEnd = Math.max(
      SEMANTIC_REVIEW_WINDOW,
      Math.ceil((lastAdjudicatedIndex + 1) / SEMANTIC_REVIEW_WINDOW)
        * SEMANTIC_REVIEW_WINDOW
    );
  } else if (firstUnadjudicatedIndex >= 0) {
    // If a full window was rejected, expose the next one. If only part of the
    // current window was decided, keep its remaining candidates active.
    activeEnd = Math.ceil(
      (firstUnadjudicatedIndex + 1) / SEMANTIC_REVIEW_WINDOW
    ) * SEMANTIC_REVIEW_WINDOW;
  } else {
    activeEnd = reviewEligible.length;
  }
  activeEnd = Math.min(reviewEligible.length, activeEnd);

  let retrievalPruned = 0;
  for (const candidate of reviewEligible.slice(activeEnd)) {
    if (candidate.verdict !== "unknown") continue;
    candidate.verdict = "no";
    candidate.verdict_reason = "候选位于当前 AI 语义检索前沿之外；若高排名批次全部排除，宿主会在下一轮自动展开该候选";
    candidate.evidence_against.push(evidence(
      "retrieval-pruned",
      candidate.definition,
      candidate.verdict_reason,
      null
    ));
    retrievalPruned += 1;
  }

  return {
    window_size: SEMANTIC_REVIEW_WINDOW,
    current_round: Math.max(1, Math.ceil(Math.max(1, activeEnd) / SEMANTIC_REVIEW_WINDOW)),
    ai_review_required: reviewEligible
      .slice(0, activeEnd)
      .filter((candidate) => candidate.verdict === "unknown").length,
    retrieval_pruned: retrievalPruned,
    expands_when_all_rejected: true
  };
}

function scoreFeatureCandidate(
  candidate: InternalCandidate,
  evidenceFor: FeatureEvidence[],
  evidenceAgainst: FeatureEvidence[],
  upstreamPath: GraphEdge[] | undefined,
  downstreamPath: GraphEdge[] | undefined
): number {
  const weights: Partial<Record<FeatureEvidence["kind"], number>> = {
    "human-adjudication": 180,
    "symbol-name": 120,
    "declaration-text": 70,
    "adjacent-anchor": 60,
    "file-path": 35,
    "upstream-path": 28,
    "downstream-path": 28
  };
  const byKind = new Map<FeatureEvidence["kind"], number>();
  for (const item of evidenceFor) {
    byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
  }
  let score = 0;
  for (const [kind, count] of byKind) {
    score += (weights[kind] ?? 0) * Math.min(count, 3);
  }
  if (candidate.kind === "component" || candidate.kind === "class") score += 8;
  if (candidate.nested && byKind.size === 1 && byKind.has("file-path")) score -= 30;
  score -= evidenceAgainst.length * 160;
  score -= Math.max(0, (upstreamPath?.length ?? 0) - 1) * 4;
  score -= Math.max(0, (downstreamPath?.length ?? 0) - 1) * 4;
  return Math.max(0, score);
}

function validateAdjudications(
  projectPath: string,
  adjudications: FeatureCandidateAdjudication[],
  candidates: Map<string, AdjudicationCandidateScope>
): Map<string, FeatureCandidateAdjudication> {
  const result = new Map<string, FeatureCandidateAdjudication>();
  for (const adjudication of adjudications) {
    const candidate = candidates.get(adjudication.candidate_id);
    if (!candidate) {
      throw new Error(`adjudication 引用了本次普查不存在的候选：${adjudication.candidate_id}`);
    }
    if (!adjudication.reason?.trim()) {
      throw new Error(`候选 ${adjudication.candidate_id} 的 adjudication 缺少 reason`);
    }
    if (!Array.isArray(adjudication.evidence_refs) || adjudication.evidence_refs.length === 0) {
      throw new Error(`候选 ${adjudication.candidate_id} 的 adjudication 缺少 evidence_refs`);
    }
    let candidateScopedEvidence = false;
    const declarationStart = candidate.source_span.start_line;
    const declarationEnd = candidate.source_span.end_line;
    const candidateFile = path.resolve(projectPath, candidate.definition.file);
    const knownEvidence = [...candidate.evidence, ...candidate.evidenceAgainst];
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
      const insideDeclaration = absolute === candidateFile
        && location.line >= declarationStart
        && location.line <= declarationEnd;
      const matchesKnownEvidence = knownEvidence.some((item) => (
        path.resolve(projectPath, item.location.file) === absolute
        && item.location.line === location.line
      ));
      candidateScopedEvidence ||= insideDeclaration || matchesKnownEvidence;
    }
    if (!candidateScopedEvidence) {
      throw new Error(
        `候选 ${adjudication.candidate_id} 的 adjudication 证据未落在候选声明或已发现证据上`
      );
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
        explicit,
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isTestLikePath(file: string): boolean {
  return /(?:^|\/)(?:__tests__|test|tests|fixtures?|mocks?)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|(?:^|\/)[^/]+_test\.py$|(?:^|\/)[^/]+Test\.java$/i.test(file);
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

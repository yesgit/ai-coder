import { createHash } from "node:crypto";
import path from "node:path";
import {
  analyzeSymbolContract,
  type AnalyzeSymbolContractInput,
  type SymbolContractAnalysis
} from "./symbolContractAnalyzer.js";
import {
  buildBehaviorFingerprint,
  type BehaviorFingerprint
} from "./behaviorFingerprint.js";

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_WRAPPER_DEPTH = 8;
const DEFAULT_MAX_WRAPPER_SYMBOLS = 100;
const REPORT_CACHE_LIMIT = 12;
const completedReportCache = new Map<string, SymbolInvestigationReport>();

type CallsPayload = NonNullable<SymbolContractAnalysis["calls"]>;
type WrappersPayload = NonNullable<SymbolContractAnalysis["wrappers"]>;
type ReferencesPayload = NonNullable<SymbolContractAnalysis["references"]>;
type EffectsPayload = NonNullable<SymbolContractAnalysis["effects"]>;
type Page = CallsPayload["page"];
type CallItem = CallsPayload["items"][number];
type ReferenceItem = ReferencesPayload["items"][number];

export interface InvestigateSymbolContractInput {
  projectPath: string;
  targetFile: string;
  symbol: string;
  targetLine?: number;
  pageSize?: number;
  maxWrapperDepth?: number;
  maxWrapperSymbols?: number;
}

interface SectionCoverage {
  total: number;
  returned: number;
  requested_offsets: number[];
  pages: Page[];
  next_offset: null;
  all_pages_consumed: true;
}

interface CollectedSymbolContract {
  target: SymbolContractAnalysis["target"];
  contract: NonNullable<SymbolContractAnalysis["contract"]>;
  calls: Omit<CallsPayload, "page"> & { coverage: SectionCoverage };
  wrappers: Omit<WrappersPayload, "page"> & { coverage: SectionCoverage };
  references: Omit<ReferencesPayload, "page"> & { coverage: SectionCoverage };
  effects: Omit<EffectsPayload, "page"> & { coverage: SectionCoverage };
  analyzer_coverage: SymbolContractAnalysis["coverage"];
  analyzer_runs: number;
}

export interface WrapperInvestigationNode extends CollectedSymbolContract {
  depth: number;
  source_wrapper: {
    file: string;
    line: number;
    column: number;
    name: string;
  };
}

export interface SymbolReferenceCard {
  reference_id: string;
  target: {
    file: string;
    symbol: string;
  };
  location: {
    file: string;
    line: number;
    column: number;
  };
  kind: "call" | "jsx" | "indirect" | "non-call-reference";
  enclosing_callable: string | null;
  arguments: CallItem["arguments"];
  provided_parameters: string[];
  omitted_parameters: string[];
  preconditions: string[];
  invocation: string | null;
  target_path: string | null;
  payload_expression: string | null;
  expression: string | null;
  reference_kind: string | null;
  disposition: "resolved" | "irrelevant" | "blocked";
}

export interface SymbolInvestigationReport extends CollectedSymbolContract {
  schema_version: 1;
  script: "symbol-contract-investigation";
  status: "complete" | "complete_with_dynamic_unknowns" | "partial";
  sections_completed: readonly ["contract", "calls", "wrappers", "references", "effects"];
  all_pages_consumed: true;
  wrapper_graph: {
    nodes: WrapperInvestigationNode[];
    max_depth: number;
    max_symbols: number;
    complete: boolean;
    truncated_reasons: string[];
  };
  unresolved_dynamic_references: ReferencesPayload["items"];
  static_analysis_limits: string[];
  reference_cards: SymbolReferenceCard[];
  behavior_fingerprints: BehaviorFingerprint[];
  reference_accounting: {
    total: number;
    resolved: number;
    irrelevant: number;
    blocked: number;
    accounted: true;
  };
  runtime_verification_required: boolean;
  report_digest: string;
}

/**
 * Host-owned deterministic investigation script.
 *
 * One invocation consumes every analyzer page for the target and recursively
 * investigates public wrappers. Claude receives the resulting evidence, but it
 * cannot claim coverage merely by describing tool calls in prose.
 */
export function investigateSymbolContract(
  input: InvestigateSymbolContractInput
): SymbolInvestigationReport {
  const pageSize = Math.min(100, Math.max(1, input.pageSize ?? DEFAULT_PAGE_SIZE));
  const maxWrapperDepth = Math.min(
    20,
    Math.max(0, input.maxWrapperDepth ?? DEFAULT_MAX_WRAPPER_DEPTH)
  );
  const maxWrapperSymbols = Math.min(
    500,
    Math.max(1, input.maxWrapperSymbols ?? DEFAULT_MAX_WRAPPER_SYMBOLS)
  );
  const primary = collectSymbolContract(input, pageSize);
  const wrapperNodes: WrapperInvestigationNode[] = [];
  const truncatedReasons: string[] = [];
  const seen = new Set<string>([
    symbolKey(primary.target.file, input.symbol, input.targetLine ?? primary.target.definitions[0]?.line)
  ]);
  const queue = primary.wrappers.items.map((wrapper) => ({
    wrapper,
    depth: 1
  }));

  while (queue.length > 0) {
    const next = queue.shift()!;
    const { wrapper, depth } = next;
    if (depth > maxWrapperDepth) {
      truncatedReasons.push(
        `公共封装追踪达到最大深度 ${maxWrapperDepth}：${wrapper.location.file}:${wrapper.location.line}#${wrapper.name}`
      );
      continue;
    }
    if (wrapperNodes.length >= maxWrapperSymbols) {
      truncatedReasons.push(`公共封装追踪达到最大符号数 ${maxWrapperSymbols}`);
      break;
    }
    if (!wrapper.name || wrapper.name === "<anonymous>") {
      truncatedReasons.push(
        `匿名公共封装无法按符号继续追踪：${wrapper.location.file}:${wrapper.location.line}`
      );
      continue;
    }
    const key = symbolKey(wrapper.location.file, wrapper.name, wrapper.location.line);
    if (seen.has(key)) continue;
    seen.add(key);

    let collected: CollectedSymbolContract;
    try {
      collected = collectSymbolContract({
        projectPath: input.projectPath,
        targetFile: wrapper.location.file,
        symbol: wrapper.name,
        targetLine: wrapper.location.line
      }, pageSize);
    } catch (error) {
      truncatedReasons.push(
        [
          `公共封装无法继续分析：${wrapper.location.file}:${wrapper.location.line}#${wrapper.name}`,
          error instanceof Error ? error.message : String(error)
        ].join("；")
      );
      continue;
    }

    wrapperNodes.push({
      ...collected,
      depth,
      source_wrapper: {
        file: wrapper.location.file,
        line: wrapper.location.line,
        column: wrapper.location.column,
        name: wrapper.name
      }
    });
    for (const parentWrapper of collected.wrappers.items) {
      queue.push({ wrapper: parentWrapper, depth: depth + 1 });
    }
  }

  const unresolvedDynamicReferences = [
    ...primary.references.items,
    ...wrapperNodes.flatMap((node) => node.references.items)
  ].filter((reference) => reference.kind !== "import" && reference.kind !== "export");
  const staticAnalysisLimits = [...new Set([
    ...primary.analyzer_coverage.static_analysis_limits,
    ...wrapperNodes.flatMap((node) => node.analyzer_coverage.static_analysis_limits)
  ])];
  const referenceCards = buildReferenceCards(primary, wrapperNodes);
  const behaviorFingerprints = referenceCards.flatMap((card) => (
    card.kind === "non-call-reference" || !card.invocation
      ? []
      : [buildBehaviorFingerprint({
          reference_id: card.reference_id,
          target: card.target,
          location: card.location,
          kind: card.kind,
          invocation: card.invocation,
          target_path: card.target_path,
          payload_expression: card.payload_expression,
          arguments: card.arguments,
          preconditions: card.preconditions
        })]
  ));
  const referenceAccounting = {
    total: referenceCards.length,
    resolved: referenceCards.filter((card) => card.disposition === "resolved").length,
    irrelevant: referenceCards.filter((card) => card.disposition === "irrelevant").length,
    blocked: referenceCards.filter((card) => card.disposition === "blocked").length,
    accounted: true as const
  };
  const runtimeVerificationRequired = (
    referenceAccounting.blocked > 0
    || staticAnalysisLimits.length > 0
  );
  const base = {
    ...primary,
    schema_version: 1 as const,
    script: "symbol-contract-investigation" as const,
    sections_completed: ["contract", "calls", "wrappers", "references", "effects"] as const,
    all_pages_consumed: true as const,
    wrapper_graph: {
      nodes: wrapperNodes,
      max_depth: maxWrapperDepth,
      max_symbols: maxWrapperSymbols,
      complete: truncatedReasons.length === 0,
      truncated_reasons: [...new Set(truncatedReasons)]
    },
    unresolved_dynamic_references: unresolvedDynamicReferences,
    static_analysis_limits: staticAnalysisLimits,
    reference_cards: referenceCards,
    behavior_fingerprints: behaviorFingerprints,
    reference_accounting: referenceAccounting,
    runtime_verification_required: runtimeVerificationRequired,
    status: (
      truncatedReasons.length > 0
        ? "partial"
        : runtimeVerificationRequired
          ? "complete_with_dynamic_unknowns"
          : "complete"
    ) as SymbolInvestigationReport["status"]
  };
  const report = {
    ...base,
    report_digest: createHash("sha256").update(JSON.stringify(base)).digest("hex")
  };
  cacheCompletedReport(input, report);
  return report;
}

/**
 * Model-facing projection of the host-owned report.
 *
 * `reference_cards` already contain every call and non-call reference, so the
 * raw call/reference arrays and recursively repeated wrapper payloads would
 * only force the model to read the same facts twice. The full report remains
 * in the host cache for validation.
 */
export function formatSymbolInvestigationToolResult(
  report: SymbolInvestigationReport
): string {
  return JSON.stringify({
    schema_version: report.schema_version,
    script: report.script,
    report_digest: report.report_digest,
    status: report.status,
    target: report.target,
    contract: report.contract,
    sections_completed: report.sections_completed,
    all_pages_consumed: report.all_pages_consumed,
    analyzer_coverage: report.analyzer_coverage,
    analyzer_runs: report.analyzer_runs,
    calls: {
      combinations: report.calls.combinations,
      coverage: report.calls.coverage
    },
    wrappers: report.wrappers,
    references: {
      coverage: report.references.coverage
    },
    effects: {
      outgoing_calls: report.effects.items,
      coverage: report.effects.coverage
    },
    wrapper_graph: {
      max_depth: report.wrapper_graph.max_depth,
      max_symbols: report.wrapper_graph.max_symbols,
      complete: report.wrapper_graph.complete,
      truncated_reasons: report.wrapper_graph.truncated_reasons,
      nodes: report.wrapper_graph.nodes.map((node) => ({
        depth: node.depth,
        source_wrapper: node.source_wrapper,
        target: node.target,
        contract: node.contract
      }))
    },
    reference_cards: report.reference_cards,
    behavior_fingerprints: report.behavior_fingerprints,
    reference_accounting: report.reference_accounting,
    unresolved_dynamic_references: report.unresolved_dynamic_references,
    static_analysis_limits: report.static_analysis_limits,
    runtime_verification_required: report.runtime_verification_required
  });
}

function buildReferenceCards(
  primary: CollectedSymbolContract,
  wrapperNodes: WrapperInvestigationNode[]
): SymbolReferenceCard[] {
  const cards = [
    ...referenceCardsForCollectedTarget(primary),
    ...wrapperNodes.flatMap(referenceCardsForCollectedTarget)
  ];
  const seen = new Set<string>();
  return cards.filter((card) => {
    if (seen.has(card.reference_id)) return false;
    seen.add(card.reference_id);
    return true;
  });
}

function referenceCardsForCollectedTarget(
  collected: CollectedSymbolContract
): SymbolReferenceCard[] {
  const target = {
    file: collected.target.file,
    symbol: collected.target.symbol
  };
  return [
    ...collected.calls.items.map((call) => referenceCardForCall(target, call)),
    ...collected.references.items.map((reference) => (
      referenceCardForNonCallReference(target, reference)
    ))
  ];
}

function referenceCardForCall(
  target: SymbolReferenceCard["target"],
  call: CallItem
): SymbolReferenceCard {
  const identity = [
    target.file,
    target.symbol,
    call.location.file,
    call.location.line,
    call.location.column,
    call.kind
  ].join("\0");
  return {
    reference_id: createHash("sha256").update(identity).digest("hex").slice(0, 20),
    target,
    location: call.location,
    kind: call.kind,
    enclosing_callable: call.enclosing_callable,
    arguments: call.arguments,
    provided_parameters: call.provided_parameters,
    omitted_parameters: call.omitted_parameters,
    preconditions: call.preconditions,
    invocation: call.invocation,
    target_path: call.target_path,
    payload_expression: call.payload_expression,
    expression: null,
    reference_kind: null,
    disposition: "resolved"
  };
}

function referenceCardForNonCallReference(
  target: SymbolReferenceCard["target"],
  reference: ReferenceItem
): SymbolReferenceCard {
  const identity = [
    target.file,
    target.symbol,
    reference.location.file,
    reference.location.line,
    reference.location.column,
    reference.kind,
    reference.expression
  ].join("\0");
  return {
    reference_id: createHash("sha256").update(identity).digest("hex").slice(0, 20),
    target,
    location: reference.location,
    kind: "non-call-reference",
    enclosing_callable: null,
    arguments: [],
    provided_parameters: [],
    omitted_parameters: [],
    preconditions: [],
    invocation: null,
    target_path: null,
    payload_expression: null,
    expression: reference.expression,
    reference_kind: reference.kind,
    disposition: reference.kind === "import" || reference.kind === "export"
      ? "irrelevant"
      : "blocked"
  };
}

/**
 * Return only a report produced by a real investigation call in this process.
 *
 * Prepare is read-only, so output validation can reuse the exact trusted report
 * instead of rebuilding a large TypeScript project a second time. After an app
 * restart the cache is intentionally empty and validation safely re-analyzes.
 */
export function getCachedSymbolInvestigationReport(
  input: InvestigateSymbolContractInput
): SymbolInvestigationReport | undefined {
  return completedReportCache.get(reportCacheKey(input));
}

function cacheCompletedReport(
  input: InvestigateSymbolContractInput,
  report: SymbolInvestigationReport
): void {
  const key = reportCacheKey(input);
  completedReportCache.delete(key);
  completedReportCache.set(key, report);
  while (completedReportCache.size > REPORT_CACHE_LIMIT) {
    const oldest = completedReportCache.keys().next().value;
    if (typeof oldest !== "string") break;
    completedReportCache.delete(oldest);
  }
}

function reportCacheKey(input: InvestigateSymbolContractInput): string {
  const projectPath = path.resolve(input.projectPath);
  const targetFile = path.isAbsolute(input.targetFile)
    ? path.resolve(input.targetFile)
    : path.resolve(projectPath, input.targetFile);
  return JSON.stringify({
    projectPath,
    targetFile,
    symbol: input.symbol,
    targetLine: input.targetLine ?? null,
    pageSize: Math.min(100, Math.max(1, input.pageSize ?? DEFAULT_PAGE_SIZE)),
    maxWrapperDepth: Math.min(
      20,
      Math.max(0, input.maxWrapperDepth ?? DEFAULT_MAX_WRAPPER_DEPTH)
    ),
    maxWrapperSymbols: Math.min(
      500,
      Math.max(1, input.maxWrapperSymbols ?? DEFAULT_MAX_WRAPPER_SYMBOLS)
    )
  });
}

function collectSymbolContract(
  input: Omit<InvestigateSymbolContractInput, "pageSize" | "maxWrapperDepth" | "maxWrapperSymbols">,
  pageSize: number
): CollectedSymbolContract {
  const analyzerInput: AnalyzeSymbolContractInput = {
    projectPath: input.projectPath,
    targetFile: input.targetFile,
    symbol: input.symbol,
    targetLine: input.targetLine,
    section: "all",
    offset: 0,
    limit: pageSize
  };
  const initial = analyzeSymbolContract(analyzerInput);
  if (!initial.contract || !initial.calls || !initial.wrappers || !initial.references || !initial.effects) {
    throw new Error(`符号调查脚本未获得完整首屏：${input.targetFile}#${input.symbol}`);
  }
  let analyzerRuns = 1;
  const calls = collectPages(initial.calls, (offset) => {
    analyzerRuns += 1;
    const result = analyzeSymbolContract({ ...analyzerInput, section: "calls", offset });
    if (!result.calls) throw new Error("calls 分页缺少结果");
    return result.calls;
  });
  const wrappers = collectPages(initial.wrappers, (offset) => {
    analyzerRuns += 1;
    const result = analyzeSymbolContract({ ...analyzerInput, section: "wrappers", offset });
    if (!result.wrappers) throw new Error("wrappers 分页缺少结果");
    return result.wrappers;
  });
  const references = collectPages(initial.references, (offset) => {
    analyzerRuns += 1;
    const result = analyzeSymbolContract({ ...analyzerInput, section: "references", offset });
    if (!result.references) throw new Error("references 分页缺少结果");
    return result.references;
  });
  const effects = collectPages(initial.effects, (offset) => {
    analyzerRuns += 1;
    const result = analyzeSymbolContract({ ...analyzerInput, section: "effects", offset });
    if (!result.effects) throw new Error("effects 分页缺少结果");
    return result.effects;
  });
  return {
    target: initial.target,
    contract: initial.contract,
    calls: {
      items: calls.items,
      combinations: initial.calls.combinations,
      coverage: calls.coverage
    },
    wrappers: {
      items: wrappers.items,
      coverage: wrappers.coverage
    },
    references: {
      items: references.items,
      coverage: references.coverage
    },
    effects: {
      items: effects.items,
      coverage: effects.coverage
    },
    analyzer_coverage: initial.coverage,
    analyzer_runs: analyzerRuns
  };
}

function collectPages<T>(
  initial: { items: T[]; page: Page },
  readPage: (offset: number) => { items: T[]; page: Page }
): { items: T[]; coverage: SectionCoverage } {
  const items = [...initial.items];
  const pages = [initial.page];
  const seenOffsets = new Set<number>([initial.page.offset]);
  const expectedTotal = initial.page.total;
  let nextOffset = initial.page.next_offset;

  assertValidPage(initial.page, initial.items.length, expectedTotal);
  while (nextOffset !== null) {
    if (seenOffsets.has(nextOffset)) {
      throw new Error(`符号调查分页循环：offset=${nextOffset}`);
    }
    seenOffsets.add(nextOffset);
    const result = readPage(nextOffset);
    assertValidPage(result.page, result.items.length, expectedTotal);
    if (result.page.offset !== nextOffset) {
      throw new Error(`符号调查分页错位：请求 ${nextOffset}，返回 ${result.page.offset}`);
    }
    items.push(...result.items);
    pages.push(result.page);
    nextOffset = result.page.next_offset;
  }
  if (items.length !== expectedTotal) {
    throw new Error(`符号调查分页不完整：期望 ${expectedTotal}，实际 ${items.length}`);
  }
  return {
    items,
    coverage: {
      total: expectedTotal,
      returned: items.length,
      requested_offsets: pages.map((page) => page.offset),
      pages,
      next_offset: null,
      all_pages_consumed: true
    }
  };
}

function assertValidPage(page: Page, itemCount: number, expectedTotal: number): void {
  if (page.total !== expectedTotal) {
    throw new Error(`符号调查期间总数漂移：${expectedTotal} → ${page.total}`);
  }
  if (page.returned !== itemCount) {
    throw new Error(`符号调查分页计数不一致：page.returned=${page.returned}，items=${itemCount}`);
  }
  if (page.next_offset !== null && page.next_offset <= page.offset) {
    throw new Error(`符号调查分页 next_offset 未前进：${page.offset} → ${page.next_offset}`);
  }
}

function symbolKey(file: string, symbol: string, line?: number): string {
  return `${file}#${symbol}@${line ?? 0}`;
}

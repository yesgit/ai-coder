import { createHash } from "node:crypto";
import path from "node:path";
import {
  analyzeSymbolContract,
  type AnalyzeSymbolContractInput,
  type SymbolContractAnalysis
} from "./symbolContractAnalyzer.js";

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_WRAPPER_DEPTH = 8;
const DEFAULT_MAX_WRAPPER_SYMBOLS = 100;
const REPORT_CACHE_LIMIT = 12;
const completedReportCache = new Map<string, SymbolInvestigationReport>();

type CallsPayload = NonNullable<SymbolContractAnalysis["calls"]>;
type WrappersPayload = NonNullable<SymbolContractAnalysis["wrappers"]>;
type ReferencesPayload = NonNullable<SymbolContractAnalysis["references"]>;
type Page = CallsPayload["page"];

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

export interface SymbolInvestigationReport extends CollectedSymbolContract {
  schema_version: 1;
  script: "symbol-contract-investigation";
  status: "complete" | "complete_with_dynamic_unknowns" | "partial";
  sections_completed: readonly ["contract", "calls", "wrappers", "references"];
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
  const base = {
    ...primary,
    schema_version: 1 as const,
    script: "symbol-contract-investigation" as const,
    sections_completed: ["contract", "calls", "wrappers", "references"] as const,
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
    status: (
      truncatedReasons.length > 0
        ? "partial"
        : unresolvedDynamicReferences.length > 0
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
  if (!initial.contract || !initial.calls || !initial.wrappers || !initial.references) {
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

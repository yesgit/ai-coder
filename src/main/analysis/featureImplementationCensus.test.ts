import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  censusFeatureImplementations,
  formatFeatureImplementationCensusToolResult,
  type FeatureCandidateAdjudication
} from "./featureImplementationCensus.js";

async function createNavigationFixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "feature-census-"));
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      jsx: "react-jsx"
    },
    include: ["*.ts", "*.tsx"]
  }));
  await writeFile(path.join(root, "pages.tsx"), `
export function LQBInvest() {
  return <main data-page-name="零钱宝主页">零钱宝</main>;
}

export function CurrencyFundExplain() {
  return <main data-page-name="零钱宝说明页">零钱宝说明</main>;
}

export function TransactionRecordLQB() {
  return <main data-page-name="零钱宝交易记录">交易记录</main>;
}
`);
  await writeFile(path.join(root, "navigation.tsx"), `
import { CurrencyFundExplain, LQBInvest, TransactionRecordLQB } from "./pages.js";

export interface Navigator {
  push(route: { component: () => unknown }): void;
}

export function goLqbInvest(navigator: Navigator) {
  navigator.push({ component: LQBInvest });
}

export function redirectActionPush(pageName: string, navigator: Navigator) {
  if (pageName === "LQB") {
    navigator.push({ component: CurrencyFundExplain });
  } else if (pageName === "LQBTR") {
    goLqbInvest(navigator);
  } else if (pageName === "LQB_RECORD") {
    navigator.push({ component: TransactionRecordLQB });
  }
}

export function autoPushPage(pageName: string, navigator: Navigator) {
  redirectActionPush(pageName, navigator);
}
`);
  await writeFile(path.join(root, "navigation.test.ts"), `
import { redirectActionPush } from "./navigation.js";
export function mockLQBVoiceJump() {
  return redirectActionPush;
}
`);
  return root;
}

describe("censusFeatureImplementations", () => {
  it("enumerates distinctive evidence-bearing candidates and accounts for each verdict", async () => {
    const root = await createNavigationFixture();
    const report = censusFeatureImplementations({
      projectPath: root,
      feature: "语音跳转至零钱宝页面",
      aliases: ["零钱宝", "LQB", "LQBInvest", "LQBTR"],
      acceptanceClues: ["零钱宝主页"],
      negativeClues: ["零钱宝说明页", "零钱宝交易记录"]
    });

    const symbols = report.candidates.map((candidate) => candidate.symbol);
    expect(symbols).toEqual(expect.arrayContaining([
      "LQBInvest",
      "CurrencyFundExplain",
      "TransactionRecordLQB",
      "goLqbInvest",
      "redirectActionPush"
    ]));
    expect(report.candidate_accounting.total).toBe(
      report.candidate_accounting.yes
      + report.candidate_accounting.no
      + report.candidate_accounting.unknown
    );
    expect(report.candidate_accounting.accounted).toBe(true);
    expect(report.coverage).toMatchObject({
      all_supported_files_scanned: true,
      graph_traversal_complete: true
    });
    expect(report.candidates.find((candidate) => candidate.symbol === "CurrencyFundExplain")
      ?.evidence_against.some((item) => item.kind === "negative-clue")).toBe(true);
    expect(report.status).toBe("partial");
    expect(report.candidate_accounting.unknown).toBeGreaterThan(0);
    expect(report.closure).toMatchObject({
      inventory_complete: true,
      semantic_complete: false,
      closeable: false
    });
    expect(report.report_digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("accepts evidence-backed verdicts, fingerprints every yes target, and closes the census", async () => {
    const root = await createNavigationFixture();
    const initial = censusFeatureImplementations({
      projectPath: root,
      feature: "语音跳转至零钱宝页面",
      aliases: ["零钱宝", "LQB", "LQBInvest", "LQBTR"],
      acceptanceClues: ["零钱宝主页"],
      negativeClues: ["零钱宝说明页", "零钱宝交易记录"]
    });
    const yesSymbols = new Set(["LQBInvest", "goLqbInvest", "redirectActionPush"]);
    const adjudications: FeatureCandidateAdjudication[] = initial.candidates.map((candidate) => ({
      candidate_id: candidate.id,
      verdict: yesSymbols.has(candidate.symbol) ? "yes" : "no",
      reason: yesSymbols.has(candidate.symbol)
        ? "现有用户入口、路由分发或零钱宝主页实现"
        : "说明页、交易记录页或测试入口，不是目标主页实现链",
      evidence_refs: [`${candidate.definition.file}:${candidate.definition.line}`]
    }));

    const report = censusFeatureImplementations({
      projectPath: root,
      feature: "语音跳转至零钱宝页面",
      aliases: ["零钱宝", "LQB", "LQBInvest", "LQBTR"],
      acceptanceClues: ["零钱宝主页"],
      negativeClues: ["零钱宝说明页", "零钱宝交易记录"],
      adjudications
    });

    expect(report.status).toBe("complete");
    expect(report.candidate_accounting).toMatchObject({
      total: initial.candidates.length,
      yes: 3,
      unknown: 0,
      accounted: true
    });
    expect(report.selected_targets.map((target) => target.symbol)).toEqual(expect.arrayContaining([
      "LQBInvest",
      "goLqbInvest",
      "redirectActionPush"
    ]));
    expect(report.selected_targets.every((target) => /^[a-f0-9]{64}$/.test(target.trace_summary_digest)))
      .toBe(true);
    expect(report.rejected_candidates.map((candidate) => candidate.symbol)).toEqual(expect.arrayContaining([
      "CurrencyFundExplain",
      "TransactionRecordLQB"
    ]));
    expect(report.unresolved).toEqual([]);
    expect(report.closure).toEqual({
      inventory_complete: true,
      semantic_complete: true,
      runtime_verification_required: false,
      runtime_complete: true,
      closeable: true
    });
  });

  it("stays partial when matching code exists in an unsupported language", async () => {
    const root = await createNavigationFixture();
    await writeFile(path.join(root, "NativeLqb.kt"), `
fun openLqbHome() {
  println("零钱宝主页")
}
`);

    const initial = censusFeatureImplementations({
      projectPath: root,
      feature: "零钱宝主页",
      aliases: ["LQBInvest"]
    });
    const adjudications: FeatureCandidateAdjudication[] = initial.candidates.map((candidate) => ({
      candidate_id: candidate.id,
      verdict: candidate.symbol === "LQBInvest" ? "yes" : "no",
      reason: candidate.symbol === "LQBInvest" ? "主页组件" : "不是主页组件",
      evidence_refs: [`${candidate.definition.file}:${candidate.definition.line}`]
    }));
    const report = censusFeatureImplementations({
      projectPath: root,
      feature: "零钱宝主页",
      aliases: ["LQBInvest"],
      adjudications
    });

    expect(report.status).toBe("partial");
    expect(report.coverage.unsupported_matching_files).toContain("NativeLqb.kt");
    expect(report.unresolved.join("\n")).toContain("当前脚本不支持语义解析");
  });

  it("records dynamic dispatch limits without blocking feature-location completion", async () => {
    const root = await createNavigationFixture();
    await writeFile(path.join(root, "dynamic.ts"), `
export function openLqbDynamically(
  handlers: Record<string, () => void>,
  runtimePageName: string
) {
  handlers[runtimePageName]();
}
`);
    const initial = censusFeatureImplementations({
      projectPath: root,
      feature: "零钱宝动态入口",
      aliases: ["openLqbDynamically"]
    });
    const adjudications: FeatureCandidateAdjudication[] = initial.candidates.map((candidate) => ({
      candidate_id: candidate.id,
      verdict: candidate.symbol === "openLqbDynamically" ? "yes" : "no",
      reason: candidate.symbol === "openLqbDynamically" ? "动态入口函数" : "不是动态入口",
      evidence_refs: [`${candidate.definition.file}:${candidate.definition.line}`]
    }));
    const report = censusFeatureImplementations({
      projectPath: root,
      feature: "零钱宝动态入口",
      aliases: ["openLqbDynamically"],
      adjudications
    });

    expect(report.status).toBe("complete");
    expect(report.selected_targets).toHaveLength(1);
    expect(report.candidates.find((candidate) => candidate.symbol === "openLqbDynamically")
      ?.trace_summary?.unresolved_dynamic_references).toBeGreaterThan(0);
    expect(report.closure).toMatchObject({
      semantic_complete: true,
      runtime_verification_required: true,
      runtime_complete: false,
      closeable: false
    });
  });

  it("does not claim completion when every candidate was rejected", async () => {
    const root = await createNavigationFixture();
    await writeFile(path.join(root, "dynamic.ts"), `
export function unrelatedDynamicLqbWrapper(
  handlers: Record<string, () => void>,
  runtimePageName: string
) {
  handlers[runtimePageName]();
}
`);
    const initial = censusFeatureImplementations({
      projectPath: root,
      feature: "零钱宝动态候选",
      aliases: ["unrelatedDynamicLqbWrapper"]
    });
    const adjudications: FeatureCandidateAdjudication[] = initial.candidates.map((candidate) => ({
      candidate_id: candidate.id,
      verdict: "no",
      reason: "运行时处理器包装器不是目标功能实现",
      evidence_refs: [`${candidate.definition.file}:${candidate.definition.line}`]
    }));
    const report = censusFeatureImplementations({
      projectPath: root,
      feature: "零钱宝动态候选",
      aliases: ["unrelatedDynamicLqbWrapper"],
      adjudications
    });

    expect(report.status).toBe("partial");
    expect(report.candidate_accounting.unknown).toBe(0);
    expect(report.selected_targets).toEqual([]);
    expect(report.closure.semantic_complete).toBe(false);
    expect(report.unresolved.join("\n")).toContain("全部候选均被排除");
    expect(report.unresolved.join("\n")).not.toContain("动态调用边界无法静态穷举");
  });

  it("returns a compact adjudication view with host metadata before candidates", async () => {
    const root = await createNavigationFixture();
    const report = censusFeatureImplementations({
      projectPath: root,
      feature: "语音跳转至零钱宝页面",
      aliases: ["零钱宝", "LQB", "LQBInvest", "LQBTR"]
    });
    const formatted = formatFeatureImplementationCensusToolResult(report, { projectPath: root });
    const parsed = JSON.parse(formatted) as Record<string, unknown>;

    expect(formatted.indexOf("\"report_digest\"")).toBeLessThan(
      formatted.indexOf("\"candidates\"")
    );
    expect(formatted.length).toBeLessThan(JSON.stringify(report, null, 2).length);
    expect(parsed).toMatchObject({
      report_digest: report.report_digest,
      status: report.status,
      candidate_accounting: report.candidate_accounting,
      continuation_query: {
        feature: report.query.feature,
        aliases: report.query.aliases,
        acceptance_clues: report.query.acceptance_clues,
        negative_clues: report.query.negative_clues,
        scope_paths: report.query.scope_paths
      }
    });
    expect(Buffer.byteLength(formatted, "utf8")).toBeLessThanOrEqual(16_000);
    expect(parsed.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        candidate_id: expect.any(String),
        evidence_ref: expect.stringMatching(/:\d+$/)
      })
    ]));
    const firstProjected = (parsed.candidates as Array<{
      candidate_id: string;
      retrieval_score: number;
      symbol: string;
      source: { mode: string; truncated: boolean; text: string };
    }>)[0]!;
    const firstCandidate = report.candidates.find(
      (candidate) => candidate.id === firstProjected.candidate_id
    )!;
    expect(firstProjected.retrieval_score).toBe(firstCandidate.retrieval_score);
    expect(firstProjected.retrieval_score).toBe(Math.max(
      ...report.candidates
        .filter((candidate) => candidate.verdict === "unknown")
        .map((candidate) => candidate.retrieval_score)
    ));
    expect(firstProjected.source).toMatchObject({
      mode: "full-definition",
      truncated: false
    });
    expect(firstProjected.source.text).toContain(firstProjected.symbol);
    expect((parsed.candidates as unknown[]).length).toBeLessThanOrEqual(24);
    expect(parsed.selected_targets).toEqual(report.selected_targets);
    expect(parsed.rejected_candidates_projection).toEqual({
      returned: 0,
      total: report.rejected_candidates.length
    });
    expect(parsed.closure).toEqual(report.closure);
  });

  it("keeps candidate ids inline after many cumulative rejections", async () => {
    const root = await createNavigationFixture();
    await writeFile(path.join(root, "many.ts"), Array.from({ length: 80 }, (_, index) => (
      `export function ExactInlineCandidate${index}() { return "ExactInlineFeature"; }`
    )).join("\n"));
    const initial = censusFeatureImplementations({
      projectPath: root,
      feature: "ExactInlineFeature",
      aliases: ["ExactInlineFeature"]
    });
    const adjudications: FeatureCandidateAdjudication[] = initial.candidates
      .slice(0, 48)
      .map((candidate) => ({
        candidate_id: candidate.id,
        verdict: "no",
        reason: "不是目标功能实现",
        evidence_refs: [`${candidate.definition.file}:${candidate.definition.line}`]
      }));
    const report = censusFeatureImplementations({
      projectPath: root,
      feature: "ExactInlineFeature",
      aliases: ["ExactInlineFeature"],
      adjudications
    });
    const formatted = formatFeatureImplementationCensusToolResult(report);
    const parsed = JSON.parse(formatted) as {
      candidates: Array<{ candidate_id: string; evidence_ref: string }>;
      rejected_candidates_projection: { returned: number; total: number };
      adjudication_batch: { returned: number; remaining_after_batch: number };
    };

    expect(Buffer.byteLength(formatted, "utf8")).toBeLessThanOrEqual(16_000);
    expect(parsed.candidates.length).toBeGreaterThan(0);
    expect(parsed.candidates.every((candidate) => (
      candidate.candidate_id.length > 0 && /:\d+$/.test(candidate.evidence_ref)
    ))).toBe(true);
    expect(parsed.rejected_candidates_projection).toEqual({
      returned: 0,
      total: report.rejected_candidates.length
    });
    expect(parsed.adjudication_batch.returned).toBe(parsed.candidates.length);
    expect(parsed.adjudication_batch.remaining_after_batch).toBe(
      report.candidate_accounting.unknown - parsed.candidates.length
    );
  });

  it("returns a bounded snippet and exact continuation hint for an oversized definition", async () => {
    const root = await createNavigationFixture();
    await writeFile(path.join(root, "huge.ts"), [
      "export function RareHugeFeature() {",
      ...Array.from({ length: 240 }, (_, index) => (
        `  const value${index} = \"RareHugeFeature-${index}\";`
      )),
      "  return value239;",
      "}"
    ].join("\n"));
    const report = censusFeatureImplementations({
      projectPath: root,
      feature: "RareHugeFeature",
      aliases: ["RareHugeFeature"]
    });
    const candidate = report.candidates.find((item) => item.symbol === "RareHugeFeature")!;
    const formatted = formatFeatureImplementationCensusToolResult(report, { projectPath: root });
    const parsed = JSON.parse(formatted) as {
      candidates: Array<{
        candidate_id: string;
        source: {
          mode: string;
          truncated: boolean;
          definition_start_line: number;
          definition_end_line: number;
          text: string;
          read_hint: {
            path: string;
            offset: number;
            limit: number;
            continue_until_line: number;
          };
        };
      }>;
    };
    const projected = parsed.candidates.find((item) => item.candidate_id === candidate.id)!;

    expect(candidate.source_span.end_line).toBeGreaterThan(candidate.source_span.start_line + 200);
    expect(projected.source).toMatchObject({
      mode: "snippet",
      truncated: true,
      definition_start_line: candidate.source_span.start_line,
      definition_end_line: candidate.source_span.end_line,
      read_hint: {
        path: "huge.ts",
        offset: candidate.source_span.start_line,
        continue_until_line: candidate.source_span.end_line
      }
    });
    expect(Buffer.byteLength(projected.source.text, "utf8")).toBeLessThanOrEqual(1_800);
    expect(Buffer.byteLength(formatted, "utf8")).toBeLessThanOrEqual(16_000);
  });

  it("promotes a file-matched component without turning its internal methods into candidates", async () => {
    const root = await createNavigationFixture();
    await writeFile(path.join(root, "AccountPanel.ts"), [
      "export class AccountPanel {",
      "  private loadState() { return 'AccountPanel-ready'; }",
      "  render() { return this.loadState() || 'AccountPanel'; }",
      "}"
    ].join("\n"));
    const report = censusFeatureImplementations({
      projectPath: root,
      feature: "AccountPanel",
      aliases: ["AccountPanel"]
    });
    const component = report.candidates.find((candidate) => candidate.symbol === "AccountPanel")!;
    const formatted = formatFeatureImplementationCensusToolResult(report, { projectPath: root });
    const parsed = JSON.parse(formatted) as {
      candidates: Array<{
        candidate_id: string;
        source: { mode: string; truncated: boolean; text: string };
      }>;
    };
    const projected = parsed.candidates.find((candidate) => candidate.candidate_id === component.id)!;

    expect(report.candidates.some((candidate) => candidate.symbol === "loadState")).toBe(false);
    expect(report.candidates.some((candidate) => candidate.symbol === "render")).toBe(false);
    expect(projected.source).toMatchObject({ mode: "full-definition", truncated: false });
    expect(projected.source.text).toContain("private loadState()");
    expect(projected.source.text).toContain("render()");
  });

  it("does not let a short legacy alias expand semantic analysis across unrelated files", async () => {
    const root = await createNavigationFixture();
    await Promise.all(Array.from({ length: 40 }, (_, index) => (
      writeFile(path.join(root, `legacy-${index}.ts`), `
export function legacyLqbHelper${index}() {
  return "LQB";
}
`)
    )));

    const report = censusFeatureImplementations({
      projectPath: root,
      feature: "为语音页面跳转新增零钱宝协议",
      aliases: ["LQB", "redirectActionPush", "CurrencyFundExplain"]
    });

    expect(report.coverage.files_discovered).toBeGreaterThan(40);
    expect(report.coverage.files_scanned).toBeLessThan(10);
    expect(report.candidate_accounting.unknown).toBeGreaterThan(0);
    expect(report.selected_targets).toEqual([]);
    expect(report.status).toBe("partial");
  });

  it("uses repository term frequency to suppress common plumbing without a domain vocabulary", async () => {
    const root = await createNavigationFixture();
    await writeFile(path.join(root, "rare-protocol.ts"), `
export function rareProtocolHandler() {
  return "RareProtocol";
}
`);
    await Promise.all(Array.from({ length: 40 }, (_, index) => (
      writeFile(path.join(root, `shared-wrapper-${index}.ts`), `
export function sharedWrapper${index}(sharedContext: unknown) {
  return sharedContext;
}
`)
    )));

    const report = censusFeatureImplementations({
      projectPath: root,
      feature: "Activate RareProtocol through SharedContext",
      aliases: ["RareProtocol"],
      acceptanceClues: ["RareProtocol", "SharedContext"]
    });

    expect(report.coverage.files_discovered).toBeGreaterThan(40);
    expect(report.coverage.files_scanned).toBeLessThan(10);
    expect(report.candidates.some((candidate) => candidate.symbol === "rareProtocolHandler"))
      .toBe(true);
    expect(report.candidates.some((candidate) => candidate.symbol.startsWith("sharedWrapper")))
      .toBe(false);
  });

  it("uses symbol frequency to keep protocol targets while pruning same-file plumbing", async () => {
    const root = await createNavigationFixture();
    await writeFile(path.join(root, "large-router.ts"), [
      "export function RareTarget() { return 'RareRouteToken'; }",
      "export function routeRare(pageName: string, linkType: string) {",
      "  return pageName === 'RareRouteToken' && linkType === 'nativeLink' ? RareTarget() : null;",
      "}",
      "export function genericEntry() { return routeRare('other', 'nativeLink'); }",
      ...Array.from({ length: 80 }, (_, index) => (
        `export function genericWrapper${index}(pageName: string, linkType: string) { return linkType === 'nativeLink' ? pageName : ''; }`
      ))
    ].join("\n"));

    const report = censusFeatureImplementations({
      projectPath: root,
      feature: "open RareRouteToken through nativeLink",
      aliases: ["RareRouteToken", "RareTarget", "pageName", "linkType", "nativeLink"]
    });

    expect(report.candidates.map((candidate) => candidate.symbol)).toEqual([
      "RareTarget",
      "routeRare"
    ]);
    expect(report.candidates.some((candidate) => candidate.symbol === "genericEntry"))
      .toBe(false);
    expect(report.candidates.some((candidate) => candidate.symbol.startsWith("genericWrapper")))
      .toBe(false);
    expect(report.coverage.warnings.join("\n")).toContain("高频管道词");
    expect(report.coverage.graph_edges).toBeGreaterThan(0);
  });

  it("returns unknown candidates in bounded adjudication batches without losing host accounting", async () => {
    const root = await createNavigationFixture();
    await writeFile(path.join(root, "many.ts"), Array.from({ length: 30 }, (_, index) => (
      `export function ExactFeatureCandidate${index}() { return "ExactFeature"; }`
    )).join("\n"));

    const report = censusFeatureImplementations({
      projectPath: root,
      feature: "ExactFeature",
      aliases: ["ExactFeature"]
    });
    const parsed = JSON.parse(
      formatFeatureImplementationCensusToolResult(report)
    ) as {
      candidates: unknown[];
      adjudication_batch: {
        returned: number;
        remaining_after_batch: number;
      };
    };

    expect(report.candidate_accounting).toMatchObject({
      total: 30,
      unknown: 8,
      no: 22
    });
    expect(report.review_frontier).toEqual({
      window_size: 8,
      current_round: 1,
      ai_review_required: 8,
      retrieval_pruned: 22,
      expands_when_all_rejected: true
    });
    expect(parsed.candidates).toHaveLength(8);
    expect(parsed.adjudication_batch).toEqual({
      returned: 8,
      remaining_after_batch: report.candidate_accounting.unknown - 8
    });
  });

  it("expands after an all-no frontier and closes after the next frontier finds a target", async () => {
    const root = await createNavigationFixture();
    await writeFile(path.join(root, "adaptive.ts"), Array.from({ length: 30 }, (_, index) => (
      `export function AdaptiveCandidate${index}() { return "AdaptiveFeature"; }`
    )).join("\n"));
    const input = {
      projectPath: root,
      feature: "AdaptiveFeature",
      aliases: ["AdaptiveFeature"]
    };
    const initial = censusFeatureImplementations(input);
    const firstFrontier = initial.candidates.filter((candidate) => candidate.verdict === "unknown");
    const firstAdjudications: FeatureCandidateAdjudication[] = firstFrontier.map((candidate) => ({
      candidate_id: candidate.id,
      verdict: "no",
      reason: "not the requested implementation",
      evidence_refs: [`${candidate.definition.file}:${candidate.definition.line}`]
    }));
    const expanded = censusFeatureImplementations({
      ...input,
      adjudications: firstAdjudications
    });
    const secondFrontier = expanded.candidates.filter((candidate) => candidate.verdict === "unknown");

    expect(expanded.review_frontier).toMatchObject({
      current_round: 2,
      ai_review_required: 8
    });
    expect(secondFrontier).toHaveLength(8);
    expect(secondFrontier.every((candidate) => (
      !firstFrontier.some((first) => first.id === candidate.id)
    ))).toBe(true);

    const secondAdjudications: FeatureCandidateAdjudication[] = secondFrontier.map((candidate, index) => ({
      candidate_id: candidate.id,
      verdict: index === 0 ? "yes" : "no",
      reason: index === 0 ? "confirmed implementation" : "not the requested implementation",
      evidence_refs: [`${candidate.definition.file}:${candidate.definition.line}`]
    }));
    const complete = censusFeatureImplementations({
      ...input,
      adjudications: [...firstAdjudications, ...secondAdjudications]
    });

    expect(complete.status).toBe("complete");
    expect(complete.candidate_accounting).toMatchObject({
      total: 30,
      yes: 1,
      no: 29,
      unknown: 0
    });
    expect(complete.selected_targets).toHaveLength(1);
    expect(complete.review_frontier).toMatchObject({
      current_round: 2,
      ai_review_required: 0,
      retrieval_pruned: 14
    });
  });

  it("rejects adjudication evidence unrelated to the candidate declaration or discovered evidence", async () => {
    const root = await createNavigationFixture();
    const initial = censusFeatureImplementations({
      projectPath: root,
      feature: "零钱宝主页",
      aliases: ["LQBInvest"]
    });
    const candidate = initial.candidates.find((item) => item.symbol === "LQBInvest")!;

    expect(() => censusFeatureImplementations({
      projectPath: root,
      feature: "零钱宝主页",
      aliases: ["LQBInvest"],
      adjudications: [{
        candidate_id: candidate.id,
        verdict: "yes",
        reason: "uses an unrelated but valid project line",
        evidence_refs: ["navigation.tsx:1"]
      }]
    })).toThrow("证据未落在候选声明或已发现证据上");
  });

  it("rejects fabricated adjudication evidence", async () => {
    const root = await createNavigationFixture();
    const initial = censusFeatureImplementations({
      projectPath: root,
      feature: "零钱宝主页",
      aliases: ["LQBInvest"]
    });

    expect(() => censusFeatureImplementations({
      projectPath: root,
      feature: "零钱宝主页",
      aliases: ["LQBInvest"],
      adjudications: [{
        candidate_id: initial.candidates[0]!.id,
        verdict: "yes",
        reason: "fabricated evidence",
        evidence_refs: ["pages.tsx:9999"]
      }]
    })).toThrow("证据行号越界");
  });
});

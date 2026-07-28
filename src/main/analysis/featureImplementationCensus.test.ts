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
      "redirectActionPush",
      "autoPushPage"
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
    expect(report.status).toBe("complete");
    expect(report.candidate_accounting.unknown).toBe(0);
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
    const yesSymbols = new Set(["LQBInvest", "goLqbInvest", "redirectActionPush", "autoPushPage"]);
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
      yes: 4,
      unknown: 0,
      accounted: true
    });
    expect(report.selected_targets.map((target) => target.symbol)).toEqual(expect.arrayContaining([
      "LQBInvest",
      "goLqbInvest",
      "redirectActionPush",
      "autoPushPage"
    ]));
    expect(report.selected_targets.every((target) => /^[a-f0-9]{64}$/.test(target.call_contract_digest)))
      .toBe(true);
    expect(report.rejected_candidates.map((candidate) => candidate.symbol)).toEqual(expect.arrayContaining([
      "CurrencyFundExplain",
      "TransactionRecordLQB"
    ]));
    expect(report.unresolved).toEqual([]);
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
      ?.call_contract?.unresolved_dynamic_references).toBeGreaterThan(0);
  });

  it("does not let a rejected dynamic candidate keep the census partial", async () => {
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

    expect(report.status).toBe("complete");
    expect(report.candidate_accounting.unknown).toBe(0);
    expect(report.unresolved.join("\n")).not.toContain("动态调用边界无法静态穷举");
  });

  it("returns a compact adjudication view with host metadata before candidates", async () => {
    const root = await createNavigationFixture();
    const report = censusFeatureImplementations({
      projectPath: root,
      feature: "语音跳转至零钱宝页面",
      aliases: ["零钱宝", "LQB", "LQBInvest", "LQBTR"]
    });
    const formatted = formatFeatureImplementationCensusToolResult(report);
    const parsed = JSON.parse(formatted) as Record<string, unknown>;

    expect(formatted.indexOf("\"report_digest\"")).toBeLessThan(
      formatted.indexOf("\"candidates\"")
    );
    expect(formatted.length).toBeLessThan(JSON.stringify(report, null, 2).length);
    expect(parsed).toMatchObject({
      report_digest: report.report_digest,
      status: report.status,
      candidate_accounting: report.candidate_accounting
    });
    expect((parsed.candidates as unknown[]).length).toBe(
      report.candidate_accounting.unknown
    );
    expect(parsed.selected_targets).toEqual(report.selected_targets);
    expect(parsed.rejected_candidate_count).toBe(report.rejected_candidates.length);
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
    expect(report.candidate_accounting.unknown).toBe(0);
    expect(report.selected_targets.map((candidate) => candidate.symbol))
      .toContain("redirectActionPush");
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

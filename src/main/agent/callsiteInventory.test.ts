import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findCallsites, formatInventoryForModel } from "./callsiteInventory.js";
import type { CallsiteHit } from "../../shared/types.js";

let root: string;

async function write(rel: string, content: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
}

function hitsIn(hits: CallsiteHit[], file: string): CallsiteHit[] {
  return hits.filter((hit) => hit.file === file);
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "callsite-fixture-"));
  await write("src/config.ts", [
    "export function parseConfig(input: string): string {",
    "  return input.trim();",
    "}"
  ].join("\n"));
  // barrel：具名 re-export + export * 各一
  await write("src/index.ts", "export { parseConfig } from './config';\n");
  await write("src/barrel-star.ts", "export * from './config';\n");
  await write("src/empty.ts", "export const nothing = 1;\n");
  await write("src/barrel-empty.ts", "export * from './empty';\n");
  // 直接调用：import 行（reference）+ 调用行（call）
  await write("src/app.ts", [
    "import { parseConfig } from './index';",
    "",
    "const cfg = parseConfig(process.argv[2]);",
    "// parseConfig 注释行不应命中",
    "export { cfg };"
  ].join("\n"));
  // 别名导入
  await write("src/alias.ts", [
    "import { parseConfig as pc } from './config';",
    "const cfg = pc('x');"
  ].join("\n"));
  // 值引用（回调传参形态）
  await write("src/reuse.ts", "export const cb = parseConfig;\n");
  // JSX 用法
  await write("src/widget.tsx", [
    "import { Button } from './button';",
    "export function App() {",
    "  return <Button label=\"ok\" />;",
    "}"
  ].join("\n"));
  await write("src/button.tsx", [
    "export function Button(props: { label: string }) {",
    "  return <button>{props.label}</button>;",
    "}"
  ].join("\n"));
  // 测试文件：一等公民，必须计入
  await write("test/config.test.ts", [
    "import { parseConfig } from '../src/config';",
    "it('works', () => {",
    "  expect(parseConfig(' a ')).toBe('a');",
    "});"
  ].join("\n"));
  // node_modules 必须跳过
  await write("node_modules/pkg/index.js", "parseConfig('never');\n");
  // 同名异义符号：未提供 path_hint 时别名会被追踪（设计内容差），提供后被收窄
  await write("src/unrelated.ts", "export function parseConfig() { return 0; }\n");
  await write("src/confusion.ts", [
    "import { parseConfig as zz } from './unrelated';",
    "zz();"
  ].join("\n"));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("findCallsites", () => {
  it("覆盖定义点 / re-export / 直接调用 / 别名 / 值引用 / 测试文件", async () => {
    const inventory = await findCallsites(root, "parseConfig");

    expect(inventory.symbol).toBe("parseConfig");
    expect(inventory.truncated).toBe(false);

    // 定义点
    expect(hitsIn(inventory.hits, "src/config.ts").some((h) => h.kind === "definition" && h.line === 1)).toBe(true);
    // 具名 re-export 与 export *（目标含定义）都要命中；export * 到无定义文件不命中
    expect(hitsIn(inventory.hits, "src/index.ts").some((h) => h.kind === "reexport")).toBe(true);
    expect(hitsIn(inventory.hits, "src/barrel-star.ts").some((h) => h.kind === "reexport")).toBe(true);
    expect(hitsIn(inventory.hits, "src/barrel-empty.ts")).toHaveLength(0);
    // 直接调用：import 行记 reference，调用行记 call；注释行不命中
    const appHits = hitsIn(inventory.hits, "src/app.ts");
    expect(appHits.some((h) => h.kind === "reference" && h.line === 1)).toBe(true);
    expect(appHits.some((h) => h.kind === "call" && h.line === 3)).toBe(true);
    expect(appHits).toHaveLength(2);
    // 别名导入：pc('x') 记 call
    const aliasHits = hitsIn(inventory.hits, "src/alias.ts");
    expect(aliasHits.some((h) => h.kind === "call" && h.line === 2)).toBe(true);
    // 值引用
    expect(hitsIn(inventory.hits, "src/reuse.ts").some((h) => h.kind === "reference")).toBe(true);
    // 测试文件计入
    expect(hitsIn(inventory.hits, "test/config.test.ts").some((h) => h.kind === "call")).toBe(true);
    // node_modules 跳过
    expect(inventory.hits.some((h) => h.file.includes("node_modules"))).toBe(false);
    // 盲区声明必须由工具给出
    expect(inventory.blind_spots.length).toBeGreaterThan(0);
  });

  it("JSX 用法以 jsx 形态命中", async () => {
    const inventory = await findCallsites(root, "Button");
    expect(hitsIn(inventory.hits, "src/widget.tsx").some((h) => h.kind === "jsx" && h.line === 3)).toBe(true);
    expect(hitsIn(inventory.hits, "src/button.tsx").some((h) => h.kind === "definition")).toBe(true);
  });

  it("结果确定性：同一项目同一符号两次扫描完全一致", async () => {
    const first = await findCallsites(root, "parseConfig");
    const second = await findCallsites(root, "parseConfig");
    expect(second.hits).toEqual(first.hits);
    expect(second.total).toBe(first.total);
  });

  it("path_hint 收窄别名追踪：同名异义符号的别名不再计入", async () => {
    const wide = await findCallsites(root, "parseConfig");
    // 无 hint：zz 作为 parseConfig 别名被追踪，zz() 记 call
    expect(hitsIn(wide.hits, "src/confusion.ts").some((h) => h.kind === "call" && h.line === 2)).toBe(true);

    const narrow = await findCallsites(root, "parseConfig", "src/config.ts");
    // 有 hint：import 来自 './unrelated'，不解析到 hint 文件 → 别名不追踪，只剩 import 行的词面命中
    const confusionHits = hitsIn(narrow.hits, "src/confusion.ts");
    expect(confusionHits.some((h) => h.kind === "call")).toBe(false);
    expect(confusionHits.some((h) => h.kind === "reference" && h.line === 1)).toBe(true);
  });

  it("命中超上限时截断并声明盲区", async () => {
    const bigRoot = await fs.mkdtemp(path.join(os.tmpdir(), "callsite-big-"));
    try {
      // 1 个定义 + 600 行直接调用，超过 MAX_HITS(500) 触发截断
      const lines = ["export function target() {}"];
      for (let i = 0; i < 600; i += 1) {
        lines.push(`target(); // call ${i}`);
      }
      await fs.writeFile(path.join(bigRoot, "calls.ts"), lines.join("\n") + "\n");
      const inventory = await findCallsites(bigRoot, "target");
      expect(inventory.truncated).toBe(true);
      expect(inventory.total).toBeLessThanOrEqual(500);
      expect(inventory.blind_spots.some((spot) => spot.includes("上限"))).toBe(true);
    } finally {
      await fs.rm(bigRoot, { recursive: true, force: true });
    }
  });
});

describe("formatInventoryForModel", () => {
  it("明细超限截断但文件列表完整", async () => {
    const inventory = await findCallsites(root, "parseConfig");
    const text = formatInventoryForModel(inventory);
    expect(text).toContain("parseConfig");
    expect(text).toContain("## 涉及文件");
    expect(text).toContain("## 覆盖盲区");
    // 文件列表必须包含全部命中文件（断言锚定的口径）
    for (const file of new Set(inventory.hits.map((h) => h.file))) {
      expect(text).toContain(file);
    }
  });
});

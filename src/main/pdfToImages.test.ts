import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pdfToImages } from "./pdfToImages.js";

// 测试依赖项目外部的 sample PDF（/mnt/d/temp 下的任意小 PDF 都可以）。
// 没找到时通过 it.skipIf 显式跳过，CI 报告里能看到 "skipped" 而不是误以为通过。
const SAMPLE = "/mnt/d/temp/10 个让我成为更好开发者的经验教训.pdf";

const sampleAvailable = existsSync(SAMPLE);
const skipIfNoSample = sampleAvailable ? it : it.skip;

describe("pdfToImages", () => {
  it("throws on corrupted / non-PDF input", async () => {
    const garbage = Buffer.from("not a pdf %PDF-1");
    await expect(pdfToImages(garbage)).rejects.toThrow(/Invalid PDF|InvalidPDFException|FormatError|corrupted/);
  });

  skipIfNoSample("respects maxPages limit", { timeout: 15000 }, async () => {
    const pdf = await readFile(SAMPLE);
    // 该 PDF 实际有 6 页，maxPages=2 应超限抛出
    await expect(pdfToImages(pdf, { maxPages: 2 })).rejects.toThrow(/exceeds page limit/);
  });

  skipIfNoSample("renders all pages within limit and returns valid PNG buffers", { timeout: 30000 }, async () => {
    const pdf = await readFile(SAMPLE);
    const pages = await pdfToImages(pdf, { dpi: 150, maxPages: 50 });
    expect(pages.length).toBe(6);
    // 每页尺寸应大致为 A4 150dpi（1240x1754 上下）
    for (const p of pages) {
      expect(p.page).toBeGreaterThanOrEqual(1);
      expect(p.width).toBeGreaterThan(500);
      expect(p.height).toBeGreaterThan(700);
      expect(p.png.byteLength).toBeGreaterThan(1000);
      // PNG 魔数
      expect(p.png.slice(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    }
  });

  skipIfNoSample("writes PNGs to disk correctly", { timeout: 30000 }, async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "ai-coder-pdf-test-"));
    try {
      const pdf = await readFile(SAMPLE);
      const pages = await pdfToImages(pdf, { dpi: 150, maxPages: 50 });
      for (const p of pages) {
        const outPath = join(tmpDir, `page-${p.page}.png`);
        await import("node:fs/promises").then(fs => fs.writeFile(outPath, p.png));
        // 回读能开就说明没写坏
        const round = await import("node:fs/promises").then(fs => fs.readFile(outPath));
        expect(round.slice(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
        expect(round.byteLength).toBe(p.png.byteLength);
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  skipIfNoSample("automatically downsizes huge pages under maxPx", { timeout: 30000 }, async () => {
    const pdf = await readFile(SAMPLE);
    // 故意设非常小的像素上限
    const pages = await pdfToImages(pdf, { dpi: 150, maxPx: 500 });
    for (const p of pages) {
      expect(p.width).toBeLessThanOrEqual(500);
      expect(p.height).toBeLessThanOrEqual(500);
    }
  });
});

import { createCanvas, DOMMatrix, DOMPoint, DOMRect, ImageData, Path2D } from "@napi-rs/canvas";

// pdfjs-dist 6.x 在 Node 环境下仍直接引用 DOM 全局（DOMMatrix/Path2D/ImageData
// 在模块顶层初始化）。必须在 import pdfjs 前把它们 polyfill 到 globalThis，
// 否则 ReferenceError。@napi-rs/canvas 已经导出兼容实现。
//
// TODO(Brooooooklyn): 技术债务 — 这会污染 Node 全局对象。
// 如果未来有别的模块（或 Electron 自身）也用到 DOMMatrix，可能行为不一致。
// 长期方案：把 pdfjs+canvas 关进 worker 线程，或使用 pdfjs 提供的无全局依赖的
// 自定义渲染后端（但 pdfjs 6.x 不支持）。
const g = globalThis as Record<string, unknown>;
g.DOMMatrix ??= DOMMatrix;
g.DOMPoint ??= DOMPoint;
g.DOMRect ??= DOMRect;
g.ImageData ??= ImageData;
g.Path2D ??= Path2D;

type PdfJsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<PdfJsModule> | null = null;

function loadPdfjs(): Promise<PdfJsModule> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

export interface PdfToImagesOptions {
  /** 渲染分辨率（像素/英寸） */
  dpi?: number;
  /** 最多渲染多少页（从第一页起），超限直接 throw。默认 50。 */
  maxPages?: number;
  /** 单页像素上限；宽度/高度任一超限自动降 dpi。 */
  maxPx?: number;
}

export async function pdfToImages(
  pdfBuffer: Buffer,
  options: PdfToImagesOptions = {}
): Promise<Array<{
  page: number;
  png: Buffer;
  width: number;
  height: number;
}>> {
  const { dpi = 150, maxPages = 50, maxPx = 2500 } = options;
  const pdfjsLib = await loadPdfjs();
  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    useSystemFonts: true,
    enableXfa: false,
    verbosity: 0,
    disableStream: true,
    disableAutoFetch: true
  }).promise;

  if (pdf.numPages > maxPages) {
    throw new Error(
      `PDF exceeds page limit (${pdf.numPages} pages vs. ${maxPages}). Please crop or select pages.`
    );
  }

  const results: Array<{
    page: number;
    png: Buffer;
    width: number;
    height: number;
  }> = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const [vx, vy, w, h] = page.view;
    // 某些异常 PDF 把 MediaBox 写成反向坐标（top < bottom），Math.abs 兜底
    const ptW = Math.abs(w - vx);
    const ptH = Math.abs(h - vy);
    const scale = dpi / 72;
    const finalScale = ptW * scale <= maxPx && ptH * scale <= maxPx
      ? scale
      : Math.min(maxPx / ptW, maxPx / ptH);
    const finalWidth = Math.max(1, Math.floor(ptW * finalScale));
    const finalHeight = Math.max(1, Math.floor(ptH * finalScale));

    const canvas = createCanvas(finalWidth, finalHeight);
    const ctx = canvas.getContext("2d");
    await page.render({
      // pdfjs-dist 6.x 类型要求必须传 canvas（用于内部绘制坐标）；运行时只用到 ctx
      canvas: canvas as unknown as HTMLCanvasElement,
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport: page.getViewport({ scale: finalScale }),
      background: "white"
    }).promise;

    results.push({
      page: i,
      png: canvas.toBuffer("image/png"),
      width: finalWidth,
      height: finalHeight
    });
  }

  return results;
}

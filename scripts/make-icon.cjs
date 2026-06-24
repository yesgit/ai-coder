/**
 * 生成 AI Coder 应用图标。
 *
 * 设计：
 * - 圆角方形画布（1024×1024，electron-builder Linux 推荐尺寸）
 * - 渐变深青绿背景（与 styles.css 的项目主色 #146c5f 一致）
 * - 中心白色 "AI" 字样（粗体）
 * - 右下橙色终端光标 "_"，体现 "Coder" 主题
 *
 * 输出：build/icon.png（PNG，1024×1024）+ 缩略系列（512/256/128）
 *
 * 运行：node scripts/make-icon.cjs
 */
const { createCanvas, GlobalFonts } = require("@napi-rs/canvas");
const fs = require("node:fs");
const path = require("node:path");

const SIZE = 1024;
const OUTPUT_DIR = path.resolve(__dirname, "..", "build");

function drawIcon(size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  const scale = size / SIZE;
  ctx.scale(scale, scale);

  // 圆角矩形背景 + 渐变
  const radius = 180;
  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.lineTo(SIZE - radius, 0);
  ctx.arcTo(SIZE, 0, SIZE, radius, radius);
  ctx.lineTo(SIZE, SIZE - radius);
  ctx.arcTo(SIZE, SIZE, SIZE - radius, SIZE, radius);
  ctx.lineTo(radius, SIZE);
  ctx.arcTo(0, SIZE, 0, SIZE - radius, radius);
  ctx.lineTo(0, radius);
  ctx.arcTo(0, 0, radius, 0, radius);
  ctx.closePath();

  const gradient = ctx.createLinearGradient(0, 0, SIZE, SIZE);
  gradient.addColorStop(0, "#1d8d7d");
  gradient.addColorStop(1, "#0f4d44");
  ctx.fillStyle = gradient;
  ctx.fill();

  // 主体 "AI" 字样：白色粗体居中
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 560px 'Arial', 'DejaVu Sans', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("AI", SIZE / 2, SIZE / 2 - 40);

  // 下方装饰横线
  ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
  ctx.fillRect(SIZE / 2 - 200, SIZE - 280, 400, 8);

  // 右下角橙色终端光标 "_"，体现 "Coder" 主题
  ctx.fillStyle = "#ff9a3c";
  ctx.fillRect(SIZE - 320, SIZE - 220, 200, 28);

  return canvas.toBuffer("image/png");
}

function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  // electron-builder 默认从 build/icon.png 取
  const mainPath = path.join(OUTPUT_DIR, "icon.png");
  fs.writeFileSync(mainPath, drawIcon(SIZE));
  console.log(`wrote ${mainPath} (${SIZE}x${SIZE})`);

  // 缩略图组（PNG，部分桌面环境会用到不同尺寸）
  for (const px of [512, 256, 128, 64]) {
    const p = path.join(OUTPUT_DIR, `icon-${px}.png`);
    fs.writeFileSync(p, drawIcon(px));
    console.log(`wrote ${p}`);
  }
}

main();

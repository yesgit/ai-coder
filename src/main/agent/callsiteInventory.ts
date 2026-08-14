import fs from "node:fs/promises";
import path from "node:path";
import type { CallsiteHit, CallsiteInventory } from "../../shared/types.js";

/**
 * 宿主侧确定性调用清单扫描器（find_callsites 的执行体）。
 *
 * 设计定位：不追求语义完美（那是语言服务器的事），追求"模型跳不过的确定性下限"——
 * 同一项目同一符号任意时刻返回同一份清单，作为断言层校验模型自报清单的 ground truth。
 *
 * 覆盖形态：直接调用、JSX 用法、值引用（回调传参等）、import 别名、re-export 链、定义点。
 * 诚实声明盲区（blind_spots）：动态 import、default export 引用、同名歧义——由工具枚举，
 * 不靠模型自觉。
 *
 * 实现纯 Node、零新依赖；只读，无副作用。
 */

const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "release", "coverage", "out"]);
const MAX_FILES = 4000;
const MAX_HITS = 500;
const MAX_FILE_BYTES = 1_000_000;
const SNIPPET_LENGTH = 120;

const BASE_BLIND_SPOTS = [
  "动态 import()、require(变量)、字符串拼接/反射形式的调用不在覆盖范围",
  "目标符号若以 default export 导出，import AnyName from ... 形式的引用未追踪",
  "同名不同义符号未做语义消歧——可能含同名误报；传 path_hint 可收窄别名追踪范围",
  "测试文件已包含在扫描内——测试调用是该符号的活文档，不是噪声"
];

export async function findCallsites(
  projectPath: string,
  symbol: string,
  pathHint?: string
): Promise<CallsiteInventory> {
  const files = await collectCodeFiles(projectPath);
  const pathHintResolved = pathHint ? path.resolve(projectPath, pathHint) : null;

  const hits: CallsiteHit[] = [];
  const blindSpots = [...BASE_BLIND_SPOTS];
  let scannedFiles = 0;
  let skippedLarge = 0;
  let truncated = false;
  // export * from 的"目标文件是否含定义"缓存，避免重复读盘
  const definitionCache = new Map<string, boolean>();

  for (const file of files) {
    if (scannedFiles >= MAX_FILES || hits.length >= MAX_HITS) {
      truncated = true;
      break;
    }
    const abs = path.join(projectPath, file);
    let content: string;
    try {
      const stat = await fs.stat(abs);
      if (stat.size > MAX_FILE_BYTES) {
        skippedLarge += 1;
        continue;
      }
      content = await fs.readFile(abs, "utf8");
    } catch {
      continue; // 扫描中途文件消失：跳过，不影响其余结果
    }
    scannedFiles += 1;

    const lines = content.split(/\r?\n/);
    const aliases = await extractAliases(lines, symbol, abs, pathHintResolved);
    const names = [symbol, ...aliases].map((name) => ({ name, pattern: wordPattern(name) }));
    const defPatterns = names.map(({ name }) => definitionPattern(name));

    for (let index = 0; index < lines.length; index += 1) {
      if (hits.length >= MAX_HITS) {
        truncated = true;
        break;
      }
      const line = lines[index];
      const trimmed = line.trim();
      if (!trimmed || isFullLineComment(trimmed)) continue;

      // re-export 单独判定：export { X } from / export * from
      const reexport = await matchReexport(line, symbol, abs, definitionCache);
      if (reexport) {
        hits.push(makeHit(file, index, "reexport", line));
        continue;
      }

      // 定义点优先于调用形态
      if (defPatterns.some((pattern) => pattern.test(line))) {
        hits.push(makeHit(file, index, "definition", line));
        continue;
      }
      // 注意：模板字面量里 \s 要写成 \\s（单写 \s 会被字符串层吃掉变成字母 s）
      const jsx = names.some(({ name }) => new RegExp(`<${escapeRegExp(name)}[\\s/>]`).test(line));
      if (jsx) {
        hits.push(makeHit(file, index, "jsx", line));
        continue;
      }
      if (names.some(({ pattern }) => pattern.test(line))) {
        const callPattern = names.some(({ name }) => new RegExp(`(?<![\\w$])${escapeRegExp(name)}\\s*\\(`).test(line));
        hits.push(makeHit(file, index, callPattern ? "call" : "reference", line));
      }
    }
  }

  if (skippedLarge > 0) {
    blindSpots.push(`${skippedLarge} 个超过 1MB 的文件未扫描（多为构建产物或压缩 bundle）`);
  }
  if (truncated) {
    blindSpots.push(`扫描已达上限（${MAX_FILES} 文件 / ${MAX_HITS} 命中），清单不完整——请用 path_hint 分片重查`);
  }

  hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return {
    symbol,
    total: hits.length,
    hits,
    blind_spots: blindSpots,
    scanned_files: scannedFiles,
    truncated
  };
}

/**
 * 把清单格式化成模型可读的紧凑文本（MCP 工具返回值）。
 * 命中过多时明细只给前 60 条，但全量文件列表必须完整——文件集合是断言锚定的口径。
 */
export function formatInventoryForModel(inventory: CallsiteInventory): string {
  const header = [
    `# find_callsites: ${inventory.symbol}`,
    `total: ${inventory.total} 处命中，scanned_files: ${inventory.scanned_files}，truncated: ${inventory.truncated}`
  ];
  const DETAIL_LIMIT = 60;
  const details = inventory.hits.slice(0, DETAIL_LIMIT).map(
    (hit) => `- ${hit.file}:${hit.line} [${hit.kind}] ${hit.snippet}`
  );
  if (inventory.hits.length > DETAIL_LIMIT) {
    details.push(`- ...（其余 ${inventory.hits.length - DETAIL_LIMIT} 条明细省略，见下方文件列表）`);
  }
  const fileCounts = new Map<string, number>();
  for (const hit of inventory.hits) {
    fileCounts.set(hit.file, (fileCounts.get(hit.file) ?? 0) + 1);
  }
  const fileList = [...fileCounts.entries()].map(([file, count]) => `${file} (${count})`);
  const blindSpots = inventory.blind_spots.map((spot) => `- ${spot}`);
  return [
    ...header,
    "",
    "## 命中明细",
    ...details,
    "",
    "## 涉及文件（完整，共 " + fileList.length + " 个）",
    ...fileList,
    "",
    "## 覆盖盲区（本工具不保证以下形态被发现，请自行评估是否影响本次任务）",
    ...blindSpots
  ].join("\n");
}

async function collectCodeFiles(projectPath: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, prefix: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name)); // 确定性顺序
    for (const entry of entries) {
      if (out.length >= MAX_FILES * 2) return; // 目录巨大时先截断收集，扫描层还有 MAX_FILES 兜底
      const full = path.join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
        await walk(full, rel);
      } else if (entry.isFile() && CODE_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
        out.push(rel);
      }
    }
  }
  await walk(projectPath, "");
  return out;
}

/**
 * 解析 import/require 语句，找出绑定到目标符号的本地别名。
 * 有 path_hint 时只承认来自该文件的导入（防同名异义符号污染别名表）。
 */
async function extractAliases(
  lines: string[],
  symbol: string,
  fromFile: string,
  pathHintResolved: string | null
): Promise<Set<string>> {
  const aliases = new Set<string>();
  for (const line of lines) {
    const importMatch = line.match(/^\s*import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/);
    const requireMatch = line.match(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/);
    const match = importMatch ?? requireMatch;
    if (!match) continue;
    const [, members, spec] = match;
    if (pathHintResolved) {
      const resolved = await resolveModuleFile(fromFile, spec);
      if (resolved !== pathHintResolved) continue;
    }
    for (const member of members.split(",")) {
      const aliasMatch = member.trim().match(/^(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/);
      if (!aliasMatch) continue;
      const [, original, alias] = aliasMatch;
      if (original === symbol && alias) {
        aliases.add(alias);
      }
    }
  }
  return aliases;
}

async function matchReexport(
  line: string,
  symbol: string,
  fromFile: string,
  definitionCache: Map<string, boolean>
): Promise<boolean> {
  const named = line.match(/^\s*export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/);
  if (named) {
    return named[1].split(",").some((member) => {
      const m = member.trim().match(/^([\w$]+)(?:\s+as\s+[\w$]+)?$/);
      return m?.[1] === symbol;
    });
  }
  const star = line.match(/^\s*export\s*\*\s*from\s*['"]([^'"]+)['"]/);
  if (star) {
    const resolved = await resolveModuleFile(fromFile, star[1]);
    if (!resolved) return false;
    const cached = definitionCache.get(resolved);
    if (cached !== undefined) return cached;
    let has = false;
    try {
      const content = await fs.readFile(resolved, "utf8");
      has = definitionPattern(symbol).test(content);
    } catch {
      has = false;
    }
    definitionCache.set(resolved, has);
    return has;
  }
  return false;
}

async function resolveModuleFile(fromFile: string, spec: string): Promise<string | null> {
  if (!spec.startsWith(".")) return null; // 包引用不追踪
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base];
  for (const ext of CODE_EXTENSIONS) {
    candidates.push(base + ext, path.join(base, `index${ext}`));
  }
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // 继续尝试下一个候选
    }
  }
  return null;
}

function wordPattern(name: string): RegExp {
  return new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`);
}

function definitionPattern(name: string): RegExp {
  const escapedName = escapeRegExp(name);
  return new RegExp(
    `(?:^|\\s)(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function\\*?\\s+|class\\s+)${escapedName}(?![\\w$])` +
    `|(?:^|\\s)(?:export\\s+)?(?:const|let|var)\\s+${escapedName}(?![\\w$])`
  );
}

function isFullLineComment(trimmed: string): boolean {
  return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("<!--");
}

function makeHit(file: string, index: number, kind: CallsiteHit["kind"], line: string): CallsiteHit {
  const snippet = line.trim().replace(/\s+/g, " ").slice(0, SNIPPET_LENGTH);
  return { file, line: index + 1, kind, snippet };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

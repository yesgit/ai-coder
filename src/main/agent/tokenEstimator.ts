/**
 * 简易 token 估算器。
 *
 * 不依赖精确 tokenizer（避免额外依赖和加载成本），用字符数/比例估算。
 * 对英文/代码用 ~4 chars/token，对中文用 ~1.5 chars/token。
 *
 * 估算误差在 ±30% 内，足够用于"是否接近上下文窗口"的二元判断。
 */

const EN_TOKEN_RATIO = 4; // ~4 ASCII chars per token
const CJK_TOKEN_RATIO = 1.5; // ~1.5 CJK chars per token（中文每个字通常是 1-2 tokens）

/** 估算一段文本的 token 数 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  let cjkChars = 0;
  let otherChars = 0;

  for (const char of text) {
    if (isCJK(char)) {
      cjkChars += 1;
    } else {
      otherChars += 1;
    }
  }

  return Math.ceil(cjkChars / CJK_TOKEN_RATIO + otherChars / EN_TOKEN_RATIO);
}

/** 估算整个 prompt 的 token 总数 */
export function estimatePromptTokens(prompt: string): number {
  return estimateTokens(prompt);
}

/**
 * 给定估算 token 数和上下文窗口大小，返回是否应触发激进压缩。
 *
 * @param estimatedTokens 当前 prompt 估算 token 数
 * @param contextWindow 模型上下文窗口大小（默认 200K，适配 Claude Sonnet/Opus）
 * @param threshold 触发压缩的占比阈值（默认 0.8，即 80%）
 */
export function shouldCompress(
  estimatedTokens: number,
  contextWindow: number = 200_000,
  threshold: number = 0.8
): boolean {
  return estimatedTokens > contextWindow * threshold;
}

function isCJK(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Unified Ideographs Extension A
    (code >= 0x20000 && code <= 0x2a6df) || // CJK Unified Ideographs Extension B
    (code >= 0x2a700 && code <= 0x2b73f) || // CJK Unified Ideographs Extension C
    (code >= 0x2b740 && code <= 0x2b81f) || // CJK Unified Ideographs Extension D
    (code >= 0x2b820 && code <= 0x2ceaf) || // CJK Unified Ideographs Extension E
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
    (code >= 0x2f800 && code <= 0x2fa1f) || // CJK Compatibility Ideographs Supplement
    (code >= 0x3000 && code <= 0x303f) || // CJK Symbols and Punctuation
    (code >= 0xff00 && code <= 0xffef) || // Halfwidth and Fullwidth Forms
    (code >= 0x3040 && code <= 0x309f) || // Hiragana
    (code >= 0x30a0 && code <= 0x30ff) || // Katakana
    (code >= 0xac00 && code <= 0xd7af) // Hangul Syllables
  );
}


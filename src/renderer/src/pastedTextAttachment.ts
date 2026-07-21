export const LARGE_PASTE_MIN_CHARACTERS = 2_000;
export const LARGE_PASTE_MIN_LINES = 20;

export function shouldAttachPastedText(text: string): boolean {
  if (!text) return false;
  if (text.length >= LARGE_PASTE_MIN_CHARACTERS) return true;
  return text.split(/\r?\n/).length >= LARGE_PASTE_MIN_LINES;
}

export function createPastedTextFileName(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    "pasted-text-",
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
    ".txt"
  ].join("");
}

export function insertPastedTextAttachmentReference(
  currentValue: string,
  selectionStart: number,
  selectionEnd: number,
  fileName: string,
  characterCount: number
): string {
  const start = Math.max(0, Math.min(selectionStart, currentValue.length));
  const end = Math.max(start, Math.min(selectionEnd, currentValue.length));
  const reference = `[已将粘贴的 ${characterCount} 个字符保存为附件：${fileName}]`;
  const prefix = currentValue.slice(0, start);
  const suffix = currentValue.slice(end);
  const before = prefix && !/\n$/.test(prefix) ? "\n" : "";
  const after = suffix && !/^\n/.test(suffix) ? "\n" : "";
  return `${prefix}${before}${reference}${after}${suffix}`;
}

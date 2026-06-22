const POLITE_PREFIXES = /^(?:请帮我|麻烦帮我|能否帮我|可以帮我|帮我|请|麻烦)\s*/;

export function summarizeSessionTitle(taskPrompt: string, maxLength = 36): string {
  const normalized = taskPrompt
    .replace(/```[\s\S]*?```/g, "代码任务")
    .replace(/^\s*[-#>*]+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(POLITE_PREFIXES, "")
    .trim();
  if (!normalized) return "未命名会话";

  const firstSentence = normalized.split(/(?<=[。！？!?])\s*/u)[0] || normalized;
  return firstSentence.length <= maxLength ? firstSentence : `${firstSentence.slice(0, maxLength - 1).trimEnd()}…`;
}

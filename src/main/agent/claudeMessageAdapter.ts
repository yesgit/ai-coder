export interface ClaudeStageOutput {
  assistantText: string;
  resultText: string;
  structuredOutput?: unknown;
  error?: string;
}

interface AssistantContentBlock {
  type?: unknown;
  text?: unknown;
}

export function extractClaudeStageOutput(messages: unknown[]): ClaudeStageOutput {
  const assistantText: string[] = [];
  let resultText = "";
  let structuredOutput: unknown;
  const errors: string[] = [];

  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }

    if (message.type === "assistant") {
      assistantText.push(...extractAssistantText(message));
      if (typeof message.error === "string") {
        errors.push(message.error);
      }
      continue;
    }

    if (message.type === "result") {
      if (message.structured_output !== undefined) {
        structuredOutput = message.structured_output;
      }
      if (typeof message.result === "string" && message.result.trim() && !isNoContentBlock(message.result)) {
        resultText = message.result;
      }
      if (message.is_error === true && typeof message.result === "string" && message.result.trim()) {
        errors.push(message.result);
      }
      if (Array.isArray(message.errors)) {
        errors.push(...message.errors.filter((error): error is string => typeof error === "string"));
      }
    }

    if (message.type === "auth_status" && typeof message.error === "string") {
      errors.push(message.error);
    }
  }

  return {
    assistantText: assistantText.join("\n").trim(),
    resultText: resultText.trim(),
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    error: errors.length > 0 ? errors.join("\n") : undefined
  };
}

export function formatClaudeTranscript(messages: unknown[]): string {
  const output = extractClaudeStageOutput(messages);
  const parts = [output.assistantText, output.resultText]
    .filter(Boolean)
    .filter((text) => !isNoContentBlock(text));
  if (parts.length === 0) return "";
  // 去重：assistantText 和 resultText 相同时只保留一份
  if (parts.length === 2 && parts[0] === parts[1]) return parts[0];
  return parts.join("\n\n");
}

function extractAssistantText(message: Record<string, unknown>): string[] {
  const assistantMessage = message.message;
  if (!isRecord(assistantMessage) || !Array.isArray(assistantMessage.content)) {
    return [];
  }

  return assistantMessage.content
    .filter((block): block is AssistantContentBlock => isRecord(block))
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .filter((block) => !isNoContentBlock(String(block.text)))
    .map((block) => String(block.text));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** SDK 内部占位文本块——没有任何信息量，应被过滤掉 */
function isNoContentBlock(text: string): boolean {
  const trimmed = text.trim();
  return trimmed === "(no content)" || trimmed === "(no content)\n" || /^\(no content\)\s*$/.test(trimmed);
}

export interface ClaudeStageOutput {
  assistantText: string;
  resultText: string;
  error?: string;
}

interface AssistantContentBlock {
  type?: unknown;
  text?: unknown;
}

export function extractClaudeStageOutput(messages: unknown[]): ClaudeStageOutput {
  const assistantText: string[] = [];
  let resultText = "";
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
      if (typeof message.result === "string" && message.result.trim()) {
        resultText = message.result;
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
    error: errors.length > 0 ? errors.join("\n") : undefined
  };
}

export function formatClaudeTranscript(messages: unknown[]): string {
  const output = extractClaudeStageOutput(messages);
  if (output.assistantText && output.resultText && output.assistantText !== output.resultText) {
    return [output.assistantText, output.resultText].join("\n\n");
  }
  return output.resultText || output.assistantText || messages.map((message) => JSON.stringify(message)).join("\n");
}

function extractAssistantText(message: Record<string, unknown>): string[] {
  const assistantMessage = message.message;
  if (!isRecord(assistantMessage) || !Array.isArray(assistantMessage.content)) {
    return [];
  }

  return assistantMessage.content
    .filter((block): block is AssistantContentBlock => isRecord(block))
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

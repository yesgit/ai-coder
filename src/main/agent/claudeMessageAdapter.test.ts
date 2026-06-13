import { describe, expect, it } from "vitest";
import { extractClaudeStageOutput, formatClaudeTranscript } from "./claudeMessageAdapter.js";

describe("claude message adapter", () => {
  it("extracts assistant text and result text from SDK messages", () => {
    const messages = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Working through the current stage." },
            { type: "tool_use", name: "Read" }
          ]
        }
      },
      {
        type: "result",
        subtype: "success",
        result: '{"status":"completed","output_summary":"Done"}'
      }
    ];

    expect(extractClaudeStageOutput(messages)).toEqual({
      assistantText: "Working through the current stage.",
      resultText: '{"status":"completed","output_summary":"Done"}',
      error: undefined
    });
  });

  it("extracts execution errors", () => {
    const messages = [
      {
        type: "result",
        subtype: "error_during_execution",
        errors: ["SDK failed"]
      }
    ];

    expect(extractClaudeStageOutput(messages).error).toBe("SDK failed");
  });

  it("extracts error result text from failed SDK runs", () => {
    const messages = [
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Invalid API key · Please run /login" }] },
        error: "authentication_failed"
      },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        result: "Invalid API key · Please run /login"
      }
    ];

    expect(extractClaudeStageOutput(messages)).toMatchObject({
      assistantText: "Invalid API key · Please run /login",
      resultText: "Invalid API key · Please run /login",
      error: "authentication_failed\nInvalid API key · Please run /login"
    });
  });

  it("formats a readable transcript", () => {
    const transcript = formatClaudeTranscript([
      {
        type: "assistant",
        message: { content: [{ type: "text", text: "Summary" }] }
      },
      {
        type: "result",
        subtype: "success",
        result: '{"status":"completed","output_summary":"Done"}'
      }
    ]);

    expect(transcript).toContain("Summary");
    expect(transcript).toContain('"status":"completed"');
  });
});

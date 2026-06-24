import { describe, expect, it } from "vitest";
import { isMeaningfulAgentText } from "./agentMessages.js";

describe("isMeaningfulAgentText", () => {
  it("rejects null / undefined / empty", () => {
    expect(isMeaningfulAgentText(null)).toBe(false);
    expect(isMeaningfulAgentText(undefined)).toBe(false);
    expect(isMeaningfulAgentText("")).toBe(false);
  });

  it("rejects whitespace-only", () => {
    expect(isMeaningfulAgentText("   ")).toBe(false);
    expect(isMeaningfulAgentText("\n\t  ")).toBe(false);
  });

  it("rejects the (no content) placeholder, with or without surrounding whitespace", () => {
    expect(isMeaningfulAgentText("(no content)")).toBe(false);
    expect(isMeaningfulAgentText("  (no content)  ")).toBe(false);
    expect(isMeaningfulAgentText("\n(no content)\n")).toBe(false);
  });

  it("rejects SDK internal transcript prefix in any of its forms", () => {
    expect(isMeaningfulAgentText("收到 Claude SDK 消息：assistant")).toBe(false);
    expect(isMeaningfulAgentText("收到 Claude SDK 消息：tool_use")).toBe(false);
    expect(isMeaningfulAgentText("收到 Claude SDK 消息。")).toBe(false);
    // 前导空白：trim 后仍以前缀开头，应过滤
    expect(isMeaningfulAgentText("  收到 Claude SDK 消息：assistant")).toBe(false);
  });

  it("preserves non-SDK content that happens to share a partial prefix", () => {
    // "收到 Claude SDK 工具调用：xxx" 由 describeSdkMessage 产出但只写入 progress_events，
    // 从不进 messages.content；isMeaningfulAgentText 只过滤 "收到 Claude SDK 消息" 这一族。
    expect(isMeaningfulAgentText("收到 Claude SDK 工具调用：Read")).toBe(true);
  });

  it("accepts ordinary content", () => {
    expect(isMeaningfulAgentText("已完成阶段一的代码读取。")).toBe(true);
    expect(isMeaningfulAgentText("a")).toBe(true);
    // JSON 字符串也是真实内容
    expect(isMeaningfulAgentText('{"status":"completed"}')).toBe(true);
  });

  it("preserves content that merely mentions the placeholder mid-string", () => {
    // 关键边界：助手在描述时引用占位符不算占位符
    expect(isMeaningfulAgentText("响应里包含 (no content) 作为示例")).toBe(true);
    expect(isMeaningfulAgentText("提示：不要返回 (no content)")).toBe(true);
  });
});

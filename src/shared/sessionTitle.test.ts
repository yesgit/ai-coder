import { describe, expect, it } from "vitest";
import { summarizeSessionTitle } from "./sessionTitle.js";

describe("summarizeSessionTitle", () => {
  it("removes polite prefixes and keeps the first sentence", () => {
    expect(summarizeSessionTitle("请帮我修复登录页面崩溃。还需要补充测试。")).toBe("修复登录页面崩溃。");
  });

  it("collapses whitespace and truncates long prompts", () => {
    const title = summarizeSessionTitle("实现一个非常非常长的会话历史自动摘要名称并确保它不会撑开侧边栏中的布局", 18);
    expect(title).toHaveLength(18);
    expect(title.endsWith("…")).toBe(true);
  });

  it("provides a fallback for empty prompts", () => {
    expect(summarizeSessionTitle("   ")).toBe("未命名会话");
  });
});

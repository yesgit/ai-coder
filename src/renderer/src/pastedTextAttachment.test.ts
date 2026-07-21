import { describe, expect, it } from "vitest";
import {
  createPastedTextFileName,
  insertPastedTextAttachmentReference,
  shouldAttachPastedText
} from "./pastedTextAttachment.js";

describe("pasted text attachments", () => {
  it("keeps ordinary pasted text inline", () => {
    expect(shouldAttachPastedText("short text")).toBe(false);
    expect(shouldAttachPastedText(Array.from({ length: 19 }, () => "line").join("\n"))).toBe(false);
  });

  it("turns long or many-line pasted text into an attachment", () => {
    expect(shouldAttachPastedText("x".repeat(2_000))).toBe(true);
    expect(shouldAttachPastedText(Array.from({ length: 20 }, () => "line").join("\n"))).toBe(true);
  });

  it("creates a stable txt name and inserts a readable reference at the selection", () => {
    const fileName = createPastedTextFileName(new Date(2026, 6, 21, 14, 5, 9));
    expect(fileName).toBe("pasted-text-20260721-140509.txt");
    expect(insertPastedTextAttachmentReference("before after", 7, 7, fileName, 2_345)).toBe(
      `before \n[已将粘贴的 2345 个字符保存为附件：${fileName}]\nafter`
    );
  });
});

import { describe, expect, it } from "vitest";
import { formatActivityLog } from "./activityLog.js";

describe("formatActivityLog", () => {
  it("formats every displayed event without truncating its message", () => {
    const longMessage = "执行结果".repeat(100);
    const result = formatActivityLog([
      {
        id: "event-1",
        type: "runner",
        visibility: "milestone",
        message: "开始执行",
        created_at: "2026-07-21T02:00:00.000Z"
      },
      {
        id: "event-2",
        type: "tool_policy",
        visibility: "transient",
        message: longMessage,
        created_at: "2026-07-21T02:00:01.000Z"
      }
    ], (value) => value.endsWith("00.000Z") ? "10:00:00" : "10:00:01");

    expect(result).toBe([
      "10:00:00\trunner\tmilestone\t开始执行",
      `10:00:01\ttool_policy\ttransient\t${longMessage}`
    ].join("\n"));
  });

  it("returns an empty string when there are no events", () => {
    expect(formatActivityLog([], () => "unused")).toBe("");
  });
});

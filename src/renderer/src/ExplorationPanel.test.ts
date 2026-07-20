import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ExplorationPanel from "./ExplorationPanel.js";

describe("ExplorationPanel", () => {
  it("renders an empty state before the first checkpoint", () => {
    const html = renderToStaticMarkup(createElement(ExplorationPanel));

    expect(html).toContain("工作记忆");
    expect(html).toContain("等待建立");
  });

  it("renders the latest checkpoint as raw text", () => {
    const html = renderToStaticMarkup(createElement(ExplorationPanel, {
      checkpoints: [
        {
          revision: 1,
          text: "旧认知",
          disposition: "continue",
          next_action: "旧行动",
          observed_tool_call_count: 0,
          created_at: "2026-07-20T00:00:00.000Z"
        },
        {
          revision: 2,
          text: "## 已确认\n- 路由映射存在",
          disposition: "verify",
          next_action: "运行跳转验证",
          observed_tool_call_count: 3,
          created_at: "2026-07-20T00:01:00.000Z"
        }
      ]
    }));

    expect(html).toContain("r2");
    expect(html).toContain("验证中");
    expect(html).toContain("路由映射存在");
    expect(html).toContain("运行跳转验证");
    expect(html).not.toContain("旧认知");
  });
});

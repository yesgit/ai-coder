import { describe, expect, it } from "vitest";
import type { StageRun } from "../../shared/types.js";
import { formatStageRunCardDetail, formatStageRunStartDetail } from "./stageRunPresentation.js";

function run(partial: Partial<StageRun> = {}): StageRun {
  return {
    id: "run-1",
    stage_id: "understand",
    attempt: 1,
    status: "running",
    input_summary: "项目画像扫描完成。已有 CLAUDE.md。",
    started_at: "2026-07-14T00:00:00.000Z",
    ...partial
  };
}

describe("stage run presentation", () => {
  it("does not present an upstream input summary as the running stage result", () => {
    const stageRun = run();

    expect(formatStageRunCardDetail(stageRun)).toBe("正在执行本阶段，尚未产生阶段结果。");
    expect(formatStageRunStartDetail(stageRun)).toBe("正在执行本阶段，尚未产生阶段结果。");
    expect(formatStageRunCardDetail(stageRun)).not.toContain("项目画像");
  });

  it("shows retry and rework reasons because they describe the current execution", () => {
    expect(formatStageRunCardDetail(run({ retry_reason: "缺少入口证据" }))).toBe("正在重试本阶段：缺少入口证据");
    expect(formatStageRunCardDetail(run({ input_summary: "Rework requested from verify: 测试未覆盖失败路径" })))
      .toBe("正在按返工要求重新执行：verify: 测试未覆盖失败路径");
  });

  it("shows an output summary only after the stage has produced one", () => {
    expect(formatStageRunCardDetail(run({ status: "completed", output_summary: "需求契约已建立。" })))
      .toBe("需求契约已建立。");
    expect(formatStageRunCardDetail(run({ status: "waiting_approval", output_summary: "方案待审批。" })))
      .toBe("方案待审批。");
  });
});

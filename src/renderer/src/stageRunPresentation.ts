import type { StageRun } from "../../shared/types.js";

const REWORK_PREFIX = "Rework requested from ";

/**
 * A stage's input_summary describes how control reached the stage. It is not
 * the stage's result and must not be presented as if the current stage said it.
 */
export function formatStageRunCardDetail(stageRun: StageRun): string {
  if (stageRun.status === "running") {
    return formatRunningStageDetail(stageRun);
  }

  if (stageRun.status === "waiting_approval") {
    return stageRun.output_summary ?? "本阶段已执行完成，正在等待审批。";
  }

  return stageRun.rework_reason
    ?? stageRun.output_summary
    ?? "本次阶段执行没有产生可展示的结果摘要。";
}

export function formatStageRunStartDetail(stageRun: StageRun): string {
  return formatRunningStageDetail(stageRun);
}

function formatRunningStageDetail(stageRun: StageRun): string {
  if (stageRun.retry_reason) {
    return `正在重试本阶段：${stageRun.retry_reason}`;
  }
  if (stageRun.input_summary.startsWith(REWORK_PREFIX)) {
    return `正在按返工要求重新执行：${stageRun.input_summary.slice(REWORK_PREFIX.length)}`;
  }
  return "正在执行本阶段，尚未产生阶段结果。";
}

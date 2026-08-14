import type { TaskClaimResult, UnifiedTask } from "../../shared/types.js";

/**
 * 构建注入 session.task_prompt 的结构化文本。
 * 包含任务来源、描述、验收标准和工作分支信息。
 */
export function buildTaskPrompt(task: UnifiedTask, claim: TaskClaimResult): string {
  const lines: string[] = [
    `## 任务来源`,
    `- 平台：${formatPlatformName(task.platform)}`,
    `- 任务 ID：${task.task_id}`,
    `- 任务链接：${task.raw_url}`,
    `- 工作分支：${claim.branch}（基于 ${task.project_mapping.default_base_branch}）`,
    ``,
    `## 任务标题`,
    task.title,
    ``
  ];

  if (task.description) {
    lines.push(`## 任务描述`, task.description, ``);
  }

  if (task.priority) {
    lines.push(`## 优先级`, task.priority, ``);
  }

  if (task.labels.length > 0) {
    lines.push(`## 标签`, task.labels.map((l) => `\`${l}\``).join(", "), ``);
  }

  lines.push(
    `## 难度评估`,
    `预估难度：${formatDifficulty(task.difficulty_estimate)}`,
    ``,
    `## 完成要求`,
    `1. 在当前分支 ${claim.branch} 上实现上述需求`,
    `2. 编写或更新测试并确保通过`,
    `3. 提交 commit（引用任务 ${task.task_id}）`,
    `4. 完成后将自动创建 Pull Request 并通知平台`
  );

  return lines.join("\n");
}

function formatPlatformName(platform: string): string {
  switch (platform) {
    case "jira_cloud": return "Jira Cloud";
    case "jira_server": return "Jira Server";
    case "pingcode": return "PingCode";
    default: return platform;
  }
}

function formatDifficulty(level: string): string {
  switch (level) {
    case "trivial": return "简单（trivial）";
    case "low": return "较低（low）";
    case "medium": return "中等（medium）";
    case "high": return "较高（high）";
    default: return "未知（unknown）";
  }
}

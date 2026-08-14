import type { ClaimedTaskRecord, MRComment, MRDiffNote, ReviewAction } from "../../shared/types.js";

/**
 * 构建 MR Review 意见处理的 AI 会话 prompt。
 * 包含评论内容、diff 上下文和修改要求。
 */
export function buildReviewPrompt(
  record: ClaimedTaskRecord,
  actions: ReviewAction[],
  diffs: MRDiffNote[]
): string {
  const lines: string[] = [
    `## MR Review 意见处理`,
    `- MR 链接：${record.pr_url ?? "未知"}`,
    `- 分支：${record.branch}`,
    `- Review 轮次：第 ${record.review_round + 1} 轮`,
    ``
  ];

  lines.push(`### 收到的评论`);
  lines.push(``);

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const comment = action.comment;
    const position = comment.position;

    lines.push(`${i + 1}. **@${comment.author}** 评论：`);

    if (position) {
      lines.push(`   文件：\`${position.new_path}\`，第 ${position.new_line} 行`);

      // 查找对应的 diff 上下文
      const diffContext = findDiffContext(diffs, position.new_path);
      if (diffContext) {
        lines.push(`   diff 上下文：`);
        lines.push(`   \`\`\``);
        lines.push(`   ${diffContext.slice(0, 500)}`);
        lines.push(`   \`\`\``);
      }
    }

    lines.push(`   > ${comment.body}`);
    lines.push(``);
  }

  lines.push(`### 要求`);
  lines.push(`1. 根据上述评论逐一修改代码`);
  lines.push(`2. 确保相关测试通过`);
  lines.push(`3. 修改完成后提交 commit 并推送`);
  lines.push(`4. 每条 commit message 需引用对应的评论内容摘要`);

  return lines.join("\n");
}

/**
 * 在 diff 列表中查找指定文件的相关 diff 片段。
 */
function findDiffContext(diffs: MRDiffNote[], filePath: string): string | null {
  const diff = diffs.find((d) => d.new_path === filePath);
  if (!diff) return null;
  // 截取前 500 字符作为上下文
  return diff.diff.length > 500 ? `${diff.diff.slice(0, 500)}...` : diff.diff;
}

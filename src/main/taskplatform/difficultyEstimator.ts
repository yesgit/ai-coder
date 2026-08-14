import type { DifficultyLevel, UnifiedTask } from "../../shared/types.js";

/** 高难度关键词 */
const HIGH_DIFFICULTY_KEYWORDS = [
  "refactor", "重构", "migration", "迁移", "performance", "性能优化",
  "architecture", "架构", "security", "安全", "concurrency", "并发"
];

/** 低难度关键词 */
const LOW_DIFFICULTY_KEYWORDS = [
  "typo", "错别字", "docs", "文档", "readme", "comment", "注释",
  "ui tweak", "样式调整", "css", "i18n", "国际化"
];

/** 高优先级标签 */
const HIGH_PRIORITY = new Set(["highest", "critical", "blocker", "p0", "urgent"]);

/** 低优先级标签 */
const LOW_PRIORITY = new Set(["lowest", "trivial", "minor", "p3", "p4"]);

/**
 * 基于规则的启发式难度评估器。不消耗 LLM 调用。
 */
export class DifficultyEstimator {
  estimate(task: UnifiedTask): DifficultyLevel {
    let score = 0;

    // 描述长度评分
    const descLen = (task.description || "").length;
    if (descLen < 100) score -= 1;
    else if (descLen < 500) score += 0;
    else if (descLen < 2000) score += 1;
    else score += 2;

    // 关键词评分
    const text = `${task.title} ${task.description}`.toLowerCase();
    const hasHighKeyword = HIGH_DIFFICULTY_KEYWORDS.some((kw) => text.includes(kw));
    const hasLowKeyword = LOW_DIFFICULTY_KEYWORDS.some((kw) => text.includes(kw));
    if (hasHighKeyword) score += 2;
    if (hasLowKeyword) score -= 2;

    // 优先级评分
    if (task.priority && HIGH_PRIORITY.has(task.priority.toLowerCase())) score += 1;
    if (task.priority && LOW_PRIORITY.has(task.priority.toLowerCase())) score -= 1;

    // 标签数量（多标签通常意味着复杂需求）
    if (task.labels.length > 5) score += 1;

    // 分数映射难度
    if (score <= -2) return "trivial";
    if (score <= 0) return "low";
    if (score <= 2) return "medium";
    return "high";
  }
}

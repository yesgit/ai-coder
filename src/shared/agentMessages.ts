/**
 * 共享过滤器：判断助手消息或 SDK transcript 是否含有"真正可展示的内容"。
 *
 * Claude Agent SDK 在工具调用/思考阶段会产出大量占位 transcript：
 *  - `formatClaudeTranscript()` 没东西可写时回退到 `"(no content)"`
 *  - `describeSdkMessage()` 把工具调用/SDK 内部消息渲染成 `"收到 Claude SDK 消息：xxx"`
 *
 * 这些字符串既不能落进 session.messages（前端要展示给用户），也不能注入到下次 prompt
 * 的历史里（污染上下文）。所以多处需要同一组判断；本模块是唯一真理源。
 *
 * 之前同一段过滤条件复制在：
 *  - claudeAgentRunner.ts 4 处（line 142 / 159 / 191 / 389）
 *  - sessionTimeline.ts 2 处（line 59 / 66）
 *  - workflowPrompt.ts 1 处（line 31）
 */

const SDK_PLACEHOLDER = "(no content)";
// 前缀做"宽松匹配"：claudeAgentRunner.describeSdkMessage 会产出两种变体：
//   "收到 Claude SDK 消息：${type}"（带冒号）
//   "收到 Claude SDK 消息。"（带句号，无类型时的兜底）
// 历史 session 文件可能两种都存有，所以前缀只匹配公共部分，不带分隔符。
const SDK_MESSAGE_PREFIX = "收到 Claude SDK 消息";

/**
 * 判断助手消息文本是否值得展示/注入历史。
 * 空 / 占位符 / SDK 内部 transcript 一律为 false。
 *
 * 注意：占位符匹配作用在 `content.trim()` 后的值上——前后空白被规范化掉。
 * 这是有意的（消息持久化前一般已 trim，但旧 session 文件可能不同）。
 */
export function isMeaningfulAgentText(content: string | null | undefined): boolean {
  if (!content) return false;
  const trimmed = content.trim();
  if (!trimmed) return false;
  if (trimmed === SDK_PLACEHOLDER) return false;
  if (trimmed.startsWith(SDK_MESSAGE_PREFIX)) return false;
  return true;
}

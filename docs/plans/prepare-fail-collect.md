# Fix A+B：prepare 阶段 fail-collect + 指纹按类归一

## 背景与根因
prepare 校验是 **fail-fast**（遇首个违规即 `throw`），叠加指纹按逐条消息计算，导致：

- 模型一次只看到一个义务缺口 → B1→B3→B4→B6 轮转，`同类问题` 恒为 `1/6`，软自愈（`repeats>=3` 退回 investigate）永不触发；
- 真实进步被误读为原地打转，最终某复发的 schema 错误 trip `totalFailures>=6` 误杀整个 run；
- 强停后重启又不带草稿/历史，从零再来。

## Fix A — prepare 校验改为 fail-collect（仅限 prepare）
**文件**：`src/main/agent/claudeAgentRunner.ts`，函数 `validateHierarchicalBehaviorObligationContinuity` 的 `if (operation.phase === "prepare")` 分支（4287–4512）。

1. 在草稿校验区起点（4354 `const callContract = …` 之前）引入：
   ```ts
   const violations: string[] = [];
   ```
2. 把以下「prepare 草稿完整性」违规由 `throw new Error(msg)` 改为 `violations.push(msg)`（**文案逐字不变**，以保 `toThrow(子串)` 测试通过）：
   - 4405 `prepare 必须逐目标分析 investigate 选中的同功能入口对应的真实函数/组件：…`
   - 4424 `reference_application 未逐目标覆盖 ${targetKey}`
   - 4433 `reference_application 包含未声明的 target_key：…`
   - 4454 `行为义务 ${id} 未覆盖目标：…`
   - 4460 `行为义务 ${id} 包含未声明目标：…`
   - 4475 `行为义务 ${id} 未引用 ${targetKey} 的选定同功能入口 ${selectedLocation}`（核心）
   - 4496 `already_satisfied 行为义务 ${id} 缺少当前目标代码的独立 path:line 证据`
   - 4508 `already_satisfied 必须为每条行为义务提供独立 satisfaction_evidence`
3. **保留 fail-fast**（前置条件 / investigate 产物完整性，不属于当前 prepare 草稿，先于收集区抛出）：
   - 4289 `prepare 缺少 investigate 同功能入口交接物`
   - 4314 `${targetKey} 的 selected_location 未对应同一目标的候选`
   - 4338 `prepare 前必须由 investigate 选定同一业务功能的既有入口`
4. 在 4511 `return;` 之前插入复合抛出（仍由 832–838 的 catch 包成 `HierarchicalRoleValidationError(reason + 可原地修正, rejectedOutput)`，模型照旧拿到完整被拒草稿）：
   ```ts
   if (violations.length > 0) {
     throw new Error(
       `prepare 阶段交接物未通过校验，共 ${violations.length} 处：\n`
       + violations.map((v) => `- ${v}`).join("\n")
     );
   }
   ```

`hierarchicalValidationCorrection`（4755–4770）的 `逐目标分析|真实函数/组件|选中的同功能入口` 分支仍命中（复合消息含这些词），指引文案不变。

## Fix B — 指纹按「违规类」归一（全局，覆盖 prepare + implement/verify 义务消息）
**文件**：同上，函数 `normalizeHierarchicalErrorForFingerprint`（4781–4805）。

在现有 `feature_census` 特化（4783–4795）之后、通用回退（4799）之前，插入「违规类集合」归一：检测 `reason`（已去 `可原地修正` 后缀、已折叠空白）命中的所有违规类，排序去重后拼成稳定 token。

```ts
const violationClasses: Array<[RegExp, string]> = [
  // prepare（validateHierarchicalBehaviorObligationContinuity）
  [/行为义务.*未引用.*选定同功能入口/, "obligation-evidence-missing"],
  [/行为义务.*未覆盖目标/, "obligation-target-coverage-missing"],
  [/行为义务.*包含未声明目标/, "obligation-unexpected-target"],
  [/reference_application 未逐目标覆盖/, "reference-application-coverage-missing"],
  [/reference_application 包含未声明的 target_key/, "reference-application-unexpected-target"],
  [/prepare 必须逐目标分析.*真实函数\/组件/, "analyzed-targets-missing"],
  [/already_satisfied 行为义务.*缺少当前目标代码/, "already-satisfied-target-evidence-missing"],
  [/already_satisfied 必须为每条行为义务提供独立 satisfaction_evidence/, "satisfaction-evidence-missing"],
  // implement/verify（assertObligationResultClosure）
  [/行为义务 ID 未闭环/, "obligation-id-not-closed"],
  [/行为义务.*未通过：/, "obligation-result-not-passing"],
  [/行为义务.*缺少 observed_behavior/, "obligation-result-missing-observed"],
  [/行为义务.*缺少 evidence_refs/, "obligation-result-missing-evidence"],
  [/行为义务.*缺少 path:line 代码证据/, "obligation-result-missing-pathline"]
];
const matched = new Set<string>();
for (const [pattern, token] of violationClasses) {
  if (pattern.test(reason)) matched.add(token);
}
if (matched.size > 0) {
  return `hierarchical-contract:${[...matched].sort().join(",")}`;
}
```

**效果**：B1/B3/B4/B6 任一「未引用选定同功能入口」都映射到 `obligation-evidence-missing` → 同一指纹 → `countConsecutiveHierarchicalPhaseFailures` 正确累加 → 软自愈（`repeats>=3` 退回 investigate）与硬上限（`totalFailures>=6`）按「同类」正确计数。复合消息（Fix A）里多个类并存时按类集合归一；修掉整类后集合变化、指纹变化、streak 重置——这正是「类级别进步」应得的处理，不再把进步误判为打转。

> 类模式两两不重叠（已核：例如 prepare 的 `already_satisfied …缺少当前目标代码的独立 path:line 证据` 不含字面 `缺少 path:line 代码证据`，不会误命中 implement/verify 类）。

## 测试
### 现有测试不破坏（已逐一核对）
- `toThrow(子串)` 类：814/827/834（prepare）、961/970/978/986（verify）——复合消息仍含原逐条文案，子串命中。
- 重试语义：1546 `attempt 1；同类问题 1/6`（首次失败 `repeats=1`，与指纹值无关）；1700/1635 implement 耗尽测试用裸 query Error（`unchanged implementation fault` / `same recoverable implementation fault`，不命中违规类 → 走回退 → 指纹不变）。
- 指纹单测 711–731（investigate census）——census 消息不命中违规类 → 走原 `feature_census` 特化 → 不变。

### 新增测试（`src/main/agent/claudeAgentRunner.hierarchical.test.ts`）
1. **fail-collect**：构造 prepare 草稿使 B1+B3 同时缺入口引用，断言 `validateHierarchicalBehaviorObligationContinuity` 抛出的消息**同时包含**两条 `未引用 … 选定同功能入口` 文案（而非只抛第一条）。
2. **指纹归一**：断言
   - `hierarchicalErrorFingerprint("R/prepare", "行为义务 B1-destination 未引用 零钱宝 的选定同功能入口 a.ts:36")`
     === `hierarchicalErrorFingerprint("R/prepare", "行为义务 B3-arguments 未引用 转托管入 的选定同功能入口 b.ts:892")`；
   - 两者 ≠ `hierarchicalErrorFingerprint("R/prepare", "reference_application 未逐目标覆盖 TQlqbmore")`。
3. **端到端**（可选）：prepare 连续 3 次只缺 obligation-evidence 时，触发「退回 investigate 自愈」而非无限 retry（验证 streak 正确累加）。

## 范围外（明示）
`assertObligationResultClosure`（implement/verify，4546–4588）有相同 fail-fast 模式；本次**不做 fail-collect**，仅由 Fix B 的指纹归一覆盖其计数问题。若 implement/verify 出现同类可见性症状，再单独 fail-collect。

## 验证步骤
- `./node_modules/.bin/tsc -p tsconfig.json --noEmit`
- `./node_modules/.bin/vitest run src/main/agent/claudeAgentRunner.hierarchical.test.ts`

# Fix C：prepare 选定入口证据预填（P1 - 每次 attempt 都预填）

## 目标
宿主已从 investigate 产物知道每个 target_key 的**选定同功能入口 `path:line`**（`reference_analysis.target_selections.selected_location`），却要求模型自己把这个 `path:line` 重新发现并塞进 6 条 behavior_obligations 的 `evidence_refs`，漏一个罚一个（4475）。弱模型在此反复失败。

把宿主已知的选定入口**在校验前注入** `behavior_obligations[].evidence_refs` 与 `target_keys`，模型不再需要猜 `path:line`。决策（已确认）：**每次 attempt 都预填**（P1），与现有 `reconcileHierarchicalPrepareContractHandoff` 对 `analyzed_targets` 的预填一致，贴合"减架构/批判行为即证据"方向。

## 机制
`runHierarchicalRoleQuery` 在校验前已有一段 reconcile（`claudeAgentRunner.ts:791-802`）：先 `reconcileHierarchicalFeatureCensusHandoff`，再 `reconcileHierarchicalPrepareContractHandoff`（后者已把 trusted 工具报告合并进 `analyzed_targets`）。新增一个并列的 reconcile 步骤 `reconcileHierarchicalPrepareObligationEvidence`，紧随其后调用，同样在每次 prepare attempt、校验前运行。

### 为什么是新函数而不是扩进现有 `reconcileHierarchicalPrepareContractHandoff`
现有函数被 `reports.length === 0`（3578）和 `!Array.isArray(call_contract.analyzed_targets)`（3575）两个 early-return 守卫，因为它合并的是**本 session 的 investigate_symbol_contract 工具回执**。而义务引用证据来自 **investigate 阶段产物的 `target_selections`**，与 reports 无关。若塞进现有函数，要么被 reports 守卫误杀（模型没在本 attempt 重跑工具就不预填），要么得重构它的 early-return。新函数独立、不被 reports 守卫，更安全。

## 改动

### 1. 新 helper：`prepareSelectedEntries`
```ts
function prepareSelectedEntries(
  investigate: PhaseArtifact | undefined,
  projectPath: string
): Array<{ targetKey: string; location: string }> {
  if (!investigate) return [];
  const referenceAnalysis = isPlainObject(investigate.handoff.reference_analysis)
    ? investigate.handoff.reference_analysis
    : null;
  const selections = Array.isArray(referenceAnalysis?.target_selections)
    ? referenceAnalysis.target_selections.filter(isPlainObject)
    : [];
  return selections.flatMap((selection) => {
    const targetKey = optionalString(selection.target_key);
    const location = optionalString(selection.selected_location);
    return targetKey && location && evidenceLocationFile(location, projectPath)
      ? [{ targetKey, location }]
      : [];
  });
}
```
（与 validator 4290-4323 / reconcile 3609-3621 的同源数据，但只取 `target_key + selected_location` 且是有效 path:line 的项。）

### 2. 新函数：`reconcileHierarchicalPrepareObligationEvidence`
```ts
export function reconcileHierarchicalPrepareObligationEvidence(
  session: AgentSession,
  operation: Extract<HierarchicalNextOperation, { kind: "run_phase" | "run_alignment_batch" | "run_planner" | "run_integrator" }>,
  structured: unknown
): void {
  if (operation.kind !== "run_phase" || operation.phase !== "prepare" || !isPlainObject(structured)) return;
  const handoff = isPlainObject(structured.handoff) ? structured.handoff : null;
  const obligations = handoff && Array.isArray(handoff.behavior_obligations)
    ? handoff.behavior_obligations.filter(isPlainObject)
    : [];
  if (obligations.length === 0) return;
  const state = session.hierarchical_state;
  const investigate = state ? latestHierarchicalArtifact(state, operation.requirement_id, "investigate") : undefined;
  const selectedEntries = prepareSelectedEntries(investigate, session.project_path);
  if (selectedEntries.length === 0) return;
  for (const obligation of obligations) {
    const targetKeys = new Set(optionalStringArray(obligation.target_keys) ?? []);
    for (const { targetKey } of selectedEntries) targetKeys.add(targetKey);
    obligation.target_keys = [...targetKeys];
    const evidence = Array.isArray(obligation.evidence_refs)
      ? obligation.evidence_refs.filter((item): item is string => typeof item === "string")
      : [];
    for (const { location } of selectedEntries) {
      const file = evidenceLocationFile(location, session.project_path);
      if (file && !evidence.some((item) => evidenceLocationFile(item, session.project_path) === file)) {
        evidence.push(location);
      }
    }
    obligation.evidence_refs = evidence;
  }
}
```
- **就地 mutate** `structured.handoff.behavior_obligations`（与现有 reconcile 一致；`structured` 在校验前是 live 对象）。
- 只做**加法**：union `target_keys`、追加缺失的选定入口 `path:line`；不删既有证据。
- 安全网：`already_satisfied` 的"当前目标代码证据"检查（4496）仍由模型负责（预填的选定入口在 selectedAnchors 内，不满足该检查，正确）。

### 3. 在 797-802 处挂接
```ts
reconcileHierarchicalFeatureCensusHandoff(input.session, operation, structured, stageId);
reconcileHierarchicalPrepareContractHandoff(input.session, operation, structured, stageId);
reconcileHierarchicalPrepareObligationEvidence(input.session, operation, structured);  // 新增
```

## 行为效果
- **每次 prepare attempt**（含 attempt 1）校验前，宿主把 investigate 已确认的选定入口 `path:line` 注入每条义务的 `evidence_refs`，并 union `target_keys`。
- 4475（未引用选定同功能入口）、4454（未覆盖目标）在**有选定入口**的真实流程里基本不再触发，退化为安全网（与 4405/analyzed_targets 现状一致）。
- **自愈性**：reconcile 每 attempt 都跑，即使模型在重提交时删掉预填证据，下次 attempt 会被重新注入--比 P2（只预填被拒草稿一次）更鲁棒。
- 无选定入口（`featureCensusRequired=false` / 静态配置无同类入口）时 `selectedEntries` 为空，预填跳过，4475 等检查照常作为安全网生效。

## 测试

### 现有测试不破坏（已核对）
- **直接调 validator 的单测**（733 "closes frozen obligations"、1049 fail-collect、555 investigate、~1107 "separates a static same-feature entry"）：都直接调 `validateHierarchicalBehaviorObligationContinuity` / `validateHierarchicalContractToolEvidence`，**绕过 reconcile**，4475 照常触发。这些测试的断言（`toThrow(子串)` 等）不受影响。
- **全流程测试**（1538/1556/1635/1696）：investigate 都用 `featureCensusRequired=false`（`selected_location=""`）-> `selectedEntries` 空 -> 预填跳过 -> 行为不变。

### 新增测试（`claudeAgentRunner.hierarchical.test.ts`）
单测 `reconcileHierarchicalPrepareObligationEvidence`：构造 investigate 产物（`featureCensusRequired=true`，`selected_location=reference.ts:5`）+ prepare 草稿（义务 `evidence_refs` 只含 `target.ts:1`、`target_keys` 缺该目标），调用 reconcile 后断言：
- 每条义务 `evidence_refs` 现含 `reference.ts:5`；
- `target_keys` 现含该目标；
- 既有 `target.ts:1` 证据保留（只做加法）；
- 无选定入口（`featureCensusRequired=false`）时调用为 no-op。

## 范围外（明示）
- 模型产不出合法 StructuredOutput（schema 超载，根因 2）仍不在预填能力内--预填只修"引用/覆盖"类逻辑违规，不修 JSON 形状错。需 schema 拆分/放宽 strict，另议。
- `assertObligationResultClosure`（implement/verify）的 fail-fast 仍未做 fail-collect（Fix B 已覆盖其计数）。

## 验证
- `./node_modules/.bin/tsc -p tsconfig.json --noEmit`
- `./node_modules/.bin/vitest run src/main/agent/claudeAgentRunner.hierarchical.test.ts`
- `./node_modules/.bin/vitest run src/main/agent/`（确认全流程测试无回归）

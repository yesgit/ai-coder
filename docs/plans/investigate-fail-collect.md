# Investigate A+B 扩展：fail-collect + 指纹按类归一

## 背景
prepare 的 A+B+C 已落地，但日志显示 **investigate 阶段有完全相同的打地鼠**：模型在 `contract_symbol/contract_location 未命中同一定义` -> `target_mappings 未逐项覆盖…pageName 原词` -> `缺少逐目标 reference selection` -> `candidates 未追到…同一最终函数/组件` 之间轮转，每换一种检查 `同类问题` 重置到 1/6，永不终止。原因：
1. investigate 校验跨**多个检查类型** fail-fast（一次只暴露一种）；
2. Fix B 的指纹类模式不含 investigate 消息 -> 走通用归一 -> 不同检查类型不同指纹 -> streak 重置 -> 6 次硬停永不触发；
3. investigate 的 `hierarchicalPhaseSelfHealRoute` 恒返回 `"retry"`，无软自愈（本计划不含，另议）。

## 调用结构（已核实）
校验顺序：`parseHierarchicalRoleResult`（runner:809 -> protocol:476 `validatePhaseHandoffSemantics`）**先于** `validateHierarchicalContractToolEvidence`（runner:810 -> 3393 `validateHierarchicalFeatureCensusEvidence` -> 4121 `validateInvestigateTargetMappingEvidence`）。所以 protocol 与 runner 是**先后两个 throwing 函数**，跨函数只能各自收集（模型看到 protocol 全部违规 或 runner 全部违规，不再一次一个）。Fix B 让这两段轮转也按类正确计数。

investigate 错误来源：
- runner：`validateHierarchicalFeatureCensusEvidence`（4030）：4061 覆盖、4108/4118 feature_census；`validateInvestigateTargetMappingEvidence`（4155）：4166/4191 `assertExactDeclaredContract`（4211，6 处 throw）、4187 缺候选、4202 非基线。
- protocol：`validatePhaseHandoffSemantics`（519）investigate 分支：677 未追到、702/705/723/730/740/744 selection、753 缺 selection。

---

## Fix B — `normalizeHierarchicalErrorForFingerprint` 增加 investigate 类
在现有 `violationClasses` 数组追加 3 条（按 handoff 段分组，与 prepare 的 per-class 哲学一致；fail-collect 后模型一次修完，类集合指纹稳定，不会轮转）：

```ts
// investigate（validateHierarchicalFeatureCensusEvidence / validateInvestigateTargetMappingEvidence / validatePhaseHandoffSemantics）
[/target_mappings 未逐项覆盖需求中的 pageName 原词|未命中同一定义|未声明精确 contract_symbol@contract_location|contract_location 不是有效 path:line|契约文件不在项目内或不存在|未解析到真实函数\/组件|定义行附近没有符号/, "investigate-target-mappings"],
[/未追到.*同一最终函数\/组件|缺少逐目标 reference selection|target_key 未对应 target_mappings|只能有一条 reference selection|未找到同功能入口时|存在同功能候选时必须选择|selected_location 必须对应|冒充同功能既有入口|选定同功能入口缺少候选证据|同功能参考必须来自任务基线/, "investigate-reference-analysis"],
[/selected_candidate_ids 未完整对应|未被功能普查以 yes 证据选中/, "investigate-feature-census"]
```

效果：investigate 的任一语义违规坍缩到这 3 类之一；同一类跨多次失败指纹稳定 -> `countConsecutiveHierarchicalPhaseFailures` / `countHierarchicalPhaseFailures` 正确累加 -> 6 次硬停能触发，不再无限轮转。模型修掉整段后类集合变化、指纹变化、streak 重置（类级进步奖励，与 prepare 一致）。

## Fix A — runner 侧 fail-collect

### A1. `assertExactDeclaredContract`（4211）重构：throw -> 返回错误串
签名 `: void` -> `: string | undefined`（返回错误消息，合法返回 `undefined`）。6 处 `throw new Error(msg)` 改 `return msg`；4262 `return;` 保持（即 `undefined`）。仅 2 个调用点（4166/4191，都在 `validateInvestigateTargetMappingEvidence`），非 exported，无直接单测。

### A2. `validateInvestigateTargetMappingEvidence`（4155）改为收集
增加 `violations: string[]` 参数；把 4166/4191 的 `assertExactDeclaredContract(...)` 改为 `const err = assertExactDeclaredContract(...); if (err) violations.push(err);`（循环继续，跨 target 收集）；4187（缺候选）、4202（非基线）`throw` 改 `violations.push(...)`。不再自行 throw。

### A3. `validateHierarchicalFeatureCensusEvidence`（4030）收集 + 复合抛出
在 investigate 可达的检查区起点引入 `const violations: string[] = []`；4061（覆盖）、4108、4118 的 `throw` 改 `violations.push`；4121 调用 `validateInvestigateTargetMappingEvidence(session, handoff, referenceAnalysis, referenceCandidates, violations)`；末尾（`return` 前）：
```ts
if (violations.length > 0) {
  throw new Error(
    `investigate 阶段交接物未通过校验，共 ${violations.length} 处：\n`
    + violations.map((v) => `- ${v}`).join("\n")
  );
}
```
> 保留 fail-fast：前置的 feature_census 回执检查（"未实际执行功能实现候选普查脚本"/"缺少宿主 Worker 回执"等，属 555 测试覆盖的范围）不在收集区，维持原 throw（它们是工具证据前置条件，非草稿完整性）。

## Fix A — protocol 侧 fail-collect

### A4. `validatePhaseHandoffSemantics`（519）investigate 分支收集
在 investigate 分支（676 起的 candidates/selections 语义检查区）引入 `const violations: string[] = []`；把**直接语义 throw** 改 `violations.push`：
- 677（candidate 未追到同一最终函数/组件）
- 702（selection.target_key 未对应 target_mappings）
- 705（重复 selection）
- 723（未找到入口时空字段规则）
- 730（存在候选时必须选择）
- 740（selected_location 须对应 candidate.location）
- 744（冒充目标本身）
- 753（缺逐目标 reference selection）
末尾（755 `return` 前）插入复合抛出（同 A3 文案前缀 `investigate 阶段交接物未通过校验，共 N 处：`）。

> 保留 fail-fast：分支前段的 **helper 式 schema 检查**（`requiredString`/`requiredArray`/`requirePathLineEvidence`/`requirePathLineString`/`requireNonEmptyStringArray` 等）维持原 throw——它们是结构性前置条件，结构错时语义检查无意义。SDK 已在工具层强制 JSON schema，这些 host 层 schema 错较少；schema-valid 但语义不全（日志主场景）时语义收集生效。

> 注意：candidates 循环里 schema(655-667) 与语义(677) 交错；schema helper 仍会先 throw。schema-valid 草稿（常见）下全部 677 收集；schema-invalid 时 helper 先 throw、语义部分收集——可接受。

## 行为效果
- 模型一次看到**单函数内的全部 investigate 违规**（protocol 段 或 runner 段），不再一类一类喂。
- 跨段（protocol -> runner）仍两步，但 Fix B 让两段都按 `investigate-target-mappings` / `investigate-reference-analysis` / `investigate-feature-census` 计数，streak/cap 正确，6 次硬停能触发，不再无限轮转。
- 与 prepare 的 A+B 风格一致（per-class 指纹 + fail-collect）。

## 测试

### 现有测试不破坏（需跑套件确认）
- `toThrow(子串)` 类（如 555 的 feature_census 回执、其他 investigate 断言）：复合消息仍含原逐条文案，子串命中。
- 指纹单测（711-731 census）：census 消息不命中新 investigate 类 -> 走原 feature_census 特化 -> 不变。
- `hierarchicalRoleProtocol.test.ts:311` 的 `error_fingerprint: "missing-12"` 若是 mock fixture（非真实计算值）则不受影响；实现时确认。

### 新增测试（`claudeAgentRunner.hierarchical.test.ts` + `hierarchicalRoleProtocol.test.ts`）
1. **Fix B 指纹归一**：`hierarchicalErrorFingerprint("R33/investigate", "…contract_symbol/contract_location 未命中同一定义…")` === `hierarchicalErrorFingerprint("R33/investigate", "target_mappings.LgbWealth 的 contract_symbol/contract_location 未命中同一定义：…")`（同类）；且 ≠ `…缺少逐目标 reference selection…`（不同类）。
2. **Fix A runner fail-collect**：构造 investigate 草稿同时有「覆盖缺失 + contract 未命中同一定义」，调用 `validateHierarchicalContractToolEvidence`（或 `validateHierarchicalFeatureCensusEvidence`），断言抛出消息同时含两条文案 + `共 2 处`，而不是只抛第一条。
3. **Fix A protocol fail-collect**（`hierarchicalRoleProtocol.test.ts`）：构造 `reference_analysis` 同时缺两个 target 的 selection + 一个 candidate 未追到，调用 `parseHierarchicalRoleResult`，断言抛出消息含全部两条 + 复合前缀。

## 范围外（明示）
- investigate 软自愈路由（恒 `retry`，无 `repeats>=3` 升级）——另议。
- 根因 2（schema 超载/模型产不出合法 StructuredOutput）——另议。
- 跨 protocol+runner 的统一聚合（一次看到两段全部违规）——需顶层 wrapper 重构，本次不做；per-段收集 + Fix B 已能终止轮转。

## 验证
- `./node_modules/.bin/tsc -p tsconfig.json --noEmit`
- `./node_modules/.bin/vitest run src/main/agent/claudeAgentRunner.hierarchical.test.ts src/main/agent/hierarchicalRoleProtocol.test.ts`
- `./node_modules/.bin/vitest run src/main/agent/`（全 agent 回归）

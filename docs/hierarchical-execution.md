# 宿主分层循环执行模式

`execution_mode: hierarchical` 把执行控制权从自由运行的根 Agent 移到宿主状态机。知识雪球仍负责传承认知，但不再兼任任务计划、当前目标或完成声明。

## 循环层级

1. Goal Loop：保存用户原始目标、来源和 Definition of Done。
2. Requirement Loop：planner 一次建立稳定 R-ID 账本；每个 R-ID 对应一个可独立验收的结果。
3. Phase Loop：每个 R-ID 纵向经过 `investigate → prepare → implement → verify → close`，关闭后才进入下一个 dependency-ready R-ID。
4. Action Loop：宿主直接启动当前阶段角色；角色只获得本阶段的 prompt、Skill 契约和工具能力。
5. Recovery Loop：宿主按错误指纹只修复当前动作/工作单元；重复失败优先退回相邻内阶段自愈。相邻阶段成功后连续计数归零；同一错误跨自愈循环累计六次仍无法校正时升级为宿主故障，避免无限往返。

所有 R-ID 和工作单元 ID 都与知识 revision 解耦。知识更新只增加或校正事实，不会把 `knowledge-r59` 变成新的任务目标。
调查中发现遗漏的独立结果时，只能追加新的 R-ID，不能替换或重编号既有账本。

## 阶段交接与观察新鲜度

每个阶段在角色启动前就声明必填 handoff 契约，并把同一份 JSON Schema 交给 StructuredOutput。宿主只有在契约完整时才原子提交 `phase_artifact`、推进下一阶段；缺字段会留在当前阶段自愈，不能把不完整结果推给下一角色。

阶段输出被拒绝时，宿主会保留一份有界的结构化草稿和最近几条不同的拒绝原因，下一次角色直接在草稿上定向修正。这样后一个校验的修正不会重新引入前一个校验已经指出的问题，也不需要重新读取已完成的只读证据。第三方模型轻微拼错 `StructuredOutput` 工具名时，只要参数对象仍完整，宿主会恢复该对象并执行同一套语义校验，不会绕过阶段契约。

行为义务通过稳定 obligation ID、允许状态和 path:line 证据闭环。`observed_behavior` 用于描述最终代码观察，不与 `required_behavior` 做自然语言逐字相等；语义是否满足由独立 verify 根据代码证据判定，实质不符必须返回 fail。这样既保留目标、参数、guard 等冻结契约，也不会因同义改写回滚正确实现。

- investigate：确认事实、目标位置、相似实现、开放未知；
- prepare：调用契约、修改前行为、保留不变量、最小补丁计划、验证计划；
- implement：实际改动、diff 摘要、即时检查、已保留不变量；
- verify：验证摘要、回归检查、未解决风险和逐项 acceptance 结果。

交接物携带 `workspace_revision`。与当前工作区版本一致时标记 fresh，可复用语义结论，但不能跳过 Edit 的旧内容匹配或实时验证；代码提交后旧观察自动降为 historical，只能作为修改前基线。宿主不缓存原始文件内容或任意命令结果，最终 diff、语法检查和测试始终实时执行。

## 修改事务与自愈

prepare 签发规范化的项目相对文件租约。implement 启动前，宿主快照这些文件：

- 现有文件禁止整文件 Write，只能最小 Edit；Write 仅用于创建新文件；
- implement 失败、异常退出、删除既有文件或导致大文件异常缩减时，只恢复本工作单元开始前的快照；
- 快照包含此前已完成 R-ID 的累计修改，因此自愈不会恢复到 develop 或覆盖用户原有工作；
- 分支、HEAD、stash/reset/restore 属于 Goal 级工作区契约，叶子角色不得重复执行。

`prepare.call_contract.analyzed_targets` 只描述真实函数、方法、类或组件的调用契约，不要求和 `allowed_files` 一一对应。常量表、路由配置、静态数据和样式文件只进入 `allowed_files`、`patch_plan` 与修改前证据，避免为了满足文件覆盖而伪造手工符号分析。

只读阶段仍向 SDK 暴露受宿主门禁保护的 `Edit`/`Write` 名称。过早调用不会得到“工具不存在”，而会得到当前阶段应提交什么、何时自动进入 implement 的修正指引。Bash 写入同样按阶段返回下一步；分层角色调用旧 Profile 的任务树、checkpoint 或用 `ask_human` 申请内部工具时，宿主会原地引导回当前 handoff，不创建用户问题。

## 阶段角色与能力

| 阶段 | 角色 | 写权限 | 核心 Skill |
| --- | --- | --- | --- |
| align | task-planner | 无 | clarifying-requirements、exploring-codebase、task-decomposition |
| investigate | code-investigator | 无 | exploring-codebase |
| prepare | implementation-preparer | 无 | preserving-existing-behavior、investigating-call-contracts |
| implement | task-executor | 仅 prepare 签发的文件租约 | preserving-existing-behavior、safe-git-operations |
| verify | task-verifier | 无 | verification-before-completion |
| integrate | completeness-checker | 无 | verification-before-completion |

阶段角色不持有 `Task` 或 `ask_human` 工具。宿主根据 typed blocker 决定是否询问用户；只有 `user_decision` 和 `external_resource_missing` 且 owner 为 user 时可以提问。

## 完成条件

只有同时满足以下条件，会话才进入 `completed`：

- 稳定需求账本非空；
- 每个非 skipped R-ID 均已关闭；
- 每个验收项都有独立验证证据且状态为 PASS；
- 没有开放 blocker；
- 全局 completeness 审计通过并保存证据。

全局审计若发现某个已关闭 R-ID 仍有缺口，会把它退回 investigate/prepare，并使依赖它的已完成需求验收失效；不会原地重复审计。

## 工作流配置

```yaml
id: careful-coder
execution_mode: hierarchical
stages: []
```

不配置 `execution_mode` 的旧 Stage/Profile 工作流继续走原路径，便于逐步迁移和回滚。

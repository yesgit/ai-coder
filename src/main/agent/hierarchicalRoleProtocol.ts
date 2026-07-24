import type {
  AgentSession,
  HierarchicalExecutionState,
  HierarchicalRequirement,
  HierarchicalWorkPhase,
  WorkflowTemplate
} from "../../shared/types.js";
import type {
  HierarchicalEvent,
  HierarchicalNextOperation,
  KnowledgeDelta,
  PlannedRequirement
} from "../workflows/hierarchicalWorkflowEngine.js";
import { buildHierarchicalPlannerCoverageContract } from "../workflows/hierarchicalPlannerCoverage.js";

export interface HierarchicalRoleSpec {
  role: string;
  phaseLabel: string;
  tools: string[];
  requiredSkills: string[];
  prompt: string;
  outputFormat: { type: "json_schema"; schema: Record<string, unknown> };
}

export const REQUIRED_BEHAVIOR_DIMENSIONS = [
  "destination",
  "invocation",
  "arguments",
  "preconditions",
  "context",
  "side_effects"
] as const;

export function buildHierarchicalRoleSpec(
  session: AgentSession,
  workflow: WorkflowTemplate,
  operation: Extract<HierarchicalNextOperation, {
    kind: "run_alignment_batch" | "run_planner" | "run_phase" | "run_integrator"
  }>
): HierarchicalRoleSpec {
  const state = requireState(session);
  if (operation.kind === "run_alignment_batch") return buildAlignmentBatchSpec(session, state, operation);
  if (operation.kind === "run_planner") return buildPlannerSpec(session, workflow, state);
  if (operation.kind === "run_integrator") return buildIntegratorSpec(session, workflow, state);
  return buildPhaseSpec(session, workflow, state, operation);
}

export function parseHierarchicalRoleResult(
  operation: Extract<HierarchicalNextOperation, {
    kind: "run_alignment_batch" | "run_planner" | "run_phase" | "run_integrator"
  }>,
  value: unknown,
  now = new Date().toISOString()
): HierarchicalEvent[] {
  const result = parseResultObject(value);
  if (operation.kind === "run_alignment_batch") return parseAlignmentBatchResult(operation, result, now);
  if (operation.kind === "run_planner") return parsePlannerResult(result, now);
  if (operation.kind === "run_integrator") return parseIntegratorResult(result, now);
  return parsePhaseResult(operation, result, now);
}

function buildAlignmentBatchSpec(
  session: AgentSession,
  state: HierarchicalExecutionState,
  operation: Extract<HierarchicalNextOperation, { kind: "run_alignment_batch" }>
): HierarchicalRoleSpec {
  const role = "attachment-requirements-reader";
  return {
    role,
    phaseLabel: `align/${operation.batch_id}`,
    tools: ["Read"],
    requiredSkills: ["clarifying-requirements"],
    prompt: [
      baseRoleHeader(session, state, role, operation.source_refs),
      "## 当前循环栈",
      `${state.goal.id} > align > ${operation.batch_id} > attempt-${operation.attempt}`,
      "## 当前职责",
      `只摄取 ${operation.batch_id} 的附件内容，提炼候选需求事实；不要建立最终 R-ID，不要读取代码，不要修改任何文件。`,
      "一次只发起一个 Read，等待该结果返回后再读取下一个，严禁并行读取多个附件。",
      "Read.file_path 必须逐字复制本批次清单中的绝对路径，不得增删前缀、猜测路径、Glob、搜索或寻找替代副本。",
      "每项 finding 必须保留页码/序号/控件等可追溯 source_anchor，并写成可观察结果与独立验收断言。",
      "表格、清单或连续编号中的每个业务序号必须单独输出一个 finding；不得把一段编号范围内的多个独立条目合并成一条 finding。跨页续行保留相同业务序号并注明续页关系。",
      "没有独立需求的封面或上下文页可以只进入 summary；evidence_refs 必须列出实际读取的本批次路径。",
      "当前批次是整套附件的一小段。未出现用户指定序号、页面底部内容延续到下一批、或暂缺全局上下文，都不是 blocker；如实标注局部/待后续拼接并返回 passed。",
      "只有本批次文件实际无法读取时才返回 failed。附件摄取角色不得向用户提问或返回 blocked。",
      "不要先输出长篇叙述；读取完成后直接调用 StructuredOutput 提交精简结构化结果。"
    ].join("\n\n"),
    outputFormat: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["passed", "failed"] },
          summary: { type: "string" },
          evidence_refs: { type: "array", items: { type: "string" } },
          findings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                source_anchor: { type: "string" },
                observable_result: { type: "string" },
                acceptance: { type: "array", items: { type: "string" } }
              },
              required: ["source_anchor", "observable_result", "acceptance"],
              additionalProperties: false
            }
          },
          failure_reason: { type: "string" }
        },
        required: ["status", "summary", "evidence_refs", "findings"],
        additionalProperties: false
      }
    }
  };
}

function buildPlannerSpec(
  session: AgentSession,
  workflow: WorkflowTemplate,
  state: HierarchicalExecutionState
): HierarchicalRoleSpec {
  const role = "task-planner";
  const coverageContract = buildHierarchicalPlannerCoverageContract(session.task_prompt, state);
  const retry = state.planner_retry;
  return {
    role,
    phaseLabel: "align",
    tools: ["Read", "Grep", "Glob", "Bash"],
    requiredSkills: ["clarifying-requirements", "exploring-codebase", "task-decomposition"],
    prompt: [
      baseRoleHeader(session, state, role),
      `## 谨慎程序员心智\n${workflow.description}`,
      "## 宿主已归并的附件证据",
      ...(state.alignment_batches.length > 0
        ? state.alignment_batches.map(formatAlignmentBatchForPlanner)
        : ["- 本次没有落盘附件。"]),
      ...(coverageContract
        ? [
            "## 本轮输出契约（宿主在角色启动前公开，提交时将逐项校验）",
            `用户枚举范围起点：${coverageContract.scope_start}`,
            `requirements 必须分别覆盖这些业务序号：${coverageContract.required_sequences.join(", ")}`,
            "每个上述业务序号必须有独立、稳定的 R-ID；不得合并、遗漏，也不得用 blocked 绕过。",
            "同一序号在不同附件中解释冲突时，仍保留该序号的 R-ID，在 source_anchor 中并列冲突来源，把最终目标映射留给该 R-ID 的 investigate。"
          ]
        : []),
      ...(retry
        ? [
            "## 上次 planner 输出未通过宿主契约",
            `当前为第 ${retry.attempt} 次 planner 尝试。`,
            `宿主拒绝原因：${retry.failure_reason}`,
            "本次必须针对拒绝原因修复输出；这是结构化账本缺口，不是需要用户或宿主做业务选择的 blocker。",
            "若拒绝原因点名缺失序号，必须为每个点名序号补独立 R-ID，同时继续满足上方完整覆盖契约。不得再次以附件编号冲突为由省略或返回 blocked。"
          ]
        : []),
      "## 当前职责",
      "根据用户原始目标、宿主已归并的附件证据和必要代码证据，建立一次性、稳定的需求账本。",
      "附件摄取已经完成：禁止再次 Read 附件、禁止搜索附件替代路径；只可按需读取项目代码。",
      "先按文档中的业务序号跨批次拼接候选事实；附件页码和批次号不是业务序号。不得因早期批次尚未出现目标序号而提问，必须核对全部已归并批次。",
      "每个独立可验证结果必须拥有稳定 R-ID；不要创建‘读取需求’‘调用 planner’等过程任务。",
      "用户要求从某个序号开始时，逐项建立来源锚点；不得把全部页面压成一个笼统需求。",
      "证据摘要是可复核观察，不是高于用户原话的范围命令。范围冲突时以用户明确目标优先，并把附件备注作为 investigate 阶段需核对的证据。",
      "pageName 暂缺、跨页编号冲突或附件解释不一致时，仍应建立可观察需求和验收标准，把具体调用契约留给该 R-ID 的 investigate 内循环；不得返回 evidence_blocked。",
      "只有必须由用户选择且不同选择会实质改变目标，或外部必需资源确实缺失时才允许 blocked。宿主不是另一个业务决策角色，不要要求‘宿主澄清’。",
      "dependencies 只填写其他 R-ID。acceptance 必须是可观察、可独立验证的断言。",
      "用户指定‘从序号 N 开始’等枚举范围时，宿主会自动核对范围内实际出现的每个业务序号是否都有独立 R-ID；不要为范围外条目建立需求，也不要把范围内多个序号合并为一个需求。",
      "只负责规划，不修改工作区。"
    ].filter(Boolean).join("\n\n"),
    outputFormat: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["passed", "blocked", "failed"] },
          summary: { type: "string" },
          definition_of_done: { type: "array", items: { type: "string" } },
          requirements: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                source_anchor: { type: "string" },
                observable_result: { type: "string" },
                acceptance: { type: "array", items: { type: "string" } },
                dependencies: { type: "array", items: { type: "string" } }
              },
              required: ["id", "source_anchor", "observable_result", "acceptance", "dependencies"],
              additionalProperties: false
            }
          },
          blocker: plannerBlockerSchema()
        },
        required: ["status", "summary", "definition_of_done", "requirements"],
        additionalProperties: false
      }
    }
  };
}

function buildPhaseSpec(
  session: AgentSession,
  workflow: WorkflowTemplate,
  state: HierarchicalExecutionState,
  operation: Extract<HierarchicalNextOperation, { kind: "run_phase" }>
): HierarchicalRoleSpec {
  const requirement = requireRequirement(state, operation.requirement_id);
  const workUnit = state.active_work_unit!;
  const configuration = phaseConfiguration(operation.phase);
  const activeFacts = state.knowledge.facts.filter((fact) =>
    fact.status === "active"
    && (!fact.scope.requirement_id || fact.scope.requirement_id === requirement.id)
  );
  const openUnknowns = state.knowledge.unknowns.filter((unknown) =>
    unknown.status === "open"
    && (!unknown.scope.requirement_id || unknown.scope.requirement_id === requirement.id)
  );
  const acceptanceLines = requirement.acceptance.map((item) =>
    `- ${item.id}: ${item.criterion} [${item.status}]`
  );
  const priorArtifacts = state.phase_artifacts.filter((artifact) =>
    artifact.requirement_id === requirement.id
  );
  const phaseSpecific = phaseInstructions(operation.phase, requirement, workUnit.allowed_files);
  const correctionHistory = workUnit.correction_history ?? [];
  const hasCorrectionContext = workUnit.attempt > 1
    || Boolean(workUnit.failure_reason)
    || correctionHistory.length > 0
    || Boolean(workUnit.last_rejected_output);
  return {
    role: operation.role,
    phaseLabel: `${requirement.id}/${operation.phase}`,
    tools: configuration.tools,
    requiredSkills: configuration.skills,
    prompt: [
      baseRoleHeader(session, state, operation.role),
      `## 谨慎程序员心智\n${workflow.description}`,
      "## 当前循环栈",
      `${state.goal.id} > ${requirement.id} > ${operation.phase} > ${workUnit.id}`,
      ...(hasCorrectionContext
        ? [
            "## 当前阶段自愈重试",
            `这是 attempt ${workUnit.attempt}；上次未通过原因：${workUnit.failure_reason ?? "阶段交接契约未满足"}`,
            ...(correctionHistory.length > 0
              ? [
                  "宿主已累计的拒绝原因（后一次修正不能重新引入前一次错误）：",
                  ...correctionHistory.map((reason, index) => `${index + 1}. ${reason}`)
                ]
              : []),
            ...(workUnit.last_rejected_output
              ? [
                  "上次被拒绝的结构化草稿如下；复制后只修正被指出的字段，不要丢弃已完成调查：",
                  workUnit.last_rejected_output
                ]
              : []),
            "同一阶段已成功完成的只读工具证据仍由宿主保留。只修复列出的失败点；不要从头重读、不要提前实现、不要向用户申请阶段工具。"
          ]
        : []),
      "## 当前需求",
      `来源：${requirement.source_anchor}`,
      `可观察结果：${requirement.observable_result}`,
      "验收标准：",
      ...acceptanceLines,
      "## 当前 active 事实",
      ...(activeFacts.length > 0
        ? activeFacts.map((fact) => `- ${fact.id}: ${fact.claim}；证据 ${fact.evidence_refs.join(", ")}`)
        : ["- 暂无。"]),
      "## 当前开放未知",
      ...(openUnknowns.length > 0
        ? openUnknowns.map((unknown) => `- ${unknown.id}: ${unknown.question}`)
        : ["- 暂无。"]),
      "## 已验收的前序阶段交接物",
      ...(priorArtifacts.length > 0
        ? priorArtifacts.map((artifact) => formatPhaseArtifact(artifact, state.workspace_revision))
        : ["- 当前是该需求的首个阶段，暂无前序交接物。"]),
      "## 本阶段最终输出骨架（开始工作前即生效）",
      phaseOutputSkeleton(operation.phase),
      "最终只提交符合该骨架和 SDK JSON Schema 的结构化结果；不要等到工作完成后再猜字段嵌套。",
      "## 本阶段启动前已声明的交接契约",
      phaseHandoffContract(operation.phase),
      "只有满足上述全部字段和阶段出口检查，宿主才会原子提交交接物并启动下一角色；缺字段时留在当前阶段修补，不得把不完整信息推给下一角色。",
      "fresh 交接物是带工作区版本证明的观察复用，不是无条件缓存；historical 交接物只能作为修改前基线。",
      "## 本阶段职责与出口",
      phaseSpecific,
      "如果本阶段发现了原账本未覆盖、但完成 Goal 必需的独立可验证结果，只在 discovered_requirements 中追加新的稳定 R-ID；不要捎带执行。",
      "代码事实、文件/组件存在、调用契约前置条件和当前 R-ID 的验收细节都不是新需求，必须写入 summary/knowledge_delta，不得创建形如当前 R-ID-A1 的 discovered_requirement。dependencies 只能填写账本中的 R-ID，严禁填写自然语言事实或文件路径。",
      "只完成当前叶子工作，不修改总体目标、不处理其他 R-ID、不自行宣布整体完成。"
    ].filter(Boolean).join("\n\n"),
    outputFormat: phaseOutputFormat(operation.phase, requirement)
  };
}

function buildIntegratorSpec(
  session: AgentSession,
  workflow: WorkflowTemplate,
  state: HierarchicalExecutionState
): HierarchicalRoleSpec {
  const role = "completeness-checker";
  return {
    role,
    phaseLabel: "integrate",
    tools: ["Read", "Grep", "Glob", "Bash"],
    requiredSkills: ["verification-before-completion"],
    prompt: [
      baseRoleHeader(session, state, role),
      `## 谨慎程序员心智\n${workflow.description}`,
      "## 当前职责",
      "对照用户原始目标、稳定需求账本、每个验收项的证据、最终 diff 和真实验证输出进行全局审计。",
      "任何 R-ID 或验收项缺少证据都必须返回 failed；不得用总体测试替代逐项核对。",
      "每个 R-ID 的 prepare 行为义务和 verify 契约结果也是 Definition of Done；目标、调用方式、参数、guard、上下文或副作用任一不一致都必须失败，不能临时解释成‘备选方式’。",
      "passed 时必须基于最终工作区重新提交 contract_results，逐项覆盖所有 R-ID 的全部行为义务；不能复用较早 workspace_revision 的 verify 结论。",
      `Definition of Done：${state.goal.definition_of_done.join("；") || "以用户原始目标和逐项验收为准"}`,
      "failed 时必须指出一个应重开的已完成 R-ID，并选择 investigate 或 prepare；宿主会恢复该需求内循环。",
      "## 需求账本",
      ...state.requirements.map(formatRequirementForAudit),
      "## 冻结行为契约与独立验证结果",
      ...state.requirements.map((requirement) => formatBehaviorContractForAudit(state, requirement.id))
    ].filter(Boolean).join("\n\n"),
    outputFormat: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["passed", "failed"] },
          summary: { type: "string" },
          evidence_refs: { type: "array", items: { type: "string" } },
          contract_results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                requirement_id: { type: "string" },
                obligation_id: { type: "string" },
                status: { type: "string", enum: ["pass", "fail"] },
                observed_behavior: { type: "string" },
                evidence_refs: { type: "array", items: { type: "string" } }
              },
              required: [
                "requirement_id",
                "obligation_id",
                "status",
                "observed_behavior",
                "evidence_refs"
              ],
              additionalProperties: false
            }
          },
          failure_reason: { type: "string" },
          rework_requirement_id: { type: "string" },
          failure_route: { type: "string", enum: ["investigate", "prepare"] }
        },
        required: ["status", "summary", "evidence_refs", "contract_results"],
        additionalProperties: false
      }
    }
  };
}

function parseAlignmentBatchResult(
  operation: Extract<HierarchicalNextOperation, { kind: "run_alignment_batch" }>,
  result: Record<string, unknown>,
  now: string
): HierarchicalEvent[] {
  const status = requiredString(result.status, "alignment.status");
  if (status === "failed") {
    throw new Error(requiredString(result.failure_reason ?? result.summary, "alignment.failure_reason"));
  }
  // 兼容少数模型无视 JSON enum 仍返回 blocked：摄取批次只有局部视野，不能据此
  // 把全局序号/跨页截断升级为人类问题。只要证据和 findings 可解析，就按局部摘要落盘。
  if (status !== "passed" && status !== "blocked") throw new Error(`未知附件摄取状态：${status}`);
  const findings = requiredArray(result.findings, "alignment.findings").map((item, index) => {
    const finding = requiredRecord(item, `alignment.findings[${index}]`);
    return {
      source_anchor: requiredString(finding.source_anchor, `alignment.findings[${index}].source_anchor`),
      observable_result: requiredString(
        finding.observable_result,
        `alignment.findings[${index}].observable_result`
      ),
      acceptance: stringArray(finding.acceptance, `alignment.findings[${index}].acceptance`)
    };
  });
  return [{
    type: "alignment_batch_passed",
    batch_id: operation.batch_id,
    summary: requiredString(result.summary, "alignment.summary"),
    findings,
    evidence_refs: stringArray(result.evidence_refs, "alignment.evidence_refs"),
    occurred_at: now
  }];
}

function parsePlannerResult(result: Record<string, unknown>, now: string): HierarchicalEvent[] {
  const status = requiredString(result.status, "planner.status");
  if (status === "blocked") {
    const blocker = requiredRecord(result.blocker, "planner.blocker");
    const blockerKind = requiredString(blocker.kind, "planner.blocker.kind");
    if (blockerKind === "evidence_blocked") {
      // 兼容模型仍把可调查的证据冲突误报为内部阻塞：只要账本已经形成，
      // 宿主接受账本并把未知留给各 R-ID 的 investigate，而不是终止整个 Goal。
      const requirements = parsePlannedRequirements(result.requirements, "planner.requirements");
      return [{
        type: "plan_accepted",
        requirements,
        definition_of_done: stringArray(result.definition_of_done, "planner.definition_of_done"),
        occurred_at: now
      }];
    }
    return [blockerEvent(result.blocker, now)];
  }
  if (status === "failed") throw new Error(requiredString(result.summary, "planner.summary"));
  if (status !== "passed") throw new Error(`未知 planner 状态：${status}`);
  const requirements = parsePlannedRequirements(result.requirements, "planner.requirements");
  return [{
    type: "plan_accepted",
    requirements,
    definition_of_done: stringArray(result.definition_of_done, "planner.definition_of_done"),
    occurred_at: now
  }];
}

function parsePhaseResult(
  operation: Extract<HierarchicalNextOperation, { kind: "run_phase" }>,
  result: Record<string, unknown>,
  now: string
): HierarchicalEvent[] {
  const status = requiredString(result.status, "phase.status");
  const events: HierarchicalEvent[] = [];
  if (result.discovered_requirements !== undefined) {
    // discovered_requirements 是阶段的可选附带产物，不能让一个本来已经 passed 的
    // 主阶段因模型把“组件存在”之类代码事实误填成依赖而整体失败。只接受语法上确实
    // 是新 R-ID 的条目；状态机仍会对保留下来的跨需求依赖做完整 DAG 校验。
    const discovered = parsePlannedRequirements(result.discovered_requirements, "phase.discovered_requirements")
      .filter((requirement) => isEligibleDiscoveredRequirement(requirement, operation.requirement_id));
    if (discovered.length > 0) {
      events.push({ type: "requirements_appended", requirements: discovered, occurred_at: now });
    }
  }
  if (result.knowledge_delta !== undefined) {
    events.push({
      type: "knowledge_delta_committed",
      delta: result.knowledge_delta as KnowledgeDelta,
      occurred_at: now
    });
  }
  if (status === "blocked") {
    const blocker = requiredRecord(result.blocker, "phase.blocker");
    if (requiredString(blocker.kind, "phase.blocker.kind") === "evidence_blocked") {
      throw new Error([
        "当前阶段把可继续调查的证据冲突误报为 evidence_blocked。",
        "命名、大小写、缩写、附件 OCR、跨页编号或代码别名冲突必须保留原始 token，",
        "再用定义、消费者、调用点和同类实现建立映射；仍未闭合时返回 failed/retry 或写入 open_unknowns，不能终止 Goal。"
      ].join(""));
    }
    events.push(blockerEvent(result.blocker, now, operation.requirement_id, operation.work_unit_id));
    events.push({
      type: "phase_failed",
      work_unit_id: operation.work_unit_id,
      reason: requiredString(result.summary, "phase.summary"),
      route: "blocked",
      occurred_at: now
    });
    return events;
  }
  if (status === "failed") {
    events.push({
      type: "phase_failed",
      work_unit_id: operation.work_unit_id,
      reason: requiredString(result.failure_reason ?? result.summary, "phase.failure_reason"),
      route: phaseFailureRoute(result.failure_route),
      occurred_at: now
    });
    return events;
  }
  if (status !== "passed") throw new Error(`未知阶段状态：${status}`);
  const handoff = requiredRecord(result.handoff, "phase.handoff");
  validatePhaseHandoffSemantics(operation.phase, handoff);
  if (operation.phase === "prepare") {
    const allowedFiles = result.allowed_files === undefined
      ? []
      : stringArray(result.allowed_files, "phase.allowed_files");
    const disposition = requiredString(handoff.change_disposition, "handoff.change_disposition");
    if (disposition === "changes_required" && allowedFiles.length === 0) {
      throw new Error("prepare 判定需要修改时必须提前签发非空 allowed_files");
    }
    if (disposition === "already_satisfied" && allowedFiles.length > 0) {
      throw new Error("prepare 判定 already_satisfied 时 allowed_files 必须为空；宿主将直接进入独立验证");
    }
  }
  events.push({
    type: "phase_passed",
    work_unit_id: operation.work_unit_id,
    summary: requiredString(result.summary, "phase.summary"),
    handoff,
    evidence_refs: stringArray(result.evidence_refs, "phase.evidence_refs"),
    ...(result.allowed_files !== undefined
      ? { allowed_files: stringArray(result.allowed_files, "phase.allowed_files") }
      : {}),
    ...(result.acceptance_results !== undefined
      ? {
          acceptance_results: requiredArray(result.acceptance_results, "phase.acceptance_results").map((item, index) => {
            const value = requiredRecord(item, `acceptance_results[${index}]`);
            const acceptanceStatus = requiredString(value.status, `acceptance_results[${index}].status`);
            if (acceptanceStatus !== "pass" && acceptanceStatus !== "fail") {
              throw new Error(`非法验收状态：${acceptanceStatus}`);
            }
            return {
              acceptance_id: requiredString(value.acceptance_id, `acceptance_results[${index}].acceptance_id`),
              status: acceptanceStatus,
              evidence_refs: stringArray(value.evidence_refs, `acceptance_results[${index}].evidence_refs`)
            };
          })
        }
      : {}),
    occurred_at: now
  });
  return events;
}

function validatePhaseHandoffSemantics(
  phase: Exclude<HierarchicalWorkPhase, "close">,
  handoff: Record<string, unknown>
): void {
  if (phase === "investigate") {
    const target = requiredRecord(handoff.target_investigation, "handoff.target_investigation");
    for (const field of ["inputs", "outputs", "internal_calls", "guards", "state_and_side_effects", "callers"] as const) {
      requireNonEmptyStringArray(target[field], `handoff.target_investigation.${field}`);
    }
    requirePathLineEvidence(target.evidence_refs, "handoff.target_investigation.evidence_refs");

    const reference = requiredRecord(handoff.reference_analysis, "handoff.reference_analysis");
    requireNonEmptyStringArray(reference.search_scope, "handoff.reference_analysis.search_scope");
    const candidates = requiredArray(reference.candidates, "handoff.reference_analysis.candidates")
      .map((item, index) => requiredRecord(item, `handoff.reference_analysis.candidates[${index}]`));
    if (candidates.length === 0) {
      const noReferenceReason = typeof reference.no_reference_reason === "string"
        ? reference.no_reference_reason.trim()
        : "";
      if (!noReferenceReason) {
        throw new Error("未找到同类实现时必须说明 no_reference_reason 和已搜索范围");
      }
      return;
    }
    const selected = requiredString(reference.selected_location, "handoff.reference_analysis.selected_location").trim();
    if (!selected) throw new Error("存在同类实现候选时必须选择 selected_location");
    if (!requiredString(reference.selection_reason, "handoff.reference_analysis.selection_reason").trim()) {
      throw new Error("存在同类实现候选时必须说明 selection_reason");
    }
    const candidateLocations = candidates.map((candidate, index) => {
      if (requiredString(
        candidate.reference_kind,
        `handoff.reference_analysis.candidates[${index}].reference_kind`
      ) !== "same-feature-entry") {
        throw new Error("同类实现候选必须是同一业务功能的既有用户入口，不能只选外形相似的兄弟分支");
      }
      requireNonEmptyStringArray(
        candidate.feature_equivalence,
        `handoff.reference_analysis.candidates[${index}].feature_equivalence`
      );
      requireNonEmptyStringArray(candidate.similarity, `handoff.reference_analysis.candidates[${index}].similarity`);
      requireNonEmptyStringArray(candidate.reusable_behavior, `handoff.reference_analysis.candidates[${index}].reusable_behavior`);
      requireNonEmptyStringArray(candidate.differences, `handoff.reference_analysis.candidates[${index}].differences`);
      for (const field of [
        "arguments",
        "preconditions",
        "context_forwarding",
        "side_effects"
      ] as const) {
        requireNonEmptyStringArray(
          candidate[field],
          `handoff.reference_analysis.candidates[${index}].${field}`
        );
      }
      requiredString(candidate.destination, `handoff.reference_analysis.candidates[${index}].destination`);
      requiredString(candidate.invocation, `handoff.reference_analysis.candidates[${index}].invocation`);
      requirePathLineEvidence(candidate.evidence_refs, `handoff.reference_analysis.candidates[${index}].evidence_refs`);
      return requiredString(candidate.location, `handoff.reference_analysis.candidates[${index}].location`);
    });
    if (!candidateLocations.includes(selected)) {
      throw new Error("selected_location 必须对应 reference_analysis.candidates 中的一个候选");
    }
    const targetDefinition = firstPathLineToken(requiredString(target.definition, "handoff.target_investigation.definition"));
    const selectedDefinition = firstPathLineToken(selected);
    if (targetDefinition && selectedDefinition && targetDefinition === selectedDefinition) {
      throw new Error("不得把当前待实现代码本身冒充同功能既有入口");
    }
    return;
  }

  if (phase === "implement") {
    validateObligationResults(
      handoff.obligation_results,
      "handoff.obligation_results",
      ["applied", "already-satisfied"]
    );
    return;
  }
  if (phase === "verify") {
    validateObligationResults(
      handoff.contract_results,
      "handoff.contract_results",
      ["pass", "fail"]
    );
    return;
  }
  if (phase !== "prepare") return;
  const callContract = requiredRecord(handoff.call_contract, "handoff.call_contract");
  const targets = requiredArray(callContract.analyzed_targets, "handoff.call_contract.analyzed_targets")
    .map((item, index) => requiredRecord(item, `handoff.call_contract.analyzed_targets[${index}]`));
  if (targets.length === 0) throw new Error("prepare 至少需要一个完整调查的目标函数或组件");
  const requiredSections = new Set(["contract", "calls", "wrappers", "references"]);
  targets.forEach((target, index) => {
    const prefix = `handoff.call_contract.analyzed_targets[${index}]`;
    const method = requiredString(target.analysis_method, `${prefix}.analysis_method`);
    for (const field of [
      "inputs",
      "outputs",
      "callers",
      "wrappers_and_indirect_references",
      "guards",
      "state_and_side_effects",
      "compatibility_obligations"
    ] as const) {
      requireNonEmptyStringArray(target[field], `${prefix}.${field}`);
    }
    requirePathLineEvidence(target.evidence_refs, `${prefix}.evidence_refs`);
    if (method === "symbol-analyzer") {
      const sections = new Set(stringArray(target.analyzer_sections, `${prefix}.analyzer_sections`));
      const missing = [...requiredSections].filter((section) => !sections.has(section));
      if (missing.length > 0 || target.all_pages_consumed !== true) {
        throw new Error(`${prefix} 的符号分析不完整：缺少 ${missing.join(", ") || "完整分页证明"}`);
      }
    } else if (method === "manual-static-analysis") {
      if (!requiredString(target.method_reason, `${prefix}.method_reason`).trim()) {
        throw new Error(`${prefix} 使用手工静态分析时必须说明分析器不适用原因`);
      }
    } else {
      throw new Error(`${prefix}.analysis_method 非法：${method}`);
    }
  });
  const applications = requiredArray(handoff.reference_application, "handoff.reference_application");
  if (applications.length === 0) throw new Error("prepare 必须说明同类实现如何应用到当前改动");
  const disposition = requiredString(handoff.change_disposition, "handoff.change_disposition");
  if (disposition !== "changes_required" && disposition !== "already_satisfied") {
    throw new Error(`handoff.change_disposition 非法：${disposition}`);
  }
  requireNonEmptyStringArray(handoff.satisfaction_evidence, "handoff.satisfaction_evidence");
  validateBehaviorObligations(handoff.behavior_obligations, "handoff.behavior_obligations");
}

function validateBehaviorObligations(value: unknown, label: string): string[] {
  const obligations = requiredArray(value, label)
    .map((item, index) => requiredRecord(item, `${label}[${index}]`));
  const ids = new Set<string>();
  const dimensions = new Set<string>();
  obligations.forEach((obligation, index) => {
    const prefix = `${label}[${index}]`;
    const id = requiredString(obligation.id, `${prefix}.id`);
    if (ids.has(id)) throw new Error(`${label} 的 obligation id 重复：${id}`);
    ids.add(id);
    const dimension = requiredString(obligation.dimension, `${prefix}.dimension`);
    if (!REQUIRED_BEHAVIOR_DIMENSIONS.includes(dimension as typeof REQUIRED_BEHAVIOR_DIMENSIONS[number])) {
      throw new Error(`${prefix}.dimension 非法：${dimension}`);
    }
    if (dimensions.has(dimension)) throw new Error(`${label} 的行为维度重复：${dimension}`);
    dimensions.add(dimension);
    requiredString(obligation.reference_behavior, `${prefix}.reference_behavior`);
    requiredString(obligation.required_behavior, `${prefix}.required_behavior`);
    const decision = requiredString(obligation.decision, `${prefix}.decision`);
    if (!["reuse", "intentional-difference", "not-applicable"].includes(decision)) {
      throw new Error(`${prefix}.decision 非法：${decision}`);
    }
    if (decision === "intentional-difference" && !requiredString(obligation.reason, `${prefix}.reason`).trim()) {
      throw new Error(`${prefix} 的 intentional-difference 必须说明用户需求或代码架构依据`);
    }
    requirePathLineEvidence(obligation.evidence_refs, `${prefix}.evidence_refs`);
  });
  const missing = REQUIRED_BEHAVIOR_DIMENSIONS.filter((dimension) => !dimensions.has(dimension));
  if (missing.length > 0) throw new Error(`${label} 缺少行为维度：${missing.join(", ")}`);
  return [...ids];
}

function validateObligationResults(
  value: unknown,
  label: string,
  allowedStatuses: readonly string[]
): void {
  const results = requiredArray(value, label);
  if (results.length === 0) throw new Error(`${label} 必须逐项关闭 prepare 行为义务`);
  const ids = new Set<string>();
  results.forEach((item, index) => {
    const result = requiredRecord(item, `${label}[${index}]`);
    const id = requiredString(result.obligation_id, `${label}[${index}].obligation_id`);
    if (ids.has(id)) throw new Error(`${label} 的 obligation_id 重复：${id}`);
    ids.add(id);
    const status = requiredString(result.status, `${label}[${index}].status`);
    if (!allowedStatuses.includes(status)) {
      throw new Error(`${label}[${index}].status 非法：${status}`);
    }
    requiredString(result.observed_behavior, `${label}[${index}].observed_behavior`);
    requirePathLineEvidence(result.evidence_refs, `${label}[${index}].evidence_refs`);
  });
}

function requireNonEmptyStringArray(value: unknown, label: string): string[] {
  const items = stringArray(value, label).map((item) => item.trim()).filter(Boolean);
  if (items.length === 0) throw new Error(`${label} 必须至少包含一项；不存在时也要明确写明‘无’及证据`);
  return items;
}

function requirePathLineEvidence(value: unknown, label: string): void {
  const evidence = requireNonEmptyStringArray(value, label);
  if (!evidence.some((item) => /(?:^|\s|\()\S+\.[A-Za-z0-9]+:\d+/.test(item))) {
    throw new Error(`${label} 必须包含至少一条 path:line 代码证据`);
  }
}

function firstPathLineToken(value: string): string | null {
  return value.match(/(?:^|\s|\()(\S+\.[A-Za-z0-9]+:\d+)/)?.[1] ?? null;
}

function parseIntegratorResult(result: Record<string, unknown>, now: string): HierarchicalEvent[] {
  const status = requiredString(result.status, "integrator.status");
  if (status === "passed") {
    const contractResults = requiredArray(result.contract_results, "integrator.contract_results")
      .map((item, index) => {
        const value = requiredRecord(item, `integrator.contract_results[${index}]`);
        const resultStatus = requiredString(value.status, `integrator.contract_results[${index}].status`);
        if (resultStatus !== "pass" && resultStatus !== "fail") {
          throw new Error(`integrator.contract_results[${index}].status 非法：${resultStatus}`);
        }
        requirePathLineEvidence(
          value.evidence_refs,
          `integrator.contract_results[${index}].evidence_refs`
        );
        return {
          requirement_id: requiredString(
            value.requirement_id,
            `integrator.contract_results[${index}].requirement_id`
          ),
          obligation_id: requiredString(
            value.obligation_id,
            `integrator.contract_results[${index}].obligation_id`
          ),
          status: resultStatus as "pass" | "fail",
          observed_behavior: requiredString(
            value.observed_behavior,
            `integrator.contract_results[${index}].observed_behavior`
          ),
          evidence_refs: stringArray(
            value.evidence_refs,
            `integrator.contract_results[${index}].evidence_refs`
          )
        };
      });
    return [{
      type: "integration_passed",
      evidence_refs: stringArray(result.evidence_refs, "integrator.evidence_refs"),
      contract_results: contractResults,
      occurred_at: now
    }];
  }
  if (status === "failed") {
    return [{
      type: "integration_failed",
      reason: requiredString(result.failure_reason ?? result.summary, "integrator.failure_reason"),
      requirement_id: requiredString(result.rework_requirement_id, "integrator.rework_requirement_id"),
      route: integrationFailureRoute(result.failure_route),
      occurred_at: now
    }];
  }
  throw new Error(`未知 integrator 状态：${status}`);
}

function phaseConfiguration(phase: Exclude<HierarchicalWorkPhase, "close">): {
  tools: string[];
  skills: string[];
} {
  switch (phase) {
    case "investigate":
      return { tools: ["Read", "Grep", "Glob", "Bash"], skills: ["exploring-codebase"] };
    case "prepare":
      return {
        tools: ["Read", "Grep", "Glob", "Bash", "mcp__ai_coder__analyze_symbol_contract"],
        skills: ["preserving-existing-behavior", "investigating-call-contracts"]
      };
    case "implement":
      return {
        tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
        skills: ["preserving-existing-behavior", "safe-git-operations"]
      };
    case "verify":
      return { tools: ["Read", "Grep", "Glob", "Bash"], skills: ["verification-before-completion"] };
  }
}

function phaseInstructions(
  phase: Extract<HierarchicalNextOperation, { kind: "run_phase" }>["phase"],
  requirement: HierarchicalRequirement,
  allowedFiles: string[]
): string {
  switch (phase) {
    case "investigate":
      return [
        "只读取证：定位目标代码、最相似既有实现、真实调用方和关键未知。",
        "目标函数/组件必须逐项调查定义、输入、输出、内部调用、guard、状态/副作用和调用方；某项不存在也要用证据明确写‘无’，不得省略。",
        "同类实现不是外形相似的路由分支。必须优先找到应用内进入同一业务功能的既有用户入口，沿该入口追到最终组件/函数，并记录目标、调用方式、完整参数、guard、上下文透传和副作用。",
        "每个候选都必须证明 feature_equivalence，并提交完整行为指纹；不得拿当前待实现分支、刚新增代码或仅同属导航模块的兄弟分支冒充同功能参考。",
        "同功能入口必须先列候选再选择：记录搜索范围、相似依据、可复用行为和差异；确无同功能入口时写明搜索范围与未找到原因。",
        "附件 token 与代码名称存在大小写、缩写、OCR、历史错拼或编号冲突时，保留附件原词并建立‘原词 → 候选 → 代码 canonical symbol’映射；定义、配置消费者、调用点和同类实现能够收敛时直接记录校正，不得要求用户确认命名差异。",
        "只有不同候选会产生不同的用户可观察行为且仓库证据无法裁决时，才允许 status=blocked + user_decision；外部必需资源确实缺失时可用 external_resource_missing。evidence_blocked 不属于允许的阶段出口，会被宿主退回自愈。",
        "通过时 target_investigation 和每个参考候选都必须包含 path:line 证据。"
      ].join("\n");
    case "prepare":
      return [
        "只读取证：建立调用契约、pre-behavior、修改处置和验证入口。需要修改时必须返回非空 allowed_files；完整契约已满足时走有证据的 no-op。",
        "对每个将调用、复用或修改的既有函数/组件，优先使用 analyze_symbol_contract，并完整覆盖 contract、calls、wrappers、references 及全部分页。",
        "analyzed_targets 只登记函数、方法、类或组件等真实调用契约目标；常量表、路由配置对象、静态数据和样式文件即使列入 allowed_files，也不要为了凑文件覆盖伪造符号契约目标。",
        "如果真实调用契约目标不受分析器支持，才改为 manual-static-analysis，说明原因并用 path:line 补齐同样的契约维度。纯静态配置改动直接写入 patch_plan、pre_behavior 和 allowed_files。",
        "必须把 investigate 选中的同功能入口落实为 reference_application，并生成恰好六类稳定 behavior_obligations：destination、invocation、arguments、preconditions、context、side_effects。",
        "默认逐维度复用同功能入口。任何 intentional-difference 都必须引用用户要求或既有架构证据；不能以‘当前代码已经这样写’作为差异依据。",
        "若六类义务已全部满足，返回 change_disposition=already_satisfied、空 allowed_files 和逐项 satisfaction_evidence，宿主将跳过 implement 直接独立验证；否则返回 changes_required 和非空 allowed_files。",
        "prepare 是只读阶段，不需要 Edit。提交合格 handoff 后宿主会自动进入 implement 并授予 allowed_files 的 Edit 权限；不得改用 Bash 写文件，也不得要求用户启用内部工具。"
      ].join("\n");
    case "implement":
      return [
        "执行最小修改并取得真实 diff；不得处理其他需求点。",
        `允许修改文件：${allowedFiles.length > 0 ? allowedFiles.join(", ") : "未准备——应返回 blocked"}`,
        "必须逐项落实 prepare 冻结的 behavior_obligations，并在 obligation_results 中用相同 ID 提交 observed_behavior 和代码证据；observed_behavior 必须与冻结的 required_behavior 精确一致，不得更换目标、参数、guard 或同功能参考。",
        "必须实际运行至少一条与本改动相关的验证或语法/diff 检查，并在 evidence_refs 中引用。"
      ].join("\n");
    case "verify":
      return [
        "只读独立核对，不信任 executor 自述。",
        `必须返回 ${requirement.acceptance.length} 条 acceptance_results，逐项 PASS/FAIL 并附证据。`,
        "还必须逐项核对 prepare 冻结的全部 behavior_obligations，contract_results 的 ID 必须完整一致，observed_behavior 必须逐字复述最终代码实际行为；verifier 不得现场发明‘备选方案’或新的 intentional-difference。",
        "任何一项无法确认都返回 failed，并选择回 implement、prepare 或 investigate。"
      ].join("\n");
  }
}

function phaseOutputFormat(
  phase: Extract<HierarchicalNextOperation, { kind: "run_phase" }>["phase"],
  requirement: HierarchicalRequirement
): HierarchicalRoleSpec["outputFormat"] {
  const properties: Record<string, unknown> = {
    status: { type: "string", enum: ["passed", "blocked", "failed"] },
    summary: { type: "string" },
    evidence_refs: { type: "array", items: { type: "string" } },
    failure_reason: { type: "string" },
    failure_route: { type: "string", enum: ["retry", "investigate", "prepare", "implement"] },
    blocker: userResolvableBlockerSchema(),
    knowledge_delta: { type: "object", additionalProperties: true },
    handoff: phaseHandoffSchema(phase),
    discovered_requirements: {
      type: "array",
      items: plannedRequirementSchema(requirement.id)
    }
  };
  if (phase === "prepare") properties.allowed_files = { type: "array", items: { type: "string" } };
  if (phase === "verify") {
    properties.acceptance_results = {
      type: "array",
      minItems: requirement.acceptance.length,
      maxItems: requirement.acceptance.length,
      items: {
        type: "object",
        properties: {
          acceptance_id: { type: "string" },
          status: { type: "string", enum: ["pass", "fail"] },
          evidence_refs: { type: "array", items: { type: "string" } }
        },
        required: ["acceptance_id", "status", "evidence_refs"],
        additionalProperties: false
      }
    };
  }
  return {
    type: "json_schema",
    schema: {
      type: "object",
      properties,
      required: ["status", "summary", "evidence_refs", "handoff"],
      additionalProperties: false
    }
  };
}

function phaseHandoffSchema(
  phase: Extract<HierarchicalNextOperation, { kind: "run_phase" }>["phase"]
): Record<string, unknown> {
  const stringList = (minItems = 0): Record<string, unknown> => ({
    type: "array",
    minItems,
    items: { type: "string", minLength: 1 }
  });
  const evidenceList = (): Record<string, unknown> => stringList(1);
  const referenceCandidateSchema = strictObjectSchema({
    reference_kind: { type: "string", enum: ["same-feature-entry"] },
    location: { type: "string", minLength: 1 },
    feature_equivalence: stringList(1),
    similarity: stringList(1),
    reusable_behavior: stringList(1),
    differences: stringList(1),
    destination: { type: "string", minLength: 1 },
    invocation: { type: "string", minLength: 1 },
    arguments: stringList(1),
    preconditions: stringList(1),
    context_forwarding: stringList(1),
    side_effects: stringList(1),
    evidence_refs: evidenceList()
  });
  const analyzedTargetSchema = strictObjectSchema({
    target_file: { type: "string", minLength: 1 },
    symbol: { type: "string", minLength: 1 },
    analysis_method: { type: "string", enum: ["symbol-analyzer", "manual-static-analysis"] },
    method_reason: { type: "string" },
    analyzer_sections: stringList(),
    all_pages_consumed: { type: "boolean" },
    definition: { type: "string", minLength: 1 },
    inputs: stringList(1),
    outputs: stringList(1),
    callers: stringList(1),
    wrappers_and_indirect_references: stringList(1),
    guards: stringList(1),
    state_and_side_effects: stringList(1),
    compatibility_obligations: stringList(1),
    unresolved: stringList(),
    evidence_refs: evidenceList()
  });
  const behaviorObligationSchema = strictObjectSchema({
    id: { type: "string", pattern: "^B[A-Za-z0-9._-]+$" },
    dimension: { type: "string", enum: [...REQUIRED_BEHAVIOR_DIMENSIONS] },
    reference_behavior: { type: "string", minLength: 1 },
    required_behavior: { type: "string", minLength: 1 },
    decision: { type: "string", enum: ["reuse", "intentional-difference", "not-applicable"] },
    reason: { type: "string" },
    evidence_refs: evidenceList()
  });
  const obligationResultSchema = (statuses: string[]): Record<string, unknown> => strictObjectSchema({
    obligation_id: { type: "string", pattern: "^B[A-Za-z0-9._-]+$" },
    status: { type: "string", enum: statuses },
    observed_behavior: { type: "string", minLength: 1 },
    evidence_refs: evidenceList()
  });
  switch (phase) {
    case "investigate":
      return strictObjectSchema({
        confirmed_facts: stringList(1),
        target_locations: stringList(1),
        target_investigation: strictObjectSchema({
          target_kind: { type: "string", minLength: 1 },
          definition: { type: "string", minLength: 1 },
          inputs: stringList(1),
          outputs: stringList(1),
          internal_calls: stringList(1),
          guards: stringList(1),
          state_and_side_effects: stringList(1),
          callers: stringList(1),
          evidence_refs: evidenceList(),
          unresolved: stringList()
        }),
        reference_analysis: strictObjectSchema({
          search_scope: stringList(1),
          candidates: {
            type: "array",
            items: referenceCandidateSchema
          },
          selected_location: { type: "string" },
          selection_reason: { type: "string" },
          no_reference_reason: { type: "string" }
        }),
        open_unknowns: stringList()
      });
    case "prepare":
      return strictObjectSchema({
        call_contract: strictObjectSchema({
          analyzed_targets: {
            type: "array",
            minItems: 1,
            items: analyzedTargetSchema
          }
        }),
        reference_application: {
          type: "array",
          minItems: 1,
          items: strictObjectSchema({
            dimension: { type: "string", minLength: 1 },
            target_behavior: { type: "string", minLength: 1 },
            reference_behavior: { type: "string", minLength: 1 },
            decision: { type: "string", enum: ["reuse", "intentional-difference", "not-applicable"] },
            reason: { type: "string", minLength: 1 },
            evidence_refs: evidenceList()
          })
        },
        behavior_obligations: {
          type: "array",
          minItems: REQUIRED_BEHAVIOR_DIMENSIONS.length,
          maxItems: REQUIRED_BEHAVIOR_DIMENSIONS.length,
          items: behaviorObligationSchema
        },
        change_disposition: {
          type: "string",
          enum: ["changes_required", "already_satisfied"]
        },
        satisfaction_evidence: stringList(1),
        pre_behavior: stringList(1),
        preserve_invariants: stringList(1),
        patch_plan: stringList(1),
        verification_plan: stringList(1)
      });
    case "implement":
      return strictObjectSchema({
        changes: stringList(1),
        diff_summary: { type: "string", minLength: 1 },
        checks_run: stringList(1),
        preserved_invariants: stringList(1),
        obligation_results: {
          type: "array",
          minItems: REQUIRED_BEHAVIOR_DIMENSIONS.length,
          items: obligationResultSchema(["applied", "already-satisfied"])
        }
      });
    case "verify":
      return strictObjectSchema({
        verification_summary: { type: "string", minLength: 1 },
        regression_checks: stringList(1),
        unresolved_risks: stringList(),
        contract_results: {
          type: "array",
          minItems: REQUIRED_BEHAVIOR_DIMENSIONS.length,
          items: obligationResultSchema(["pass", "fail"])
        }
      });
  }
}

function strictObjectSchema(properties: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false
  };
}

function phaseHandoffContract(
  phase: Extract<HierarchicalNextOperation, { kind: "run_phase" }>["phase"]
): string {
  switch (phase) {
    case "investigate":
      return "必须提交 confirmed_facts、target_locations、target_investigation、reference_analysis、open_unknowns；同类参考必须是同一业务功能的既有入口，并覆盖目标、调用方式、参数、前置条件、上下文和副作用。";
    case "prepare":
      return "必须提交结构化 call_contract、reference_application、六类 behavior_obligations、change_disposition、satisfaction_evidence、pre_behavior、preserve_invariants、patch_plan、verification_plan；changes_required 另行提交非空 allowed_files，already_satisfied 提交空数组。";
    case "implement":
      return "必须提交 changes、diff_summary、checks_run、preserved_invariants、obligation_results；obligation ID 必须与 prepare 完全一致。现有文件只允许最小 Edit，不得整文件 Write。";
    case "verify":
      return "必须提交 verification_summary、regression_checks、unresolved_risks、contract_results，并逐项提交 acceptance_results；两组 ID 都必须完整一致。";
  }
}

function phaseOutputSkeleton(
  phase: Extract<HierarchicalNextOperation, { kind: "run_phase" }>["phase"]
): string {
  switch (phase) {
    case "investigate":
      return [
        "{ status, summary, evidence_refs,",
        "  handoff: { confirmed_facts, target_locations,",
        "    target_investigation: { target_kind, definition, inputs, outputs, internal_calls, guards, state_and_side_effects, callers, evidence_refs, unresolved },",
        "    reference_analysis: { search_scope, candidates: [{ reference_kind: \"same-feature-entry\", location, feature_equivalence, similarity, reusable_behavior, differences, destination, invocation, arguments, preconditions, context_forwarding, side_effects, evidence_refs }], selected_location, selection_reason, no_reference_reason },",
        "    open_unknowns } }"
      ].join("\n");
    case "prepare":
      return [
        "{ status, summary, evidence_refs, allowed_files,",
        "  handoff: { call_contract: { analyzed_targets }, reference_application,",
        "    behavior_obligations: [恰好六项：destination/invocation/arguments/preconditions/context/side_effects],",
        "    change_disposition: \"changes_required\" | \"already_satisfied\", satisfaction_evidence,",
        "    pre_behavior, preserve_invariants, patch_plan, verification_plan } }"
      ].join("\n");
    case "implement":
      return "{ status, summary, evidence_refs, handoff: { changes, diff_summary, checks_run, preserved_invariants, obligation_results } }";
    case "verify":
      return "{ status, summary, evidence_refs, acceptance_results, handoff: { verification_summary, regression_checks, unresolved_risks, contract_results } }";
  }
}

function formatPhaseArtifact(
  artifact: HierarchicalExecutionState["phase_artifacts"][number],
  currentWorkspaceRevision: number
): string {
  const freshness = artifact.workspace_revision === currentWorkspaceRevision
    ? "fresh：可复用语义结论；精确修改仍须由 Edit 旧内容匹配，验证仍须实时执行"
    : "historical：仅作修改前基线，不得冒充当前代码观察；按需刷新受影响证据";
  return [
    `### ${artifact.phase} / attempt ${artifact.attempt}`,
    `摘要：${artifact.summary}`,
    `handoff：${JSON.stringify(artifact.handoff)}`,
    `证据：${artifact.evidence_refs.join(", ")}`,
    `知识版本：${artifact.knowledge_revision}`,
    `工作区版本：${artifact.workspace_revision} / 当前 ${currentWorkspaceRevision}（${freshness}）`
  ].join("\n");
}

function blockerEvent(
  value: unknown,
  now: string,
  requirementId?: string,
  workUnitId?: string,
  alignmentBatchId?: string
): Extract<HierarchicalEvent, { type: "blocker_raised" }> {
  const blocker = requiredRecord(value, "blocker");
  const kind = requiredString(blocker.kind, "blocker.kind");
  const allowedKinds = ["user_decision", "external_resource_missing", "evidence_blocked"] as const;
  if (!allowedKinds.includes(kind as typeof allowedKinds[number])) {
    throw new Error(`阶段 Agent 不得创建内部运行故障类型：${kind}`);
  }
  const owner = kind === "user_decision" ? "user" : kind === "external_resource_missing" ? "user" : "agent";
  return {
    type: "blocker_raised",
    blocker: {
      id: requiredString(blocker.id, "blocker.id"),
      kind: kind as "user_decision" | "external_resource_missing" | "evidence_blocked",
      owner,
      message: requiredString(blocker.message, "blocker.message"),
      status: "open",
      retryable: owner !== "user",
      user_input_required: owner === "user",
      ...(alignmentBatchId ? { alignment_batch_id: alignmentBatchId } : {}),
      ...(requirementId ? { requirement_id: requirementId } : {}),
      ...(workUnitId ? { work_unit_id: workUnitId } : {}),
      created_at: now
    },
    occurred_at: now
  };
}

function userResolvableBlockerSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      id: { type: "string" },
      kind: { type: "string", enum: ["user_decision", "external_resource_missing"] },
      message: { type: "string" }
    },
    required: ["id", "kind", "message"],
    additionalProperties: false
  };
}

function plannerBlockerSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      id: { type: "string" },
      kind: { type: "string", enum: ["user_decision", "external_resource_missing"] },
      message: { type: "string" }
    },
    required: ["id", "kind", "message"],
    additionalProperties: false
  };
}

function plannedRequirementSchema(currentRequirementId: string): Record<string, unknown> {
  const currentId = escapeRegExp(currentRequirementId);
  return {
    type: "object",
    properties: {
      id: {
        type: "string",
        pattern: `^(?!${currentId}-A\\d)(?:R[A-Za-z0-9][A-Za-z0-9._-]*)$`,
        description: "仅限原账本未覆盖的独立新需求 R-ID；不得使用当前验收项 ID"
      },
      source_anchor: { type: "string" },
      observable_result: { type: "string" },
      acceptance: { type: "array", items: { type: "string" } },
      dependencies: {
        type: "array",
        items: {
          type: "string",
          pattern: "^R[A-Za-z0-9][A-Za-z0-9._-]*$",
          description: "只能填写已有或本批新增的 R-ID，不得填写文件路径或自然语言事实"
        }
      }
    },
    required: ["id", "source_anchor", "observable_result", "acceptance", "dependencies"],
    additionalProperties: false
  };
}

function parsePlannedRequirements(value: unknown, name: string): PlannedRequirement[] {
  return requiredArray(value, name).map((item, index) => {
    const requirement = requiredRecord(item, `${name}[${index}]`);
    return {
      id: requiredString(requirement.id, `${name}[${index}].id`),
      source_anchor: requiredString(requirement.source_anchor, `${name}[${index}].source_anchor`),
      observable_result: requiredString(requirement.observable_result, `${name}[${index}].observable_result`),
      acceptance: stringArray(requirement.acceptance, `${name}[${index}].acceptance`),
      dependencies: stringArray(requirement.dependencies, `${name}[${index}].dependencies`)
    };
  });
}

function isEligibleDiscoveredRequirement(
  requirement: PlannedRequirement,
  currentRequirementId: string
): boolean {
  const stableRequirementId = /^R[A-Za-z0-9][A-Za-z0-9._-]*$/;
  if (!stableRequirementId.test(requirement.id)) return false;
  if (new RegExp(`^${escapeRegExp(currentRequirementId)}-A\\d`, "i").test(requirement.id)) return false;
  if (requirement.dependencies.some((dependency) => !stableRequirementId.test(dependency))) return false;
  if (requirement.dependencies.includes(requirement.id)) return false;
  return true;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function phaseFailureRoute(value: unknown): "retry" | "investigate" | "prepare" | "implement" {
  return value === "investigate" || value === "prepare" || value === "implement"
    ? value
    : "retry";
}

function integrationFailureRoute(value: unknown): "investigate" | "prepare" {
  if (value !== "investigate" && value !== "prepare") {
    throw new Error("integrator.failure_route 必须是 investigate 或 prepare");
  }
  return value;
}

function formatRequirementForAudit(requirement: HierarchicalRequirement): string {
  return [
    `- ${requirement.id} [${requirement.status}] ${requirement.observable_result}`,
    ...requirement.acceptance.map((acceptance) =>
      `  - ${acceptance.id} [${acceptance.status}] ${acceptance.criterion}; evidence=${acceptance.evidence_refs.join(", ") || "none"}`
    )
  ].join("\n");
}

function formatBehaviorContractForAudit(
  state: HierarchicalExecutionState,
  requirementId: string
): string {
  const prepare = [...state.phase_artifacts].reverse().find((artifact) =>
    artifact.requirement_id === requirementId && artifact.phase === "prepare"
  );
  const verify = [...state.phase_artifacts].reverse().find((artifact) =>
    artifact.requirement_id === requirementId && artifact.phase === "verify"
  );
  return [
    `### ${requirementId}`,
    `prepare.behavior_obligations=${JSON.stringify(prepare?.handoff.behavior_obligations ?? [])}`,
    `prepare.change_disposition=${String(prepare?.handoff.change_disposition ?? "missing")}`,
    `verify.contract_results=${JSON.stringify(verify?.handoff.contract_results ?? [])}`
  ].join("\n");
}

function formatAlignmentBatchForPlanner(
  batch: HierarchicalExecutionState["alignment_batches"][number]
): string {
  return [
    `### ${batch.id}`,
    `批次摘要：${batch.summary ?? "无"}`,
    `来源证据：${batch.evidence_refs.join(", ") || "无"}`,
    "候选需求事实：",
    ...(batch.findings.length > 0
      ? batch.findings.map((finding) => [
          `- 来源：${finding.source_anchor}`,
          `  可观察结果：${finding.observable_result}`,
          `  验收：${finding.acceptance.join("；")}`
        ].join("\n"))
      : ["- 本批次没有独立需求事实，仅作为上下文。"])
  ].join("\n");
}

function baseRoleHeader(
  session: AgentSession,
  state: HierarchicalExecutionState,
  role: string,
  attachmentPaths: string[] = []
): string {
  const attachments = attachmentPaths.map((attachmentPath) => `- ${attachmentPath}`);
  const answeredQuestions = (session.pending_human_questions ?? [])
    .filter((question) => question.status === "answered")
    .map((question) =>
      `- 问：${question.question}\n  答：${Array.isArray(question.answer) ? question.answer.join(", ") : (question.answer ?? "")}`
    );
  return [
    `你是分层循环工作流中的 ${role}。`,
    "你只负责宿主交给你的当前循环叶子，宿主负责外层 Goal/Requirement/Phase 状态迁移。",
    "## 唯一项目根目录",
    session.project_path,
    "所有项目代码工具调用都以该目录为 cwd。优先使用项目相对路径；如使用绝对路径，必须以该目录逐字开头。严禁猜测 /workspace、/home/user/workspace 或省略中间目录的 /home/user/lib 等替代根目录，也不要执行 cd 切换到猜测目录。",
    "## Goal 级工作区不变量",
    state.workspace_contract
      ? [
          `工作区由宿主锁定：${state.workspace_contract.project_path}`,
          `分支：${state.workspace_contract.branch ?? "宿主未能读取，但仍禁止叶子角色切换"}`,
          `HEAD：${state.workspace_contract.head_sha ?? "宿主未能读取"}`,
          "checkout、switch、stash、reset、restore、创建分支和回退基线都是 Goal 级动作；当前叶子角色禁止重做。已完成 R-ID 的累计改动属于当前基线，必须保留。"
        ].join("\n")
      : "工作区契约尚在旧会话迁移中；叶子角色仍不得切换分支、stash、reset 或恢复到其他基线。",
    "## 用户原始目标",
    state.goal.statement,
    "## 精确附件",
    ...(attachments.length > 0
      ? [...attachments, "以上仅为当前批次；不得读取清单外附件。"]
      : ["- 当前角色没有原始附件读取权限；使用宿主已归并证据。"]),
    ...(answeredQuestions.length > 0 ? ["## 已回答的人类决策", ...answeredQuestions] : []),
    "所有判断必须基于用户原话、附件、代码或真实命令证据；禁止把工具/权限故障包装成用户业务问题。"
  ].join("\n");
}

function requireState(session: AgentSession): HierarchicalExecutionState {
  if (!session.hierarchical_state) throw new Error("会话尚未建立 hierarchical_state");
  return session.hierarchical_state;
}

function requireRequirement(state: HierarchicalExecutionState, id: string): HierarchicalRequirement {
  const requirement = state.requirements.find((item) => item.id === id);
  if (!requirement) throw new Error(`需求不存在：${id}`);
  return requirement;
}

function parseResultObject(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value !== "string") throw new Error("阶段 Agent 没有返回结构化对象");
  const trimmed = value.trim();
  try {
    return requiredRecord(JSON.parse(trimmed), "role result");
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("阶段 Agent 返回无法解析的结构化结果");
    return requiredRecord(JSON.parse(trimmed.slice(start, end + 1)), "role result");
  }
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} 必须是对象`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} 必须是非空字符串`);
  return value.trim();
}

function requiredArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${name} 必须是数组`);
  return value;
}

function stringArray(value: unknown, name: string): string[] {
  return requiredArray(value, name).map((item, index) => requiredString(item, `${name}[${index}]`));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

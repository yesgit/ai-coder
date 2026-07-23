import type { HierarchicalExecutionState } from "../../shared/types.js";

interface HierarchicalLoopPanelProps {
  state?: HierarchicalExecutionState;
}

const PHASE_LABELS: Record<string, string> = {
  align: "目标对齐",
  deliver: "逐项交付",
  integrate: "全局审计",
  complete: "完成",
  investigate: "调查",
  prepare: "准备",
  implement: "实现",
  verify: "验证",
  close: "关闭"
};

const STATUS_CLASS: Record<string, string> = {
  pending: "not_started",
  active: "running",
  ready: "not_started",
  running: "running",
  passed: "completed",
  completed: "completed",
  blocked: "failed",
  failed: "failed",
  skipped: "superseded"
};

export default function HierarchicalLoopPanel({ state }: HierarchicalLoopPanelProps) {
  if (!state) {
    return (
      <section className="stages-panel hierarchical-loop-panel" aria-live="polite">
        <div className="task-tree-heading">
          <h3>分层循环</h3>
          <span className="task-tree-count">初始化</span>
        </div>
        <div className="task-tree-empty">
          <strong>等待宿主建立目标契约</strong>
          <small>目标、需求、阶段与动作会由宿主状态机分别管理。</small>
        </div>
      </section>
    );
  }

  const completed = state.requirements.filter((requirement) =>
    requirement.status === "completed" || requirement.status === "skipped"
  ).length;
  const alignmentBatches = state.alignment_batches ?? [];
  const completedAlignmentBatches = alignmentBatches.filter((batch) => batch.status === "completed").length;
  const activeAlignmentBatch = alignmentBatches.find((batch) => batch.status === "running")
    ?? alignmentBatches.find((batch) => batch.status === "pending" || batch.status === "blocked");
  const activeRequirement = state.requirements.find((requirement) =>
    requirement.id === state.active_requirement_id
  );
  const activeUnknowns = state.knowledge.unknowns.filter((unknown) => unknown.status === "open").length;
  const activeFacts = state.knowledge.facts.filter((fact) => fact.status === "active").length;
  const openBlockers = state.blockers.filter((blocker) => blocker.status === "open");

  return (
    <section className="stages-panel hierarchical-loop-panel" aria-live="polite">
      <div className="task-tree-heading">
        <h3>分层循环</h3>
        <span className="task-tree-count">{completed}/{state.requirements.length}</span>
      </div>

      <div className="hierarchical-goal">
        <small>目标 {state.goal.id} · rev {state.goal.revision}</small>
        <strong>{state.goal.statement}</strong>
      </div>

      <div className="hierarchical-stack" aria-label="当前循环栈">
        <div><small>外循环</small><span>{PHASE_LABELS[state.macro_phase]}</span></div>
        {!activeRequirement && activeAlignmentBatch && (
          <div>
            <small>附件摄取内循环</small>
            <span>{activeAlignmentBatch.id} · {activeAlignmentBatch.source_refs.length} 个来源 · 第 {activeAlignmentBatch.attempt} 次</span>
          </div>
        )}
        {activeRequirement && <div><small>需求循环</small><span>{activeRequirement.id}</span></div>}
        {state.active_work_unit && (
          <>
            <div><small>阶段循环</small><span>{PHASE_LABELS[state.active_work_unit.phase]}</span></div>
            <div><small>动作循环</small><span>{state.active_work_unit.assigned_role} · 第 {state.active_work_unit.attempt} 次</span></div>
          </>
        )}
      </div>

      <div className="hierarchical-knowledge">
        <small>知识雪球 rev {state.knowledge.revision}</small>
        <span>{activeFacts} 条有效事实 · {activeUnknowns} 个开放未知</span>
      </div>

      <div className="stages stages-stepper hierarchical-requirements">
        {state.requirements.length === 0 ? (
          <div className="task-tree-empty">
            <strong>{alignmentBatches.length > 0 ? "正在分批摄取附件" : "正在建立稳定需求账本"}</strong>
            <small>
              {alignmentBatches.length > 0
                ? `附件批次 ${completedAlignmentBatches}/${alignmentBatches.length}；完成后由 planner 仅消费持久化摘要。`
                : "R-ID 建立后不会随知识版本变化。"}
            </small>
          </div>
        ) : state.requirements.map((requirement) => {
          const passed = requirement.acceptance.filter((item) => item.status === "pass").length;
          const isCurrent = requirement.id === state.active_requirement_id;
          return (
            <div key={requirement.id} className={`stage ${STATUS_CLASS[requirement.status]}${isCurrent ? " current" : ""}`}>
              <span className={`stage-indicator ${STATUS_CLASS[requirement.status]}`} />
              <div>
                <span><strong>{requirement.id}</strong> · {requirement.observable_result}</span>
                <small>
                  {requirement.current_phase ? PHASE_LABELS[requirement.current_phase] : requirement.status}
                  {` · 验收 ${passed}/${requirement.acceptance.length}`}
                </small>
                {requirement.status_reason && <small className="muted">{requirement.status_reason}</small>}
              </div>
            </div>
          );
        })}
      </div>

      {openBlockers.length > 0 && (
        <div className="hierarchical-blockers">
          <small>开放阻塞</small>
          {openBlockers.map((blocker) => (
            <span key={blocker.id}>{blocker.kind} · {blocker.owner}：{blocker.message}</span>
          ))}
        </div>
      )}
    </section>
  );
}

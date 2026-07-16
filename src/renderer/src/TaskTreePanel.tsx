import type { TaskTree } from "../../shared/types.js";

interface TaskTreePanelProps {
  taskTree: TaskTree;
}

const STATUS_ICON: Record<string, string> = {
  pending: "⏳",
  in_progress: "🔄",
  completed: "✅",
  blocked: "🚫",
  skipped: "⏭️",
};

const STATUS_CLASS: Record<string, string> = {
  pending: "not_started",
  in_progress: "running",
  completed: "completed",
  blocked: "failed",
  skipped: "superseded",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "待执行",
  in_progress: "执行中",
  completed: "已完成",
  blocked: "阻塞",
  skipped: "已跳过",
};

export default function TaskTreePanel({ taskTree }: TaskTreePanelProps) {
  return (
    <div className="stages-panel task-tree-panel">
      <h3>任务树</h3>

      <div className="task-tree-goal">
        <small className="muted">目标：{taskTree.goal_restated}</small>
      </div>
      <div className="task-tree-strategy">
        <small className="muted">策略：{taskTree.strategy}</small>
      </div>

      <div className="stages stages-stepper task-tree-stages">
        {taskTree.tasks.map((t) => {
          const isCurrent = t.id === taskTree.current_focus;
          return (
            <div
              key={t.id}
              className={`stage task-tree-node ${isCurrent ? "current" : ""}`}
            >
              <span
                className={`stage-indicator ${STATUS_CLASS[t.status]}`}
                aria-label={STATUS_LABEL[t.status]}
              />
              <div>
                <span className="task-tree-node-label">
                  <span className="task-tree-icon">{STATUS_ICON[t.status]}</span>
                  <strong>{t.id}</strong>: {t.description}
                </span>
                {t.dependencies.length > 0 && (
                  <small className="muted task-tree-deps">
                    依赖: {t.dependencies.join(", ")}
                  </small>
                )}
                {t.status_reason && (
                  <small className="muted task-tree-reason">
                    {t.status_reason}
                  </small>
                )}
                {t.evidence && (
                  <small className="task-tree-evidence" title={t.evidence}>
                    证据: {t.evidence.length > 80
                      ? t.evidence.slice(0, 80) + "…"
                      : t.evidence}
                  </small>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {taskTree.current_focus && taskTree.focus_reason && (
        <div className="task-tree-focus">
          <small className="muted">
            当前聚焦：<strong>{taskTree.current_focus}</strong>——{taskTree.focus_reason}
          </small>
        </div>
      )}
    </div>
  );
}

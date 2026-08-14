import { useTaskAutomationStore } from "./taskAutomationStore.js";
import TaskAutomationSettingsEditor from "./TaskAutomationSettingsEditor.js";
import "./styles.css";

/** 活跃状态：用于顶部统计概览，按关注优先级排序。 */
const SUMMARY_STATUSES = ["executing", "pr_submitted", "reviewing", "claimed", "failed"] as const;

/**
 * 任务自动化主面板：状态概览 + 已认领队列 + 扫描结果 + 自动化设置。
 */
export default function TaskAutomationPanel() {
  const {
    queue,
    scannedTasks,
    scanning,
    error,
    handleScan,
    handleClaim,
    handleRelease
  } = useTaskAutomationStore();

  const statusCounts = queue.reduce<Record<string, number>>((acc, record) => {
    acc[record.status] = (acc[record.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="task-automation-panel">
      <header className="task-automation-header">
        <div className="task-automation-title">
          <h2>任务自动化</h2>
          <p>从 Jira / PingCode 侦察任务，自动认领、执行并提交 MR。</p>
        </div>
        <button onClick={handleScan} disabled={scanning} className="secondary scan-button">
          {scanning ? "侦察中…" : "手动侦察"}
        </button>
      </header>

      {error && <div className="error-banner">{error}</div>}

      {/* 状态概览 */}
      {queue.length > 0 && (
        <div className="task-summary-strip">
          {SUMMARY_STATUSES.filter((s) => (statusCounts[s] ?? 0) > 0).map((s) => (
            <span key={s} className={`status-badge status-${s}`}>
              {formatStatus(s)} {statusCounts[s]}
            </span>
          ))}
        </div>
      )}

      {/* 已认领队列 */}
      <section className="task-automation-section">
        <div className="task-section-heading">
          <h3>已认领任务</h3>
          <span className="task-count-badge">{queue.length}</span>
        </div>
        {queue.length === 0 ? (
          <div className="task-empty">
            <strong>暂无已认领任务</strong>
            <small>点击「手动侦察」扫描各平台待办，或等待定时轮询自动认领。</small>
          </div>
        ) : (
          <div className="claimed-list">
            {queue.map((record) => (
              <article key={record.task_id} className={`claimed-card status-${record.status}`}>
                <div className="claimed-card-main">
                  <div className="claimed-card-top">
                    <span className="platform-badge">{formatPlatform(record.platform)}</span>
                    <strong className="claimed-task-id">{record.task_id}</strong>
                    <span className={`status-badge status-${record.status}`}>
                      {formatStatus(record.status)}
                    </span>
                  </div>
                  <div className="claimed-card-meta">
                    <span className="mono" title={record.branch}>⎇ {record.branch}</span>
                    {record.session_id && (
                      <span className="mono" title={record.session_id}>
                        会话 {record.session_id.slice(0, 8)}
                      </span>
                    )}
                    <span>认领于 {formatTime(record.claimed_at)}</span>
                    {record.review_round > 0 && (
                      <span className="review-round-badge">Review 第 {record.review_round} 轮</span>
                    )}
                  </div>
                  {record.last_error && (
                    <div className="claimed-card-error" title={record.last_error}>
                      {record.last_error}
                    </div>
                  )}
                </div>
                <div className="claimed-card-actions">
                  {record.pr_url && (
                    <a className="mr-link" href={record.pr_url} target="_blank" rel="noopener noreferrer">
                      查看 MR ↗
                    </a>
                  )}
                  {(record.status === "claimed" || record.status === "executing") && (
                    <button
                      className="danger small"
                      onClick={() => handleRelease(record.task_id)}
                    >
                      释放
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* 扫描结果 */}
      {scannedTasks.length > 0 && (
        <section className="task-automation-section">
          <div className="task-section-heading">
            <h3>扫描结果</h3>
            <span className="task-count-badge">{scannedTasks.length}</span>
          </div>
          <div className="scanned-list">
            {scannedTasks.map((task) => (
              <article key={task.task_id} className="scanned-card">
                <div className="scanned-card-main">
                  <div className="scanned-card-top">
                    <span className="platform-badge">{formatPlatform(task.platform)}</span>
                    <a href={task.raw_url} target="_blank" rel="noopener noreferrer" className="scanned-task-id">
                      {task.task_id} ↗
                    </a>
                    <span className={`difficulty-badge difficulty-${task.difficulty_estimate}`}>
                      {formatDifficulty(task.difficulty_estimate)}
                    </span>
                  </div>
                  <p className="scanned-title" title={task.title}>{task.title}</p>
                  {task.labels.length > 0 && (
                    <div className="label-row">
                      {task.labels.slice(0, 4).map((label) => (
                        <span key={label} className="label-chip">{label}</span>
                      ))}
                    </div>
                  )}
                </div>
                <button className="primary small" onClick={() => handleClaim(task)}>
                  认领
                </button>
              </article>
            ))}
          </div>
        </section>
      )}

      {/* 自动化设置 */}
      <section className="task-automation-section">
        <div className="task-section-heading">
          <h3>自动化设置</h3>
        </div>
        <TaskAutomationSettingsEditor />
      </section>
    </div>
  );
}

function formatPlatform(platform: string): string {
  switch (platform) {
    case "jira_cloud": return "Jira Cloud";
    case "jira_server": return "Jira Server";
    case "pingcode": return "PingCode";
    default: return platform;
  }
}

function formatStatus(status: string): string {
  switch (status) {
    case "claimed": return "待执行";
    case "executing": return "执行中";
    case "pr_submitted": return "待审核";
    case "reviewing": return "处理意见中";
    case "merged": return "已合并";
    case "released": return "已释放";
    case "failed": return "失败";
    default: return status;
  }
}

function formatDifficulty(difficulty: string): string {
  switch (difficulty) {
    case "trivial": return "极简";
    case "low": return "低";
    case "medium": return "中";
    case "high": return "高";
    default: return "未知";
  }
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

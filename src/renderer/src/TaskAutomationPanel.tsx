import { useTaskAutomationStore } from "./taskAutomationStore.js";
import type { UnifiedTask } from "../../shared/types.js";
import "./styles.css";

/**
 * 任务自动化主面板：任务队列 + 认领历史。
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

  return (
    <div className="task-automation-panel">
      <header className="task-automation-header">
        <h2>任务自动化</h2>
        <button onClick={handleScan} disabled={scanning} className="secondary">
          {scanning ? "扫描中..." : "手动侦察"}
        </button>
      </header>

      {error && <div className="error-banner">{error}</div>}

      {/* 已认领队列 */}
      <section>
        <h3>已认领任务 ({queue.length})</h3>
        {queue.length === 0 ? (
          <p className="muted">暂无已认领任务</p>
        ) : (
          <table className="task-table">
            <thead>
              <tr>
                <th>平台</th>
                <th>任务 ID</th>
                <th>状态</th>
                <th>分支</th>
                <th>会话</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {queue.map((record) => (
                <tr key={record.task_id}>
                  <td>{formatPlatform(record.platform)}</td>
                  <td>{record.task_id}</td>
                  <td>
                    <span className={`status-badge status-${record.status}`}>
                      {formatStatus(record.status)}
                    </span>
                  </td>
                  <td className="mono">{record.branch}</td>
                  <td className="mono">{record.session_id?.slice(0, 8) ?? "-"}</td>
                  <td>
                    {(record.status === "claimed" || record.status === "executing") && (
                      <button
                        className="danger small"
                        onClick={() => handleRelease(record.task_id)}
                      >
                        释放
                      </button>
                    )}
                    {record.pr_url && (
                      <a href={record.pr_url} target="_blank" rel="noopener noreferrer">
                        PR
                      </a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* 扫描结果 */}
      {scannedTasks.length > 0 && (
        <section>
          <h3>扫描结果 ({scannedTasks.length})</h3>
          <table className="task-table">
            <thead>
              <tr>
                <th>平台</th>
                <th>任务 ID</th>
                <th>标题</th>
                <th>难度</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {scannedTasks.map((task) => (
                <tr key={task.task_id}>
                  <td>{formatPlatform(task.platform)}</td>
                  <td>
                    <a href={task.raw_url} target="_blank" rel="noopener noreferrer">
                      {task.task_id}
                    </a>
                  </td>
                  <td className="task-title">{task.title}</td>
                  <td>
                    <span className={`difficulty-badge difficulty-${task.difficulty_estimate}`}>
                      {task.difficulty_estimate}
                    </span>
                  </td>
                  <td>
                    <button className="primary small" onClick={() => handleClaim(task)}>
                      认领
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
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
    case "merged": return "已合并";
    case "released": return "已释放";
    case "failed": return "失败";
    default: return status;
  }
}

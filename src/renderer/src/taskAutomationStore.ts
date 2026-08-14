import { useCallback, useEffect, useState } from "react";
import type { ClaimedTaskRecord, UnifiedTask } from "../../shared/types.js";

/**
 * 任务自动化状态管理 hook。
 * 管理已认领队列、扫描结果、加载状态和错误信息。
 */
export function useTaskAutomationStore() {
  const [queue, setQueue] = useState<ClaimedTaskRecord[]>([]);
  const [scannedTasks, setScannedTasks] = useState<UnifiedTask[]>([]);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");

  const loadQueue = useCallback(async () => {
    try {
      const tasks = await window.aiCoder.getTaskQueue();
      setQueue(tasks);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    loadQueue();
    const unsub = window.aiCoder.onTaskQueueUpdated((tasks: UnifiedTask[]) => {
      setScannedTasks(tasks);
    });
    return unsub;
  }, [loadQueue]);

  const handleScan = useCallback(async () => {
    setScanning(true);
    setError("");
    try {
      const tasks = await window.aiCoder.triggerTaskScan();
      setScannedTasks(tasks);
      await loadQueue();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(false);
    }
  }, [loadQueue]);

  const handleClaim = useCallback(async (task: UnifiedTask) => {
    setError("");
    try {
      const result = await window.aiCoder.claimTask(task);
      if (!result.success) {
        setError(result.error ?? "认领失败");
      }
      await loadQueue();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [loadQueue]);

  const handleRelease = useCallback(async (taskId: string) => {
    setError("");
    try {
      await window.aiCoder.releaseTask(taskId, "手动释放");
      await loadQueue();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [loadQueue]);

  return {
    queue,
    scannedTasks,
    scanning,
    error,
    handleScan,
    handleClaim,
    handleRelease
  };
}

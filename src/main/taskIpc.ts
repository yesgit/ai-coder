import { BrowserWindow, ipcMain } from "electron";
import type { TaskAutomationSettings, TaskPlatformKind, UnifiedTask } from "../shared/types.js";
import type { CredentialsStore } from "./settings/credentialsStore.js";
import type { SettingsStore } from "./settings/settingsStore.js";
import type { ClaimedTaskStore } from "./taskplatform/claimedTaskStore.js";
import type { TaskClaimManager } from "./taskplatform/taskClaimManager.js";
import type { TaskPlatformRegistry } from "./taskplatform/taskPlatformRegistry.js";
import type { TaskScout } from "./taskplatform/taskScout.js";
import type { ReviewWatcher } from "./taskplatform/reviewWatcher.js";
import type { SessionOrchestrator } from "./taskplatform/sessionOrchestrator.js";

/**
 * 任务自动化 IPC 通道注册。遵循 ipc.ts 的 ipcMain.handle 模式。
 */
export function registerTaskIpcHandlers(
  scout: TaskScout,
  claimManager: TaskClaimManager,
  orchestrator: SessionOrchestrator,
  credentials: CredentialsStore,
  registry: TaskPlatformRegistry,
  claimedTaskStore: ClaimedTaskStore,
  settingsStore: SettingsStore,
  reviewWatcher: ReviewWatcher
): void {
  // 设置侦察完成回调 → 自动编排会话
  scout.onTaskClaimed = async (task: UnifiedTask) => {
    // claimAndPrepare 已在 scout 内部完成；这里触发会话编排
    const record = await claimedTaskStore.findByTaskId(task.task_id);
    if (record && record.status === "claimed") {
      // 构建一个简化的 claim result 供 orchestrator 使用
      orchestrator.orchestrate(task, {
        success: true,
        task,
        branch: record.branch,
        claimed_at: record.claimed_at
      }).catch((error) => {
        console.error("[taskIpc] Orchestration failed:", error);
      });
    }
  };

  // 设置队列更新回调 → 广播给 UI
  scout.onQueueUpdated = (tasks: UnifiedTask[]) => {
    broadcastTaskQueueUpdate(tasks);
  };

  // 设置凭证过期回调 → 广播给 UI
  scout.onCredentialsExpired = (platform: TaskPlatformKind) => {
    broadcastCredentialsExpired(platform);
  };

  ipcMain.handle("task:get-queue", async () => {
    return claimedTaskStore.list();
  });

  ipcMain.handle("task:scan", async () => {
    return scout.scanAll();
  });

  ipcMain.handle("task:claim", async (_event, task: UnifiedTask) => {
    const result = await claimManager.claimAndPrepare(task);
    if (result.success) {
      // 触发会话编排
      orchestrator.orchestrate(task, result).catch((error) => {
        console.error("[taskIpc] Orchestration failed:", error);
      });
    }
    return result;
  });

  ipcMain.handle("task:release", async (_event, taskId: string, reason: string) => {
    await claimManager.release(taskId, reason);
  });

  ipcMain.handle("credentials:set", async (_event, platform: string, token: string) => {
    await credentials.set(platform, token);
  });

  ipcMain.handle("credentials:test", async (_event, platform: string) => {
    const token = await credentials.get(platform);
    if (!token) {
      return { ok: false, error: "未存储该平台的凭证" };
    }
    const adapter = registry.get(platform as TaskPlatformKind, token);
    if (!adapter) {
      return { ok: false, error: "平台适配器不可用：请先在平台配置中启用该平台并填写地址" };
    }
    return adapter.ping();
  });

  // 任务自动化配置：保存后立即生效（刷新适配器、重启侦察与 Review 轮询）
  ipcMain.handle("task:update-automation-settings", async (_event, input: TaskAutomationSettings) => {
    await settingsStore.update({ task_automation: input });
    // update 的 partial 不经 sanitize，重新读取拿到净化后的完整配置再驱动联动
    const clean = (await settingsStore.get()).task_automation;
    registry.updateConfigs(clean.platforms);
    scout.stop();
    reviewWatcher.stop();
    // allSettled 保证一个启动失败不妨碍另一个被尝试
    const results = await Promise.allSettled([scout.start(), reviewWatcher.start()]);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (rejected) {
      const reason = rejected.reason instanceof Error ? rejected.reason.message : String(rejected.reason);
      throw new Error(`配置已保存，但重启自动轮询失败：${reason}`);
    }
    return clean;
  });
}

function broadcastTaskQueueUpdate(tasks: UnifiedTask[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("task:queue-updated", tasks);
  }
}

function broadcastCredentialsExpired(platform: TaskPlatformKind): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("credentials:expired", platform);
  }
}

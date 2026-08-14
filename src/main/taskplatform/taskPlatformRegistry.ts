import type { TaskPlatformConfig, TaskPlatformKind } from "../../shared/types.js";
import type { TaskPlatformAdapter } from "./taskPlatformAdapter.js";
import { JiraAdapter } from "./jiraAdapter.js";
import { PingCodeAdapter } from "./pingcodeAdapter.js";
import { PlatformRateLimiter } from "./platformRateLimiter.js";

/**
 * 平台适配器注册表。按配置创建并缓存适配器实例，
 * 凭证由调用方注入（解密后的 token 不缓存在注册表中）。
 */
export class TaskPlatformRegistry {
  private readonly limiter = new PlatformRateLimiter();
  private readonly adapterCache = new Map<TaskPlatformKind, TaskPlatformAdapter>();

  constructor(private configs: TaskPlatformConfig[]) {}

  /** 更新配置（设置变更时调用）。 */
  updateConfigs(configs: TaskPlatformConfig[]): void {
    this.configs = configs;
    this.adapterCache.clear();
  }

  /** 获取指定平台的适配器。需提供 token 用于首次创建。 */
  get(kind: TaskPlatformKind, token?: string): TaskPlatformAdapter | null {
    const cached = this.adapterCache.get(kind);
    if (cached) return cached;

    const config = this.configs.find((c) => c.kind === kind && c.enabled);
    if (!config) return null;

    const adapter = this.createAdapter(config, token ?? "");
    if (adapter) {
      this.adapterCache.set(kind, adapter);
    }
    return adapter;
  }

  /** 获取所有已启用平台的适配器。需提供 token 映射。 */
  listEnabled(tokens: Record<string, string>): TaskPlatformAdapter[] {
    const adapters: TaskPlatformAdapter[] = [];
    for (const config of this.configs) {
      if (!config.enabled) continue;
      const cached = this.adapterCache.get(config.kind);
      if (cached) {
        adapters.push(cached);
        continue;
      }
      const adapter = this.createAdapter(config, tokens[config.kind] ?? "");
      if (adapter) {
        this.adapterCache.set(config.kind, adapter);
        adapters.push(adapter);
      }
    }
    return adapters;
  }

  private createAdapter(config: TaskPlatformConfig, token: string): TaskPlatformAdapter | null {
    switch (config.kind) {
      case "jira_cloud":
        return new JiraAdapter(config.base_url, token, config.project_mappings, this.limiter, "jira_cloud");
      case "jira_server":
        return new JiraAdapter(config.base_url, token, config.project_mappings, this.limiter, "jira_server");
      case "pingcode":
        return new PingCodeAdapter(config.base_url, token, config.project_mappings, this.limiter);
      default:
        return null;
    }
  }
}

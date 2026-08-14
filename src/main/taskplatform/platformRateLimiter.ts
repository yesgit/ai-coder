import type { TaskPlatformKind } from "../../shared/types.js";

interface TokenBucket {
  tokens: number;
  capacity: number;
  refillRatePerSecond: number;
  lastRefill: number;
}

/**
 * 平台 API 令牌桶限流器。每个平台独立桶，不足时 sleep 等待而非报错。
 * 防止触发 Jira / PingCode 的 rate limit。
 */
export class PlatformRateLimiter {
  private readonly buckets = new Map<TaskPlatformKind, TokenBucket>();

  constructor() {
    // Jira Cloud 约 5000 req/hr ≈ 1.4 req/s；保守设置 1 req/s
    this.createBucket("jira_cloud", 10, 1);
    // Jira Server 通常更宽松
    this.createBucket("jira_server", 20, 2);
    // PingCode 限制更严格
    this.createBucket("pingcode", 8, 0.8);
  }

  /**
   * 获取令牌。不足时自动等待（sleep），不会抛错。
   * @param cost 本次请求消耗的令牌数（默认 1）
   */
  async acquire(kind: TaskPlatformKind, cost = 1): Promise<void> {
    const bucket = this.buckets.get(kind);
    if (!bucket) return; // 未知平台不限制

    this.refill(bucket);

    while (bucket.tokens < cost) {
      const waitMs = Math.ceil((cost - bucket.tokens) / bucket.refillRatePerSecond * 1000);
      await sleep(Math.min(waitMs, 5000)); // 单次最多等 5 秒
      this.refill(bucket);
    }

    bucket.tokens -= cost;
  }

  private createBucket(kind: TaskPlatformKind, capacity: number, refillRatePerSecond: number): void {
    this.buckets.set(kind, {
      tokens: capacity,
      capacity,
      refillRatePerSecond,
      lastRefill: Date.now()
    });
  }

  private refill(bucket: TokenBucket): void {
    const now = Date.now();
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillRatePerSecond);
    bucket.lastRefill = now;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 极简单IP滑动窗口限流，用于展厅单机防刷 */
export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** 返回 null 表示放行，否则返回需等待秒数 */
  allow(key: string): number | null {
    const now = Date.now();
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.limit) {
      const oldest = arr[0] ?? now;
      return Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
    }
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 1000) {
      const first = this.hits.keys().next().value;
      if (first) this.hits.delete(first);
    }
    return null;
  }
}

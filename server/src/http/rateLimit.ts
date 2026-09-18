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
      // 命中即刷新插入序，使淘汰接近 LRU（此前按首次插入序淘汰，活跃 IP 可能被误删）
      this.hits.delete(key);
      this.hits.set(key, arr);
      return Math.max(1, Math.ceil((oldest + this.windowMs - now) / 1000));
    }
    arr.push(now);
    this.hits.delete(key);
    this.hits.set(key, arr);
    this.prune();
    return null;
  }

  /** 键数量上限保护：优先淘汰最久未访问的键 */
  private prune(max = 1000): void {
    while (this.hits.size > max) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) return;
      this.hits.delete(oldest);
    }
  }
}

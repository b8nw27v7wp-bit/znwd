export interface ChatLogItem {
  at: number;
  sessionId: string | null;
  mode: 'rag' | 'llm_only';
  provider: string;
  messagePreview: string;
  answerPreview: string;
  latencyMs: number;
  /** 相关性闸门拦截（知识库未覆盖）——运营据此补资料 */
  noHit?: boolean;
  retrieval?: 'hybrid' | 'keyword';
  /** 多轮指代改写是否生效（看追问场景占比） */
  rewritten?: boolean;
  /** 知识库未覆盖时的原始提问（仅 noHit 且开启 UNCOVERED_LOG_SIZE 时留存，供补资料） */
  question?: string;
  error?: string;
}

export interface FeedbackItem {
  at: number;
  sessionId: string | null;
  rating: 'up' | 'down';
  comment?: string;
  /** 可选：访客问题摘要（运营分析用，非完整 chat 日志） */
  question?: string;
}

const MAX_LOGS = 500;
const MAX_FEEDBACK = 500;
const MAX_UNCOVERED = 50;

export interface UncoveredItem {
  at: number;
  sessionId: string | null;
  question: string;
}

export class Analytics {
  private logs: ChatLogItem[] = [];
  private feedback: FeedbackItem[] = [];
  private startedAt = Date.now();
  private chatTotal = 0;
  private ragHits = 0;
  private errors = 0;
  private noHits = 0;
  private rewritten = 0;
  /** 未覆盖问题（明文）：这是下一批要补的知识，0 表示关闭留存 */
  private uncovered: UncoveredItem[] = [];
  private readonly maxUncovered: number;

  constructor(maxUncovered = MAX_UNCOVERED) {
    this.maxUncovered = Math.max(0, maxUncovered);
  }

  logChat(item: ChatLogItem): void {
    this.chatTotal++;
    if (item.mode === 'rag') this.ragHits++;
    if (item.noHit) this.noHits++;
    if (item.rewritten) this.rewritten++;
    if (item.error) this.errors++;
    if (item.noHit && item.question && this.maxUncovered > 0) {
      this.uncovered.unshift({ at: item.at, sessionId: item.sessionId, question: item.question });
      if (this.uncovered.length > this.maxUncovered) this.uncovered.length = this.maxUncovered;
    }
    this.logs.unshift(item);
    if (this.logs.length > MAX_LOGS) this.logs.length = MAX_LOGS;
  }

  /** 未覆盖问题清单（新→旧），供运营补资料 */
  uncoveredList(limit = this.maxUncovered): UncoveredItem[] {
    return this.uncovered.slice(0, limit);
  }

  logFeedback(item: FeedbackItem): void {
    this.feedback.unshift(item);
    if (this.feedback.length > MAX_FEEDBACK) this.feedback.length = MAX_FEEDBACK;
  }

  stats(activeSessions: number) {
    const up = this.feedback.filter((f) => f.rating === 'up').length;
    const down = this.feedback.filter((f) => f.rating === 'down').length;
    const recent = this.logs.slice(0, 20).map((l) => ({
      at: l.at,
      sessionId: l.sessionId,
      mode: l.mode,
      noHit: l.noHit ?? false,
      messagePreview: l.messagePreview,
      latencyMs: l.latencyMs,
      error: l.error ?? null,
    }));
    return {
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      chatTotal: this.chatTotal,
      ragHits: this.ragHits,
      llmOnly: this.chatTotal - this.ragHits - this.errors,
      /** 知识库未覆盖（闸门拦截）次数：这类问题就是下一批要补的资料 */
      noHit: this.noHits,
      /** 多轮指代改写生效次数（追问占比） */
      rewritten: this.rewritten,
      /** 已留存的未覆盖问题条数（明细见 /api/admin/uncovered） */
      uncoveredCount: this.uncovered.length,
      errors: this.errors,
      activeSessions,
      feedback: { up, down },
      recent,
    };
  }

  /** P3：负反馈汇总，便于知识回流 */
  feedbackStats() {
    const total = this.feedback.length;
    const up = this.feedback.filter((f) => f.rating === 'up').length;
    const downItems = this.feedback.filter((f) => f.rating === 'down');
    const down = downItems.length;
    const byQuestion = new Map<string, { question: string; down: number; comments: string[] }>();
    for (const f of downItems) {
      const q = (f.question || f.comment || '(未记录问题)').slice(0, 200);
      const prev = byQuestion.get(q) || { question: q, down: 0, comments: [] };
      prev.down += 1;
      if (f.comment) prev.comments.push(f.comment.slice(0, 200));
      byQuestion.set(q, prev);
    }
    const topDown = [...byQuestion.values()].sort((a, b) => b.down - a.down).slice(0, 20);
    return {
      total,
      up,
      down,
      downRate: total ? Number((down / total).toFixed(4)) : 0,
      topDown,
      /** 最近反馈（含正向）：便于核对某条回答是否被投诉 */
      recent: this.feedback.slice(0, 20).map((f) => ({
        at: f.at,
        sessionId: f.sessionId,
        rating: f.rating,
        question: f.question ?? null,
        comment: f.comment ?? null,
      })),
      recentDown: downItems.slice(0, 20).map((f) => ({
        at: f.at,
        sessionId: f.sessionId,
        question: f.question ?? null,
        comment: f.comment ?? null,
      })),
    };
  }

  feedbackCsv(): string {
    const header = 'at,sessionId,rating,question,comment';
    const esc = (s: string | null | undefined) => {
      const v = s ?? '';
      return `"${String(v).replace(/"/g, '""')}"`;
    };
    const lines = this.feedback.map((f) =>
      [String(f.at), esc(f.sessionId), f.rating, esc(f.question), esc(f.comment)].join(','),
    );
    return [header, ...lines].join('\n');
  }

  recentFeedback(limit = 20): FeedbackItem[] {
    return this.feedback.slice(0, limit);
  }

  /** 导出可持久化的状态（计数 + 反馈 + 未覆盖清单） */
  exportState(): {
    startedAt: number;
    chatTotal: number;
    ragHits: number;
    errors: number;
    noHits: number;
    rewritten: number;
    feedback: FeedbackItem[];
    uncovered: UncoveredItem[];
  } {
    return {
      startedAt: this.startedAt,
      chatTotal: this.chatTotal,
      ragHits: this.ragHits,
      errors: this.errors,
      noHits: this.noHits,
      rewritten: this.rewritten,
      feedback: [...this.feedback],
      uncovered: [...this.uncovered],
    };
  }

  /** 恢复状态（重启后反馈与计数不丢；字段缺失时按 0/空处理） */
  importState(state: {
    startedAt?: number;
    chatTotal?: number;
    ragHits?: number;
    errors?: number;
    noHits?: number;
    rewritten?: number;
    feedback?: FeedbackItem[];
    uncovered?: UncoveredItem[];
  }): void {
    this.startedAt = state.startedAt ?? Date.now();
    this.chatTotal = state.chatTotal ?? 0;
    this.ragHits = state.ragHits ?? 0;
    this.errors = state.errors ?? 0;
    this.noHits = state.noHits ?? 0;
    this.rewritten = state.rewritten ?? 0;
    this.feedback = Array.isArray(state.feedback) ? state.feedback.slice(0, MAX_FEEDBACK) : [];
    this.uncovered = Array.isArray(state.uncovered)
      ? state.uncovered.slice(0, this.maxUncovered)
      : [];
  }
}

export interface ChatLogItem {
  at: number;
  sessionId: string | null;
  mode: 'rag' | 'llm_only';
  provider: string;
  messagePreview: string;
  answerPreview: string;
  latencyMs: number;
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

export class Analytics {
  private logs: ChatLogItem[] = [];
  private feedback: FeedbackItem[] = [];
  private startedAt = Date.now();
  private chatTotal = 0;
  private ragHits = 0;
  private errors = 0;

  logChat(item: ChatLogItem): void {
    this.chatTotal++;
    if (item.mode === 'rag') this.ragHits++;
    if (item.error) this.errors++;
    this.logs.unshift(item);
    if (this.logs.length > MAX_LOGS) this.logs.length = MAX_LOGS;
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
      messagePreview: l.messagePreview,
      latencyMs: l.latencyMs,
      error: l.error ?? null,
    }));
    return {
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      chatTotal: this.chatTotal,
      ragHits: this.ragHits,
      llmOnly: this.chatTotal - this.ragHits - this.errors,
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
}

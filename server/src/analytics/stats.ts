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

  recentFeedback(limit = 20): FeedbackItem[] {
    return this.feedback.slice(0, limit);
  }
}

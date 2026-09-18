import type { ChatMessage } from '../llm/types.js';

const MAX_TURNS = 6;
const TTL_MS = 10 * 60 * 1000;

interface SessionEntry {
  messages: ChatMessage[];
  lastActive: number;
}

function prune(entry: SessionEntry, now: number): boolean {
  if (now - entry.lastActive > TTL_MS) return false;
  const limit = MAX_TURNS * 2;
  if (entry.messages.length > limit) {
    entry.messages = entry.messages.slice(-limit);
  }
  return true;
}

export class SessionStore {
  private map = new Map<string, SessionEntry>();

  history(sessionId: string | undefined): ChatMessage[] {
    if (!sessionId) return [];
    const now = Date.now();
    const entry = this.map.get(sessionId);
    if (!entry || !prune(entry, now)) {
      this.map.delete(sessionId);
      return [];
    }
    entry.lastActive = now;
    return [...entry.messages];
  }

  append(sessionId: string | undefined, user: string, assistant: string): void {
    if (!sessionId) return;
    const now = Date.now();
    let entry = this.map.get(sessionId);
    if (!entry || !prune(entry, now)) {
      entry = { messages: [], lastActive: now };
      this.map.set(sessionId, entry);
    }
    entry.messages.push({ role: 'user', content: user });
    entry.messages.push({ role: 'assistant', content: assistant });
    entry.lastActive = now;
    const limit = MAX_TURNS * 2;
    if (entry.messages.length > limit) {
      entry.messages = entry.messages.slice(-limit);
    }
    // 简单防膨胀
    if (this.map.size > 200) {
      const oldest = [...this.map.entries()].sort((a, b) => a[1].lastActive - b[1].lastActive)[0];
      if (oldest) this.map.delete(oldest[0]);
    }
  }

  reset(sessionId: string | undefined): void {
    if (sessionId) this.map.delete(sessionId);
  }
}

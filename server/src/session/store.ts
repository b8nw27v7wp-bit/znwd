import type { ChatMessage } from '../llm/types.js';

const MAX_TURNS = 6;
const TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 200;

interface SessionEntry {
  messages: ChatMessage[];
  lastActive: number;
  createdAt: number;
}

function isAlive(entry: SessionEntry, now: number): boolean {
  return now - entry.lastActive <= TTL_MS;
}

function trim(entry: SessionEntry): void {
  const limit = MAX_TURNS * 2;
  if (entry.messages.length > limit) {
    entry.messages = entry.messages.slice(-limit);
  }
}

function evictOldest(map: Map<string, SessionEntry>): void {
  if (map.size <= MAX_SESSIONS) return;
  const sorted = [...map.entries()].sort((a, b) => a[1].lastActive - b[1].lastActive);
  const excess = map.size - MAX_SESSIONS;
  for (let i = 0; i < excess; i++) {
    const key = sorted[i]?.[0];
    if (key) map.delete(key);
  }
}

export class SessionStore {
  private map = new Map<string, SessionEntry>();

  /** 供 LLM 使用：刷新 lastActive */
  history(sessionId: string | undefined): ChatMessage[] {
    if (!sessionId) return [];
    const now = Date.now();
    const entry = this.map.get(sessionId);
    if (!entry || !isAlive(entry, now)) {
      this.map.delete(sessionId);
      return [];
    }
    entry.lastActive = now;
    trim(entry);
    return [...entry.messages];
  }

  /** 只读查看，不刷新 TTL */
  peek(sessionId: string): { messages: ChatMessage[]; lastActive: number } | null {
    const now = Date.now();
    const entry = this.map.get(sessionId);
    if (!entry || !isAlive(entry, now)) {
      this.map.delete(sessionId);
      return null;
    }
    trim(entry);
    return { messages: [...entry.messages], lastActive: entry.lastActive };
  }

  append(sessionId: string | undefined, user: string, assistant: string): void {
    if (!sessionId) return;
    const now = Date.now();
    let entry = this.map.get(sessionId);
    if (!entry || !isAlive(entry, now)) {
      entry = { messages: [], lastActive: now, createdAt: now };
      this.map.set(sessionId, entry);
    }
    entry.messages.push({ role: 'user', content: user });
    entry.messages.push({ role: 'assistant', content: assistant });
    entry.lastActive = now;
    trim(entry);
    evictOldest(this.map);
  }

  reset(sessionId: string | undefined): boolean {
    if (!sessionId) return false;
    return this.map.delete(sessionId);
  }

  count(): number {
    const now = Date.now();
    let n = 0;
    for (const entry of this.map.values()) {
      if (isAlive(entry, now)) n++;
    }
    return n;
  }
}

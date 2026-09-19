/**
 * 进程状态持久化（可选，PERSIST_STATE=true 时启用）。
 *
 * 为什么需要：会话/统计/反馈原本全在内存，server 一重启，运营侧的反馈历史与
 * 问答计数就清零——展厅每天开机/更新都会遇到。这里把这几项落盘到
 * DATA_DIR/state.json，启动恢复、定时与退出时写回。
 *
 * 不做的事：答案缓存不持久化（重启重建成本低，且与索引 generation 绑定）；
 * 会话按原有 TTL（10 分钟）过滤，过期的不恢复。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ChatMessage } from '../llm/types.js';
import type { FeedbackItem, UncoveredItem } from '../analytics/stats.js';

const VERSION = 1;

export interface PersistedSession {
  id: string;
  messages: ChatMessage[];
  lastActive: number;
  createdAt: number;
}

export interface PersistedState {
  version: number;
  savedAt: string;
  stats: {
    startedAt?: number;
    chatTotal?: number;
    ragHits?: number;
    errors?: number;
    noHits?: number;
    rewritten?: number;
    tokens?: { prompt?: number; completion?: number; reasoning?: number; total?: number; calls?: number };
  };
  feedback: FeedbackItem[];
  uncovered: UncoveredItem[];
  sessions: PersistedSession[];
}

export function stateFilePath(dataDir: string): string {
  return path.join(dataDir, 'state.json');
}

export async function readState(dataDir: string): Promise<PersistedState | null> {
  try {
    const raw = await fs.readFile(stateFilePath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as PersistedState;
    if (!parsed || parsed.version !== VERSION) return null;
    return {
      version: VERSION,
      savedAt: parsed.savedAt ?? new Date().toISOString(),
      stats: parsed.stats ?? {},
      feedback: Array.isArray(parsed.feedback) ? parsed.feedback : [],
      uncovered: Array.isArray(parsed.uncovered) ? parsed.uncovered : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
  } catch {
    return null;
  }
}

/** 原子写：临时文件 + rename，避免进程中途被杀留下半个 JSON */
export async function writeState(dataDir: string, state: Omit<PersistedState, 'version' | 'savedAt'>): Promise<void> {
  const payload: PersistedState = {
    version: VERSION,
    savedAt: new Date().toISOString(),
    ...state,
  };
  const target = stateFilePath(dataDir);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
  await fs.rename(tmp, target);
}

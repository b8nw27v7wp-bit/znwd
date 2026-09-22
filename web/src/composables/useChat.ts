import { reactive, ref } from 'vue';
import type { ChatMeta, HealthInfo, Message, Source, Suggestion, ZoneInfo } from '../api';
import {
  fetchHealth,
  fetchSuggestions,
  fetchZones,
  newSessionId,
  resetSession,
  sendFeedback,
  streamChat,
} from '../api';

const SESSION_KEY = 'znwd.sessionId';
const ZONE_KEY = 'znwd.zone';
/** 技术问题留存条数：只给运营视图看，页面上一律不显示 */
const ERROR_LOG_SIZE = 20;

export type TechError = { at: number; question: string; message: string };

/**
 * 问答状态机。
 *
 * 两个刻意的设计：
 * 1) 会话 ID 落 localStorage —— 展厅同一台机、同一位参观者连续追问时上下文不丢；换人点"新对话"即重置。
 * 2) 流式回答失败时保留已收到的半句并标注错误，而不是把整条消息抹掉——现场看到一半突然空白最差。
 */
export function useChat() {
  const messages = ref<Message[]>([]);
  const streaming = ref(false);
  const sessionId = ref<string>(readSessionId());
  const zone = ref<string | null>(localStorage.getItem(ZONE_KEY));
  const suggestions = ref<Suggestion[]>([]);
  const zones = ref<ZoneInfo[]>([]);
  const health = ref<HealthInfo | null>(null);
  const sources = ref<Source[]>([]);
  const lastMeta = ref<ChatMeta | null>(null);
  const error = ref<string>('');
  /** 最近的技术问题（回答失败的原因），只在运营视图里列出来 */
  const errors = ref<TechError[]>([]);
  const feedback = ref<Record<string, 'up' | 'down'>>({});

  let controller: AbortController | null = null;

  function readSessionId(): string {
    const saved = localStorage.getItem(SESSION_KEY);
    if (saved) return saved;
    const fresh = newSessionId();
    localStorage.setItem(SESSION_KEY, fresh);
    return fresh;
  }

  async function bootstrap(): Promise<void> {
    try {
      health.value = await fetchHealth();
    } catch {
      health.value = null;
    }
    try {
      const data = await fetchZones();
      zones.value = data.zones ?? [];
    } catch {
      zones.value = [];
    }
    await loadSuggestions();
  }

  async function loadSuggestions(): Promise<void> {
    try {
      suggestions.value = await fetchSuggestions(zone.value);
    } catch {
      suggestions.value = [];
    }
  }

  async function setZone(next: string | null): Promise<void> {
    zone.value = next;
    if (next) localStorage.setItem(ZONE_KEY, next);
    else localStorage.removeItem(ZONE_KEY);
    await loadSuggestions();
  }

  async function ask(question: string): Promise<void> {
    const text = question.trim();
    if (!text || streaming.value) return;
    error.value = '';
    sources.value = [];
    lastMeta.value = null;

    messages.value.push({ id: `u-${Date.now()}`, role: 'user', content: text });
    // 必须是 reactive：push 进响应式数组的普通对象在数组里被代理，但流式回调改的是原始对象，
    // 字段变更不会被追踪（以前靠 streaming 变化顺带重渲染才读到新值，一旦模板里有基于消息内容的
    // computed 就会读到空答案）。
    const assistant = reactive<Message>({
      id: `a-${Date.now()}`,
      role: 'assistant',
      content: '',
      pending: true,
      meta: null,
    });
    messages.value.push(assistant);
    streaming.value = true;
    const started = performance.now();

    controller = new AbortController();
    try {
      await streamChat(text, sessionId.value, {
        onMeta: (meta) => {
          assistant.meta = meta;
          lastMeta.value = meta;
          sources.value = meta.sources ?? [];
        },
        onDelta: (chunk) => {
          assistant.content += chunk;
        },
        onDone: (done) => {
          assistant.pending = false;
          assistant.meta = done;
          assistant.latencyMs = done.latencyMs;
          sources.value = done.sources ?? [];
          lastMeta.value = done;
          if (done.sessionId && done.sessionId !== sessionId.value) {
            sessionId.value = done.sessionId;
            localStorage.setItem(SESSION_KEY, done.sessionId);
          }
        },
      }, controller.signal);
    } catch (e) {
      assistant.pending = false;
      const message = e instanceof Error ? e.message : '请求失败';
      if (!assistant.content) assistant.content = '这条问题暂时没能回答，请再试一次。';
      assistant.error = message;
      error.value = message;
      logError(text, message);
    } finally {
      assistant.pending = false;
      if (!assistant.content) assistant.content = '（没有返回内容）';
      if (!assistant.latencyMs) assistant.latencyMs = Math.round(performance.now() - started);
      streaming.value = false;
      controller = null;
    }
  }

  function cancel(): void {
    controller?.abort();
  }

  /**
   * 记一条技术问题（只在运营视图里显示）。
   *
   * 回答失败与**语音播报失败**共用这一条通道：展厅大屏上不给参观者看技术信息，
   * 但运营必须能看到「为什么没声音 / 没回答」——否则现场只会表现为「坏了」。
   */
  function logError(question: string, message: string): void {
    errors.value.unshift({ at: Date.now(), question, message });
    if (errors.value.length > ERROR_LOG_SIZE) errors.value.length = ERROR_LOG_SIZE;
  }

  /** 运营处理完就清掉，避免越堆越多 */
  function clearErrors(): void {
    errors.value = [];
  }

  async function rate(message: Message, rating: 'up' | 'down'): Promise<void> {
    feedback.value[message.id] = rating;
    const index = messages.value.findIndex((m) => m.id === message.id);
    const question = index > 0 ? messages.value[index - 1]?.content : undefined;
    await sendFeedback({ sessionId: sessionId.value, rating, question });
  }

  async function startOver(): Promise<void> {
    await resetSession(sessionId.value);
    const fresh = newSessionId();
    sessionId.value = fresh;
    localStorage.setItem(SESSION_KEY, fresh);
    messages.value = [];
    sources.value = [];
    lastMeta.value = null;
    feedback.value = {};
    error.value = '';
    await loadSuggestions();
  }

  return {
    messages,
    streaming,
    sessionId,
    zone,
    zones,
    suggestions,
    health,
    sources,
    lastMeta,
    error,
    errors,
    feedback,
    bootstrap,
    setZone,
    ask,
    cancel,
    clearErrors,
    logError,
    rate,
    startOver,
  };
}

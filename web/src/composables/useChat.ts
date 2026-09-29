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
import { readStorage, removeStorage, writeStorage } from '../storage';

const SESSION_KEY = 'znwd.sessionId';
const ZONE_KEY = 'znwd.zone';
/**
 * 会话归属令牌：**只放内存与 sessionStorage**，不进 URL、不进日志。
 * 为什么不用 localStorage：令牌是「这一个会话」的凭证，同一台机换个标签页/换个人就不该带着别人的令牌；
 * 隐私模式下 sessionStorage 取不到也不影响——内存里那份还在，只是刷新页面后要重新拿。
 */
const SESSION_TOKEN_KEY = 'znwd.sessionToken';
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
  const resetting = ref(false);
  const sessionId = ref<string>(readSessionId());
  const sessionToken = ref<string>(readStorage('session', SESSION_TOKEN_KEY) ?? '');
  const zone = ref<string | null>(readStorage('local', ZONE_KEY));
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
  let suggestionsGeneration = 0;
  let streamGeneration = 0;
  let resetGeneration = 0;
  let activeAssistant: Message | null = null;
  const feedbackOperations = new Map<string, number>();

  function readSessionId(): string {
    const saved = readStorage('local', SESSION_KEY);
    if (saved) return saved;
    const fresh = newSessionId();
    writeStorage('local', SESSION_KEY, fresh);
    return fresh;
  }

  /** 服务端在 done 帧里下发令牌：记在内存 + sessionStorage，供 DELETE /api/sessions/{id} 带回 */
  function rememberToken(token: string): void {
    sessionToken.value = token;
    writeStorage('session', SESSION_TOKEN_KEY, token);
  }

  /** 会话换了（或已清掉）：旧令牌必须一并丢掉——它只对上一个会话有效 */
  function forgetToken(): void {
    sessionToken.value = '';
    removeStorage('session', SESSION_TOKEN_KEY);
  }

  function invalidateStream(): void {
    streamGeneration += 1;
    const current = controller;
    controller = null;
    current?.abort();
    streaming.value = false;
    const assistant = activeAssistant;
    activeAssistant = null;
    if (assistant) {
      assistant.pending = false;
      assistant.error = '已取消';
      if (!assistant.content) assistant.content = '（回答已取消）';
    }
  }

  async function bootstrap(): Promise<void> {
    const [healthResult, zonesResult] = await Promise.allSettled([fetchHealth(), fetchZones()]);
    health.value = healthResult.status === 'fulfilled' ? healthResult.value : null;
    zones.value = zonesResult.status === 'fulfilled' ? zonesResult.value.zones ?? [] : [];
    await loadSuggestions();
  }

  async function loadSuggestions(): Promise<void> {
    const generation = ++suggestionsGeneration;
    const requestedZone = zone.value;
    try {
      const next = await fetchSuggestions(requestedZone);
      if (generation === suggestionsGeneration && zone.value === requestedZone) {
        suggestions.value = next;
      }
    } catch {
      if (generation === suggestionsGeneration && zone.value === requestedZone) {
        suggestions.value = [];
      }
    }
  }

  async function setZone(next: string | null): Promise<void> {
    zone.value = next;
    if (next) writeStorage('local', ZONE_KEY, next);
    else removeStorage('local', ZONE_KEY);
    await loadSuggestions();
  }

  async function ask(question: string): Promise<void> {
    const text = question.trim();
    if (!text || streaming.value || resetting.value) return;
    error.value = '';
    sources.value = [];
    lastMeta.value = null;

    const generation = ++streamGeneration;
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
    activeAssistant = assistant;
    const started = performance.now();
    const requestController = new AbortController();
    const requestSessionId = sessionId.value;
    controller = requestController;

    try {
      await streamChat(text, requestSessionId, {
        onMeta: (meta) => {
          if (generation !== streamGeneration) return;
          assistant.meta = meta;
          lastMeta.value = meta;
          sources.value = meta.sources ?? [];
        },
        onDelta: (chunk) => {
          if (generation !== streamGeneration) return;
          assistant.content += chunk;
        },
        onDone: (done) => {
          if (generation !== streamGeneration) return;
          assistant.pending = false;
          assistant.content = done.answer;
          assistant.meta = done;
          assistant.latencyMs = done.latencyMs;
          sources.value = done.sources ?? [];
          lastMeta.value = done;
          if (typeof done.sessionId === 'string' && done.sessionId && done.sessionId !== sessionId.value) {
            sessionId.value = done.sessionId;
            writeStorage('local', SESSION_KEY, done.sessionId);
          }
          // 令牌跟着会话走：拿到就存下来，换人清上下文时要原样带回服务端
          if (typeof done.sessionToken === 'string' && done.sessionToken) {
            rememberToken(done.sessionToken);
          }
        },
      }, requestController.signal);
    } catch (e) {
      if (generation !== streamGeneration) return;
      assistant.pending = false;
      const message = e instanceof Error ? e.message : '请求失败';
      if (!assistant.content) assistant.content = '这条问题暂时没能回答，请再试一次。';
      assistant.error = message;
      error.value = message;
      logError(text, message);
    } finally {
      if (generation === streamGeneration) {
        assistant.pending = false;
        if (!assistant.content) assistant.content = '（没有返回内容）';
        if (!assistant.latencyMs) assistant.latencyMs = Math.round(performance.now() - started);
        streaming.value = false;
        if (controller === requestController) controller = null;
        activeAssistant = null;
      }
    }
  }

  function cancel(): void {
    invalidateStream();
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
    const previous = feedback.value[message.id];
    const operation = (feedbackOperations.get(message.id) ?? 0) + 1;
    feedbackOperations.set(message.id, operation);
    feedback.value[message.id] = rating;
    const index = messages.value.findIndex((m) => m.id === message.id);
    const question = index > 0 ? messages.value[index - 1]?.content : undefined;
    const requestSessionId = sessionId.value;
    try {
      await sendFeedback({ sessionId: requestSessionId, rating, question });
    } catch (e) {
      if (feedbackOperations.get(message.id) === operation) {
        if (previous) feedback.value[message.id] = previous;
        else delete feedback.value[message.id];
      }
      const messageText = e instanceof Error ? e.message : '反馈失败';
      error.value = messageText;
      logError(question ?? '（反馈）', messageText);
    }
  }

  async function startOver(): Promise<void> {
    const operation = ++resetGeneration;
    resetting.value = true;
    suggestionsGeneration += 1;
    invalidateStream();
    try {
      const previousSessionId = sessionId.value;
      const previousToken = sessionToken.value;
      let resetError = '';
      try {
        // 带上令牌：服务端对下发过令牌的会话，不带就回 404，等于没清掉（换人失败但看不出来）
        await resetSession(previousSessionId, previousToken || null);
      } catch (e) {
        resetError = e instanceof Error ? e.message : '重置会话失败';
        logError('（重置会话）', resetError);
      }
      if (operation !== resetGeneration) return;
      const fresh = newSessionId();
      sessionId.value = fresh;
      writeStorage('local', SESSION_KEY, fresh);
      forgetToken();
      messages.value = [];
      sources.value = [];
      lastMeta.value = null;
      feedback.value = {};
      feedbackOperations.clear();
      error.value = resetError;
      await loadSuggestions();
    } finally {
      if (operation === resetGeneration) resetting.value = false;
    }
  }

  return {
    messages,
    streaming,
    resetting,
    sessionId,
    sessionToken,
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

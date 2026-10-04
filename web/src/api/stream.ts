/**
 * SSE 流式问答：POST /api/chat/stream → meta → delta* → done。
 *
 * 职责三块：
 * 1) 断流活性：总超时 180s（STREAM_TIMEOUT_MS）+ 无字节 45s（STREAM_INACTIVITY_MS，
 *    3× 后端 :ping 心跳间隔）提前失败，两种语义靠错误名与文案区分；
 * 2) 严格帧解析：event/data 齐全、JSON 可解析、meta→delta→done 顺序与字段都校验，
 *    跨 TCP chunk 的半帧先缓存再重组（splitSseBuffer），`event: error` 直接以 payload 文案抛错；
 * 3) 资源收口：任何失败都取消 reader、清掉两个计时器。
 */

import {
  apiUrl,
  awaitWithAbort,
  isFiniteNumber,
  isRecord,
  isTimeoutError,
  json,
  safeError,
  timeoutError,
} from './http';
import type { ChatDone, ChatMeta, StreamHandlers } from './types';

export const STREAM_TIMEOUT_MS = 180_000;

/**
 * 断流活性阈值：服务端每 15s 发一次 `:ping` 注释心跳（ChatController），连续 3 次没到
 * 就判定连接已僵死——对端不关流也不吐字时，不该干等 180s 总上限才报错。
 */
export const STREAM_INACTIVITY_MS = 45_000;

type StreamReader = ReadableStreamDefaultReader<Uint8Array>;

/** 活性超时：与总超时同为 TimeoutError，但 `inactivity` 标记让调用方能区分两种语义 */
function inactivityError(): Error {
  const error = timeoutError(`连接中断（${STREAM_INACTIVITY_MS / 1000} 秒未收到数据，超时中止）`);
  (error as Error & { inactivity?: true }).inactivity = true;
  return error;
}

function isInactivityError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      (error as { inactivity?: unknown }).inactivity === true,
  );
}

/**
 * 总超时（180s 上限）判定。活性超时不算——连接僵死重开一条流多半就好，值得自动重问一次；
 * 总超时则是「等满了完整上限」，再重试只是把失败再拖 180s。
 */
export function isTotalTimeoutError(error: unknown): boolean {
  return isTimeoutError(error) && !isInactivityError(error);
}

/** 流式请求的信号壳：总超时 + 活性超时 + 跟随外部 signal，touch() 每收到字节刷新活性 */
function createStreamSignal(external: AbortSignal | undefined): {
  signal: AbortSignal;
  timedOut: () => boolean;
  /** 收到任何字节（含 :ping 注释）后调用：刷新活性计时器 */
  touch: () => void;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  let inactivityExpired = false;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  const onExternalAbort = () => {
    if (!controller.signal.aborted) controller.abort(external?.reason);
  };
  if (external?.aborted) onExternalAbort();
  else external?.addEventListener('abort', onExternalAbort, { once: true });
  // 总超时计时器：声明直接落在赋值处（prefer-const）。声明点到赋值点之间无人读 timer，
  // cleanup 等闭包都在赋值之后创建，行为与原来「先 let 后赋」完全一致。
  const timer = setTimeout(() => {
    timedOut = true;
    // 总超时接管：活性计时器没必要再留着（两个都 abort 同一个 controller，但 catch 的判定要干净）
    if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
    controller.abort(timeoutError('流式回答超时'));
  }, STREAM_TIMEOUT_MS);
  const armInactivity = (): void => {
    inactivityTimer = setTimeout(() => {
      inactivityExpired = true;
      controller.abort(inactivityError());
    }, STREAM_INACTIVITY_MS);
  };
  armInactivity();
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    touch: () => {
      if (inactivityExpired || controller.signal.aborted) return;
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
      armInactivity();
    },
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer);
      if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}

function readChunk(reader: StreamReader, signal: AbortSignal): Promise<ReadableStreamReadResult<Uint8Array>> {
  let read: Promise<ReadableStreamReadResult<Uint8Array>>;
  try {
    read = reader.read();
  } catch (error) {
    return Promise.reject(error);
  }
  return awaitWithAbort(read, signal);
}

function cancelReader(reader: StreamReader): void {
  try {
    void Promise.resolve(reader.cancel()).catch(() => {});
  } catch {
    return;
  }
}

type ParsedFrame =
  | { kind: 'meta'; value: ChatMeta }
  | { kind: 'delta'; value: string }
  | { kind: 'done'; value: ChatDone };

function validateSource(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`非法 SSE ${label} 帧：sources 项不是对象`);
  if (typeof value.title !== 'string' || typeof value.snippet !== 'string' || typeof value.sourcePath !== 'string') {
    throw new Error(`非法 SSE ${label} 帧：sources 项字段无效`);
  }
  if (!isFiniteNumber(value.score)) throw new Error(`非法 SSE ${label} 帧：sources.score 无效`);
  for (const key of ['zone', 'zoneTitle']) {
    const field = value[key];
    if (field !== undefined && field !== null && typeof field !== 'string') {
      throw new Error(`非法 SSE ${label} 帧：sources.${key} 无效`);
    }
  }
  for (const key of ['vectorScore', 'keywordScore']) {
    const field = value[key];
    if (field !== undefined && field !== null && !isFiniteNumber(field)) {
      throw new Error(`非法 SSE ${label} 帧：sources.${key} 无效`);
    }
  }
  // 命中定位三件套（chunkText/matchTerm/matchOffset）是后加的：老服务端整体缺省，按可选处理；
  // 类型不对时当场丢弃该字段降级——一条来源的展示字段出错，不该废掉整条消息。
  for (const key of ['chunkText', 'matchTerm'] as const) {
    const field = value[key];
    if (field !== undefined && (field === null || typeof field !== 'string')) delete value[key];
  }
  if (value.matchOffset !== undefined && (value.matchOffset === null || !isFiniteNumber(value.matchOffset))) {
    delete value.matchOffset;
  }
}

function validateRewrite(value: unknown, label: string): void {
  if (!isRecord(value) || typeof value.rewritten !== 'boolean' || typeof value.reason !== 'string') {
    throw new Error(`非法 SSE ${label} 帧：rewrite 无效`);
  }
  if (!['none', 'no_history', 'prev_weak', 'ellipsis_merged'].includes(value.reason)) {
    throw new Error(`非法 SSE ${label} 帧：rewrite.reason 无效`);
  }
  if (value.carriedTokens !== undefined) {
    if (!Array.isArray(value.carriedTokens) || value.carriedTokens.some((token) => typeof token !== 'string')) {
      throw new Error(`非法 SSE ${label} 帧：rewrite.carriedTokens 无效`);
    }
  }
}

function validateUsage(value: unknown, label: string): void {
  if (value === undefined || value === null) return;
  if (!isRecord(value)) throw new Error(`非法 SSE ${label} 帧：usage 无效`);
  for (const key of ['promptTokens', 'completionTokens', 'reasoningTokens', 'totalTokens']) {
    const field = value[key];
    if (field !== undefined && (!isFiniteNumber(field) || !Number.isInteger(field))) {
      throw new Error(`非法 SSE ${label} 帧：usage.${key} 无效`);
    }
  }
}

function validateMeta(value: Record<string, unknown>, label: 'meta' | 'done'): ChatMeta {
  if (value.mode !== 'rag' && value.mode !== 'llm_only') {
    throw new Error(`非法 SSE ${label} 帧：mode 无效`);
  }
  if (typeof value.provider !== 'string') throw new Error(`非法 SSE ${label} 帧：provider 无效`);
  if (value.retrieval !== 'hybrid' && value.retrieval !== 'keyword') {
    throw new Error(`非法 SSE ${label} 帧：retrieval 无效`);
  }
  if (typeof value.noHit !== 'boolean') throw new Error(`非法 SSE ${label} 帧：noHit 无效`);
  if (!Array.isArray(value.sources)) throw new Error(`非法 SSE ${label} 帧：sources 无效`);
  for (const source of value.sources) validateSource(source, label);
  if (value.sessionId !== undefined && value.sessionId !== null && typeof value.sessionId !== 'string') {
    throw new Error(`非法 SSE ${label} 帧：sessionId 无效`);
  }
  if (value.rewrite !== undefined && value.rewrite !== null) validateRewrite(value.rewrite, label);
  if (value.cached !== undefined && typeof value.cached !== 'boolean') {
    throw new Error(`非法 SSE ${label} 帧：cached 无效`);
  }
  return value as unknown as ChatMeta;
}

function validateDone(value: Record<string, unknown>): ChatDone {
  if (typeof value.answer !== 'string' || value.answer.trim().length === 0) {
    throw new Error('非法 SSE done 帧：缺少有效 answer');
  }
  if (!isFiniteNumber(value.latencyMs)) throw new Error('非法 SSE done 帧：latencyMs 无效');
  validateMeta(value, 'done');
  validateUsage(value.usage, 'done');
  return value as unknown as ChatDone;
}

function parseFrame(frame: string): ParsedFrame | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  let hasContent = false;
  for (const rawLine of frame.split(/\r\n|\r|\n/)) {
    if (!rawLine || rawLine.startsWith(':')) continue;
    hasContent = true;
    const colon = rawLine.indexOf(':');
    const field = colon === -1 ? rawLine : rawLine.slice(0, colon);
    const rawValue = colon === -1 ? '' : rawLine.slice(colon + 1);
    if (field === 'event') {
      event = rawValue.trim();
    } else if (field === 'data') {
      dataLines.push(rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue);
    }
  }
  if (!hasContent) return null;
  if (!event) throw new Error('非法 SSE 帧：缺少 event');
  if (!dataLines.length) throw new Error('非法 SSE 帧：缺少 data');
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataLines.join('\n'));
  } catch {
    throw new Error('非法 SSE 帧');
  }
  if (!isRecord(parsed)) throw new Error('非法 SSE 帧');
  if (event === 'meta') return { kind: 'meta', value: validateMeta(parsed, 'meta') };
  if (event === 'delta') {
    if (typeof parsed.text !== 'string' || parsed.text.length === 0) {
      throw new Error('非法 SSE delta 帧：缺少 text');
    }
    return { kind: 'delta', value: parsed.text };
  }
  if (event === 'done') return { kind: 'done', value: validateDone(parsed) };
  if (event === 'error') {
    if (typeof parsed.message !== 'string' || !parsed.message) throw new Error('服务内部错误');
    throw new Error(parsed.message);
  }
  throw new Error(`非法 SSE 事件：${event}`);
}

function splitSseBuffer(value: string, final = false): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let frameStart = 0;
  let lineStart = 0;
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    let lineEnd = -1;
    if (code === 10) {
      lineEnd = index;
      index += 1;
    } else if (code === 13) {
      if (index + 1 >= value.length && !final) break;
      lineEnd = index;
      index += index + 1 < value.length && value.charCodeAt(index + 1) === 10 ? 2 : 1;
    } else {
      index += 1;
      continue;
    }
    if (lineStart === lineEnd) {
      frames.push(value.slice(frameStart, lineStart));
      frameStart = index;
    }
    lineStart = index;
  }
  return { frames, rest: value.slice(frameStart) };
}

export async function streamChat(
  message: string,
  sessionId: string | null,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const timeout = createStreamSignal(signal);
  let reader: StreamReader | null = null;
  try {
    const res = await awaitWithAbort(
      fetch(apiUrl('/api/chat/stream'), {
        method: 'POST',
        headers: { ...json, accept: 'text/event-stream' },
        body: JSON.stringify({ message, sessionId }),
        signal: timeout.signal,
      }),
      timeout.signal,
    );
    if (!res.ok) throw new Error(await safeError(res, timeout.signal));
    if (!res.body) throw new Error('响应没有可读流');
    reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '';
    let sawMeta = false;
    let sawDone = false;
    const consume = (frame: string): void => {
      const parsed = parseFrame(frame);
      if (!parsed) return;
      if (sawDone) throw new Error('SSE done 后存在事件帧');
      if (parsed.kind === 'meta') {
        if (sawMeta) throw new Error('SSE meta 帧重复或顺序错误');
        sawMeta = true;
        handlers.onMeta(parsed.value);
      } else if (parsed.kind === 'delta') {
        if (!sawMeta) throw new Error('SSE delta 帧顺序错误');
        handlers.onDelta(parsed.value);
      } else {
        if (!sawMeta) throw new Error('SSE done 帧顺序错误');
        sawDone = true;
        handlers.onDone(parsed.value);
      }
    };
    const consumeBuffer = (final = false): void => {
      const batch = splitSseBuffer(buffer, final);
      buffer = batch.rest;
      for (const frame of batch.frames) consume(frame);
    };

    for (;;) {
      const result = await readChunk(reader, timeout.signal);
      if (result.value) {
        // 收到任何字节都算活性（含 :ping 注释心跳、跨 chunk 的半帧）——
        // parseFrame 会把心跳丢弃，所以刷新必须在消费之前、按字节做
        timeout.touch();
        buffer += decoder.decode(result.value, { stream: true });
      }
      consumeBuffer();
      if (result.done) break;
    }

    buffer += decoder.decode();
    consumeBuffer(true);
    if (buffer.trim()) consume(buffer);
    if (!sawDone) throw new Error('SSE 流在 done 前结束');
  } catch (error) {
    if (timeout.timedOut()) throw timeoutError('流式回答超时');
    throw error;
  } finally {
    timeout.cleanup();
    if (reader) cancelReader(reader);
  }
}

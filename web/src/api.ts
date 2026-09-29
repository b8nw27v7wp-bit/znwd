/**
 * 后端接口封装。
 *
 * 契约与 Spring Boot 后端一一对应（见 docs/api.md）：
 *   POST /api/chat         非流式
 *   POST /api/chat/stream  SSE：meta → delta* → done
 *   GET  /api/suggestions  推荐问题（?zone=）
 *   GET  /api/zones        展区与展项
 *   POST /api/feedback     点赞/点踩
 *   GET  /api/health       运行状态（含 storageAvailable，数据库掉了要能看出来）
 *   管理面（stats/admin/knowledge）统一走 adminRequest，带 authorization 头
 */

export type Role = 'user' | 'assistant';

export interface Source {
  title: string;
  snippet: string;
  score: number;
  sourcePath: string;
  zone?: string | null;
  zoneTitle?: string | null;
  vectorScore?: number | null;
  keywordScore?: number | null;
  /** 命中分块完整原文（约 500 字）；老服务端不下发，缺省时来源面板不给「查看全文」 */
  chunkText?: string;
  /** 本次命中关键词；后端 jackson non_null，可能整个 key 缺省——判空用 !source.matchTerm */
  matchTerm?: string;
  /** matchTerm 在 chunkText 中的字符偏移；-1 = 未定位（此时 matchTerm 缺省） */
  matchOffset?: number;
}

export interface RewriteInfo {
  rewritten: boolean;
  reason: 'none' | 'no_history' | 'prev_weak' | 'ellipsis_merged';
  carriedTokens?: string[];
}

export interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

/**
 * SSE 的 meta 帧：模型开始吐字之前的「路由信息」。
 *
 * 它是 done 帧的**子集**（后端如此设计），done 到齐后前端会用它覆盖 meta。
 * 所以这里只声明 meta 帧真的会给的字段。
 */
export interface ChatMeta {
  sessionId?: string | null;
  mode: 'rag' | 'llm_only';
  provider: string;
  retrieval: 'hybrid' | 'keyword';
  noHit: boolean;
  sources: Source[];
  rewrite?: RewriteInfo | null;
  /** 只有 done 帧带它——meta 帧不给，所以读取时要按可选处理（`message.meta?.cached`） */
  cached?: boolean;
}

/** SSE 的 done 帧：meta 的超集（多出正文、耗时、用量与缓存标记） */
export interface ChatDone extends ChatMeta {
  answer: string;
  latencyMs: number;
  usage?: Usage | null;
  /**
   * 会话归属令牌：服务端给这个 sessionId 发的一次性所有权凭证。
   * 只有 done 帧带（meta 帧不带）。GET/DELETE /api/sessions/{id} 要原样带回，
   * 不带或带错一律 404——服务端靠它区分「这是我的会话」与「有人在枚举别人的 id」。
   */
  sessionToken?: string | null;
}

export interface Message {
  id: string;
  role: Role;
  content: string;
  pending?: boolean;
  meta?: ChatMeta | null;
  latencyMs?: number;
  error?: string | null;
}

export interface ZoneInfo {
  id: string;
  title?: string;
  dir?: string;
  aliases?: string[];
  suggestions?: string[];
}

/** 推荐问题就是一行文字（后端 /api/suggestions 的 items 是字符串数组，与旧契约一致） */
export type Suggestion = string;

export interface HealthInfo {
  ok: boolean;
  ready?: boolean;
  version?: string;
  knowledgeChunks: number;
  llmProvider: string;
  /** 语音 provider：none = 未启用（前端用浏览器内置播报），mimo = 服务端 TTS/ASR 可用 */
  speech?: string;
  /** 服务端语音是否可用：决定播报走服务端还是浏览器 */
  speechReady?: boolean;
  embedding: string;
  retrieval: string;
  storage: string;
  storageAvailable: boolean;
  activeSessions: number;
  minRelevanceScore: number;
  uptimeSec: number;
}

const json = { 'content-type': 'application/json' };
const configuredApiBase = String(import.meta.env.VITE_API_BASE_URL ?? '')
  .trim()
  .replace(/\/+$/, '');

export function apiUrl(path: string): string {
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return configuredApiBase ? `${configuredApiBase}${suffix}` : suffix;
}

export function newSessionId(): string {
  const cryptoApi = (globalThis as typeof globalThis & {
    crypto?: { randomUUID?: () => string; getRandomValues?: (array: Uint8Array) => Uint8Array };
  }).crypto;
  if (cryptoApi?.randomUUID) {
    return `kiosk-${cryptoApi.randomUUID()}`;
  }
  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    return `kiosk-${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}`;
  }
  return `kiosk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function fetchHealth(): Promise<HealthInfo> {
  const timeout = requestTimeout(undefined, 10_000);
  try {
    const res = await awaitWithAbort(fetch(apiUrl('/api/health'), { signal: timeout.signal }), timeout.signal);
    if (!res.ok) throw new Error(`health ${res.status}`);
    return (await awaitWithAbort(res.json(), timeout.signal)) as HealthInfo;
  } finally {
    timeout.cleanup();
  }
}

export async function fetchZones(): Promise<{ zones: ZoneInfo[] }> {
  const timeout = requestTimeout(undefined, 10_000);
  try {
    const res = await awaitWithAbort(fetch(apiUrl('/api/zones'), { signal: timeout.signal }), timeout.signal);
    if (!res.ok) throw new Error(`zones ${res.status}`);
    return (await awaitWithAbort(res.json(), timeout.signal)) as { zones: ZoneInfo[] };
  } finally {
    timeout.cleanup();
  }
}

export async function fetchSuggestions(zone?: string | null): Promise<Suggestion[]> {
  const url = apiUrl(zone ? `/api/suggestions?zone=${encodeURIComponent(zone)}` : '/api/suggestions');
  const timeout = requestTimeout(undefined, 10_000);
  try {
    const res = await awaitWithAbort(fetch(url, { signal: timeout.signal }), timeout.signal);
    if (!res.ok) throw new Error(`suggestions ${res.status}`);
    const data = (await awaitWithAbort(res.json(), timeout.signal)) as { items?: unknown[] };
    // 兜一层：万一后端将来改成对象数组，这里也不会渲染出空白按钮
    return (data.items ?? [])
      .map((item) => (typeof item === 'string' ? item : ((item as { question?: string }).question ?? '')))
      .filter((question) => question.trim().length > 0);
  } finally {
    timeout.cleanup();
  }
}

export async function sendFeedback(payload: {
  sessionId: string | null;
  rating: 'up' | 'down';
  question?: string;
  comment?: string;
}): Promise<void> {
  const timeout = requestTimeout(undefined, 15_000);
  try {
    const res = await awaitWithAbort(
      fetch(apiUrl('/api/feedback'), {
        method: 'POST', headers: json, body: JSON.stringify(payload), signal: timeout.signal,
      }),
      timeout.signal,
    );
    if (!res.ok) throw new Error(await safeError(res, timeout.signal));
  } finally {
    timeout.cleanup();
  }
}

/**
 * 清掉服务端这个会话的上下文（换人用）。
 *
 * 带令牌是必须的：服务端对下发过令牌的会话，GET/DELETE 不带或不匹配一律回 404，
 * 于是「换人清上下文」会静默失败——上一轮的对话还留在服务端。
 * 令牌为空时不带头（从未下发过令牌的老会话按设计仍然放行）。
 */
export async function resetSession(sessionId: string, token?: string | null): Promise<void> {
  const timeout = requestTimeout(undefined, 10_000);
  try {
    const headers: Record<string, string> = {};
    if (token) headers['x-session-token'] = token;
    const res = await awaitWithAbort(
      fetch(apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}`), {
        method: 'DELETE', headers, signal: timeout.signal,
      }),
      timeout.signal,
    );
    if (!res.ok) throw new Error(await safeError(res, timeout.signal));
  } finally {
    timeout.cleanup();
  }
}

// ---------- 管理接口：口令由运营视图存 sessionStorage（znwd.adminToken），这里统一加 authorization 头 ----------

/**
 * /api/stats、/api/admin/*、/api/knowledge/* 的公共出口。
 *
 * <p>401（口令缺失/不对）翻译成一句运营看得懂的话；其余失败一律抛带原因的 Error，
 * 调用方只管显示——管理面板上任何失败都不允许静默。
 */
async function adminRequest<T>(
  path: string,
  token: string | null,
  options: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const timeout = requestTimeout(undefined, options.timeoutMs ?? 10_000);
  try {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const init: RequestInit = { headers, signal: timeout.signal };
    if (options.method) init.method = options.method;
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    const res = await awaitWithAbort(fetch(apiUrl(path), init), timeout.signal);
    if (res.status === 401) throw new Error('口令不正确（401）');
    if (!res.ok) throw new Error(await safeError(res, timeout.signal));
    try {
      return (await awaitWithAbort(res.json(), timeout.signal)) as T;
    } catch (error) {
      if (isAbortError(error) || isTimeoutError(error)) throw error;
      throw new Error('管理接口返回的不是 JSON（后端可能没起来）');
    }
  } finally {
    timeout.cleanup();
  }
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

export interface AdminStats {
  chatTotal?: number;
  ragHits?: number;
  noHit?: number;
  rewritten?: number;
  errors?: number;
  activeSessions?: number;
  tokens?: { prompt?: number; completion?: number; reasoning?: number; total?: number };
  [key: string]: unknown;
}

export interface UncoveredItem {
  question: string;
  at: number;
}

export interface FeedbackStats {
  up?: number;
  down?: number;
  [key: string]: unknown;
}

export async function fetchAdminStats(token: string | null): Promise<AdminStats> {
  return adminRequest<AdminStats>('/api/stats', token);
}

export async function fetchUncovered(token: string | null): Promise<{ items: UncoveredItem[] }> {
  const data = await adminRequest<Record<string, unknown>>('/api/admin/uncovered', token);
  const items = Array.isArray(data.items) ? data.items.filter(isRecord) : [];
  return {
    items: items.map((item) => ({
      question: optionalString(item.question) ?? '',
      at: optionalNumber(item.at) ?? 0,
    })),
  };
}

export async function fetchFeedbackStats(token: string | null): Promise<FeedbackStats> {
  return adminRequest<FeedbackStats>('/api/admin/feedback-stats', token);
}

export interface KnowledgeDoc {
  path: string;
  title: string | null;
  zone: string | null;
  zoneTitle: string | null;
  chunks: number;
}

export interface KnowledgeListInfo {
  knowledgeDir: string | null;
  fileCount: number | null;
  chunkCount: number | null;
  synonyms: { count: number; source: string | null; file: string | null } | null;
  docs: KnowledgeDoc[];
}

export async function fetchKnowledgeList(token: string | null): Promise<KnowledgeListInfo> {
  const data = await adminRequest<Record<string, unknown>>('/api/knowledge/list', token);
  const rawDocs = Array.isArray(data.docs) ? data.docs.filter(isRecord) : [];
  const synonyms = isRecord(data.synonyms) ? data.synonyms : null;
  return {
    knowledgeDir: optionalString(data.knowledgeDir),
    fileCount: optionalNumber(data.fileCount),
    chunkCount: optionalNumber(data.chunkCount),
    synonyms: synonyms
      ? {
          count: optionalNumber(synonyms.count) ?? 0,
          source: optionalString(synonyms.source),
          file: optionalString(synonyms.file),
        }
      : null,
    docs: rawDocs.map((doc) => ({
      path: optionalString(doc.path) ?? '',
      title: optionalString(doc.title),
      zone: optionalString(doc.zone),
      zoneTitle: optionalString(doc.zoneTitle),
      chunks: optionalNumber(doc.chunks) ?? 0,
    })),
  };
}

/** 重建关键词/向量索引是重活，超时给足两分钟 */
export const KNOWLEDGE_RELOAD_TIMEOUT_MS = 120_000;

export interface KnowledgeReloadInfo {
  ok: boolean;
  knowledgeChunks: number | null;
  generation: number | null;
}

export async function reloadKnowledge(token: string | null): Promise<KnowledgeReloadInfo> {
  const data = await adminRequest<Record<string, unknown>>('/api/knowledge/reload', token, {
    method: 'POST',
    timeoutMs: KNOWLEDGE_RELOAD_TIMEOUT_MS,
  });
  return {
    ok: data.ok === true,
    knowledgeChunks: optionalNumber(data.knowledgeChunks),
    generation: optionalNumber(data.generation),
  };
}

export interface SynonymEntry {
  key: string;
  alternatives: string[];
}

export interface SynonymsInfo {
  count: number;
  source: string | null;
  file: string | null;
  entries: SynonymEntry[];
  /** TSV 原文：直接塞进编辑框，保存时按行回传 */
  tsv: string;
}

export async function fetchSynonyms(token: string | null): Promise<SynonymsInfo> {
  const data = await adminRequest<Record<string, unknown>>('/api/admin/synonyms', token);
  const rawEntries = Array.isArray(data.entries) ? data.entries.filter(isRecord) : [];
  const entries = rawEntries
    .map((entry) => ({
      key: optionalString(entry.key) ?? '',
      alternatives: Array.isArray(entry.alternatives)
        ? entry.alternatives.filter((alt): alt is string => typeof alt === 'string')
        : [],
    }))
    .filter((entry) => entry.key.length > 0);
  const tsv =
    optionalString(data.tsv) ?? entries.map((entry) => `${entry.key}\t${entry.alternatives.join(',')}`).join('\n');
  return {
    count: optionalNumber(data.count) ?? entries.length,
    source: optionalString(data.source),
    file: optionalString(data.file),
    entries,
    tsv,
  };
}

export interface SynonymsSaveResult {
  ok: boolean;
  count: number | null;
  /** 请求持久化时回写的文件路径；null = 落盘失败（内存已生效） */
  persistedTo: string | null;
}

export async function saveSynonyms(
  token: string | null,
  lines: string[],
  persist: boolean,
): Promise<SynonymsSaveResult> {
  const data = await adminRequest<Record<string, unknown>>('/api/admin/synonyms', token, {
    method: 'PUT',
    body: { lines, persist },
  });
  return {
    ok: data.ok === true,
    count: optionalNumber(data.count),
    persistedTo: optionalString(data.persistedTo),
  };
}

export interface DiagnosticsHit {
  title: string | null;
  sourcePath: string | null;
  zone: string | null;
  zoneTitle: string | null;
  fuseScore: number | null;
  keywordScore: number | null;
  vectorScore: number | null;
  snippet: string | null;
}

export interface DiagnosticsInfo {
  query: string;
  gated: boolean;
  mode: string | null;
  reason: string | null;
  keywordGateScore: number | null;
  keywordBestScore: number | null;
  vectorBestCosine: number | null;
  candidates: number | null;
  thresholds: { minKeywordScore: number | null; minVectorScore: number | null };
  distanceToGate: number | null;
  verdict: string | null;
  hits: DiagnosticsHit[];
}

export async function runDiagnostics(token: string | null, q: string, topK?: number): Promise<DiagnosticsInfo> {
  const topKPart = topK === undefined ? '' : `&topK=${topK}`;
  const data = await adminRequest<Record<string, unknown>>(
    `/api/admin/diagnostics?q=${encodeURIComponent(q)}${topKPart}`,
    token,
  );
  const rawHits = Array.isArray(data.hits) ? data.hits.filter(isRecord) : [];
  const thresholds = isRecord(data.thresholds) ? data.thresholds : {};
  return {
    query: optionalString(data.query) ?? q,
    gated: data.gated === true,
    mode: optionalString(data.mode),
    reason: optionalString(data.reason),
    keywordGateScore: optionalNumber(data.keywordGateScore),
    keywordBestScore: optionalNumber(data.keywordBestScore),
    vectorBestCosine: optionalNumber(data.vectorBestCosine),
    candidates: optionalNumber(data.candidates),
    thresholds: {
      minKeywordScore: optionalNumber(thresholds.minKeywordScore),
      minVectorScore: optionalNumber(thresholds.minVectorScore),
    },
    distanceToGate: optionalNumber(data.distanceToGate),
    verdict: optionalString(data.verdict),
    hits: rawHits.map((hit) => ({
      title: optionalString(hit.title),
      sourcePath: optionalString(hit.sourcePath),
      zone: optionalString(hit.zone),
      zoneTitle: optionalString(hit.zoneTitle),
      fuseScore: optionalNumber(hit.fuseScore),
      keywordScore: optionalNumber(hit.keywordScore),
      vectorScore: optionalNumber(hit.vectorScore),
      snippet: optionalString(hit.snippet),
    })),
  };
}

export interface StreamHandlers {
  onMeta: (meta: ChatMeta) => void;
  onDelta: (text: string) => void;
  onDone: (done: ChatDone) => void;
}

export const STREAM_TIMEOUT_MS = 180_000;

type StreamReader = ReadableStreamDefaultReader<Uint8Array>;

function isNamedError(value: unknown): value is Error {
  if (value instanceof Error) return true;
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { name?: unknown; message?: unknown };
  return typeof candidate.name === 'string' && typeof candidate.message === 'string';
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'name' in error &&
      (error as { name?: unknown }).name === 'AbortError',
  );
}

function isTimeoutError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'name' in error &&
      (error as { name?: unknown }).name === 'TimeoutError',
  );
}

function timeoutError(message: string): Error {
  const error = new Error(message);
  error.name = 'TimeoutError';
  return error;
}

function streamAbortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (isNamedError(reason)) return reason;
  const error = new Error('请求已取消');
  error.name = 'AbortError';
  return error;
}

function createStreamSignal(external: AbortSignal | undefined): {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onExternalAbort = () => {
    if (!controller.signal.aborted) controller.abort(external?.reason);
  };
  if (external?.aborted) onExternalAbort();
  else external?.addEventListener('abort', onExternalAbort, { once: true });
  timer = setTimeout(() => {
    timedOut = true;
    controller.abort(timeoutError('流式回答超时'));
  }, STREAM_TIMEOUT_MS);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}

function awaitWithAbort<T>(promise: PromiseLike<T> | T, signal: AbortSignal): Promise<T> {
  const pending = Promise.resolve(promise);
  if (signal.aborted) {
    void pending.catch(() => {});
    return Promise.reject(streamAbortError(signal));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(streamAbortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

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
      if (result.value) buffer += decoder.decode(result.value, { stream: true });
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

async function safeError(res: Response, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw streamAbortError(signal);
  try {
    const body = (await (signal ? awaitWithAbort(res.json(), signal) : res.json())) as {
      message?: unknown;
      error?: unknown;
    };
    if (body && typeof body === 'object') {
      if (typeof body.message === 'string' && body.message) return body.message;
      if (typeof body.error === 'string' && body.error) return body.error;
    }
    return `请求失败（${res.status}）`;
  } catch (error) {
    if (signal?.aborted) throw streamAbortError(signal);
    if (isAbortError(error) || isTimeoutError(error)) throw error;
    return `请求失败（${res.status}）`;
  }
}

/**
 * 单段合成的等待上限。
 *
 * <p>没有它的话，一次卡住的请求会让播报循环永久停在 await 上（speaking 一直为 true、
 * 页面上「停读」不消失）。按句切片后正常在 1~3 秒内回来，20 秒是给网络抖动留的余量。
 */
export const SYNTH_TIMEOUT_MS = 20_000;
export const RECOGNITION_TIMEOUT_MS = 90_000;

function requestTimeout(signal: AbortSignal | undefined, ms: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const onAbort = () => {
    if (!controller.signal.aborted) controller.abort(signal?.reason);
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(timeoutError('请求超时')), ms);
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

/**
 * 文本转语音：后端回 WAV 字节流，前端拿到就能塞进 Audio 播。
 *
 * <p>两种失败在语义上都不是「重试一下就好」：503（speech_unavailable）= 服务端没开语音，
 * 502（speech_failed）= 上游网关挂了。调用方（useSpeech）一律当场降级到浏览器内置播报。
 */
export async function synthesizeSpeech(text: string, signal?: AbortSignal): Promise<Blob> {
  const timeout = requestTimeout(signal, SYNTH_TIMEOUT_MS);
  try {
    const res = await awaitWithAbort(
      fetch(apiUrl('/api/speech/synthesize'), {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ text }),
        signal: timeout.signal,
      }),
      timeout.signal,
    );
    if (!res.ok) throw new Error(await safeError(res, timeout.signal));
    return await awaitWithAbort(res.blob(), timeout.signal);
  } finally {
    timeout.cleanup();
  }
}

export interface RecognitionResult {
  text: string;
  /** 音频时长（秒）：用来判断「说了话」还是「录到了一片静音」 */
  seconds: number;
  elapsedMs?: number;
}

/** 语音转文本：16bit PCM 的 WAV 整体 POST（接口只收 wav/mp3，见后端 SpeechParser） */
export async function recognizeSpeech(wav: Blob, signal?: AbortSignal): Promise<RecognitionResult> {
  const timeout = requestTimeout(signal, RECOGNITION_TIMEOUT_MS);
  try {
    const audio = await blobToDataUrl(wav, timeout.signal);
    const res = await awaitWithAbort(
      fetch(apiUrl('/api/speech/recognize'), {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ audio }),
        signal: timeout.signal,
      }),
      timeout.signal,
    );
    if (!res.ok) throw new Error(await safeError(res, timeout.signal));
    return (await awaitWithAbort(res.json(), timeout.signal)) as RecognitionResult;
  } finally {
    timeout.cleanup();
  }
}

/** Blob → data URL：交给 FileReader（原生实现），不用 btoa 拼字符串，避免大录音上爆栈 */
function blobToDataUrl(blob: Blob, signal: AbortSignal): Promise<string> {
  if (signal.aborted) return Promise.reject(streamAbortError(signal));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      reader.abort();
      cleanup();
      reject(streamAbortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.onload = () => {
      cleanup();
      resolve(String(reader.result));
    };
    reader.onerror = () => {
      cleanup();
      reject(new Error('录音读取失败'));
    };
    reader.onabort = () => {
      cleanup();
      reject(streamAbortError(signal));
    };
    reader.readAsDataURL(blob);
  });
}

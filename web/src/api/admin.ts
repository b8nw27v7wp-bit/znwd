/**
 * 管理面：/api/stats、/api/admin/*、/api/knowledge/*。
 *
 * 口令由运营视图存 sessionStorage（znwd.adminToken），这里统一加 authorization 头。
 * 超时/中止/错误翻译复用 http.ts 的原语，和公共端点同一套语义。
 */

import {
  apiUrl,
  awaitWithAbort,
  isAbortError,
  isFiniteNumber,
  isRecord,
  isTimeoutError,
  requestTimeout,
  safeError,
} from './http';

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
  matchedTokens?: number;
  matched?: string[];
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
  semantic?: boolean;
  degraded?: boolean;
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

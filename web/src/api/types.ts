/**
 * 契约类型：与 Spring Boot 后端一一对应（见 docs/api.md）。
 *
 * 这一层只有类型，不发请求、不碰运行时，供 http/stream/admin/speech 与页面组件共用；
 * 单向依赖的最底层——它不 import 任何同级模块。
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

/** /api/health 的 retrieval：后端直接把检索统计对象序列化出来（不是字符串），字段与 HybridStats 同名 */
export interface HealthRetrieval {
  mode: 'hybrid' | 'keyword';
  keywordChunks?: number;
  indexReady?: boolean;
  /** 索引代数：reload 后 +1，也是答案缓存 key 的一部分 */
  generation?: number;
  /** 语义向量这一轮是否真的参与了排序（false = 只走关键词路） */
  semantic?: boolean;
  thresholds?: { minKeywordScore?: number; minVectorScore?: number };
  vector?: {
    provider?: string;
    semantic?: boolean;
    dims?: number;
    vectors?: number;
    fingerprint?: string;
    indexFile?: string;
    queryFailures?: number;
  };
}

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
  /** 检索统计（对象，不是字符串）：2026-09-29 修掉这里原先错标成 string 的类型 */
  retrieval: HealthRetrieval;
  /** 语义向量可用性：embedding 不通时为 false，检索自动只走关键词路 */
  embeddingReady?: boolean;
  /** 管理口径是否强制口令（运营排障用；只在上报里有，前端不读它做判断） */
  adminTokenRequired?: boolean;
  answerCacheSize?: number;
  storage: string;
  storageAvailable: boolean;
  activeSessions: number;
  minRelevanceScore: number;
  uptimeSec: number;
}

/** streamChat 的三个回调；顺序契约（meta → delta* → done）由 streamChat 自己保证 */
export interface StreamHandlers {
  onMeta: (meta: ChatMeta) => void;
  onDelta: (text: string) => void;
  onDone: (done: ChatDone) => void;
}

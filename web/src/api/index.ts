/**
 * 后端接口封装（barrel：对外唯一入口，`import ... from './api'` 解析到这里）。
 *
 * 契约与 Spring Boot 后端一一对应（见 docs/api.md）：
 *   POST /api/chat/stream  SSE：meta → delta* → done（只有流式这一条；没有非流式 POST /api/chat）
 *   GET  /api/suggestions  推荐问题（?zone=）
 *   GET  /api/zones        展区与展项
 *   GET  /api/health       运行状态（含 storageAvailable，数据库掉了要能看出来）
 *   POST /api/feedback     点赞/点踩
 *   DELETE /api/sessions/{id}  换人时清会话上下文（带 x-session-token）
 *   语音 POST /api/speech/{synthesize,recognize,metrics}（metrics = 声学遥测，无口令、无重试）
 *   管理面（stats/admin/knowledge）统一走 adminRequest，带 authorization 头
 *
 * 拆分后的模块（单向依赖：types ← http ← {stream, admin, speech}）：
 *   types.ts   契约类型与回调形状（无运行时依赖）
 *   http.ts    API 前缀、超时/abort 原语、错误翻译与公共端点
 *   stream.ts  SSE 帧解析、断流活性、streamChat
 *   admin.ts   /api/stats、/api/admin/*、/api/knowledge/*
 *   speech.ts  TTS / ASR
 */

export type {
  ChatDone,
  ChatMeta,
  HealthInfo,
  HealthRetrieval,
  Message,
  RewriteInfo,
  Role,
  Source,
  StreamHandlers,
  Suggestion,
  Usage,
  ZoneInfo,
} from './types';

export {
  apiUrl,
  fetchHealth,
  fetchSuggestions,
  fetchZones,
  newSessionId,
  resetSession,
  sendFeedback,
} from './http';

export { isTotalTimeoutError, streamChat, STREAM_INACTIVITY_MS, STREAM_TIMEOUT_MS } from './stream';

export type {
  AdminStats,
  DiagnosticsHit,
  DiagnosticsInfo,
  FeedbackStats,
  KnowledgeDoc,
  KnowledgeListInfo,
  KnowledgeReloadInfo,
  SynonymEntry,
  SynonymsInfo,
  SynonymsSaveResult,
  UncoveredItem,
} from './admin';

export {
  fetchAdminStats,
  fetchFeedbackStats,
  fetchKnowledgeList,
  fetchSynonyms,
  fetchUncovered,
  KNOWLEDGE_RELOAD_TIMEOUT_MS,
  reloadKnowledge,
  runDiagnostics,
  saveSynonyms,
} from './admin';

export type { RecognitionResult } from './speech';

export {
  recognizeSpeech,
  RECOGNITION_TIMEOUT_MS,
  SEGMENT_RECOGNITION_TIMEOUT_MS,
  sendSpeechMetrics,
  synthesizeSpeech,
  SYNTH_TIMEOUT_MS,
} from './speech';

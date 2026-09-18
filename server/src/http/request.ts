/** 请求入参解析：所有错误都收敛为可判定的原因码，路由层统一转 400，不再抛 500 */
export const MESSAGE_MAX_CHARS = 2000;
export const SESSION_ID_MAX_CHARS = 64;
const SESSION_ID_SAFE = /[^A-Za-z0-9._-]/g;

export interface ChatInput {
  message: string;
  sessionId?: string;
  /** 原始 message 是否被截断 */
  truncated: boolean;
}

export type ParseChatInputResult =
  | { ok: true; value: ChatInput }
  | { ok: false; reason: 'body_not_object' | 'message_not_string' | 'message_empty' };

/** 对外可见的校验失败原因（不回显请求体内容） */
export function validationMessage(reason: 'body_not_object' | 'message_not_string' | 'message_empty'): string {
  switch (reason) {
    case 'body_not_object':
      return 'message is required';
    case 'message_not_string':
      return 'message must be a string';
    default:
      return 'message is required';
  }
}

/**
 * sessionId 只作内存会话键与日志字段，不做路径；非法字符直接剔除，
 * 避免控制字符/路径片段进入日志与响应。
 */
export function normalizeSessionId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw.replace(SESSION_ID_SAFE, '').slice(0, SESSION_ID_MAX_CHARS);
  return cleaned.length > 0 ? cleaned : undefined;
}

export function parseChatInput(body: unknown, maxChars = MESSAGE_MAX_CHARS): ParseChatInputResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'body_not_object' };
  }
  const raw = (body as { message?: unknown }).message;
  if (raw !== undefined && typeof raw !== 'string') {
    return { ok: false, reason: 'message_not_string' };
  }
  const message = (raw ?? '').trim();
  if (!message) return { ok: false, reason: 'message_empty' };
  const truncated = message.length > maxChars;
  return {
    ok: true,
    value: {
      message: truncated ? message.slice(0, maxChars) : message,
      sessionId: normalizeSessionId((body as { sessionId?: unknown }).sessionId),
      truncated,
    },
  };
}

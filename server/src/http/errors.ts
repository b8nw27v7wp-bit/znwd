/** hash 字符串（与向量索引指纹同算法） */
export function hashStr(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
    h2 = (h2 + s.charCodeAt(i) * 31) | 0;
  }
  return `${(h1 >>> 0).toString(16)}-${(h2 >>> 0).toString(16)}`;
}

export interface ErrorBody {
  error: string;
  message: string;
  requestId?: string | number | null;
  [k: string]: unknown;
}

export function errorPayload(
  code: string,
  message: string,
  requestId?: string | number | null,
  extra?: Record<string, unknown>,
): ErrorBody {
  return {
    error: code,
    message,
    requestId: requestId ?? null,
    ...(extra ?? {}),
  };
}

/** 是否在非开发环境强制 ADMIN_TOKEN */
export function adminTokenRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (env.REQUIRE_ADMIN_TOKEN || '').toLowerCase();
  if (flag === 'true' || flag === '1' || flag === 'yes') return true;
  const nodeEnv = (env.NODE_ENV || '').toLowerCase();
  return nodeEnv === 'production' || nodeEnv === 'prod' || nodeEnv === 'staging';
}

export type LogMessageMode = 'hash' | 'preview';

/** 日志用消息预览：默认 hash，避免落盘完整问题 */
export function messageLogFields(
  message: string | undefined,
  mode: LogMessageMode = 'hash',
): { messagePreview?: string; messageLen?: number } {
  if (!message) return {};
  const len = message.length;
  if (mode === 'preview') {
    return { messagePreview: message.slice(0, 80), messageLen: len };
  }
  return {
    messagePreview: `${hashStr(message)}#${len}#${message.slice(0, 20)}`,
    messageLen: len,
  };
}

/**
 * CORS 策略：默认只放行本地开发源；生产用 CORS_ORIGINS 显式配置白名单。
 * HTTP 路由（@fastify/cors）与 SSE 手写头共用同一策略，避免两套口径。
 */
const DEV_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/;

export function resolveCorsOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = (env.CORS_ORIGINS || '').trim();
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

export interface CorsDecision {
  allowed: boolean;
  /** 允许时回显的 Origin（无 Origin 头时为 undefined） */
  origin?: string;
}

export function decideOrigin(origin: string | undefined, allow: string[]): CorsDecision {
  if (!origin) return { allowed: true };
  const norm = origin.replace(/\/$/, '');
  if (allow.length > 0) {
    if (allow.includes('*') || allow.includes(norm)) return { allowed: true, origin };
    return { allowed: false };
  }
  // 未配置白名单：仅本地开发源（展厅生产请显式配置 CORS_ORIGINS）
  if (DEV_ORIGIN.test(norm)) return { allowed: true, origin };
  return { allowed: false };
}

export function corsHeadersFor(
  origin: string | undefined,
  allow: string[],
): Record<string, string> {
  const d = decideOrigin(origin, allow);
  if (!d.allowed || !d.origin) return { vary: 'Origin' };
  return { 'access-control-allow-origin': d.origin, vary: 'Origin' };
}

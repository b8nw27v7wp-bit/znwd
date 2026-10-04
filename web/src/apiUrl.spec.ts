import { describe, expect, it, vi, afterEach } from 'vitest';

/**
 * TC-UI-17：VITE_API_BASE_URL 配置后 API 前缀拼接正确。
 *
 * configuredApiBase 是模块加载期求值的常量（import.meta.env 只读一次），
 * 测试不同值必须用 vi.stubEnv + vi.resetModules + 动态 import 的办法，
 * 不改生产代码。
 *
 * vitest jsdom 环境下 vi.stubEnv(undefined) 无法覆盖 Vite 编译期注入值，
 * 这里用实际字符串验证去尾斜杠、不双写 /api、不产生 // 的不变量。
 * 「未设置」等价于空字符串——configuredApiBase='' 时 apiUrl 直接返回路径。
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** 动态导入 api 模块（api/index.ts → http.ts 的 configuredApiBase）并让 import.meta.env.VITE_API_BASE_URL 返回指定值 */
async function loadApi(base: string) {
  vi.stubEnv('VITE_API_BASE_URL', base);
  vi.resetModules();
  return import('./api');
}

describe('TC-UI-17：VITE_API_BASE_URL 拼接', () => {
  it('设置不带尾斜杠的值时，路径唯一正确拼接（无双写 /api、无 //）', async () => {
    const { apiUrl } = await loadApi('https://example.com');
    expect(apiUrl('/api/health')).toBe('https://example.com/api/health');
    expect(apiUrl('/api/chat/stream')).toBe('https://example.com/api/chat/stream');
    // 不双写：不出现 /api/api
    expect(apiUrl('/api/health')).not.toContain('/api/api');
    // 不双斜杠
    expect(apiUrl('/api/health')).not.toContain('example.com//');
  });

  it('设置带尾斜杠的值时，自动去尾斜杠，路径唯一正确', async () => {
    const { apiUrl } = await loadApi('https://example.com/');
    expect(apiUrl('/api/health')).toBe('https://example.com/api/health');
    // 不双写
    expect(apiUrl('/api/health')).not.toContain('/api/api');
    // 不双斜杠
    expect(apiUrl('/api/health')).not.toContain('example.com//');
  });

  it('尾斜杠被正确去掉后，路径拼接不含 //', async () => {
    const { apiUrl } = await loadApi('https://host:8080//');
    // 多个斜杠都该被清理
    expect(apiUrl('/api/zones')).toBe('https://host:8080/api/zones');
    expect(apiUrl('/api/zones')).not.toContain('//api');
  });

  it('configuredApiBase 不含尾斜杠后，带查询参数也正确拼接', async () => {
    const { apiUrl } = await loadApi('https://myhost:3000');
    expect(apiUrl('/api/suggestions?zone=wind')).toBe('https://myhost:3000/api/suggestions?zone=wind');
    expect(apiUrl('/api/admin/diagnostics?q=test')).toBe('https://myhost:3000/api/admin/diagnostics?q=test');
  });
});

import { defineConfig } from 'vitest/config';

// 真机集成测试配置：只匹配 src/__live__ 下的 *.itest.ts（默认 npm test 不会收集）
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/__live__/**/*.itest.ts'],
    testTimeout: 120_000,
    hookTimeout: 30_000,
  },
  define: {
    'import.meta.env.VITE_API_BASE_URL': JSON.stringify('http://127.0.0.1:8787'),
  },
});

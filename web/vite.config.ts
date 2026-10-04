// defineConfig 取自 vitest/config（它是 vite defineConfig 的超集，多一个 test 段），
// 这样 npm test / npm run test:coverage 与 vite build 共用同一份配置，vue-tsc 也认它的类型。
import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

const apiTarget = process.env.VITE_API_TARGET || 'http://127.0.0.1:8787';

// VITE_API_TARGET 只用于 dev/preview 代理；生产静态包由 VITE_API_BASE_URL 决定 API 前缀，默认同源 /api。
// 本地开发把 /api 转到 Spring Boot（127.0.0.1:8787）；展厅一体机上前端由 Nginx 托管，
// 或直接 `npm run build` 后把 dist 交给任意静态服务器，跨域交给后端 CORS_ORIGINS 白名单。
export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        // SSE 不能被压缩缓冲，否则看不到逐字输出
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (String(proxyRes.headers['content-type'] || '').includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
            }
          });
        },
      },
    },
  },
  // preview 也代到后端：展厅现场用一次 `npm run build && npm run preview` 就能自查，不必装 Nginx
  preview: {
    host: '127.0.0.1',
    port: 4173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2020',
  },
  // vitest：`npm test`（不带 coverage）与 `npm run test:coverage` 都吃这份配置，
  // 默认收集 src/**/*.spec.ts（vitest 默认口径），live 用例仍走 vitest.live.config.ts。
  test: {
    coverage: {
      provider: 'v8',
      // 只量 src 下的业务源码；spec、真机用例、构建产物与应用入口不计入
      include: ['src/**/*.{ts,vue}'],
      exclude: [
        'src/**/*.spec.ts',
        'src/__live__/**',
        'dist/**',
        // 应用入口：只做 createApp 挂载，靠组件测试覆盖，不算分母
        'src/main.ts',
      ],
      reporter: ['text', 'html', 'lcov'],
      // 覆盖率门禁：阈值取 2026-10-04 实测（164 项）下调 1–2 个百分点，防抖动卡线——
      // 门禁的意义是「不低于当前水平」，不是追高。实测：Stmts 88.14 / Branch 75.08 /
      // Funcs 90.32 / Lines 91.67。改了被测代码把覆盖率做上去后，四项一起上调。
      thresholds: {
        statements: 86.5,
        branches: 73.5,
        functions: 88.5,
        lines: 90,
      },
    },
  },
});

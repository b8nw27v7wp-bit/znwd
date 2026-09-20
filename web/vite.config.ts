import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 本地开发把 /api 转到 Spring Boot（127.0.0.1:8787）；展厅一体机上前端由 Nginx 托管，
// 或直接 `npm run build` 后把 dist 交给任意静态服务器，跨域交给后端 CORS_ORIGINS 白名单。
export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_TARGET || 'http://127.0.0.1:8787',
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
        target: process.env.VITE_API_TARGET || 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2020',
  },
});

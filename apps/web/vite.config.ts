/**
 * Vite 配置：React 插件 + 开发态 /api 代理到 :3001（无跨域）
 * 别名将 @aicorrection/shared 指向 TS 源，免预构建。
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@aicorrection/shared': path.resolve(
        __dirname,
        '../../packages/shared/src/index.ts'
      ),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        // 必须用 127.0.0.1 而非 localhost：Windows 上 localhost 优先解析为 ::1，
        // 而 API 侧 app.listen(PORT,'0.0.0.0') 只绑 IPv4，走 ::1 会 ECONNREFUSED。
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
});

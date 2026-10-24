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
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});

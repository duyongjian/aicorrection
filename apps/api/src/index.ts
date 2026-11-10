/**
 * 进程入口：建库迁移 → Provider 探活 → 启动 Express
 */
import { createApp } from './app';
import { getDb } from './db';
import { initProvider } from './services/llm';
import { warmupLocalOcr } from './services/ocr/localOcrService';
import { env } from './config/env';

async function main(): Promise<void> {
  getDb(); // 建库 + 迁移
  const provider = await initProvider();
  const app = createApp();
  // 预热本地 OCR 常驻进程（模型只加载一次），使首个用户请求不再承担加载开销。
  // best-effort、不阻塞启动：后台拉起 serve 进程，加载完成后常驻复用。
  void warmupLocalOcr().catch(() => undefined);
  // 绑定到 0.0.0.0，同时支持 IPv4 和 IPv6
  // 使用 '0.0.0.0' 避免 localhost 解析到 IPv6 ::1 时的连接问题
  app.listen(env.PORT, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(
      `[aicorrection-api] listening on http://0.0.0.0:${env.PORT} ` +
        `(NODE_ENV=${env.NODE_ENV}, provider=${provider.name})`
    );
  });
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[startup failed]', e);
  process.exit(1);
});

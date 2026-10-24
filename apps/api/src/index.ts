/**
 * 进程入口：建库迁移 → Provider 探活 → 启动 Express
 */
import { createApp } from './app';
import { getDb } from './db';
import { initProvider } from './services/llm';
import { env } from './config/env';

async function main(): Promise<void> {
  getDb(); // 建库 + 迁移
  const provider = await initProvider();
  const app = createApp();
  app.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[aicorrection-api] listening on http://localhost:${env.PORT} ` +
        `(NODE_ENV=${env.NODE_ENV}, provider=${provider.name})`
    );
  });
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('[startup failed]', e);
  process.exit(1);
});

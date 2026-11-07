#!/usr/bin/env node
/**
 * 线下分发一键启动：构建 → 用独立分发库启动单端口服务。
 * 本脚本只做编排，不实现任何业务逻辑；环境一律取自 dist-env.mjs。
 *
 *   npm run distribute
 *
 * 前置：先发卡（npm run license:generate -- --count 20 --batch offline-01）。
 * 会占用 PORT（默认 3001），Ctrl+C 结束。
 */
import { spawn } from 'node:child_process';
import { REPO_ROOT, ensureDistDirs, buildChildEnv } from './dist-env.mjs';

const env = buildChildEnv();
const { dbPath, uploadsDir } = ensureDistDirs(env);
const port = env.PORT;

let activeChild = null;

function cleanup() {
  if (
    activeChild &&
    activeChild.exitCode === null &&
    activeChild.signalCode === null
  ) {
    try {
      activeChild.kill();
    } catch {
      /* 进程已退出，忽略 */
    }
  }
}

function forwardSignal(sig) {
  if (activeChild && activeChild.exitCode === null) {
    try {
      activeChild.kill(sig);
    } catch {
      /* 进程已退出，忽略 */
    }
  }
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => forwardSignal(sig));
}
process.on('exit', cleanup);

function runNpm(args) {
  const child = spawn('npm', args, {
    cwd: REPO_ROOT,
    env,
    stdio: 'inherit',
    // Windows 下 npm 是 npm.cmd，需经 shell 才能被 spawn 找到。
    shell: process.platform === 'win32',
  });
  activeChild = child;
  return child;
}

/** 等待子进程结束并返回退出码；失败时打印原因。 */
function waitFor(label, child) {
  return new Promise((resolve) => {
    child.on('error', (e) => {
      console.error(`[distribute] ${label} 无法启动：${e.message}`);
      resolve(1);
    });
    child.on('close', (code, signal) => {
      if (activeChild === child) activeChild = null;
      if (code !== 0) {
        console.error(
          `[distribute] ${label} 失败（exit=${code}${
            signal ? `, signal=${signal}` : ''
          }）`
        );
        resolve(code || 1);
      } else {
        resolve(0);
      }
    });
  });
}

async function main() {
  console.log('=== 线下分发（独立库 / 单端口）===');
  console.log(`分发库    : ${dbPath}`);
  console.log(`上传目录  : ${uploadsDir}`);
  console.log(`访问端口  : ${port}`);
  console.log('');

  console.log('[1/2] 构建：npm run build ...');
  const buildCode = await waitFor('构建', runNpm(['run', 'build']));
  if (buildCode !== 0) {
    console.error('[distribute] 构建未通过，已中止启动。请先修复构建错误。');
    process.exit(buildCode);
  }

  console.log('[2/2] 启动服务：npm run start -w @aicorrection/api ...');
  console.log('');
  console.log(`  访问地址 : http://localhost:${port}`);
  console.log('  发卡示例 : npm run license:generate -- --count 20 --batch offline-01 --out data/distribution/offline-01.csv');
  console.log('  查看卡密 : npm run license:list -- --batch offline-01');
  console.log('  停用卡密 : npm run license:revoke -- --code AC-XXXX-XXXX-XXXX');
  console.log('');
  console.log('  按 Ctrl+C 停止服务。');
  console.log('');

  const apiCode = await waitFor(
    '服务',
    runNpm(['run', 'start', '-w', '@aicorrection/api'])
  );
  process.exit(apiCode);
}

main().catch((e) => {
  console.error(`[distribute] ${e && e.message ? e.message : e}`);
  process.exit(1);
});

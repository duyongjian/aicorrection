#!/usr/bin/env node
/**
 * 线下分发发卡 CLI（用 tsx 运行，见根 package.json 的 license:* scripts）。
 *
 * 用法（npm run 传参必须用 -- 分隔）：
 *   npm run license:generate -- --count 20 --batch offline-01 --note "现场试用" --expires 2027-12-31 --out offline-01.csv
 *   npm run license:list    -- --batch offline-01
 *   npm run license:revoke  -- --code AC-XXXX-XXXX-XXXX
 *   npx tsx scripts/license-cli.mjs --help
 *
 * 数据主权：明文卡密只在 generate 时输出一次（--out 的 CSV 或 stdout），
 * 之后 DB 只存 SHA-256；本 CLI 任何输出都不含完整卡密二次回显、hash、token 或学生数据。
 */
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  REPO_ROOT,
  distEnvOverrides,
  assertNotProductionDb,
} from './dist-env.mjs';

const HELP = `发卡 CLI（线下分发 MVP）

用法（npm run 传参必须用 -- 分隔）：
  npm run license:generate -- --count N [--batch ID] [--note TEXT] [--expires YYYY-MM-DD] [--out FILE]
  npm run license:list    -- [--batch ID]
  npm run license:revoke  -- --code AC-XXXX-XXXX-XXXX
  npx tsx scripts/license-cli.mjs <generate|list|revoke> [选项]

选项：
  --count N        发卡数量，1–1000 的整数（generate 必填）
  --batch ID       批次标识，便于按批查看 / 管理
  --note TEXT      备注（如 现场试用）
  --expires DATE   到期日 YYYY-MM-DD，到期后卡密不可兑换
  --out FILE       明文卡密写入 CSV（表头 code,batch_id,expires_at,note，UTF-8）
                   不传则明文只打印到 stdout；安全警告始终打印到 stderr
  --code CODE      要停用的卡密（revoke 必填）
  --help, -h       显示本帮助

分发库：
  默认 data/distribution/aicorrection-dist.db；可用 AICORRECTION_DB_PATH 或
  AICORRECTION_DIST_DB 覆盖（与一键启动脚本共用同一套解析）。
  生产库 apps/api/**/aicorrection.db 会被 assertNotProductionDb 直接拒绝。

安全（务必遵守）：
  明文卡密只在 generate 时出现一次，DB 仅存 SHA-256，之后无法找回。
  立即妥善保管：不要提交到 git、不要发到聊天 / 邮件 / 网盘 / 任何云端、不要写入日志。
  建议 --out 输出到 data/distribution/ 下或仓库根目录（这些路径已被 .gitignore 忽略）。`;

const VALID_COMMANDS = new Set(['generate', 'list', 'revoke']);

function fail(message, code = 2) {
  console.error(`[错误] ${message}`);
  process.exit(code);
}

/** 解析 --key value / --key=value；位置参数收进 _。 */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      out.help = true;
      continue;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = a.slice(2, eq === -1 ? undefined : eq);
      let value;
      if (eq !== -1) {
        value = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          value = next;
          i += 1;
        } else {
          value = 'true';
        }
      }
      out[key] = value;
    } else {
      out._.push(a);
    }
  }
  return out;
}

/**
 * 在调用任何 service 之前设好分发环境，再动态 import service。
 * 顺序至关重要：licenseService 的依赖链会在 import 时加载 config/env.ts
 * （dotenv 在此刻快照 process.env），所以环境变量必须先落地。
 */
async function loadService() {
  const overrides = distEnvOverrides();
  Object.assign(process.env, overrides);
  const dbPath = assertNotProductionDb(overrides.AICORRECTION_DB_PATH);
  const url = pathToFileURL(
    path.join(REPO_ROOT, 'apps/api/src/services/licenseService.ts')
  ).href;
  const svc = await import(url);
  return { svc, dbPath };
}

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  const header = 'code,batch_id,expires_at,note';
  const lines = [
    header,
    ...rows.map((r) =>
      [r.code, r.batch_id, r.expires_at, r.note].map(csvCell).join(',')
    ),
  ];
  return `${lines.join('\r\n')}\r\n`;
}

/** 输出安全警告（stderr，不污染可重定向的明文 stdout）。 */
function warnPlaintext(where) {
  console.error('');
  console.error(`[重要] 明文卡密只在此处出现一次：${where}。`);
  console.error('       数据库仅保存 SHA-256，之后任何人都无法从库中找回明文。');
  console.error('       请立即妥善保管，并严格遵守：');
  console.error('       - 不要提交到 git（.gitignore 已忽略分发目录与根目录 *.csv）');
  console.error('       - 不要发到聊天软件、邮件、网盘或任何云端');
  console.error('       - 不要写入日志');
  console.error('       线下交给真人试用后即可销毁本地副本。');
}

/**
 * 新建分发库时，apps/api/src/db/migrate.ts 会用 console.log 逐条打印迁移，
 * 这些日志会污染 stdout（明文 CSV / 表格）。service 都是同步函数，
 * 故在调用期间把 console.log 临时导到 stderr，保证 stdout 只有本 CLI 的正式输出；
 * 之后无论成功失败都恢复，避免影响后续输出。
 */
function callService(fn, ...args) {
  const original = console.log;
  console.log = (...parts) =>
    process.stderr.write(`${parts.map(String).join(' ')}\n`);
  try {
    return fn(...args);
  } finally {
    console.log = original;
  }
}

/** revoke 的 service message 会回显完整卡密，统一掩码成 ****-末4位。 */
function maskCodes(text) {
  return String(text).replace(
    /AC-[A-Z0-9]{4}-[A-Z0-9]{4}-([A-Z0-9]{4})/g,
    (_match, last4) => `****-${last4}`
  );
}

function cmdGenerate(args, svc) {
  if (args.count === undefined) fail('generate 需要 --count N');
  const count = Number(args.count);
  if (!Number.isInteger(count) || count < 1 || count > 1000) {
    fail('--count 须为 1–1000 的整数');
  }

  let expiresAt;
  if (args.expires !== undefined) {
    const v = String(args.expires);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) fail('--expires 须为 YYYY-MM-DD');
    const d = new Date(`${v}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
      fail(`--expires 不是有效日期：${v}`);
    }
    expiresAt = v;
  }

  const rows = callService(svc.generateLicenses, {
    count,
    batchId: args.batch,
    note: args.note ?? null,
    expiresAt: expiresAt ?? null,
  });
  const csv = toCsv(rows);

  if (args.out !== undefined && args.out !== 'true') {
    const outPath = path.resolve(String(args.out));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, csv, 'utf8');
    // 终端不回显明文，只在 CSV 文件里出现这一次。
    console.log(`[完成] 已生成 ${rows.length} 张卡密，明文已写入：${outPath}`);
    warnPlaintext(`文件 ${outPath}`);
  } else {
    // 明文仅打印到 stdout 一次。
    process.stdout.write(csv);
    warnPlaintext('上面的 stdout 输出');
  }
}

function cmdList(args, svc) {
  const rows = callService(svc.listLicenses, args.batch || undefined);
  if (rows.length === 0) {
    console.log(`(无记录${args.batch ? `，批次 ${args.batch}` : ''})`);
    return;
  }
  const cols = [
    'hint',
    'batch_id',
    'status',
    'note',
    'expires_at',
    'anon_user_id',
    'redeemed_at',
    'created_at',
  ];
  const disp = (v) =>
    v === null || v === undefined || v === '' ? '-' : String(v);
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => disp(r[c]).length))
  );
  const line = (cells) =>
    cells.map((v, i) => disp(v).padEnd(widths[i])).join(' | ');
  console.log(line(cols));
  console.log(widths.map((w) => '-'.repeat(w)).join('-+-'));
  for (const r of rows) console.log(line(cols.map((c) => r[c])));
  console.log(`共 ${rows.length} 条（hint 仅末 4 位，不含明文 / hash / token）`);
}

function cmdRevoke(args, svc) {
  if (args.code === undefined || args.code === 'true') {
    fail('revoke 需要 --code AC-XXXX-XXXX-XXXX');
  }
  const res = callService(svc.revokeLicense, String(args.code));
  console.log(maskCodes(res.message));
  if (!res.ok) process.exit(1);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // --help 不需要加载 service，保证 shared 未构建时也能查看用法。
  if (args.help) {
    console.log(HELP);
    return;
  }

  const cmd = args._[0];
  if (!cmd) fail('缺少子命令 (generate|list|revoke)，可用 --help 查看用法');
  if (!VALID_COMMANDS.has(cmd)) fail(`未知子命令：${cmd}`);

  const { svc, dbPath } = await loadService();
  console.error(`[分发库] ${dbPath}`);

  if (cmd === 'generate') cmdGenerate(args, svc);
  else if (cmd === 'list') cmdList(args, svc);
  else cmdRevoke(args, svc);
}

main().catch((e) => {
  console.error(`[错误] ${e && e.message ? e.message : e}`);
  process.exit(1);
});

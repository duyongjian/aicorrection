/**
 * 运行时配置覆盖层（管理后台可控的配置项）
 *
 * 背景：归因系统现在有一堆「该让人改、而不是改代码」的旋钮——归因策略（single/ensemble/cloud）、
 * 各专精小模型端点（8094/8096/8097）、RAG/联网开关、嵌入模型等。它们原本散落在 env.ts，
 * 改一次要动文件+重启。本模块把它们抽成「可被管理后台在运行时覆盖」的键值存储，
 * 持久化到本地 SQLite 的 settings 表，env 值作为兜底（未覆盖时回落 env）。
 *
 * 数据安全：仅 MANAGED_KEYS 允许被覆盖，杜绝任意键写入；覆盖仅影响运行时，不回写 .env。
 * 无任何内容外发，纯本地。
 */
import { getDb } from '../../db';
import { env } from '../../config/env';

const TABLE = 'settings';
let ensured = false;

function ensure(): void {
  if (ensured) return;
  getDb()
    .prepare(`CREATE TABLE IF NOT EXISTS ${TABLE} (key TEXT PRIMARY KEY, value TEXT)`)
    .run();
  ensured = true;
}

/** 允许通过管理后台运行时覆盖的配置键白名单。 */
export const MANAGED_KEYS = [
  'ATTRIBUTION_STRATEGY',
  'ENSEMBLE_THINK_URL',
  'ENSEMBLE_THINK_MODEL',
  'ENSEMBLE_BROAD_URL',
  'ENSEMBLE_BROAD_MODEL',
  'ENSEMBLE_FAST_URL',
  'ENSEMBLE_FAST_MODEL',
  'ENSEMBLE_SYNTH_URL',
  'ENSEMBLE_SYNTH_MODEL',
  'CLOUD_BASE_URL',
  'CLOUD_API_KEY',
  'CLOUD_MODEL',
  'RAG_ENABLED',
  'WEB_SEARCH_ENABLED',
  'RAG_EMBED_MODEL',
  'RAG_TOP_K',
  'RAG_MIN_SCORE',
  'DISABLE_THINKING',
] as const;

export type ManagedKey = (typeof MANAGED_KEYS)[number];

export function getRaw(key: string): string | undefined {
  ensure();
  const row = getDb().prepare(`SELECT value FROM ${TABLE} WHERE key=?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function getStr(key: ManagedKey, fallback: string): string {
  const v = getRaw(key);
  return v ?? fallback;
}

export function getBool(key: ManagedKey, fallback: boolean): boolean {
  const v = getRaw(key);
  if (v === undefined) return fallback;
  return v === 'true' || v === '1';
}

export function setRaw(key: string, value: string): void {
  ensure();
  getDb()
    .prepare(
      `INSERT INTO ${TABLE} (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`
    )
    .run(key, value);
}

export function deleteRaw(key: string): void {
  ensure();
  getDb().prepare(`DELETE FROM ${TABLE} WHERE key=?`).run(key);
}

export function listRaw(): Record<string, string> {
  ensure();
  const rows = getDb().prepare(`SELECT key,value FROM ${TABLE}`).all() as {
    key: string;
    value: string;
  }[];
  const o: Record<string, string> = {};
  for (const r of rows) o[r.key] = r.value;
  return o;
}

/** 当前生效配置视图（覆盖值优先，否则回落 env），供后台 GET /config 回显。 */
export function configView() {
  return {
    ATTRIBUTION_STRATEGY: getStr('ATTRIBUTION_STRATEGY', env.ATTRIBUTION_STRATEGY),
    ENSEMBLE_THINK_URL: getStr('ENSEMBLE_THINK_URL', env.ENSEMBLE_THINK_URL),
    ENSEMBLE_THINK_MODEL: getStr('ENSEMBLE_THINK_MODEL', env.ENSEMBLE_THINK_MODEL),
    ENSEMBLE_BROAD_URL: getStr('ENSEMBLE_BROAD_URL', env.ENSEMBLE_BROAD_URL),
    ENSEMBLE_BROAD_MODEL: getStr('ENSEMBLE_BROAD_MODEL', env.ENSEMBLE_BROAD_MODEL),
    ENSEMBLE_FAST_URL: getStr('ENSEMBLE_FAST_URL', env.ENSEMBLE_FAST_URL),
    ENSEMBLE_FAST_MODEL: getStr('ENSEMBLE_FAST_MODEL', env.ENSEMBLE_FAST_MODEL),
    ENSEMBLE_SYNTH_URL: getStr('ENSEMBLE_SYNTH_URL', env.ENSEMBLE_SYNTH_URL),
    ENSEMBLE_SYNTH_MODEL: getStr('ENSEMBLE_SYNTH_MODEL', env.ENSEMBLE_SYNTH_MODEL),
    CLOUD_BASE_URL: getStr('CLOUD_BASE_URL', env.CLOUD_BASE_URL),
    CLOUD_API_KEY_SET: Boolean(getRaw('CLOUD_API_KEY') ?? env.CLOUD_API_KEY),
    CLOUD_MODEL: getStr('CLOUD_MODEL', env.CLOUD_MODEL),
    RAG_ENABLED: getBool('RAG_ENABLED', env.RAG_ENABLED),
    WEB_SEARCH_ENABLED: getBool('WEB_SEARCH_ENABLED', env.WEB_SEARCH_ENABLED),
    RAG_EMBED_MODEL: getStr('RAG_EMBED_MODEL', env.RAG_EMBED_MODEL),
    RAG_TOP_K: getStr('RAG_TOP_K', String(env.RAG_TOP_K)),
    RAG_MIN_SCORE: getStr('RAG_MIN_SCORE', String(env.RAG_MIN_SCORE)),
    DISABLE_THINKING: getBool('DISABLE_THINKING', env.DISABLE_THINKING),
    overrides: listRaw(),
  };
}

/**
 * 联网搜索本地审计（P2）
 *
 * 仅落本地 data/websearch_audit.log（JSONL），不离开本机，符合数据主权铁律的"可核查"要求。
 * 记录：时间戳、脱敏后的检索词、提供方、引擎、命中条数、耗时、是否失败。
 * 绝不动抛出异常（best-effort）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../../config/env';

export interface WebSearchAuditEntry {
  ts: string;
  query: string;
  provider: string;
  engine?: string;
  result_count?: number;
  duration_ms?: number;
  error?: boolean;
  note?: string;
}

/**
 * 追加一条审计记录到本地日志。审计关闭或写失败均静默忽略。
 */
export function logWebSearchAudit(entry: WebSearchAuditEntry): void {
  if (!env.WEB_SEARCH_AUDIT) return;
  try {
    const dir = env.DATA_DIR;
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'websearch_audit.log'),
      JSON.stringify(entry) + '\n',
      'utf-8'
    );
  } catch {
    /* 审计失败不应影响主流程 */
  }
}

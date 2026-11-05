/**
 * analytics_events 数据访问层（INF-03 / QAL-02 看板数据源）
 * 幂等：idempotency_key UNIQUE，INSERT OR IGNORE，changes=0 视为重复。
 */
import { getDb } from '../db';
import type { AnalyticsEvent } from '@aicorrection/shared';

/** 返回 true 表示该事件为重复（被忽略）。 */
export function insertEvent(event: AnalyticsEvent): boolean {
  const info = getDb()
    .prepare(
      `INSERT OR IGNORE INTO analytics_events (
        event_id, event_name, anon_user_id, loop_id, session_id,
        context_json, props_json, ts_utc, idempotency_key, received_at,
        is_mock, is_internal, rollout_group
      ) VALUES (
        @event_id, @event_name, @anon_user_id, @loop_id, @session_id,
        @context_json, @props_json, @ts_utc, @idempotency_key, @received_at,
        @is_mock, @is_internal, @rollout_group
      )`
    )
    .run(event);
  return info.changes === 0;
}

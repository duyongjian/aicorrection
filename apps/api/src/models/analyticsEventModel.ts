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

/**
 * K1.4 放量就绪：把该 (user, loop) 的 rollout_exposure 事件 is_mock 对齐到归因行最终值。
 * 曝光在归因入口即发出，而 is_mock 可能因运行时 Mock 兜底（fallback）在之后才变为 true；
 * 不对齐会让 K1.5 §5.3-A（attributions）与 §5.3-C（analytics_events）按 is_mock=0 过滤时错配。
 * 幂等：默认 off 下无曝光行，UPDATE 影响 0 行，无副作用。
 */
export function markExposureMockFlag(
  loopId: string,
  anonUserId: string,
  isMock: boolean
): void {
  getDb()
    .prepare(
      `UPDATE analytics_events SET is_mock = @is_mock
       WHERE event_name = 'rollout_exposure'
         AND loop_id = @loop_id
         AND anon_user_id = @anon_user_id`
    )
    .run({ loop_id: loopId, anon_user_id: anonUserId, is_mock: isMock ? 1 : 0 });
}

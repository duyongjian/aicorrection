/**
 * 埋点接收服务（INF-03）
 * 服务端仅接收 + 幂等去重 + 落库；不主动发事件（§7.3）。
 * 幂等键 = anon_user_id|loop_id|event_name|event_seq|channel。
 */
import { insertEvent } from '../../models/analyticsEventModel';
import { generateEventId } from '../../utils/id';
import type { TrackEvent, TrackIngestResponse } from '@aicorrection/shared';

function buildIdempotencyKey(e: TrackEvent): string {
  const c = e.context;
  const channel = c.channel ?? 'organic';
  return `${c.user_id ?? ''}|${c.loop_id ?? ''}|${e.event_name}|${c.event_seq ?? 1}|${channel}`;
}

export function ingest(events: TrackEvent[]): TrackIngestResponse {
  let accepted = 0;
  let rejected = 0;
  let dup = 0;

  for (const e of events) {
    try {
      const ctx = e.context ?? {};
      const isDup = insertEvent({
        event_id: generateEventId(),
        event_name: e.event_name,
        anon_user_id: ctx.user_id ?? null,
        loop_id: ctx.loop_id ?? null,
        session_id: ctx.session_id ?? null,
        context_json: JSON.stringify(ctx),
        props_json: JSON.stringify(e.props ?? {}),
        ts_utc: e.ts_utc,
        idempotency_key: buildIdempotencyKey(e),
        received_at: new Date().toISOString(),
        is_mock: ctx.is_mock ? 1 : 0,
        is_internal: ctx.is_internal ? 1 : 0,
      });
      if (isDup) {
        dup++;
      } else {
        accepted++;
      }
    } catch {
      rejected++;
    }
  }

  return { accepted, rejected, dup };
}

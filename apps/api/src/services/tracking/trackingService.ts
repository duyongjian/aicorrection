/**
 * 埋点接收服务（INF-03）
 * 服务端仅接收 + 幂等去重 + 落库；不主动发事件（§7.3）。
 * 幂等键 = anon_user_id|loop_id|event_name|event_seq|channel。
 */
import { insertEvent } from '../../models/analyticsEventModel';
import { assignCohort } from '../rollout/cohortService';
import { generateEventId } from '../../utils/id';
import type { TrackEvent, TrackIngestResponse } from '@aicorrection/shared';

function buildIdempotencyKey(e: TrackEvent): string {
  const c = e.context;
  const channel = c.channel ?? 'organic';
  // v0.1.x：upload_fail 没有 loop_id，若仍用空串作作用域，同一用户的所有失败事件
  // 会因 key 完全相同被幂等去重成 1 条。用客户端 attempt id 作为替代作用域。
  // 对既有事件（有 loop_id 或无 attempt id）返回值逐字不变，零行为变化。
  const attemptId = e.props?.['upload_attempt_id'];
  const scope =
    c.loop_id ??
    (typeof attemptId === 'string' && attemptId ? `attempt:${attemptId}` : '');
  return `${c.user_id ?? ''}|${scope}|${e.event_name}|${c.event_seq ?? 1}|${channel}`;
}

/** 服务端权威元数据（metadataMiddleware 计算，前端不可信）。 */
export interface IngestServerMeta {
  /** 回环 IP 或内部白名单判定结果；覆盖前端 context 里的同名标记。 */
  isInternal: boolean;
}

/**
 * @param serverMeta 由埋点路由从 req 传入。K1.4 放量前修复：
 *   前端 buildContext 不产出 is_internal，若只信 ctx.is_internal 则本机调试流量恒为 0，
 *   而归因侧 is_internal=1 → `WHERE is_internal=0` 只过滤归因/曝光、不过滤展示/评价，
 *   导致 K1.5 §5.3-C 曝光→展示漏斗断裂。此处改为服务端判定为准。
 */
export function ingest(events: TrackEvent[], serverMeta?: IngestServerMeta): TrackIngestResponse {
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
        // 服务端判定优先；未提供 serverMeta（内部直接调用 / 旧测试）时回落前端标记。
        is_internal: serverMeta
          ? (serverMeta.isInternal ? 1 : 0)
          : (ctx.is_internal ? 1 : 0),
        // K1.4: 服务端按 anon_user_id 确定性推导分组，使所有埋点事件可按 cohort 切片分析
        rollout_group: assignCohort(ctx.user_id ?? '').group,
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

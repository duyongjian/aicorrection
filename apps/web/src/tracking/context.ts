/**
 * 埋点全局 context 构建（INF-03）
 * 全事件携带：app_version / platform / user_id / segment / session_id / loop_id /
 * ts_utc / event_seq / exp_id / exp_group。
 * user_id / segment 在账户创建后由 tracker.setUser 注入。
 */
import { nanoid } from 'nanoid';
import {
  APP_VERSION,
  DEFAULT_EXP_GROUP,
  ID_PREFIX,
  type Platform,
  type Segment,
  type TrackContext,
} from '@aicorrection/shared';

class TrackingContextManager {
  app_version = APP_VERSION;
  platform: Platform = 'web';
  user_id = '';
  segment: Segment = 'kaoyan';
  session_id = ID_PREFIX.session + nanoid(12);
  exp_id: string | undefined;
  exp_group = DEFAULT_EXP_GROUP;

  setUser(user_id: string, segment: Segment): void {
    this.user_id = user_id;
    this.segment = segment;
  }
}

export const trackingContext = new TrackingContextManager();

export function buildContext(opts: {
  loopId?: string;
  eventSeq: number;
}): TrackContext {
  return {
    app_version: trackingContext.app_version,
    platform: trackingContext.platform,
    user_id: trackingContext.user_id,
    segment: trackingContext.segment,
    session_id: trackingContext.session_id,
    loop_id: opts.loopId,
    ts_utc: new Date().toISOString(),
    event_seq: opts.eventSeq,
    exp_id: trackingContext.exp_id,
    exp_group: trackingContext.exp_group,
  };
}

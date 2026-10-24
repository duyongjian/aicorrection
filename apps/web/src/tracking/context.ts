/**
 * 埋点全局 context 构建（INF-03）
 * 全事件携带：app_version / platform / user_id / segment / session_id / loop_id /
 * ts_utc / event_seq / exp_id / exp_group。
 * user_id / segment 在账户创建后由 tracker.setUser 注入。
 * channel / utm_source / utm_campaign 从 URL 查询参数自动读取。
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
  /** 可通过代码注入覆盖（测试环境 / 服务端打标） */
  channel: string | undefined;
  utm_source: string | undefined;
  utm_campaign: string | undefined;

  setUser(user_id: string, segment: Segment): void {
    this.user_id = user_id;
    this.segment = segment;
  }

  /** 从 URL 查询参数读取 channel / utm_source / utm_campaign */
  readUrlParams(): void {
    if (typeof window === 'undefined') return;
    const sp = new URLSearchParams(window.location.search);
    this.channel = sp.get('channel') || this.channel || 'organic';
    this.utm_source = sp.get('utm_source') || undefined;
    this.utm_campaign = sp.get('utm_campaign') || undefined;
  }
}

export const trackingContext = new TrackingContextManager();
// 初始化时读取 URL 参数
trackingContext.readUrlParams();

export function buildContext(opts: {
  loopId?: string;
  eventSeq: number;
}): TrackContext {
  const ctx: TrackContext = {
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
  // 仅在非空时注入（避免 null 污染 context）
  if (trackingContext.channel) ctx.channel = trackingContext.channel as typeof ctx.channel;
  if (trackingContext.utm_source) ctx.utm_source = trackingContext.utm_source;
  if (trackingContext.utm_campaign) ctx.utm_campaign = trackingContext.utm_campaign;
  return ctx;
}

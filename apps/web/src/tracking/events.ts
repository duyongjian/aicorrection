/**
 * 事件构造器（v0.1 四大业务事件 + screen_view）：
 * loop_upload / loop_attr_show / attr_rate / followup / screen_view
 * 每个构造器产出完整 TrackEvent（含全局 context）。
 */
import { EVENT_NAMES, type TrackEvent, type ScreenViewPage } from '@aicorrection/shared';
import { buildContext } from './context';
import type {
  LoopUploadProps,
  LoopAttrShowProps,
  AttrRateProps,
  FollowupProps,
} from '@aicorrection/shared';

export function makeLoopUpload(
  props: LoopUploadProps,
  eventSeq = 1
): TrackEvent {
  return {
    event_name: EVENT_NAMES.LOOP_UPLOAD,
    context: buildContext({ loopId: props.loop_id, eventSeq }),
    props: props as unknown as Record<string, unknown>,
    ts_utc: new Date().toISOString(),
  };
}

export function makeLoopAttrShow(
  props: LoopAttrShowProps,
  loopId: string,
  eventSeq = 2
): TrackEvent {
  return {
    event_name: EVENT_NAMES.LOOP_ATTR_SHOW,
    context: buildContext({ loopId, eventSeq }),
    props: props as unknown as Record<string, unknown>,
    ts_utc: new Date().toISOString(),
  };
}

export function makeAttrRate(
  props: AttrRateProps,
  loopId: string,
  eventSeq = 3
): TrackEvent {
  return {
    event_name: EVENT_NAMES.ATTR_RATE,
    context: buildContext({ loopId, eventSeq }),
    props: props as unknown as Record<string, unknown>,
    ts_utc: new Date().toISOString(),
  };
}

export function makeFollowup(
  props: FollowupProps,
  loopId: string,
  eventSeq: number
): TrackEvent {
  return {
    event_name: EVENT_NAMES.FOLLOWUP,
    context: buildContext({ loopId, eventSeq }),
    props: props as unknown as Record<string, unknown>,
    ts_utc: new Date().toISOString(),
  };
}

/**
 * screen_view 事件构造器
 * @param screenName 页面名称（upload / attr_show / followup / practice / restate / verify / review / dashboard / other）
 * @param enterTs ISO8601 UTC 进入时间，不传则取当前时间
 */
export function screenView(screenName: ScreenViewPage, enterTs?: string): TrackEvent {
  return {
    event_name: 'screen_view',
    context: buildContext({ eventSeq: 0 }),
    props: { screen_name: screenName } as Record<string, unknown>,
    ts_utc: enterTs ?? new Date().toISOString(),
  };
}

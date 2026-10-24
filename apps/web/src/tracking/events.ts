/**
 * 事件构造器（v0.1 四大业务事件）：loop_upload / loop_attr_show / attr_rate / followup
 * 每个构造器产出完整 TrackEvent（含全局 context）。
 */
import { EVENT_NAMES, type TrackEvent } from '@aicorrection/shared';
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

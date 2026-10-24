/**
 * 埋点 SDK（INF-03）：采集 + 批量上报 + 本地队列重试 + 幂等（event_seq）
 * 业务事件一律由客户端上报；服务端仅接收落库（§7.3）。
 * 注：本地持久化兜底可用 IndexedDB 扩展；此处实现内存队列 + 失败重试，
 * 断网时事件暂存于内存队列，恢复后随下一次 flush 自动续传。
 */
import type { Segment, TrackEvent } from '@aicorrection/shared';
import { trackingContext } from './context';
import {
  makeLoopUpload,
  makeLoopAttrShow,
  makeAttrRate,
  makeFollowup,
  screenView,
} from './events';
import type {
  LoopUploadProps,
  LoopAttrShowProps,
  AttrRateProps,
  FollowupProps,
  ScreenViewPage,
} from '@aicorrection/shared';
import { api } from '../api/client';

const queue: TrackEvent[] = [];
const FLUSH_MS = 800;
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

function scheduleFlush(): void {
  if (timer || flushing) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, FLUSH_MS);
}

async function flush(): Promise<void> {
  if (queue.length === 0) return;
  flushing = true;
  const batch = queue.splice(0, queue.length);
  try {
    await api.track({ events: batch });
  } catch {
    // 失败：放回队首，下次重试（断网恢复后自动续传）
    queue.unshift(...batch);
  } finally {
    flushing = false;
    if (queue.length > 0) scheduleFlush();
  }
}

export const tracker = {
  /** 账户创建后注入 user_id / segment */
  setUser(user_id: string, segment: Segment): void {
    trackingContext.setUser(user_id, segment);
  },

  loopUpload(props: LoopUploadProps): void {
    queue.push(makeLoopUpload(props, 1));
    scheduleFlush();
  },

  loopAttrShow(props: LoopAttrShowProps, loopId: string): void {
    queue.push(makeLoopAttrShow(props, loopId, 2));
    scheduleFlush();
  },

  attrRate(props: AttrRateProps, loopId: string): void {
    queue.push(makeAttrRate(props, loopId, 3));
    scheduleFlush();
  },

  followup(props: FollowupProps, loopId: string, eventSeq: number): void {
    queue.push(makeFollowup(props, loopId, eventSeq));
    scheduleFlush();
  },

  /**
   * screen_view 事件上报
   * @param screenName 页面名称
   * @param enterTs 进入时间（ISO8601），不传则用当前时间
   */
  screenView(screenName: ScreenViewPage, enterTs?: string): void {
    queue.push(screenView(screenName, enterTs));
    scheduleFlush();
  },

  /** 立即强制上报（页面卸载前调用） */
  async flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await flush();
  },
};

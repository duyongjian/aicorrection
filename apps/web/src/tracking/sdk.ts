/**
 * 埋点 SDK（INF-03）：采集 + 批量上报 + 队列重试 + 幂等（event_seq）
 * 业务事件一律由客户端上报；服务端仅接收落库（§7.3）。
 *
 * v0.1.x 上传失败细分：新增 localStorage outbox。
 * 传输失败发生「后端不可达」时，若只用内存队列，刷新页面即丢失这条失败证据——
 * 而它恰恰是最需要被测量的失败类型。故把待发队列持久化，恢复后续传（上限 200 条）。
 */
import { validateScreenView } from '@aicorrection/shared';
import type { Segment, TrackEvent } from '@aicorrection/shared';
import { trackingContext } from './context';
import {
  makeLoopUpload,
  makeLoopAttrShow,
  makeAttrRate,
  makeFollowup,
  makeUploadFail,
  screenView,
} from './events';
import type {
  LoopUploadProps,
  LoopAttrShowProps,
  AttrRateProps,
  FollowupProps,
  UploadFailProps,
} from '@aicorrection/shared';
import { api } from '../api/client';

const FLUSH_MS = 800;
const OUTBOX_KEY = 'aicorrection.track.outbox.v1';
const MAX_QUEUE = 200;

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** 读取上次会话未发完的事件（含断网时的 upload_fail）。只接受形状合法的事件。 */
function loadOutbox(): TrackEvent[] {
  const s = safeStorage();
  if (!s) return [];
  try {
    const raw = s.getItem(OUTBOX_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const valid = parsed.filter(
      (e): e is TrackEvent =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as TrackEvent).event_name === 'string' &&
        typeof (e as TrackEvent).ts_utc === 'string'
    );
    return valid.slice(-MAX_QUEUE);
  } catch {
    return [];
  }
}

const queue: TrackEvent[] = loadOutbox();
let timer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

function persistQueue(): void {
  const s = safeStorage();
  if (!s) return;
  try {
    if (queue.length === 0) s.removeItem(OUTBOX_KEY);
    else s.setItem(OUTBOX_KEY, JSON.stringify(queue));
  } catch {
    // 隐私模式 / 配额超限：内存队列仍可用，只是不再跨刷新持久化。
  }
}

function scheduleFlush(): void {
  if (timer || flushing) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, FLUSH_MS);
}

function enqueue(event: TrackEvent): void {
  queue.push(event);
  if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
  persistQueue();
  scheduleFlush();
}

async function flush(): Promise<void> {
  if (flushing || queue.length === 0) return;
  flushing = true;
  const batch = queue.splice(0, queue.length);
  persistQueue();
  try {
    await api.track({ events: batch });
    persistQueue(); // 成功：期间新入队的事件仍需持久化
  } catch {
    // 失败：放回队首，下次重试（断网恢复后自动续传）
    queue.unshift(...batch);
    if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
    persistQueue();
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
    enqueue(makeLoopUpload(props, 1));
  },

  loopAttrShow(props: LoopAttrShowProps, loopId: string): void {
    enqueue(makeLoopAttrShow(props, loopId, 2));
  },

  attrRate(props: AttrRateProps, loopId: string): void {
    enqueue(makeAttrRate(props, loopId, 3));
  },

  followup(props: FollowupProps, loopId: string, eventSeq: number): void {
    enqueue(makeFollowup(props, loopId, eventSeq));
  },

  /**
   * 上传失败诊断事件（v0.1.x 增量）。
   * 立即尝试上报：失败往往伴随后端不可达，此时该事件会留在持久化 outbox，
   * 待网络恢复或下次打开页面时自动续传，不会被刷新丢弃。
   */
  uploadFail(props: UploadFailProps): void {
    enqueue(makeUploadFail(props));
    void flush();
  },

  /**
   * screen_view 事件上报（K1.2b 冻结校验）
   *
   * 仅 v0.1 ACTIVE 页（upload / attr_show / followup）允许上报；
   * PENDING 页（practice/restate/verify/review/dashboard/other）或未知页名
   * 一律丢弃并告警，避免污染 v0.1 分析口径。
   *
   * @param screenName 页面名称
   * @param enterTs 进入时间（ISO8601），不传则用当前时间
   */
  screenView(screenName: string, enterTs?: string): void {
    const v = validateScreenView(screenName);
    if (!v.ok) {
      if (v.reason === 'pending') {
        console.warn(
          `[tracking] screen_view "${String(screenName)}" 在 v0.1 为 PENDING，已丢弃（不上报）`
        );
      } else {
        console.warn(
          `[tracking] screen_view 未知页名 "${String(screenName)}"，已丢弃（请先在 SCREEN_VIEW_STATUS 登记）`
        );
      }
      return;
    }
    enqueue(screenView(v.page, enterTs));
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

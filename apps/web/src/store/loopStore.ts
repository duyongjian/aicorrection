/**
 * 轻量全局状态（zustand）：贯穿单题闭环的 loop 上下文。
 */
import { create } from 'zustand';
import { nanoid } from 'nanoid';
import { ID_PREFIX } from '@aicorrection/shared';
import type {
  Segment,
  OcrStatus,
  UploadResponse,
  AttributionOkData,
} from '@aicorrection/shared';

/**
 * 匿名身份持久化（FLW-02 前置）：anon_user_id + segment 存 localStorage，
 * 使同一浏览器跨刷新/跨页面保持稳定身份。否则每次刷新都新建匿名用户，
 * 历史会被切碎、按当前用户查历史也会查空。
 */
const LS_KEY = 'aicorrection_anon_user';

interface PersistedUser {
  anonUserId: string;
  segment: Segment;
}

function loadPersistedUser(): PersistedUser | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<PersistedUser>;
    if (p && typeof p.anonUserId === 'string' && p.anonUserId && p.segment) {
      return { anonUserId: p.anonUserId, segment: p.segment as Segment };
    }
  } catch {
    /* 解析失败忽略，等同未登录 */
  }
  return null;
}

function savePersistedUser(id: string, segment: Segment): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ anonUserId: id, segment }));
  } catch {
    /* 隐私模式/配额超限忽略 */
  }
}

const persisted = loadPersistedUser();

interface LoopStore {
  anonUserId: string | null;
  segment: Segment | null;
  sessionId: string;
  loop: UploadResponse | null;
  attribution: AttributionOkData | null;
  loading: boolean;
  error: string | null;

  setAnonUser: (id: string, segment: Segment) => void;
  setLoop: (loop: UploadResponse) => void;
  setAttribution: (a: AttributionOkData) => void;
  setLoading: (v: boolean) => void;
  setError: (msg: string | null) => void;
  resetLoop: () => void;
}

export const useLoopStore = create<LoopStore>((set) => ({
  anonUserId: persisted?.anonUserId ?? null,
  segment: persisted?.segment ?? null,
  sessionId: ID_PREFIX.session + nanoid(12),
  loop: null,
  attribution: null,
  loading: false,
  error: null,

  setAnonUser: (id, segment) => {
    savePersistedUser(id, segment);
    set({ anonUserId: id, segment });
  },
  setLoop: (loop) => set({ loop, error: null }),
  setAttribution: (a) => set({ attribution: a }),
  setLoading: (v) => set({ loading: v }),
  setError: (msg) => set({ error: msg }),
  resetLoop: () =>
    set({ loop: null, attribution: null, error: null, loading: false }),
}));

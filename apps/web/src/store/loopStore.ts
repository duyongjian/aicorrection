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
  anonUserId: null,
  segment: null,
  sessionId: ID_PREFIX.session + nanoid(12),
  loop: null,
  attribution: null,
  loading: false,
  error: null,

  setAnonUser: (id, segment) => set({ anonUserId: id, segment }),
  setLoop: (loop) => set({ loop, error: null }),
  setAttribution: (a) => set({ attribution: a }),
  setLoading: (v) => set({ loading: v }),
  setError: (msg) => set({ error: msg }),
  resetLoop: () =>
    set({ loop: null, attribution: null, error: null, loading: false }),
}));

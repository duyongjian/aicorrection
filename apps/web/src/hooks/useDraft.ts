/**
 * 断网草稿暂存（IndexedDB，useDraft）
 * 网络中断时提交失败，将题目草稿存入本地，恢复后重试（retry_count 由客户端计数）。
 * 注：图片二进制草稿 IndexedDB 亦可存 Blob，v0.1 仅恢复文本/元数据 + 提示重拍。
 */
import { useCallback, useState } from 'react';
import type { Segment } from '@aicorrection/shared';

export interface Draft {
  id: string;
  segment: Segment;
  src_type: 'photo' | 'text' | 'paste';
  subject?: string;
  raw_text?: string;
  retry_count: number;
  photo_blur: boolean;
  upload_duration_ms: number;
  image_name?: string;
  created_at: string;
}

const DB_NAME = 'aicorrection-draft';
const STORE = 'drafts';
const VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function useDraft() {
  const [drafts, setDrafts] = useState<Draft[]>([]);

  const loadDrafts = useCallback(async (): Promise<void> => {
    try {
      const db = await openDb();
      const all = await new Promise<Draft[]>((res, rej) => {
        const t = db.transaction(STORE, 'readonly');
        const req = t.objectStore(STORE).getAll();
        req.onsuccess = () => res(req.result as Draft[]);
        req.onerror = () => rej(req.error);
      });
      db.close();
      const sorted = [...all].sort((a, b) =>
        b.created_at.localeCompare(a.created_at)
      );
      setDrafts(sorted);
    } catch {
      /* IndexedDB 不可用时静默降级（草稿功能不可用） */
    }
  }, []);

  const saveDraft = useCallback(
    async (draft: Draft): Promise<void> => {
      try {
        const db = await openDb();
        await new Promise<void>((res, rej) => {
          const t = db.transaction(STORE, 'readwrite');
          t.objectStore(STORE).put(draft);
          t.oncomplete = () => res();
          t.onerror = () => rej(t.error);
        });
        db.close();
        await loadDrafts();
      } catch {
        /* 忽略 */
      }
    },
    [loadDrafts]
  );

  const deleteDraft = useCallback(
    async (id: string): Promise<void> => {
      try {
        const db = await openDb();
        await new Promise<void>((res, rej) => {
          const t = db.transaction(STORE, 'readwrite');
          t.objectStore(STORE).delete(id);
          t.oncomplete = () => res();
          t.onerror = () => rej(t.error);
        });
        db.close();
        await loadDrafts();
      } catch {
        /* 忽略 */
      }
    },
    [loadDrafts]
  );

  return { drafts, loadDrafts, saveDraft, deleteDraft };
}

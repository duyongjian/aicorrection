/**
 * 上传服务（UPL-02）
 * 图片/文本 → OCR → 生成 loop_id → 落 loop_sessions + mistakes。
 * 注意：loop_upload 事件由客户端 SDK 在收到响应后上报（§7.3），服务端不主动发。
 */
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env';
import { createLoopSession } from '../models/loopSessionModel';
import { createMistake } from '../models/mistakeModel';
import { generateLoopId, generateMistakeId } from '../utils/id';
import { recognizeImage, recognizeText } from './ocr/ocrService';
import type {
  LoopSession,
  Mistake,
  Segment,
  SrcType,
  UploadResponse,
} from '@aicorrection/shared';

export interface UploadInput {
  anon_user_id: string;
  segment: Segment;
  session_id: string;
  src_type: SrcType;
  subject?: string;
  retry_count: number;
  photo_blur: boolean;
  upload_duration_ms: number;
  raw_text?: string;
  imageBuffer?: Buffer;
  imageExt?: string;
}

function hashText(text: string): string {
  // 轻量非加密哈希，仅作原文引用占位（敏感原文不入分析库，见 §7.3）
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  }
  return `h${(h >>> 0).toString(36)}`;
}

function extFromMime(mime: string): string {
  if (mime.includes('png')) return '.png';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('gif')) return '.gif';
  return '.jpg';
}

/** loop_id 碰撞重试（better-sqlite3 抛 UNIQUE 冲突则重生成） */
function createLoopSessionRetry(ls: LoopSession): void {
  for (let i = 0; i < 5; i++) {
    try {
      createLoopSession(ls);
      return;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('UNIQUE')) {
        ls.loop_id = generateLoopId();
        continue;
      }
      throw e;
    }
  }
  throw new Error('loop_id 冲突重试失败');
}

export async function handleUpload(input: UploadInput): Promise<UploadResponse> {
  // ① ID 与时间戳（先生成，落盘文件名依赖 mistake_id）
  const loop_id = generateLoopId();
  const mistake_id = generateMistakeId();
  const now = new Date().toISOString();

  // ② 图片先落盘（本地 OCR CLI 接收"图片路径"而非 Buffer，故必须在 OCR 之前）
  //    加密：TODO 待定，见 §8.4，v0.1 先明文落 apps/api/data/uploads/
  let mistake_ref: string | null = null;
  let imagePath: string | null = null;
  if (input.imageBuffer && input.imageExt) {
    fs.mkdirSync(env.UPLOAD_DIR, { recursive: true });
    const fname = `${mistake_id}${input.imageExt}`;
    imagePath = path.join(env.UPLOAD_DIR, fname);
    fs.writeFileSync(imagePath, input.imageBuffer);
    mistake_ref = fname; // TODO: AES-256-GCM 加密存储待定
  } else if (input.raw_text) {
    mistake_ref = `hash:${hashText(input.raw_text)}`;
  }

  // ③ OCR（图片入口传落盘后的绝对路径；文本入口复用原文）
  const ocr =
    imagePath && input.src_type === 'photo'
      ? await recognizeImage(imagePath, { subject: input.subject })
      : recognizeText(input.raw_text);

  // ④ 落库
  createLoopSessionRetry({
    loop_id,
    anon_user_id: input.anon_user_id,
    segment: input.segment,
    session_id: input.session_id,
    start_ts: now,
    complete_ts: null,
    duration_ms: null,
    loop_complete: 0,
    verify_result: null,
    verify_rounds: null,
    followup_rounds: 0,
    has_practice: null,
    restate_len: null,
    restate_is_copy: null,
    created_at: now,
  });

  const mistake: Mistake = {
    mistake_id,
    anon_user_id: input.anon_user_id,
    loop_id,
    subject: input.subject ?? null,
    src_type: input.src_type,
    ocr_status: ocr.ocr_status,
    mistake_ref,
    created_at: now,
  };
  createMistake(mistake);

  return {
    loop_id,
    mistake_id,
    ocr_status: ocr.ocr_status,
    question: ocr.question,
    latex: ocr.latex ?? null,
  };
}

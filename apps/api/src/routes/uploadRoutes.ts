/**
 * 上传路由（UPL-02）
 * 同时支持 multipart（拍照）与 JSON（文本/粘贴）入口。
 */
import { Router } from 'express';
import multer from 'multer';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { SEGMENTS, SRC_TYPES } from '@aicorrection/shared';
import { handleUpload } from '../services/uploadService';
import { ok } from '../utils/result';
import { boolFromForm } from '../middleware/validate';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const fieldSchema = z.object({
  anon_user_id: z.string().min(1),
  segment: z.enum(SEGMENTS),
  session_id: z.string().min(1),
  src_type: z.enum(SRC_TYPES),
  subject: z.string().optional(),
  retry_count: z.coerce.number().int().nonnegative().default(0),
  photo_blur: boolFromForm.default(false),
  upload_duration_ms: z.coerce.number().int().nonnegative().default(0),
  raw_text: z.string().optional(),
});

function extFromMime(mime: string): string {
  if (mime.includes('png')) return '.png';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('gif')) return '.gif';
  return '.jpg';
}

// 仅 multipart 走 multer；JSON 由 express.json() 已解析
const maybeUpload = (req: Request, res: Response, next: NextFunction): void => {
  if (req.is('multipart/form-data')) {
    upload.single('image')(req, res, next);
  } else {
    next();
  }
};

router.post('/', maybeUpload, async (req, res, next) => {
  try {
    const parsed = fieldSchema.parse(req.body);
    const imageBuffer = req.file?.buffer;
    const imageExt = req.file ? extFromMime(req.file.mimetype) : undefined;
    const result = await handleUpload({
      ...parsed,
      imageBuffer,
      imageExt,
    });
    res.json(ok(result));
  } catch (e) {
    next(e);
  }
});

export default router;

/**
 * 上传路由（UPL-02）
 * 同时支持 multipart（拍照）与 JSON（文本/粘贴）入口。
 */
import { Router } from 'express';
import multer from 'multer';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { SEGMENTS, SRC_TYPES, FREE_DAILY_LOOP_QUOTA, ERROR_CODES } from '@aicorrection/shared';
import { handleUpload } from '../services/uploadService';
import { ok } from '../utils/result';
import { boolFromForm } from '../middleware/validate';
import { HttpError } from '../middleware/errorHandler';
import { isLicenseGateEnabled } from '../services/licenseService';
import { countLoopsToday } from '../models/loopSessionModel';

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

    // 每日闭环配额（unlimited_loops 权益的反面）：门禁开启且用户无 unlimited_loops
    // 时，免费版每日限 FREE_DAILY_LOOP_QUOTA 次；达到上限即拦截，引导升级。
    // 门禁关闭（开发态）一律放行，保持全功能可用。
    // 依赖 requireLicense 在 res.locals.identity 写入的 entitlements。
    if (isLicenseGateEnabled()) {
      const identity = res.locals.identity as
        | { entitlements?: string[] }
        | undefined;
      const hasUnlimited = Array.isArray(identity?.entitlements)
        ? identity!.entitlements!.includes('unlimited_loops')
        : false;
      if (!hasUnlimited) {
        const used = countLoopsToday(parsed.anon_user_id);
        if (used >= FREE_DAILY_LOOP_QUOTA) {
          next(
            new HttpError(
              ERROR_CODES.ENTITLEMENT_REQUIRED,
              403,
              `免费版每日最多 ${FREE_DAILY_LOOP_QUOTA} 次闭环，今日已用完。升级专业版 / 旗舰版解锁无限次。`
            )
          );
          return;
        }
      }
    }

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

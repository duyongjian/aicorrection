/**
 * ID 生成规则（§7.1）
 * u_ / l_YYYYMMDD_xxxx / m_ / a_ / s_ / r_ / e_
 */
import { customAlphabet } from 'nanoid';
import { ID_PREFIX } from '@aicorrection/shared';

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const nano12 = customAlphabet(BASE36, 12);
const nano10 = customAlphabet(BASE36, 10);

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

export function generateUserId(): string {
  return ID_PREFIX.user + nano12();
}

export function generateMistakeId(): string {
  return ID_PREFIX.mistake + nano12();
}

export function generateAttributionId(): string {
  return ID_PREFIX.attribution + nano12();
}

export function generateSessionId(): string {
  return ID_PREFIX.session + nano12();
}

export function generateReviewId(): string {
  return ID_PREFIX.review + nano12();
}

export function generateEventId(): string {
  return 'e_' + nano12();
}

export function generateFollowupId(): string {
  return ID_PREFIX.followup + nano12();
}

/** loop_id = l_YYYYMMDD_xxxx（10 位 base36） */
export function generateLoopId(): string {
  const d = new Date();
  const ymd = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  return `${ID_PREFIX.loop}${ymd}_${nano10()}`;
}

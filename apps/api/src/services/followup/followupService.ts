/**
 * 追问服务（FLW-01）
 * 苏格拉底补充归因；MVP 限 1 次有效追问（防 R2 信任崩塌）。
 * 已达 1 次 → 拒绝新增，返回 has_next_action:false + "已达当前追问深度"。
 */
import { getProvider } from '../llm';
import { getLoopSession, incrementFollowupRounds } from '../../models/loopSessionModel';
import { getAttributionByLoop } from '../../models/attributionModel';
import { withTimeout } from '../../utils/promise';
import { TIMEOUT } from '../../config/timeout';
import type { FollowupResponse } from '@aicorrection/shared';
import { FOLLOWUP_SYSTEM, followupUserPrompt } from '../attribution/prompt';

const MAX_FOLLOWUP_ROUNDS = 1;

export async function followup(
  loop_id: string,
  anon_user_id: string,
  message: string,
  _followup_round: number
): Promise<FollowupResponse> {
  const session = getLoopSession(loop_id);
  const usedRounds = session?.followup_rounds ?? 0;

  // 已达有效追问上限 → 拒绝新增
  if (usedRounds >= MAX_FOLLOWUP_ROUNDS) {
    return {
      followup_round: usedRounds,
      role: 'ai_ask',
      content:
        '已达当前追问深度。建议回去做一道同类题巩固该知识点（验证环节将在 v0.2 开放）。',
      has_next_action: false,
      followup_rounds_remaining: 0,
    };
  }

  const provider = getProvider();
  const original = getAttributionByLoop(loop_id);
  const originalText = original
    ? `错因：${original.cause}；知识点：${original.knowledge_point}；本质：${original.essence}`
    : undefined;
  const userContent = followupUserPrompt(message, originalText);

  let content: string;
  try {
    const res = await withTimeout(
      provider.chat(
        [
          { role: 'system', content: FOLLOWUP_SYSTEM },
          { role: 'user', content: userContent },
        ],
        { maxTokens: 600 }
      ),
      TIMEOUT.FOLLOWUP_MS
    );
    content = res.text.trim() || '（模型暂未返回，请稍后重试）';
  } catch {
    content = '（追问生成超时，请稍后重试）';
  }

  incrementFollowupRounds(loop_id);

  return {
    followup_round: usedRounds + 1,
    role: 'ai_ask',
    content,
    has_next_action: true,
    followup_rounds_remaining: 0,
  };
}

/**
 * 账户服务（INF-01）
 * v0.1 仅匿名创建 anon_user_id；微信/手机号登录 UI 不做（推到 v0.2）。
 */
import { createUser, getUser } from '../models/userModel';
import { generateUserId } from '../utils/id';
import { DEFAULT_EXP_GROUP } from '@aicorrection/shared';
import type {
  AccountResponse,
  CreateAccountRequest,
  Segment,
} from '@aicorrection/shared';

export function createAccount(req: CreateAccountRequest): AccountResponse {
  const anon_user_id = generateUserId();
  const now = new Date().toISOString();
  createUser({
    anon_user_id,
    segment: req.segment,
    exp_id: null,
    exp_group: DEFAULT_EXP_GROUP,
    register_ts: now,
    first_pay_ts: null,
    last_active_ts: now,
    churn_status: 'active',
    churn_ts: null,
    created_at: now,
  });
  return {
    anon_user_id,
    segment: req.segment as Segment,
    exp_id: null,
    exp_group: DEFAULT_EXP_GROUP,
    register_ts: now,
  };
}

export function getAccount(anon_user_id: string): AccountResponse | null {
  const u = getUser(anon_user_id);
  if (!u) return null;
  return {
    anon_user_id: u.anon_user_id,
    segment: u.segment,
    exp_id: u.exp_id,
    exp_group: u.exp_group,
    register_ts: u.register_ts,
  };
}

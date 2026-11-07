-- 商业化：卡密即权益层（线下分发 MVP 延伸）
-- 目标：卡密除「能否进入」外，额外承载档位(tier)与权益(entitlements)；
--      支持订阅生命周期（subscriptions）与支付台账（payments），
--      以及线下「续费」= 延长有效期。

-- license_keys 增加 tier 与权益快照（发卡时按档位冻结，避免档位定义变更后历史卡密权益漂移）
ALTER TABLE license_keys ADD COLUMN tier TEXT NOT NULL DEFAULT 'free';
ALTER TABLE license_keys ADD COLUMN entitlements_json TEXT;

-- license_sessions 冗余存 tier，verify 时无需回表即可返回档位
ALTER TABLE license_sessions ADD COLUMN tier TEXT NOT NULL DEFAULT 'free';

-- 订阅生命周期（线上支付/线下续费都落这里；provider='none' 表示纯卡密权益）
CREATE TABLE IF NOT EXISTS subscriptions (
  subscription_id   TEXT PRIMARY KEY,
  anon_user_id     TEXT NOT NULL REFERENCES users(anon_user_id),
  provider         TEXT NOT NULL DEFAULT 'none',   -- none / stripe / wechat_pay
  provider_sub_id  TEXT,
  tier             TEXT NOT NULL DEFAULT 'free',
  status           TEXT NOT NULL DEFAULT 'active', -- active / cancelled / expired
  current_period_start TEXT NOT NULL,
  current_period_end   TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  cancelled_at     TEXT
);

-- 支付台账（仅作为财务留痕；未配置真实支付 provider 时不写真实金额）
CREATE TABLE IF NOT EXISTS payments (
  payment_id   TEXT PRIMARY KEY,
  anon_user_id TEXT NOT NULL REFERENCES users(anon_user_id),
  provider     TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency     TEXT NOT NULL DEFAULT 'CNY',
  tier         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending / paid / failed
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(anon_user_id);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(anon_user_id);

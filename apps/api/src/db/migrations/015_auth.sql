-- 真实账号体系（v0.2 地基）：在既有 anon_user_id 之上挂一个可链接凭证层。
-- 设计取舍：anon_user_id 仍是系统内唯一身份主键（错题/归因/闭环/埋点全依赖它），
-- 真实账号只是 accounts 表里 provider+identifier→anon_user_id 的映射；
-- 邮箱/手机/微信/magic 任一登录方式都解析回同一个 anon_user_id，老匿名/卡密身份不丢。

-- 凭证映射：同一 (provider, identifier) 唯一（如一个邮箱只能绑定一个账号）。
CREATE TABLE IF NOT EXISTS accounts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  anon_user_id  TEXT NOT NULL REFERENCES users(anon_user_id) ON DELETE CASCADE,
  provider      TEXT NOT NULL CHECK (provider IN ('password','sms','wechat','magic')),
  identifier    TEXT NOT NULL,
  secret_hash   TEXT,                -- 密码 scrypt 哈希 / 短信验证码哈希；微信为 NULL
  verified_at   TEXT,                -- 离线优先：注册即标记 verified，无需外部校验
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_provider_identifier
  ON accounts(provider, identifier);
CREATE INDEX IF NOT EXISTS idx_accounts_anon ON accounts(anon_user_id);

-- 登录会话：auth token ↔ anon_user_id（对称于 license_sessions）。
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash    TEXT PRIMARY KEY,
  anon_user_id  TEXT NOT NULL REFERENCES users(anon_user_id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_anon ON auth_sessions(anon_user_id);

-- 短信验证码：每手机号只保留最新一条（发送时清旧），由服务端按 TTL + 尝试次数做防暴破。
CREATE TABLE IF NOT EXISTS sms_codes (
  phone         TEXT PRIMARY KEY,
  code_hash     TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  consumed      INTEGER NOT NULL DEFAULT 0
);

-- 魔法链接令牌（email 登录）：每邮箱只保留最新一条。
CREATE TABLE IF NOT EXISTS magic_tokens (
  email         TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  consumed      INTEGER NOT NULL DEFAULT 0
);

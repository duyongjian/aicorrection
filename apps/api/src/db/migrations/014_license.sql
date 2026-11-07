-- 线下分发 MVP：卡密 + 凭证会话
-- 数据主权：服务端只存 SHA-256，卡密明文与 token 明文仅在管理员本机生成/兑换时输出一次。
-- 本迁移只做 CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS，
-- 不 ALTER 任何既有表、不改写任何既有数据，对既有库是纯增量。

CREATE TABLE IF NOT EXISTS license_keys (
  code_hash    TEXT PRIMARY KEY,
  code_hint    TEXT NOT NULL,
  batch_id     TEXT NOT NULL,
  note         TEXT,
  status       TEXT NOT NULL DEFAULT 'unused' CHECK (status IN ('unused','redeemed','revoked')),
  expires_at   TEXT,
  anon_user_id TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  redeemed_at  TEXT,
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_license_keys_batch ON license_keys(batch_id);
CREATE INDEX IF NOT EXISTS idx_license_keys_status ON license_keys(status);

CREATE TABLE IF NOT EXISTS license_sessions (
  token_hash   TEXT PRIMARY KEY,
  anon_user_id TEXT NOT NULL,
  code_hash    TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (code_hash) REFERENCES license_keys(code_hash)
);
CREATE INDEX IF NOT EXISTS idx_license_sessions_user ON license_sessions(anon_user_id);

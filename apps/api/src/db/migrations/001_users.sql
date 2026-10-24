CREATE TABLE IF NOT EXISTS users (
  anon_user_id TEXT PRIMARY KEY,
  segment       TEXT NOT NULL CHECK (segment IN ('kaoyan','kaogong','gaozhong')),
  exp_id        TEXT,
  exp_group     TEXT NOT NULL DEFAULT 'none' CHECK (exp_group IN ('control','treatment','none')),
  register_ts   TEXT NOT NULL,
  first_pay_ts  TEXT,
  last_active_ts TEXT,
  churn_status  TEXT NOT NULL DEFAULT 'active' CHECK (churn_status IN ('active','sub_expired','inactive')),
  churn_ts      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_segment ON users(segment);

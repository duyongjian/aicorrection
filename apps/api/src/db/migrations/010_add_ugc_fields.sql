-- Migration 010: 为 qbank_items 追加 UGC 来源追踪列（BD 方案 D 路线：用户 UGC 沉淀）。
--
-- 重要（避免 "duplicate column name"）：
--  source / difficulty / license / created_at 已在 009_qbank_items.sql 中定义，
--  【切勿】在本文件中再次 ALTER 这些列，否则在全新库上会中断迁移、连带后续迁移无法执行。
--  本文件只新增以下 4 列：
--    review_status   审核状态（pending|approved|rejected）
--    contributor_hash 匿名贡献者哈希（UGC 来源追踪，绝不存 PII）
--    votes           社区投票数
--    snippet         UGC 原始来源片段（来源合规留痕）
--
-- 幂等性：migrate.ts 通过 _migrations 表按文件名记录已执行迁移，本文件不会重复跑；
-- 风格与 008_add_mock_flags.sql 一致（直接 ALTER，依赖迁移跟踪防止重复执行）。
ALTER TABLE qbank_items ADD COLUMN review_status TEXT NOT NULL DEFAULT 'approved'
  CHECK (review_status IN ('pending', 'approved', 'rejected'));
ALTER TABLE qbank_items ADD COLUMN contributor_hash TEXT;
ALTER TABLE qbank_items ADD COLUMN votes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE qbank_items ADD COLUMN snippet TEXT;

CREATE INDEX IF NOT EXISTS idx_qbank_review_status ON qbank_items(review_status);
CREATE INDEX IF NOT EXISTS idx_qbank_source          ON qbank_items(source);

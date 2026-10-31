-- Migration 008: 为 analytics_events 加 is_mock / is_internal 布尔列（打标 §T4）。
-- 注意：attributions 表的 is_mock / is_internal 已在 003_attributions.sql 中定义，
-- 此处【切勿】再 ALTER attributions，否则在全新库上会触发 "duplicate column name"，
-- 导致 runMigrations 中断、后续迁移（如 009）无法执行。
ALTER TABLE analytics_events ADD COLUMN is_mock INTEGER NOT NULL DEFAULT 0 CHECK (is_mock IN (0, 1));
ALTER TABLE analytics_events ADD COLUMN is_internal INTEGER NOT NULL DEFAULT 0 CHECK (is_internal IN (0, 1));
CREATE INDEX IF NOT EXISTS idx_attr_is_mock ON attributions(is_mock);
CREATE INDEX IF NOT EXISTS idx_attr_is_internal ON attributions(is_internal);
CREATE INDEX IF NOT EXISTS idx_events_is_mock ON analytics_events(is_mock);
CREATE INDEX IF NOT EXISTS idx_events_is_internal ON analytics_events(is_internal);

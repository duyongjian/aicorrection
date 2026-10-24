-- Migration 008: 为 attributions 和 analytics_events 加 is_mock / is_internal 布尔列
-- §T4: 服务端强制打标
ALTER TABLE attributions ADD COLUMN is_mock INTEGER NOT NULL DEFAULT 0 CHECK (is_mock IN (0, 1));
ALTER TABLE attributions ADD COLUMN is_internal INTEGER NOT NULL DEFAULT 0 CHECK (is_internal IN (0, 1));
ALTER TABLE analytics_events ADD COLUMN is_mock INTEGER NOT NULL DEFAULT 0 CHECK (is_mock IN (0, 1));
ALTER TABLE analytics_events ADD COLUMN is_internal INTEGER NOT NULL DEFAULT 0 CHECK (is_internal IN (0, 1));
CREATE INDEX IF NOT EXISTS idx_attr_is_mock ON attributions(is_mock);
CREATE INDEX IF NOT EXISTS idx_attr_is_internal ON attributions(is_internal);
CREATE INDEX IF NOT EXISTS idx_events_is_mock ON analytics_events(is_mock);
CREATE INDEX IF NOT EXISTS idx_events_is_internal ON analytics_events(is_internal);

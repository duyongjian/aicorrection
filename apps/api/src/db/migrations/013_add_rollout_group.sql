-- Migration 013: 灰度/金丝雀发布（K1.4）埋点分组列
--
-- 背景：需要把"新模型变体 / 新功能"安全暴露给一定比例真实用户，
-- 并在全量前用指标对比 treatment vs control（认可率 / 延迟）。
-- 做法：attributions 与 analytics_events 各新增一列 rollout_group 标识用户所属分组。
--
-- ⚠️ 铁律（避免 "duplicate column name" 中断迁移，见 008/010 注释）：
--   1) 本文件【只】对 attributions 新增这一列 rollout_group，绝不重复 ALTER 其它列；
--   2) 旧数据（迁移前）因 NOT NULL DEFAULT 'control' 自动归为 control，无需回填；
--   3) 迁移幂等：migrate.ts 用 _migrations 表按文件名记录，本文件不会重复执行。
--   4) analytics_events 同样只加这一列，风格与 008/011/012 保持一致（直接 ALTER + 索引）。

ALTER TABLE attributions
  ADD COLUMN rollout_group TEXT NOT NULL DEFAULT 'control'
  CHECK (rollout_group IN ('control', 'treatment'));

ALTER TABLE analytics_events
  ADD COLUMN rollout_group TEXT NOT NULL DEFAULT 'control'
  CHECK (rollout_group IN ('control', 'treatment'));

CREATE INDEX IF NOT EXISTS idx_attr_rollout_group    ON attributions(rollout_group);
CREATE INDEX IF NOT EXISTS idx_events_rollout_group  ON analytics_events(rollout_group);

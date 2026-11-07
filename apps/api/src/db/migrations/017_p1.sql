/**
 * P1 强化期（R09 错因聚合 / R10 薄弱点可视化 / R11 答案沉淀 / R13 针对性多题 / R14 掌握判定）
 *
 * 设计：
 *  - mastery_state：按 (anon_user_id, kp_key) 存「每个知识点-每个用户」的掌握等级状态机（R14）。
 *    kp_key 优先使用受控词表 knowledge_point_id（kp_xxx）；旧归因若缺 id 则退化为
 *    'txt:<knowledge_point 文本>'，保证所有错题都能被追踪、且同一知识点跨来源归一。
 *    level 受 MASTERY_LEVELS 约束（not_started / learning / familiar / mastered），
 *    状态转移由 aggregationService 按 practice_items + loop 复述/验证结果推导后写回。
 *  - qbank_items.sedimented_from_loop：R11 答案沉淀的来源闭环留痕（UGC 来源合规），
 *    允许为空以兼容既有种子库与开放集导入。
 *
 * 数据主权：掌握度只依赖用户本地作答结论（正确/错误/复述/验证），不回传任何外部模型。
 */

-- R14 掌握判定状态表
CREATE TABLE IF NOT EXISTS mastery_state (
  anon_user_id       TEXT NOT NULL,
  kp_key             TEXT NOT NULL,
  kp_text            TEXT,
  level              TEXT NOT NULL DEFAULT 'not_started'
                      CHECK (level IN ('not_started', 'learning', 'familiar', 'mastered')),
  attempts           INTEGER NOT NULL DEFAULT 0,
  correct            INTEGER NOT NULL DEFAULT 0,
  correct_streak     INTEGER NOT NULL DEFAULT 0,
  last_practiced_ts  TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (anon_user_id, kp_key)
);
CREATE INDEX IF NOT EXISTS idx_mastery_user ON mastery_state(anon_user_id);
CREATE INDEX IF NOT EXISTS idx_mastery_level ON mastery_state(level);

-- R11 答案沉淀来源留痕（UGC 合规）
ALTER TABLE qbank_items ADD COLUMN sedimented_from_loop TEXT;

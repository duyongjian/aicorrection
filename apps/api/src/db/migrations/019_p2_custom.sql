/**
 * P2 自定义知识点（R17）/ 手动错因（R20）/ 知识图谱（R18）。
 *
 * custom_knowledge_points：用户自定义知识点（R17）。系统受控词表 kp_* 之外的个人化标签，
 *   可挂到某个父知识点下形成层级；自定义 kp_id 以 'ckp_' 前缀避免与系统词表冲突。
 *   attribution 的 knowledge_point_id 可指向自定义 kp（外键未强约束，靠应用层校验），
 *   从而使 R09/R10/R14 的聚合能纳入用户自建体系。
 *
 * R20 手动错因不新增表：复用 attributions 的 cause_id / knowledge_point_id 列，
 *   由 /learn/attribution/:loop_id/cause 的 PATCH 直接回写（用户侧的"让我自己定"）。
 */

CREATE TABLE IF NOT EXISTS custom_knowledge_points (
  kp_id          TEXT PRIMARY KEY CHECK (kp_id LIKE 'ckp_%'),
  anon_user_id   TEXT NOT NULL,
  kp_text        TEXT NOT NULL,
  parent_kp_key  TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_custom_kp_user ON custom_knowledge_points(anon_user_id);

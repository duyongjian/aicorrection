-- ATT-01b: 无作答讲解模式。attributions 增加教学三字段（正确答案 / 正确推导 / 常见陷阱）。
-- 均为可空 TEXT，旧数据缺省 NULL；有作答的诊断模式不写入这些字段。
ALTER TABLE attributions ADD COLUMN correct_answer TEXT;
ALTER TABLE attributions ADD COLUMN derivation     TEXT;
ALTER TABLE attributions ADD COLUMN pitfalls       TEXT;

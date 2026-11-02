-- 归因快照：落库题干与用户作答（K1.3 盲评的前置条件）
--
-- 背景：原 attributions 只存结论（错因/知识点/本质/讲解），题干与作答散落在上传链路，
-- 文本题连原文都没有持久化（mistakes.mistake_ref 只对 photo 有意义）。结果是：
-- 无法回放"当时学生怎么答的 + AI 怎么诊断的"，K1.3 的 50–100 条真实错题盲评样本
-- 无法从库里生成，只能靠人工重录。
--
-- 现在把两份快照直接挂在归因记录上：一条归因即一条可复盘的样本。
-- 注意：属用户内容，仅本地留存，不得外发（见数据主权铁律）。
ALTER TABLE attributions ADD COLUMN question TEXT;
ALTER TABLE attributions ADD COLUMN user_answer TEXT;

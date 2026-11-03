import { getDb } from '../db/index.ts';
const db = getDb();
const c = (sql, p = []) => db.prepare(sql).get(...p);
const all = (sql, p = []) => db.prepare(sql).all(...p);

console.log('=== mistakes 按 src_type 分布 ===');
console.table(all('SELECT src_type, COUNT(*) n FROM mistakes GROUP BY src_type'));
console.log('=== mistakes 样例（含 mistake_ref 前 80 字符）===');
for (const m of all(
  `SELECT mistake_id, subject, src_type, ocr_status, substr(mistake_ref,1,80) ref FROM mistakes LIMIT 8`
)) {
  console.log(JSON.stringify(m));
}

console.log('\n=== loop_sessions 表是否存在 / 结构 ===');
const tabs = all("SELECT name FROM sqlite_master WHERE type='table'");
console.log('所有表:', tabs.map((t) => t.name).join(', '));
if (tabs.some((t) => t.name === 'loop_sessions')) {
  console.log('loop_sessions 结构:', all('PRAGMA table_info(loop_sessions)').map((x) => x.name).join(', '));
  console.log('loop_sessions 样例:', JSON.stringify(all('SELECT * FROM loop_sessions LIMIT 2'), null, 1).slice(0, 800));
}

console.log('\n=== attribution→mistake 能否补齐 question/user_answer？ ===');
// 看 attributions 里 user_answer 是否真的全空（用 attribution_id）
console.log('总归因:', c('SELECT COUNT(*) n FROM attributions').n);
console.log('有 user_answer:', c(`SELECT COUNT(*) n FROM attributions WHERE user_answer IS NOT NULL`).n);
console.log('有 question:', c(`SELECT COUNT(*) n FROM attributions WHERE question IS NOT NULL`).n);
console.log('is_mock=0 (真) 且有 user_answer:', c(`SELECT COUNT(*) n FROM attributions WHERE is_mock=0 AND user_answer IS NOT NULL`).n);

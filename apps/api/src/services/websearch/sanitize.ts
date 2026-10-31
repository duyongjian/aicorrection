/**
 * 联网搜索脱敏（P2，数据主权铁律核心）
 *
 * 原则：外发给第三方搜索引擎的内容必须经过脱敏，只发"学科 + 知识点主题词"，
 * 绝不包含学生作答、姓名、手机号、邮箱等任何个人可识别信息（PII）。
 *
 * 依据：用户铁律「用户内容不参与训练、不向第三方转发」。联网搜索是少数会真正
 * 把内容送出本机的路径，故默认关闭；开启后也只发脱敏后的最小主题词，且留本地审计。
 */

/**
 * 从题干（+学科）中提取可外发的脱敏检索词。
 * - 丢弃 userAnswer（可能含个人表达/笔误，且检索并不需要）。
 * - 仅保留题干 + 学科前缀。
 * - 启发式剔除手机号 / 邮箱等 PII。
 * - 截断长度，避免整段长文本外发。
 *
 * @returns 脱敏后的检索词；若脱敏后为空则返回空串（调用方应判空 → 不发起检索）。
 */
export function sanitizeSearchQuery(
  question: string,
  userAnswer?: string,
  subject?: string
): string {
  void userAnswer; // 刻意不使用：学生作答绝不外发
  let q = (question || '').replace(/\s+/g, ' ').trim();
  if (subject) q = `${subject} ${q}`;
  // 启发式剔除 PII
  q = q.replace(/(?:\+?86)?1[3-9]\d{9}/g, ''); // 手机号
  q = q.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, ''); // 邮箱
  q = q.replace(/\b\d{15,18}\b/g, ''); // 疑似身份证/长数字串
  q = q.replace(/\s+/g, ' ').trim();
  // 截断：只发主题词，不整题外发
  if (q.length > 80) q = q.slice(0, 80).trim();
  return q;
}

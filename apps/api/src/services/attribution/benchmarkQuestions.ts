// 考研归因诊断 · 模型极限基准题库（可复用资产）
// 覆盖难度 1（简单）→ 5（高难），跨学科（数学/英语/政治/计算机408/专业课）。
// expectedLetter = 正确答案字母；wrongLetter = 诊断模式故意错选的字母（脚本自动抽取其选项文本作作答）。
// 题型说明：mathVerify 仅对 极限/积分/级数/隐函数 四类可数值验证；其余题型 correct_answer 由讲解模式模型给出，
//           故本题库既能测"数值校验兜底"，也能测"模型本身的跨学科解题与诊断能力"。

export interface BenchItem {
  id: string;
  subject: string;
  /** 1=简单 2=较易 3=中等 4=较难 5=高难 */
  difficulty: number;
  question: string;
  expectedLetter: string;
  wrongLetter: string;
}

export const BENCH_QUESTIONS: BenchItem[] = [
  // ───────── 数学 · 高数 ─────────
  {
    id: 'M1',
    subject: '数学-高数(极限)',
    difficulty: 1,
    question:
      String.raw`\lim_{x\to 0}\frac{\sin x}{x} = (A) 0 (B) 1 (C) 2 (D) \infty`,
    expectedLetter: 'B',
    wrongLetter: 'A',
  },
  {
    id: 'M2',
    subject: '数学-高数(定积分)',
    difficulty: 2,
    question:
      String.raw`\int_0^{1}\frac{1}{1+x^2}\,dx = (A) \frac{\pi}{4} (B) \frac{\pi}{2} (C) \pi (D) 2`,
    expectedLetter: 'A',
    wrongLetter: 'B',
  },
  {
    id: 'M3',
    subject: '数学-高数(隐函数)',
    difficulty: 3,
    question:
      String.raw`设方程 x^2 + y^2 + z^2 = a^2 所确定的隐函数 z=z(x,y)，则 \frac{\partial z}{\partial x} = (A) -\frac{x}{z} (B) \frac{x}{z} (C) -\frac{y}{z} (D) \frac{y}{z}`,
    expectedLetter: 'A',
    wrongLetter: 'B',
  },
  {
    id: 'M4',
    subject: '数学-高数(级数)',
    difficulty: 4,
    question:
      String.raw`\sum_{n=1}^{\infty}\frac{1}{n} (A) 收敛 (B) 发散 (C) 条件收敛 (D) 绝对收敛`,
    expectedLetter: 'B',
    wrongLetter: 'A',
  },
  {
    id: 'M5',
    subject: '数学-高数(泰勒/极限)',
    difficulty: 4,
    question:
      String.raw`\lim_{x\to 0}\frac{1-\cos x}{x^2} = (A) 0 (B) \frac{1}{2} (C) 1 (D) \infty`,
    expectedLetter: 'B',
    wrongLetter: 'A',
  },
  {
    id: 'M6',
    subject: '数学-高数(二重积分·高难)',
    difficulty: 5,
    question:
      String.raw`\iint_{x^2+y^2\le 1}(x^2+y^2)\,dx\,dy = (A) \frac{\pi}{2} (B) \pi (C) \frac{2\pi}{3} (D) \frac{\pi}{4}`,
    expectedLetter: 'A',
    wrongLetter: 'C',
  },
  // ───────── 数学 · 线代 ─────────
  {
    id: 'L1',
    subject: '数学-线代(行列式)',
    difficulty: 1,
    question:
      '设 A 为 3 阶矩阵，|A| = 2，则 |2A| = (A) 4 (B) 8 (C) 16 (D) 2',
    expectedLetter: 'C',
    wrongLetter: 'A',
  },
  {
    id: 'L2',
    subject: '数学-线代(特征值)',
    difficulty: 3,
    question:
      '设 n 阶矩阵 A 的特征值为 1, 2, 3，则 A^{-1} 的特征值为 (A) 1, 2, 3 (B) 1, 1/2, 1/3 (C) -1, -2, -3 (D) 0, 0, 0',
    expectedLetter: 'B',
    wrongLetter: 'A',
  },
  {
    id: 'L3',
    subject: '数学-线代(齐次方程组·较难)',
    difficulty: 4,
    question:
      '设 A 为 n 阶方阵，齐次线性方程组 AX = 0 只有零解的充分必要条件是 (A) |A| ≠ 0 (B) |A| = 0 (C) 秩(A) < n (D) A 为对称矩阵',
    expectedLetter: 'A',
    wrongLetter: 'B',
  },
  // ───────── 数学 · 概率 ─────────
  {
    id: 'P1',
    subject: '数学-概率(期望)',
    difficulty: 1,
    question:
      '设 X ~ B(10, 0.3)（二项分布），则 E(X) = (A) 3 (B) 7 (C) 0.3 (D) 10',
    expectedLetter: 'A',
    wrongLetter: 'C',
  },
  {
    id: 'P2',
    subject: '数学-概率(正态分布)',
    difficulty: 3,
    question:
      '设随机变量 X ~ N(0,1)（标准正态分布），则 P(X < 0) = (A) 0 (B) 0.5 (C) 1 (D) 0.25',
    expectedLetter: 'B',
    wrongLetter: 'A',
  },
  {
    id: 'P3',
    subject: '数学-概率(变量变换·较难)',
    difficulty: 4,
    question:
      '设 X ~ U(0,1)（均匀分布），Y = X^2，则 E(Y) = (A) 1/2 (B) 1/3 (C) 1/4 (D) 2/3',
    expectedLetter: 'B',
    wrongLetter: 'A',
  },
  // ───────── 英语 ─────────
  {
    id: 'E1',
    subject: '英语(虚拟语气)',
    difficulty: 1,
    question:
      'If I ___ you, I would take the job. (A) am (B) was (C) were (D) be',
    expectedLetter: 'C',
    wrongLetter: 'B',
  },
  {
    id: 'E2',
    subject: '英语(词汇辨析)',
    difficulty: 3,
    question:
      'The new policy will ___ the development of local industries rather than hold it back. (A) hinder (B) facilitate (C) complicate (D) terminate',
    expectedLetter: 'B',
    wrongLetter: 'A',
  },
  {
    id: 'E3',
    subject: '英语(倒装·较难)',
    difficulty: 4,
    question:
      'Not until he failed the exam ___ the importance of studying. (A) he realized (B) did he realize (C) he did realize (D) realized he',
    expectedLetter: 'B',
    wrongLetter: 'A',
  },
  // ───────── 政治 ─────────
  {
    id: 'Z1',
    subject: '政治-毛中特',
    difficulty: 1,
    question:
      '习近平新时代中国特色社会主义思想的核心要义是 (A) 坚持和发展中国特色社会主义 (B) 实现中华民族伟大复兴 (C) 全面建成小康社会 (D) 全面深化改革',
    expectedLetter: 'A',
    wrongLetter: 'B',
  },
  {
    id: 'Z2',
    subject: '政治-史纲',
    difficulty: 3,
    question:
      '标志着中国新民主主义革命开端的事件是 (A) 辛亥革命 (B) 五四运动 (C) 中国共产党成立 (D) 新文化运动',
    expectedLetter: 'B',
    wrongLetter: 'A',
  },
  {
    id: 'Z3',
    subject: '政治-马原(矛盾精髓·较难)',
    difficulty: 4,
    question:
      '唯物辩证法认为，矛盾问题的精髓是 (A) 矛盾的同一性和斗争性 (B) 矛盾的普遍性和特殊性 (C) 主要矛盾和次要矛盾 (D) 内部矛盾和外部矛盾',
    expectedLetter: 'B',
    wrongLetter: 'A',
  },
  // ───────── 计算机 408 ─────────
  {
    id: 'C1',
    subject: '计算机408-OS(死锁)',
    difficulty: 1,
    question:
      '下列选项中，不属于死锁必要条件的是 (A) 互斥 (B) 占有并等待 (C) 不可剥夺 (D) 优先级高',
    expectedLetter: 'D',
    wrongLetter: 'A',
  },
  {
    id: 'C3',
    subject: '计算机408-计组(Cache·较难)',
    difficulty: 4,
    question:
      '若 Cache 采用直接映射，主存地址可分为 (A) 主存字地址和字内地址 (B) 标记、组索引、块内地址 (C) 标记、行索引、块内地址 (D) 页号、页内偏移',
    expectedLetter: 'C',
    wrongLetter: 'B',
  },
  {
    id: 'C4',
    subject: '计算机408-OS(死锁避免·高难)',
    difficulty: 5,
    question:
      '某系统有 5 个进程，每个进程最多需要 3 个同类资源。为保证系统绝不发生死锁，系统至少应配置该类资源 (A) 9 (B) 11 (C) 13 (D) 15 个',
    expectedLetter: 'B',
    wrongLetter: 'A',
  },
  // ───────── 专业课 ─────────
  {
    id: 'S1',
    subject: '经济学(微观)',
    difficulty: 3,
    question:
      '当商品的需求价格弹性 Ed > 1（富有弹性）时，降低价格会使总收益 (A) 增加 (B) 减少 (C) 不变 (D) 先增后减',
    expectedLetter: 'A',
    wrongLetter: 'B',
  },
  {
    id: 'S4',
    subject: '西医综合(生理)',
    difficulty: 1,
    question:
      '正常成年人在安静状态下的心率范围约为 (A) 40-60 次/分 (B) 60-100 次/分 (C) 100-120 次/分 (D) 120-140 次/分',
    expectedLetter: 'B',
    wrongLetter: 'A',
  },
];

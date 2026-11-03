/**
 * 知识锚点单测（node:test + tsx）。
 * 覆盖：getKnowledgeReferences 的英文分词命中/数学不命中/语境门控，
 * 以及 parseAttrTriple 在模型输出前置锚点文本时仍能正确提取三行（锚点不污染解析）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getKnowledgeReferences, GOLD_REFERENCES } from './references';
import { parseAttrTriple } from './prompt';

// 种子锚点：kp-nonfinite-participle（非谓语动词·分词作状语）
const PARTICIPLE_ANCHOR = GOLD_REFERENCES[0].anchor;

test('E03 类输入（英文 + praise/分词语境）命中非谓语分词锚点', () => {
  const q = '___ by the teacher, the boy felt ashamed. (用 praise 的适当形式填空)';
  const anchors = getKnowledgeReferences(q, 'Praising', 'english');
  assert.equal(anchors.length, 1);
  assert.ok(anchors.includes(PARTICIPLE_ANCHOR), '应返回 kp-nonfinite-participle 锚点');
});

test('数学题（M01 隐函数求导）不命中任何锚点（回归安全）', () => {
  const q = '已知函数 y = f(x) 由方程 x^2 + y^2 = 1 隐式定义，求 dy/dx。';
  const anchors = getKnowledgeReferences(q, "2x + 2y y' = 0", 'math');
  assert.equal(anchors.length, 0);
});

test('E05/E06 英文分词主动/被动双向覆盖仍命中锚点', () => {
  const e05 = getKnowledgeReferences(
    '___ the letter, she burst into tears. (用 read 的适当形式填空)',
    'Read',
    'english'
  );
  const e06 = getKnowledgeReferences(
    '___ from the hill, we saw the whole city. (用 see 的适当形式填空)',
    'Seen',
    'english'
  );
  assert.equal(e05.length, 1);
  assert.equal(e06.length, 1);
});

test('英文分词语境门控：无 subject 且无 ___ 空时，纯英文词形不误触发', () => {
  const q = 'Please read the book. Seen from far away, it looks small.';
  const anchors = getKnowledgeReferences(q, 'Reading', undefined);
  assert.equal(anchors.length, 0, '未带 subject 且无下划线空的英文句不应触发锚点');
});

test('解析不被前置锚点文本污染：夹杂规则/范本等词仍可提取三行', () => {
  const modelOutput = `【知识锚点】规则：分词（短语）作状语时，其逻辑主语就是主句主语……
范本：'Seen from the top of the hill, the city looks beautiful.'
错因：主语 the boy 与 praise 是被动关系（被老师表扬），应使用过去分词 Praised 而非现在分词 Praising
知识点：非谓语动词（分词作状语）
本质：分词作状语时逻辑主语即主句主语，需先判断主谓主动/被动关系`;
  const parsed = parseAttrTriple(modelOutput);
  assert.equal(parsed.hasThree, true, '前置锚点文本不应影响三行解析');
  assert.ok(/被动关系|Praised/i.test(parsed.cause ?? ''));
  assert.ok((parsed.knowledge_point ?? '').includes('非谓语动词'));
  assert.ok((parsed.essence ?? '').includes('逻辑主语'));
});

// ---------- kp-subject-verb-agreement（主谓一致·neither/either/each/every of + 复数 → 单数）----------

const SVA_ANCHOR =
  GOLD_REFERENCES.find((r) => r.id === 'kp-subject-verb-agreement')?.anchor ?? '';

test('re03 类（neither of + 复数）命中主谓一致锚点', () => {
  const q = '选择正确答案：Neither of the answers ___ correct.\nA. are　B. is　C. were　D. be';
  const anchors = getKnowledgeReferences(
    q,
    '选 A（are）。answers 是复数，所以谓语用 are。',
    'english'
  );
  assert.equal(anchors.length, 1);
  assert.ok(anchors.includes(SVA_ANCHOR), '应返回 kp-subject-verb-agreement 锚点');
});

test('数学题（rm01 隐函数求导）不命中主谓一致锚点（回归安全）', () => {
  const q = '已知函数 y = f(x) 由方程 x^2 + y^2 = 1 隐式定义，求 dy/dx。';
  const anchors = getKnowledgeReferences(q, "2x + 2y y' = 0", 'math');
  assert.equal(anchors.length, 0, '纯数学题不得误触发主谓一致锚点');
});

test('解析不被主谓一致锚点文本污染：夹杂规则/易错陷阱仍可提取三行', () => {
  const modelOutput = `【知识锚点】规则：以下不定代词作主语时，谓语用单数（is / was / has）……
易错陷阱：学生常按"of 后就近的复数名词"判定主谓一致
错因：主语 Neither of the answers 语义为单数，谓语应使用 is，而非 are
知识点：不定代词 neither/either/each/every 作主语时，谓语用单数
本质：Neither 是单数代词，主谓一致取决于主语本身而非 of 后的名词`;
  const parsed = parseAttrTriple(modelOutput);
  assert.equal(parsed.hasThree, true, '前置锚点文本不应影响三行解析');
  assert.ok(/is.*而非.*are|are.*is/i.test(parsed.cause ?? ''), '应识别 are→is 的纠正');
});

// ---------- kp-chengyu-wangwen（成语望文生义陷阱）----------

const CHENGYU_ANCHOR =
  GOLD_REFERENCES.find((r) => r.id === 'kp-chengyu-wangwen')?.anchor ?? '';

test('ry03 类（文不加点·望文生义陷阱）命中成语锚点', () => {
  const q =
    '判断下列句子中加点成语使用是否恰当，并说明理由：\n这篇文章文不加点，一气呵成，读来酣畅淋漓。';
  const anchors = getKnowledgeReferences(
    q,
    '使用不恰当，"文不加点"指文章不加标点，这里用错了。',
    'chinese'
  );
  assert.equal(anchors.length, 1);
  assert.ok(anchors.includes(CHENGYU_ANCHOR), '应返回 kp-chengyu-wangwen 锚点');
});

test('数学题（rm02 积分）不命中成语锚点（回归安全）', () => {
  const q = '求 ∫₀¹ x·e^x dx 的值。';
  const anchors = getKnowledgeReferences(q, '用分部积分：u=x, dv=e^x dx', 'math');
  assert.equal(anchors.length, 0, '纯数学题不得误触发成语锚点');
});

test('解析不被成语锚点文本污染：夹杂原则/正解仍可提取三行', () => {
  const modelOutput = `【知识锚点】原则：判断成语使用是否恰当必须依据约定俗成义……
常见望文生义陷阱与正解：文不加点指写文章一气呵成、无需修改
错因：学生误判：原解/原用法无误
知识点：文不加点中"点"是涂改、改动之意，指文思敏捷、写作流畅
本质：学生按字面逐字（望文生义）误读了"点"的含义，原句使用恰当`;
  const parsed = parseAttrTriple(modelOutput);
  assert.equal(parsed.hasThree, true, '前置锚点文本不应影响三行解析');
  assert.ok(/误判|原用法无误/i.test(parsed.cause ?? ''), '应识别为 student 误判');
});

// ---------- kp-subjunctive-mood（虚拟语气·high time / 与事实相反）----------

const SUBJUNCTIVE_ANCHOR =
  GOLD_REFERENCES.find((r) => r.id === 'kp-subjunctive-mood')?.anchor ?? '';

test('re05 类（It is high time + 过去式）命中虚拟语气锚点', () => {
  const q = '选择正确答案：It is high time that we ____ home.\nA. go　B. went　C. will go　D. have gone';
  const anchors = getKnowledgeReferences(q, 'A', 'english');
  assert.equal(anchors.length, 1);
  assert.ok(anchors.includes(SUBJUNCTIVE_ANCHOR), '应返回 kp-subjunctive-mood 锚点');
});

test('普通主谓一致题（re02 The number of ... is）不命中虚拟语气锚点（防噪声）', () => {
  const q = '选择正确答案：The number of pages in this book ___ large.\nA. are　B. is';
  const anchors = getKnowledgeReferences(q, 'B', 'english');
  assert.equal(anchors.length, 0, '普通 SVA 题不得误触发虚拟语气锚点');
});

test('解析不被虚拟语气锚点文本污染：夹杂规则/判定方法仍可提取三行', () => {
  const modelOutput = `【知识锚点】规则：英语虚拟语气由固定结构决定谓语形式……
"It is high time that + 主语 + 动词过去式"
错因：误选动词原形 go，未遵循 "It is high time that" 后接过去式表示虚拟语气的固定结构
知识点："It is high time that + 主语 + 动词过去式"是固定虚拟语气结构
本质：该结构强制要求过去式以表达"早已该发生"的虚拟含义`;
  const parsed = parseAttrTriple(modelOutput);
  assert.equal(parsed.hasThree, true, '前置锚点文本不应影响三行解析');
  assert.ok(/go.*went|过去式/i.test(parsed.cause ?? ''), '应识别 go→went 的纠正');
});


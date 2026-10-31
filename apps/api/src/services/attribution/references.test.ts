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

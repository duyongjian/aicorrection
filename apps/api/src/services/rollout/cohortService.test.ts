/**
 * Cohort 分配单测（node:test + tsx）。
 * 覆盖：确定性、off/percentage/cohort 策略、kill-switch、feature-flag 门控。
 * 纯函数、无 DB / 无 IO，可直接运行：npm run test -w @aicorrection/api
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assignCohort,
  bucketOf,
  fnv1a32,
} from './cohortService';
import { isFeatureEnabled, ROLLOUT_FEATURE_FLAGS } from '../../config/rollout';

const OFF_CFG = {
  strategy: 'off' as const,
  pct: 0,
  cohortAllowlist: [] as string[],
  killSwitch: false,
};

test('fnv1a32 确定性 & 无符号', () => {
  const a = fnv1a32('u_abc123');
  const b = fnv1a32('u_abc123');
  assert.equal(a, b);
  assert.ok(a >= 0 && a <= 0xffffffff);
});

test('bucketOf 稳定且落在 [0,100)', () => {
  const u = 'u_deterministic_user';
  assert.equal(bucketOf(u), bucketOf(u));
  const b = bucketOf(u);
  assert.ok(b >= 0 && b < 100);
  assert.equal(bucketOf(''), 0); // 空 id 归 bucket 0
});

test('off 策略：100% control，且不受 pct 影响', () => {
  for (const id of ['u_1', 'u_2', 'u_zzz', '']) {
    const r = assignCohort(id, { config: { ...OFF_CFG, pct: 100 } });
    assert.equal(r.group, 'control');
    assert.equal(r.strategy, 'off');
  }
});

test('percentage：同一用户永远同组（确定性）', () => {
  const id = 'u_stable';
  const r1 = assignCohort(id, { config: { ...OFF_CFG, strategy: 'percentage', pct: 50 } });
  const r2 = assignCohort(id, { config: { ...OFF_CFG, strategy: 'percentage', pct: 50 } });
  assert.equal(r1.group, r2.group);
});

test('percentage：pct=0 → 全 control；pct=100 → 全 treatment', () => {
  const id = 'u_x';
  assert.equal(
    assignCohort(id, { config: { ...OFF_CFG, strategy: 'percentage', pct: 0 } }).group,
    'control'
  );
  assert.equal(
    assignCohort(id, { config: { ...OFF_CFG, strategy: 'percentage', pct: 100 } }).group,
    'treatment'
  );
});

test('percentage：bucket < pct 进 treatment，否则 control', () => {
  // 找一个 bucket < 10 和一个 bucket >= 10 的 id，验证边界语义。
  let low: string | null = null;
  let high: string | null = null;
  for (let i = 0; i < 200 && (low === null || high === null); i++) {
    const id = `u_probe_${i}`;
    if (bucketOf(id) < 10 && low === null) low = id;
    if (bucketOf(id) >= 10 && high === null) high = id;
  }
  assert.ok(low && high);
  assert.equal(
    assignCohort(low!, { config: { ...OFF_CFG, strategy: 'percentage', pct: 10 } }).group,
    'treatment'
  );
  assert.equal(
    assignCohort(high!, { config: { ...OFF_CFG, strategy: 'percentage', pct: 10 } }).group,
    'control'
  );
});

test('cohort 白名单：名单内 treatment，名单外 control', () => {
  const cfg = { ...OFF_CFG, strategy: 'cohort' as const, cohortAllowlist: ['u_vip'] };
  assert.equal(assignCohort('u_vip', { config: cfg }).group, 'treatment');
  assert.equal(assignCohort('u_other', { config: cfg }).group, 'control');
});

test('kill-switch：无论策略强制 100% control', () => {
  const cfg = {
    strategy: 'percentage' as const,
    pct: 100,
    cohortAllowlist: [] as string[],
    killSwitch: true,
  };
  const r = assignCohort('u_any', { config: cfg });
  assert.equal(r.group, 'control');
  assert.equal(r.strategy, 'off'); // 实际生效策略回落 off，便于审计
  assert.equal(r.reason, 'kill_switch');
});

test('feature-flag：默认关闭 → treatment 也拿不到；开启后仅 treatment 命中', () => {
  const flag = ROLLOUT_FEATURE_FLAGS.newExplanationStyle;
  const original = flag.enabled;
  const treatment = { group: 'treatment' as const };
  const control = { group: 'control' as const };

  try {
    // 默认/关闭态：两组的任何组都拿不到
    flag.enabled = false;
    assert.equal(isFeatureEnabled('newExplanationStyle', treatment), false);
    assert.equal(isFeatureEnabled('newExplanationStyle', control), false);
    assert.equal(isFeatureEnabled('unknownFeature', treatment), false);

    // 开启态：仅 eligibleGroup(treatment) 命中，control 仍拿不到（保证对照干净）
    flag.enabled = true;
    assert.equal(isFeatureEnabled('newExplanationStyle', treatment), true);
    assert.equal(isFeatureEnabled('newExplanationStyle', control), false);
  } finally {
    flag.enabled = original; // 还原，避免污染其它测试
  }
});

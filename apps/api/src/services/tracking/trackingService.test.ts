/**
 * 埋点服务回归测试（node:test）—— K1.4「放量就绪」三条数据可信度修复。
 *
 * 覆盖：
 *  1) 服务端 serverMeta.isInternal 覆盖前端 context 的 is_internal（QA P1 漏斗断裂根因）
 *  2) 未提供 serverMeta 时向后兼容（回落 context 标记）
 *  3) rollout_group 由同一 user_id 确定性推导，默认 off 恒为 control
 *  4) 幂等键去重仍生效
 *  5) markExposureMockFlag 只把指定 (user, loop) 的 rollout_exposure 对齐到归因最终 is_mock
 *  6) 曝光 / 展示 / 评价三类事件在同一 serverMeta 下 is_internal 同源（§5.3-C 漏斗成立）
 *
 * 运行：npm -w @aicorrection/api run test
 * 隔离：临时 DB（process.env.DB_PATH 在任何业务模块 import 之前设定），退出即清理。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { APP_VERSION, DEFAULT_EXP_GROUP } from '@aicorrection/shared';
import type { TrackEvent } from '@aicorrection/shared';

// 在 import 业务模块前设定临时 DB，确保 getDb 落到隔离库（不污染 335MB 生产库）。
const tmpDb = path.join(os.tmpdir(), `tracking-service-test-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const { ingest } = await import('./trackingService');
const { insertEvent, markExposureMockFlag } = await import('../../models/analyticsEventModel');
const { getDb, __resetDbSingleton } = await import('../../db');
const { generateEventId } = await import('../../utils/id');

process.on('exit', () => {
  try {
    __resetDbSingleton();
  } catch {
    /* ignore */
  }
  for (const suffix of ['', '-wal', '-journal', '-shm']) {
    try {
      fs.rmSync(tmpDb + suffix, { force: true });
    } catch {
      /* ignore */
    }
  }
});

function makeEvent(opts: {
  user?: string;
  loop?: string;
  name?: string;
  seq?: number;
  ctxInternal?: boolean;
} = {}): TrackEvent {
  return {
    event_name: opts.name ?? 'loop_attr_show',
    context: {
      app_version: APP_VERSION,
      platform: 'web',
      user_id: opts.user ?? 'user_k14_a',
      segment: 'kaoyan',
      session_id: 'sess_k14_test',
      loop_id: opts.loop ?? 'loop_k14_1',
      ts_utc: new Date().toISOString(),
      event_seq: opts.seq ?? 1,
      exp_group: DEFAULT_EXP_GROUP,
      ...(opts.ctxInternal === undefined ? {} : { is_internal: opts.ctxInternal }),
    },
    props: {},
    ts_utc: new Date().toISOString(),
  };
}

type Row = Record<string, unknown>;
function all(sql: string, ...params: unknown[]): Row[] {
  return getDb().prepare(sql).all(...params) as Row[];
}

// ── 1) 服务端判定必须覆盖前端标记（两个方向都验） ────────────────────────────
test('serverMeta.isInternal=true 覆盖前端 ctx.is_internal=false', () => {
  const e = makeEvent({ name: 'evt_srv_true', seq: 101, ctxInternal: false });
  const r = ingest([e], { isInternal: true });
  assert.equal(r.accepted, 1);
  const row = all("SELECT is_internal FROM analytics_events WHERE event_name='evt_srv_true'")[0];
  assert.equal(row?.is_internal, 1);
});

test('serverMeta.isInternal=false 覆盖前端 ctx.is_internal=true', () => {
  const e = makeEvent({ name: 'evt_srv_false', seq: 102, ctxInternal: true });
  ingest([e], { isInternal: false });
  const row = all("SELECT is_internal FROM analytics_events WHERE event_name='evt_srv_false'")[0];
  assert.equal(row?.is_internal, 0);
});

// ── 2) 向后兼容：不传 serverMeta 时回落前端标记 ─────────────────────────────
test('无 serverMeta 时回落 context.is_internal（向后兼容）', () => {
  ingest([makeEvent({ name: 'evt_compat_on', seq: 103, ctxInternal: true })]);
  ingest([makeEvent({ name: 'evt_compat_off', seq: 104 })]);
  assert.equal(
    all("SELECT is_internal FROM analytics_events WHERE event_name='evt_compat_on'")[0]?.is_internal,
    1
  );
  assert.equal(
    all("SELECT is_internal FROM analytics_events WHERE event_name='evt_compat_off'")[0]?.is_internal,
    0
  );
});

// ── 3) 分组确定性 + 默认 off 恒 control ──────────────────────────────────────
test('同一 user_id 的不同事件 rollout_group 一致，默认 off 为 control', () => {
  ingest(
    [
      makeEvent({ name: 'evt_grp_1', seq: 105, user: 'user_grp_fixed' }),
      makeEvent({ name: 'evt_grp_2', seq: 106, user: 'user_grp_fixed' }),
    ],
    { isInternal: false }
  );
  const groups = all(
    "SELECT rollout_group FROM analytics_events WHERE event_name IN ('evt_grp_1','evt_grp_2')"
  ).map((r) => r.rollout_group);
  assert.equal(groups.length, 2);
  assert.equal(groups[0], groups[1]);
  assert.equal(groups[0], 'control');
});

// ── 4) 幂等键去重仍生效 ─────────────────────────────────────────────────────
test('重复上报同一事件被幂等键去重（dup=1）', () => {
  const e = makeEvent({ name: 'evt_dup', seq: 107 });
  assert.equal(ingest([e], { isInternal: false }).accepted, 1);
  const r2 = ingest([e], { isInternal: false });
  assert.equal(r2.dup, 1);
  assert.equal(r2.accepted, 0);
  assert.equal(all("SELECT COUNT(*) AS n FROM analytics_events WHERE event_name='evt_dup'")[0]?.n, 1);
});

// ── 5) 曝光事件 is_mock 与归因最终值对齐（含 fallback 场景） ─────────────────
test('markExposureMockFlag 只对指定 (user,loop) 的曝光事件生效', () => {
  const base = {
    event_name: 'rollout_exposure',
    anon_user_id: 'user_expo',
    loop_id: 'loop_expo',
    session_id: null,
    context_json: JSON.stringify({ feature: 'newExplanationStyle' }),
    props_json: JSON.stringify({ group: 'treatment' }),
    ts_utc: new Date().toISOString(),
    received_at: new Date().toISOString(),
    is_mock: 0,
    is_internal: 0,
    rollout_group: 'treatment',
  } as const;

  insertEvent({
    ...base,
    event_id: generateEventId(),
    idempotency_key: 'rollout_exposure|user_expo|loop_expo',
  });
  // 同事件类型的另一 loop（不应被误改）
  insertEvent({
    ...base,
    event_id: generateEventId(),
    loop_id: 'loop_expo_other',
    idempotency_key: 'rollout_exposure|user_expo|loop_expo_other',
  });
  // 同 loop 的非曝光事件（不应被误改）
  insertEvent({
    ...base,
    event_id: generateEventId(),
    event_name: 'loop_attr_show',
    idempotency_key: 'show|user_expo|loop_expo',
  });

  markExposureMockFlag('loop_expo', 'user_expo', true);

  const exposure = all(
    "SELECT is_mock FROM analytics_events WHERE event_name='rollout_exposure' AND loop_id='loop_expo'"
  )[0];
  const otherLoop = all(
    "SELECT is_mock FROM analytics_events WHERE event_name='rollout_exposure' AND loop_id='loop_expo_other'"
  )[0];
  const nonExposure = all(
    "SELECT is_mock FROM analytics_events WHERE event_name='loop_attr_show' AND loop_id='loop_expo'"
  )[0];
  assert.equal(exposure?.is_mock, 1);
  assert.equal(otherLoop?.is_mock, 0);
  assert.equal(nonExposure?.is_mock, 0);
});

// ── 6) 漏斗三类事件 is_internal 同源（QA P1 的端到端判据） ───────────────────
test('曝光/展示/评价在同一 serverMeta 下 is_internal 同源', () => {
  ingest(
    [
      makeEvent({ name: 'rollout_exposure', seq: 108, loop: 'loop_funnel', user: 'user_funnel' }),
      makeEvent({ name: 'loop_attr_show', seq: 109, loop: 'loop_funnel', user: 'user_funnel' }),
      makeEvent({ name: 'attr_rate', seq: 110, loop: 'loop_funnel', user: 'user_funnel' }),
    ],
    { isInternal: true }
  );
  const vals = all(
    "SELECT DISTINCT is_internal AS v FROM analytics_events WHERE loop_id='loop_funnel'"
  ).map((r) => r.v);
  assert.deepEqual(vals, [1], '三类事件必须同为内部流量，WHERE is_internal=0 才不会切断漏斗');
});

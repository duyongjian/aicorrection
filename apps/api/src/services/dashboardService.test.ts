/**
 * 上传失败细分看板聚合回归测试（node:test）。
 * 验证：M5 原口径不变 / 尝试级口径互不重复 / 真实流量过滤 / 未知值归 unknown。
 *
 * 运行：npm -w @aicorrection/api run test
 * 隔离：临时 DB（在任何业务模块 import 前设定 process.env.DB_PATH），退出即清理。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmpDb = path.join(os.tmpdir(), `upload-fail-dash-test-${Date.now()}-${process.pid}.db`);
process.env.DB_PATH = tmpDb;

const { computeUploadFailureBreakdown } = await import('./dashboardService');
const { insertEvent } = await import('../models/analyticsEventModel');
const { __resetDbSingleton } = await import('../db');
const { generateEventId } = await import('../utils/id');

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

function put(opts: {
  name: string;
  props: Record<string, unknown>;
  isMock?: number;
  isInternal?: number;
  key: string;
}): void {
  insertEvent({
    event_id: generateEventId(),
    event_name: opts.name,
    anon_user_id: 'u_dash_test',
    loop_id: null,
    session_id: 's_dash_test',
    context_json: JSON.stringify({ user_id: 'u_dash_test', exp_group: 'none' }),
    props_json: JSON.stringify(opts.props),
    ts_utc: new Date().toISOString(),
    idempotency_key: opts.key,
    received_at: new Date().toISOString(),
    is_mock: opts.isMock ?? 0,
    is_internal: opts.isInternal ?? 0,
    rollout_group: 'control',
  });
}

// 3 条 loop_upload（1 条 ocr fail）+ 4 条 upload_fail
put({ name: 'loop_upload', props: { ocr_status: 'success' }, key: 'lu_1' });
put({ name: 'loop_upload', props: { ocr_status: 'success' }, key: 'lu_2' });
put({ name: 'loop_upload', props: { ocr_status: 'fail' }, key: 'lu_3' });
put({
  name: 'upload_fail',
  props: { upload_attempt_id: 'ua_1', failure_stage: 'transport', failure_reason: 'network_error' },
  key: 'uf_1',
});
put({
  name: 'upload_fail',
  props: { upload_attempt_id: 'ua_2', failure_stage: 'transport', failure_reason: 'network_error' },
  key: 'uf_2',
});
put({
  name: 'upload_fail',
  props: { upload_attempt_id: 'ua_3', failure_stage: 'server_reject', failure_reason: 'http_5xx' },
  key: 'uf_3',
});
put({
  name: 'upload_fail',
  // 前端异常/旧版本可能送来未知值 → 必须归 unknown，绝不写自由文本
  props: { upload_attempt_id: 'ua_4', failure_stage: '学生题干', failure_reason: 'boom' },
  key: 'uf_4',
});
// 内部 / mock 流量必须被排除
put({ name: 'upload_fail', props: { failure_stage: 'transport' }, isInternal: 1, key: 'uf_internal' });
put({ name: 'loop_upload', props: { ocr_status: 'fail' }, isMock: 1, key: 'lu_mock' });

test('M5 原口径逐字不变：分母 loop_upload、分子 ocr_status=fail', () => {
  const r = computeUploadFailureBreakdown(14);
  assert.deepEqual(r.m5, {
    loop_upload_total: 3,
    ocr_fail: 1,
    upload_fail_rate: 0.3333,
  });
});

test('尝试级口径：终态互斥，不重复计数', () => {
  const r = computeUploadFailureBreakdown(14);
  assert.equal(r.attempt_total, 7, '3 loop_upload + 4 upload_fail');
  assert.equal(r.failure_total, 5, '1 ocr_fail + 4 upload_fail');
  assert.equal(r.attempt_failure_rate, 0.7143);
  assert.ok(r.attempt_failure_rate > r.m5.upload_fail_rate, '诊断口径应暴露被 M5 漏掉的失败');
  assert.equal(r.scope, 'is_mock=0 AND is_internal=0');
});

test('分层聚合：ocr 由 loop_upload 合成，非法值归 unknown', () => {
  const r = computeUploadFailureBreakdown(14);
  assert.deepEqual(r.by_stage, [
    { key: 'transport', count: 2 },
    { key: 'ocr', count: 1 },
    { key: 'server_reject', count: 1 },
    { key: 'unknown', count: 1 },
  ]);
  assert.deepEqual(r.by_reason, [
    { key: 'network_error', count: 2 },
    { key: 'http_5xx', count: 1 },
    { key: 'ocr_fail', count: 1 },
    { key: 'unknown', count: 1 },
  ]);
  assert.equal(r.by_stage_reason.find((b) => b.key === 'transport|network_error')?.count, 2);
  assert.equal(r.by_stage_reason.find((b) => b.key === 'unknown|unknown')?.count, 1);
});

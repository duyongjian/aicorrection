/**
 * 上传失败细分：受控词表 + 纯分类函数回归测试（node:test）。
 * 纯函数测试，不连 DB、不启动 API、不触碰生产库。
 *
 * 运行：npm -w @aicorrection/api run test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVENT_NAMES,
  UPLOAD_FAILURE_STAGES,
  UPLOAD_FAILURE_REASONS,
  classifyUploadError,
  isUploadFailureStage,
  isUploadFailureReason,
  newUploadAttemptId,
} from '@aicorrection/shared';

test('事件名与受控词表登记完整', () => {
  assert.equal(EVENT_NAMES.UPLOAD_FAIL, 'upload_fail');
  assert.ok(UPLOAD_FAILURE_STAGES.includes('transport'));
  assert.ok(UPLOAD_FAILURE_STAGES.includes('server_reject'));
  assert.ok(UPLOAD_FAILURE_STAGES.includes('ocr'));
  assert.ok(UPLOAD_FAILURE_REASONS.includes('ocr_fail'));
  assert.ok(isUploadFailureStage('transport'));
  assert.ok(!isUploadFailureStage('学生题干原文'));
  assert.ok(isUploadFailureReason('http_5xx'));
  assert.ok(!isUploadFailureReason('Network Error'));
});

test('axios 主动 abort（超时）→ transport / timeout', () => {
  const v = classifyUploadError({
    phase: 'upload',
    hasResponse: false,
    axiosCode: 'ECONNABORTED',
    message: 'timeout of 960000ms exceeded',
  });
  assert.deepEqual(v, { failure_stage: 'transport', failure_reason: 'timeout' });
});

test('连接被拒 → transport / network_error', () => {
  const v = classifyUploadError({
    phase: 'upload',
    hasResponse: false,
    message: 'Network Error',
  });
  assert.deepEqual(v, {
    failure_stage: 'transport',
    failure_reason: 'network_error',
  });
});

test('建账户阶段的断网失败单独归 account_create，不混入 transport', () => {
  const v = classifyUploadError({
    phase: 'account_create',
    hasResponse: false,
    message: 'connect ECONNREFUSED 127.0.0.1:3001',
  });
  assert.equal(v.failure_stage, 'account_create');
  assert.equal(v.failure_reason, 'network_error');
});

test('HTTP 4xx / 5xx → server_reject 且保留 http_status', () => {
  assert.deepEqual(
    classifyUploadError({ phase: 'upload', hasResponse: true, httpStatus: 413 }),
    { failure_stage: 'server_reject', failure_reason: 'http_4xx', http_status: 413 }
  );
  assert.deepEqual(
    classifyUploadError({ phase: 'upload', hasResponse: true, httpStatus: 502 }),
    { failure_stage: 'server_reject', failure_reason: 'http_5xx', http_status: 502 }
  );
});

test('HTTP 200 但业务信封 code!=0 → business_error / backend_reject（优先级高于 HTTP）', () => {
  const v = classifyUploadError({
    phase: 'upload',
    hasResponse: true,
    httpStatus: 200,
    backendCode: 1001,
  });
  assert.deepEqual(v, {
    failure_stage: 'business_error',
    failure_reason: 'backend_reject',
    http_status: 200,
    backend_code: 1001,
  });
});

test('无法归类的错误 → unknown / unknown（不猜测、不写自由文本）', () => {
  const v = classifyUploadError({
    phase: 'upload',
    hasResponse: false,
    message: 'something odd',
  });
  assert.deepEqual(v, { failure_stage: 'unknown', failure_reason: 'unknown' });
  assert.equal('http_status' in v, false);
  assert.equal('backend_code' in v, false);
});

test('newUploadAttemptId 唯一且不含用户内容', () => {
  const ids = new Set(Array.from({ length: 500 }, () => newUploadAttemptId()));
  assert.equal(ids.size, 500);
  for (const id of ids) {
    assert.match(id, /^ua_[0-9a-z]+_[0-9a-f]{12}$/);
  }
});

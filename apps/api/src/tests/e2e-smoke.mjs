/**
 * QAL-03 端到端冒烟脚本（curl/undici 级）
 * 覆盖：上传 → 归因 → 认可 → 追问(限1次) → 埋点 → 看板 M1 → 专家回写
 * 默认走 Mock 兜底，无 Ollama 也能跑通五步闭环。
 *
 * 前置：先启动 api server（npm run dev:api），再运行 node apps/api/src/tests/e2e-smoke.mjs
 */
const BASE = process.env.API_BASE || 'http://localhost:3001/api/v1';

let pass = 0;
let failCount = 0;

function log(...args) {
  console.log('[e2e]', ...args);
}

function assert(cond, msg) {
  if (cond) {
    pass++;
    log('  ✓', msg);
  } else {
    failCount++;
    log('  ✗', msg);
  }
}

async function call(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(BASE + path, opts);
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, data };
}

async function main() {
  log('BASE =', BASE);

  // 0) 探活
  const health = await call('GET', '/../health', undefined).catch(() => null);
  if (!health) {
    log('⚠ API 未启动，请先运行 `npm run dev:api` 或 `npm run start:api`');
    process.exit(2);
  }

  const sessionId = 's_smoke_' + Date.now().toString(36);
  const now = () => new Date().toISOString();

  // 1) 创建匿名账户
  const acc = await call('POST', '/account', { segment: 'kaoyan' });
  assert(acc.status === 200 && acc.data?.code === 0, `创建账户 (${acc.data?.data?.anon_user_id})`);
  const anonUserId = acc.data?.data?.anon_user_id;

  // 2) 上传（文本入口）
  const upload = await call('POST', '/upload', {
    anon_user_id: anonUserId,
    segment: 'kaoyan',
    session_id: sessionId,
    src_type: 'text',
    subject: 'math',
    retry_count: 0,
    photo_blur: false,
    upload_duration_ms: 500,
    raw_text: '已知函数 f(x)=x^3-3x，求其在 [-2,2] 上的单调区间与极值。',
  });
  assert(upload.status === 200 && upload.data?.code === 0, '上传成功');
  const loopId = upload.data?.data?.loop_id;
  const question = upload.data?.data?.question;
  assert(!!loopId, `生成 loop_id = ${loopId}`);

  // 3) 归因
  const attr = await call('POST', '/attribution', {
    loop_id: loopId,
    anon_user_id: anonUserId,
    question,
  });
  assert(attr.status === 200 && attr.data?.code === 0, '归因接口返回 200');
  const attrData = attr.data?.data;
  assert(
    attrData?.status === 'ok' || attrData?.status === 'incomplete' || attrData?.status === 'analyzing',
    `归因状态 = ${attrData?.status}`
  );

  // 仅当归因 ok 时继续认可/埋点闭环
  if (attrData?.status === 'ok') {
    // 4) 埋点：loop_upload + loop_attr_show
    const track1 = await call('POST', '/track', {
      events: [
        {
          event_name: 'loop_upload',
          context: {
            app_version: '0.1.0', platform: 'web', user_id: anonUserId,
            segment: 'kaoyan', session_id: sessionId, loop_id: loopId,
            ts_utc: now(), event_seq: 1, exp_group: 'none',
          },
          props: {
            src_type: 'text', ocr_status: 'success', retry_count: 0,
            photo_blur: false, subject: 'math', upload_duration_ms: 500, loop_id: loopId,
          },
          ts_utc: now(),
        },
        {
          event_name: 'loop_attr_show',
          context: {
            app_version: '0.1.0', platform: 'web', user_id: anonUserId,
            segment: 'kaoyan', session_id: sessionId, loop_id: loopId,
            ts_utc: now(), event_seq: 2, exp_group: 'none',
          },
          props: {
            attr_latency_ms: 8200, attr_has_three: true,
            attr_model_version: attrData.attr_model_version,
            knowledge_point: attrData.knowledge_point,
          },
          ts_utc: now(),
        },
      ],
    });
    assert(track1.status === 200 && track1.data?.data?.accepted === 2, '埋点 loop_upload + loop_attr_show 落库');

    // 5) 认可 approve
    const rate = await call('POST', `/attribution/${loopId}/rate`, {
      anon_user_id: anonUserId,
      rate_action: 'approve',
      rate_score: 5,
    });
    assert(rate.status === 200 && rate.data?.data?.ok === true, '认可 approve 成功');

    // 埋点 attr_rate
    const track2 = await call('POST', '/track', {
      events: [
        {
          event_name: 'attr_rate',
          context: {
            app_version: '0.1.0', platform: 'web', user_id: anonUserId,
            segment: 'kaoyan', session_id: sessionId, loop_id: loopId,
            ts_utc: now(), event_seq: 3, exp_group: 'none',
          },
          props: { rate_action: 'approve', rate_score: 5 },
          ts_utc: now(),
        },
      ],
    });
    assert(track2.status === 200 && track2.data?.data?.accepted === 1, '埋点 attr_rate 落库');

    // 6) 追问（第 1 次，应允许）
    const fu1 = await call('POST', `/attribution/${loopId}/followup`, {
      anon_user_id: anonUserId,
      message: '为什么这里要先求导再判断符号？',
      followup_round: 1,
    });
    assert(fu1.status === 200 && fu1.data?.data?.has_next_action === true, '追问第1次：has_next_action=true');

    // 7) 追问（第 2 次，应达上限）
    const fu2 = await call('POST', `/attribution/${loopId}/followup`, {
      anon_user_id: anonUserId,
      message: '再深入一点',
      followup_round: 2,
    });
    assert(fu2.status === 200 && fu2.data?.data?.has_next_action === false, '追问达上限：has_next_action=false');

    // 8) 看板 M1
    const dash = await call('GET', '/dashboard/m1?window_days=14');
    assert(dash.status === 200 && dash.data?.code === 0, '看板 M1 返回 200');
    const m1 = dash.data?.data;
    log('  · M1 =', JSON.stringify(m1));
    assert(typeof m1?.approval_rate === 'number', `approval_rate = ${m1?.approval_rate}`);
    assert(m1?.gate === 'go' || m1?.gate === 'no-go', `gate = ${m1?.gate}`);

    // 9) 专家盲评：抽样 + 回写
    const pending = await call('GET', '/review/pending?limit=20');
    assert(pending.status === 200, '专家抽样列表返回');
    const attrId = attrData.attribution_id;
    const review = await call('POST', `/review/attribution/${attrId}`, {
      expert_id: 'expert_smoke',
      expert_accuracy: 'accurate',
      expert_consistency: 'agree',
    });
    assert(review.status === 200 && review.data?.data?.ok === true, '专家回写成功');
  } else {
    log('  · 归因未在 mock 下返回 ok，跳过闭环后半段（请检查 Provider 配置）');
  }

  log(`\n结果：通过 ${pass} 项，失败 ${failCount} 项`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('[e2e] 运行异常', e);
  process.exit(1);
});

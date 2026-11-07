/**
 * 单题闭环状态机 hook：上传 → 归因 → 认可 → 追问，并同步埋点 SDK + store。
 */
import { useCallback } from 'react';
import { useLoopStore } from '../store/loopStore';
import { api, describeError, getUploadErrorMeta } from '../api/client';
import { tracker } from '../tracking/sdk';
import { classifyUploadError, newUploadAttemptId } from '@aicorrection/shared';
import type {
  Segment,
  OcrStatus,
  UploadResponse,
  AttributionData,
  RateResponse,
  FollowupResponse,
  RateAction,
  InaccurateReason,
  UploadFailureStage,
  UploadFailureReason,
  UploadRequestPhase,
} from '@aicorrection/shared';

export interface DraftPayload {
  segment: Segment;
  src_type: 'photo' | 'text' | 'paste';
  subject?: string;
  raw_text?: string;
  retry_count?: number;
  photo_blur?: boolean;
  upload_duration_ms?: number;
  imageFile?: File;
}

export function useLoop() {
  const anonUserId = useLoopStore((s) => s.anonUserId);
  const segment = useLoopStore((s) => s.segment);
  const sessionId = useLoopStore((s) => s.sessionId);
  const loop = useLoopStore((s) => s.loop);
  const attribution = useLoopStore((s) => s.attribution);
  const setAnonUser = useLoopStore((s) => s.setAnonUser);
  const setLoop = useLoopStore((s) => s.setLoop);
  const setAttribution = useLoopStore((s) => s.setAttribution);
  const setLoading = useLoopStore((s) => s.setLoading);
  const setError = useLoopStore((s) => s.setError);
  const resetLoop = useLoopStore((s) => s.resetLoop);
  const error = useLoopStore((s) => s.error);

  const ensureAccount = useCallback(
    async (seg: Segment): Promise<string> => {
      let uid = useLoopStore.getState().anonUserId;
      if (!uid) {
        const acc = await api.createAccount({ segment: seg });
        setAnonUser(acc.anon_user_id, seg);
        uid = acc.anon_user_id;
      }
      // K1.4 放量就绪：trackingContext 是模块级内存态，刷新页面后会重置为 user_id=''，
      // 而 anonUserId 从 localStorage 恢复 → 若只在新建账户时 setUser，后续所有埋点都会带
      // 空 user_id，服务端 assignCohort('') 会把同一 loop 拆到不同 rollout_group。
      // 因此无论 uid 来自新建账户还是本地恢复，每次都重新注入 tracker。
      tracker.setUser(uid, seg);
      return uid as string;
    },
    [setAnonUser]
  );

  /**
   * 上传尝试（v0.1.x：失败细分埋点）。
   *
   * 口径纪律：一次尝试有且仅有一个终态事件——
   *   - 拿到 200 + loop → `loop_upload`（含 ocr_status='fail'，仍是 G1/M5 唯一正式信号）
   *   - 未拿到 200 + loop → `upload_fail`（client_validation / account_create /
   *     transport / server_reject / business_error，受控枚举）
   * 两者互斥，故「尝试总数 = loop_upload 数 + upload_fail 数」，不会重复计数。
   */
  const upload = useCallback(
    async (payload: DraftPayload): Promise<UploadResponse> => {
      setLoading(true);
      setError(null);
      const attemptId = newUploadAttemptId();
      const t0 = Date.now();
      // K1.4 同源修复：trackingContext 是模块级内存态，刷新后 user_id 为空。
      // 客户端校验 / 建账户失败发生在 ensureAccount() 之前，若不先注入已恢复的 uid，
      // 这几条 upload_fail 会带空 user_id（anon_user_id=NULL、cohort 漂移）。
      const cachedUid = useLoopStore.getState().anonUserId;
      if (cachedUid) tracker.setUser(cachedUid, payload.segment);
      const base = {
        upload_attempt_id: attemptId,
        src_type: payload.src_type,
        subject: payload.subject,
        retry_count: payload.retry_count ?? 0,
        photo_blur: payload.photo_blur ?? false,
      };
      let failureEmitted = false;
      const emitFailure = (extra: {
        failure_stage: UploadFailureStage;
        failure_reason: UploadFailureReason;
        http_status?: number;
        backend_code?: number;
        loop_id?: string;
      }): void => {
        failureEmitted = true;
        tracker.uploadFail({
          ...base,
          upload_duration_ms: Date.now() - t0,
          ...extra,
        });
      };
      let phase: UploadRequestPhase = 'account_create';

      try {
        // 客户端校验（防御性兜底；UploadPage 也会先拦一次，此处保证事件不漏）
        if (payload.src_type === 'photo' && !payload.imageFile) {
          emitFailure({
            failure_stage: 'client_validation',
            failure_reason: 'missing_image',
          });
          throw new Error('请先选择或拍摄一张题目照片');
        }
        if (payload.src_type !== 'photo' && !(payload.raw_text ?? '').trim()) {
          emitFailure({
            failure_stage: 'client_validation',
            failure_reason: 'missing_text',
          });
          throw new Error('请先输入或粘贴题目内容');
        }

        const uid = await ensureAccount(payload.segment);
        phase = 'upload';
        let result: UploadResponse;
        const common = {
          anon_user_id: uid,
          segment: payload.segment,
          session_id: sessionId,
          src_type: payload.src_type,
          subject: payload.subject,
          retry_count: payload.retry_count ?? 0,
          photo_blur: payload.photo_blur ?? false,
          upload_duration_ms: payload.upload_duration_ms ?? 0,
        };
        if (payload.src_type === 'photo' && payload.imageFile) {
          const form = new FormData();
          Object.entries(common).forEach(([k, v]) => {
            if (v !== undefined) form.append(k, String(v));
          });
          form.append('image', payload.imageFile);
          result = await api.uploadImage(form);
        } else {
          result = await api.uploadText({
            ...common,
            raw_text: payload.raw_text ?? '',
          });
        }
        setLoop(result);
        tracker.loopUpload({
          src_type: payload.src_type,
          ocr_status: result.ocr_status as OcrStatus,
          retry_count: common.retry_count,
          photo_blur: common.photo_blur,
          subject: payload.subject,
          upload_duration_ms: common.upload_duration_ms,
          loop_id: result.loop_id,
          upload_attempt_id: attemptId,
        });
        // ocr_status='fail' 仍只由 loop_upload 承载：不发 upload_fail，避免 M5 双重计数。
        return result;
      } catch (e) {
        if (!failureEmitted) {
          const meta = getUploadErrorMeta(e);
          emitFailure(
            meta
              ? classifyUploadError({ ...meta, phase })
              : classifyUploadError({
                  phase,
                  hasResponse: false,
                  message: describeError(e),
                })
          );
        }
        const msg = describeError(e);
        const hint = /Network|ECONN|ERR_|无法连接|timeout/i.test(msg)
          ? '无法连接后端服务（:3001），请确认已运行 npm run dev 且后端已启动'
          : msg;
        setError(hint);
        throw e;
      } finally {
        setLoading(false);
      }
    },
    [ensureAccount, sessionId, setLoop, setLoading, setError]
  );

  const runAttribution = useCallback(async (): Promise<AttributionData> => {
    const l = useLoopStore.getState().loop;
    const uid = useLoopStore.getState().anonUserId;
    if (!l || !uid) throw new Error('no loop');
    setLoading(true);
    setError(null);
    try {
      const data = await api.getAttribution({
        loop_id: l.loop_id,
        anon_user_id: uid,
        question: l.question,
      });
      if (data.status === 'ok') {
        setAttribution(data);
        tracker.loopAttrShow(
          {
            attr_latency_ms: data.attr_latency_ms,
            attr_has_three: true,
            attr_model_version: data.attr_model_version,
            knowledge_point: data.knowledge_point,
          },
          l.loop_id
        );
      }
      return data;
    } catch (e) {
      setError(describeError(e));
      throw e;
    } finally {
      setLoading(false);
    }
  }, [setAttribution, setLoading, setError]);

  const rate = useCallback(
    async (
      rate_action: RateAction,
      inaccurate_reason?: InaccurateReason
    ): Promise<RateResponse> => {
      const l = useLoopStore.getState().loop;
      const uid = useLoopStore.getState().anonUserId;
      if (!l || !uid) throw new Error('no loop');
      const data = await api.rate(l.loop_id, {
        anon_user_id: uid,
        rate_action,
        inaccurate_reason,
      });
      tracker.attrRate({ rate_action, inaccurate_reason }, l.loop_id);
      return data;
    },
    []
  );

  const followup = useCallback(
    async (message: string, eventSeq: number): Promise<FollowupResponse> => {
      const l = useLoopStore.getState().loop;
      const uid = useLoopStore.getState().anonUserId;
      if (!l || !uid) throw new Error('no loop');
      const data = await api.followup(l.loop_id, {
        anon_user_id: uid,
        message,
        followup_round: eventSeq,
      });
      tracker.followup(
        {
          followup_round: data.followup_round,
          followup_role: 'ai_ask',
          has_next_action: data.has_next_action,
        },
        l.loop_id,
        eventSeq
      );
      return data;
    },
    []
  );

  const completeLoop = useCallback(
    async (): Promise<void> => {
      const l = useLoopStore.getState().loop;
      const uid = useLoopStore.getState().anonUserId;
      if (!l || !uid) throw new Error('no loop');
      await api.completeLoop({ loop_id: l.loop_id, anon_user_id: uid });
    },
    []
  );

  return {
    anonUserId,
    segment,
    sessionId,
    loop,
    attribution,
    ensureAccount,
    upload,
    runAttribution,
    rate,
    followup,
    completeLoop,
    resetLoop,
    error,
  };
}

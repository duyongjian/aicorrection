/**
 * 单题闭环状态机 hook：上传 → 归因 → 认可 → 追问，并同步埋点 SDK + store。
 */
import { useCallback } from 'react';
import { useLoopStore } from '../store/loopStore';
import { api, describeError } from '../api/client';
import { tracker } from '../tracking/sdk';
import type {
  Segment,
  OcrStatus,
  UploadResponse,
  AttributionData,
  RateResponse,
  FollowupResponse,
  RateAction,
  InaccurateReason,
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

  const upload = useCallback(
    async (payload: DraftPayload): Promise<UploadResponse> => {
      setLoading(true);
      setError(null);
      try {
        const uid = await ensureAccount(payload.segment);
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
        });
        return result;
      } catch (e) {
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
    resetLoop,
    error,
  };
}

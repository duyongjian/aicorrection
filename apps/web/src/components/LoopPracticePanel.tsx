/**
 * v0.2 闭环收尾面板：R04 同类题 → R05 复述本质 → R06 追问验证。
 * 在归因认可 + 追问之后展示，引导用户完成「练 → 讲 → 验」三步，闭合学习环。
 * 自包含：直接调用 api，不依赖 useLoop 内部状态，便于在 AttributionPage 挂载。
 */
import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { api } from '../api/client';

interface Props {
  loopId: string;
  anonUserId: string;
}

type Phase = 'idle' | 'practicing' | 'restating' | 'verifying' | 'done';

export default function LoopPracticePanel({ loopId, anonUserId }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [question, setQuestion] = useState('');
  const [practiceId, setPracticeId] = useState('');
  const [answer, setAnswer] = useState('');
  const [grade, setGrade] = useState<{ is_correct: 0 | 1; feedback: string } | null>(null);
  const [restate, setRestate] = useState('');
  const [restateMsg, setRestateMsg] = useState('');
  const [verifyQ, setVerifyQ] = useState('');
  const [verifyResp, setVerifyResp] = useState('');
  const [verifyResult, setVerifyResult] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const reset = () => {
    setPhase('idle');
    setQuestion('');
    setPracticeId('');
    setAnswer('');
    setGrade(null);
    setRestate('');
    setRestateMsg('');
    setVerifyQ('');
    setVerifyResp('');
    setVerifyResult('');
    setErr('');
  };

  const startPractice = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api.generatePractice({ loop_id: loopId, anon_user_id: anonUserId });
      setPracticeId(r.practice_id);
      setQuestion(r.question_text);
      setPhase('practicing');
    } catch (e) {
      setErr((e as Error).message || '生成练习失败');
    } finally {
      setBusy(false);
    }
  };

  const submitGrade = async () => {
    if (!answer.trim()) {
      setErr('请先作答');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const r = await api.gradePractice({
        practice_id: practiceId,
        user_answer: answer,
        anon_user_id: anonUserId,
      });
      setGrade({ is_correct: r.is_correct, feedback: r.feedback });
    } catch (e) {
      setErr((e as Error).message || '判分失败');
    } finally {
      setBusy(false);
    }
  };

  const submitRestate = async () => {
    if (restate.trim().length < 5) {
      setErr('复述内容过短');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const r = await api.submitRestate({
        loop_id: loopId,
        text: restate,
        anon_user_id: anonUserId,
      });
      setRestateMsg(
        r.restate_is_copy === 1
          ? '检测到与解析高度相似，请用你自己的话重述～'
          : `已记录（${r.restate_len} 字）`
      );
      setPhase('verifying');
    } catch (e) {
      setErr((e as Error).message || '复述提交失败');
    } finally {
      setBusy(false);
    }
  };

  const startVerify = async () => {
    setBusy(true);
    setErr('');
    try {
      const r = await api.verifyProbe({ loop_id: loopId, anon_user_id: anonUserId });
      setVerifyQ(r.question);
    } catch (e) {
      setErr((e as Error).message || '生成验证问题失败');
    } finally {
      setBusy(false);
    }
  };

  const submitVerify = async () => {
    if (verifyResp.trim().length < 4) {
      setErr('验证回答过短');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const r = await api.verify({
        loop_id: loopId,
        response: verifyResp,
        anon_user_id: anonUserId,
      });
      setVerifyResult(r.result === 'pass' ? '通过 ✅' : r.result === 'give_up' ? '已跳过' : '待加强');
      setPhase('done');
    } catch (e) {
      setErr((e as Error).message || '验证失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2, mt: 2 }}>
      <Typography variant="subtitle1" sx={{ mb: 1 }}>
        巩固练习（同类题 → 复述 → 验证）
      </Typography>

      {phase === 'idle' && (
        <Button variant="contained" onClick={startPractice} disabled={busy}>
          做一道同类题
        </Button>
      )}

      {phase === 'practicing' && (
        <Stack spacing={2}>
          <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap' }}>
            {question}
          </Typography>
          <TextField
            label="你的作答"
            multiline
            minRows={3}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
          {grade && (
            <Alert severity={grade.is_correct ? 'success' : 'info'}>{grade.feedback}</Alert>
          )}
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button variant="contained" onClick={submitGrade} disabled={busy}>
              交卷判分
            </Button>
            {grade && (
              <Button
                variant="outlined"
                onClick={() => {
                  setPhase('restating');
                  setErr('');
                }}
              >
                下一步：复述本质
              </Button>
            )}
          </Box>
        </Stack>
      )}

      {phase === 'restating' && (
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            用自己的话讲清楚「错在哪、正确思路是什么」（别照抄解析）。
          </Typography>
          <TextField
            label="我的复述"
            multiline
            minRows={3}
            value={restate}
            onChange={(e) => setRestate(e.target.value)}
          />
          {restateMsg && <Alert severity="info">{restateMsg}</Alert>}
          <Button variant="contained" onClick={submitRestate} disabled={busy}>
            提交复述
          </Button>
        </Stack>
      )}

      {phase === 'verifying' && (
        <Stack spacing={2}>
          {!verifyQ ? (
            <Button variant="contained" onClick={startVerify} disabled={busy}>
              生成验证问题
            </Button>
          ) : (
            <>
              <Typography variant="body1">{verifyQ}</Typography>
              <TextField
                label="你的回答"
                multiline
                minRows={3}
                value={verifyResp}
                onChange={(e) => setVerifyResp(e.target.value)}
              />
              <Button variant="contained" onClick={submitVerify} disabled={busy}>
                提交验证
              </Button>
            </>
          )}
        </Stack>
      )}

      {phase === 'done' && (
        <Alert severity={verifyResult.includes('通过') ? 'success' : 'warning'}>
          闭环完成：{verifyResult}。可返回上传下一道题。
          <Box sx={{ mt: 1 }}>
            <Button size="small" variant="text" onClick={reset}>
              再做一次
            </Button>
          </Box>
        </Alert>
      )}

      {err && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {err}
        </Alert>
      )}
    </Paper>
  );
}

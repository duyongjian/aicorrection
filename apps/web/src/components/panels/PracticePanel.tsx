/**
 * 强化练习面板：R13 自由刷同类题 / R11 答案沉淀（UGC）/ R20 手动标错因。
 * 自包含：直接调用 api。
 */
import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Divider,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { api } from '../../api/client';
import { CAUSE_TAXONOMY, type GenerateGroupResponse } from '@aicorrection/shared';

interface Props {
  anonUserId: string;
}

export default function PracticePanel({ anonUserId }: Props) {
  const [err, setErr] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  // R13 自由刷同类题
  const [kpInput, setKpInput] = useState('');
  const [group, setGroup] = useState<GenerateGroupResponse | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [grades, setGrades] = useState<Record<string, { is_correct: 0 | 1; feedback: string }>>({});
  const [groupBusy, setGroupBusy] = useState(false);

  // R11 答案沉淀
  const [sedQ, setSedQ] = useState('');
  const [sedA, setSedA] = useState('');
  const [sedKp, setSedKp] = useState('');
  const [sedMsg, setSedMsg] = useState('');

  // R20 手动错因
  const [manualLoop, setManualLoop] = useState('');
  const [manualCause, setManualCauseSel] = useState('');
  const [manualMsg, setManualMsg] = useState('');

  const startGroup = async () => {
    const kp = kpInput.trim();
    if (!kp) {
      setErr('请先输入要练习的知识点');
      return;
    }
    setGroupBusy(true);
    setErr('');
    setGroup(null);
    setAnswers({});
    setGrades({});
    try {
      const g = await api.generateTargetedGroup({
        anon_user_id: anonUserId,
        target_kp: kp,
        count: 3,
        kp_key: null,
      });
      setGroup(g);
    } catch (e) {
      setErr((e as Error).message || '生成针对性题组失败');
    } finally {
      setGroupBusy(false);
    }
  };

  const gradeOne = async (practiceId: string) => {
    const ans = answers[practiceId];
    if (!ans || !ans.trim()) {
      setErr('请先作答');
      return;
    }
    try {
      const r = await api.gradePractice({
        practice_id: practiceId,
        user_answer: ans,
        anon_user_id: anonUserId,
      });
      setGrades((prev) => ({ ...prev, [practiceId]: { is_correct: r.is_correct, feedback: r.feedback } }));
    } catch (e) {
      setErr((e as Error).message || '判分失败');
    }
  };

  const submitSediment = async () => {
    if (sedQ.trim().length < 2 || !sedA.trim()) {
      setErr('题干与解析均不能为空');
      return;
    }
    try {
      const r = await api.sedimentAnswer({
        anon_user_id: anonUserId,
        question: sedQ.trim(),
        answer: sedA.trim(),
        knowledge_point: sedKp.trim() || null,
      });
      setSedMsg(r.message);
      setSedQ('');
      setSedA('');
      setSedKp('');
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setErr((e as Error).message || '沉淀失败');
    }
  };

  const submitManualCause = async () => {
    if (!manualLoop.trim()) {
      setErr('请填写 loop_id');
      return;
    }
    try {
      const r = await api.setManualCause({
        loop_id: manualLoop.trim(),
        anon_user_id: anonUserId,
        cause_id: manualCause || null,
      });
      setManualMsg(`已更新：${r.cause_id ?? '（未标记）'}`);
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setErr((e as Error).message || '手动标错因失败');
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="h6" sx={{ mb: 1 }}>
        强化练习
      </Typography>

      {/* R13 自由刷同类题 */}
      <Typography variant="subtitle2" color="text.secondary">
        刷一组同类题（输入知识点）
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap' }}>
        <TextField
          size="small"
          label="知识点"
          value={kpInput}
          onChange={(e) => setKpInput(e.target.value)}
          sx={{ minWidth: 200 }}
        />
        <Button size="small" variant="contained" onClick={startGroup} disabled={groupBusy || !kpInput.trim()}>
          生成
        </Button>
      </Box>
      {group && (
        <Paper variant="outlined" sx={{ p: 2, mt: 2, bgcolor: 'action.hover' }}>
          <Typography variant="subtitle2">
            针对性练习：{group.target_kp}（共 {group.items.length} 题）
          </Typography>
          <Stack spacing={2} sx={{ mt: 1 }}>
            {group.items.map((it) => (
              <Box key={it.practice_id}>
                <Typography variant="body1" sx={{ whiteSpace: 'pre-wrap' }}>
                  {it.group_seq}. {it.question_text}
                </Typography>
                <TextField
                  size="small"
                  fullWidth
                  multiline
                  minRows={2}
                  placeholder="你的作答"
                  value={answers[it.practice_id] ?? ''}
                  onChange={(e) => setAnswers((p) => ({ ...p, [it.practice_id]: e.target.value }))}
                  sx={{ mt: 1 }}
                />
                {grades[it.practice_id] ? (
                  <Alert severity={grades[it.practice_id].is_correct ? 'success' : 'info'} sx={{ mt: 1 }}>
                    {grades[it.practice_id].feedback}
                  </Alert>
                ) : (
                  <Button size="small" variant="outlined" sx={{ mt: 1 }} onClick={() => gradeOne(it.practice_id)}>
                    判分
                  </Button>
                )}
              </Box>
            ))}
            <Button size="small" variant="text" onClick={() => setGroup(null)}>
              收起
            </Button>
          </Stack>
        </Paper>
      )}

      <Divider sx={{ my: 2 }} />

      {/* R11 答案沉淀 */}
      <Typography variant="subtitle2" color="text.secondary">
        答案沉淀（UGC，待审）
      </Typography>
      <Stack spacing={1} sx={{ mt: 1 }}>
        <TextField size="small" label="题干" multiline minRows={2} value={sedQ} onChange={(e) => setSedQ(e.target.value)} />
        <TextField size="small" label="解析/答案" multiline minRows={2} value={sedA} onChange={(e) => setSedA(e.target.value)} />
        <TextField size="small" label="知识点（可选）" value={sedKp} onChange={(e) => setSedKp(e.target.value)} />
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button size="small" variant="contained" onClick={submitSediment}>
            沉淀
          </Button>
        </Box>
      </Stack>
      {sedMsg && <Alert severity="success" sx={{ mt: 1 }}>{sedMsg}</Alert>}

      <Divider sx={{ my: 2 }} />

      {/* R20 手动标错因 */}
      <Typography variant="subtitle2" color="text.secondary">
        手动标错因（R20 · 覆盖 AI 判定）
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap' }}>
        <TextField size="small" label="loop_id" value={manualLoop} onChange={(e) => setManualLoop(e.target.value)} />
        <TextField
          size="small"
          select
          SelectProps={{ native: true }}
          label="错因"
          value={manualCause}
          onChange={(e) => setManualCauseSel(e.target.value)}
          sx={{ minWidth: 140 }}
        >
          <option value="">（清除）</option>
          {Object.entries(CAUSE_TAXONOMY).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </TextField>
        <Button size="small" variant="contained" onClick={submitManualCause} disabled={!manualLoop.trim()}>
          更新
        </Button>
      </Box>
      {manualMsg && <Alert severity="success" sx={{ mt: 1 }}>{manualMsg}</Alert>}

      {err && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {err}
        </Alert>
      )}
      <Box sx={{ display: 'none' }}>{refreshKey}</Box>
    </Paper>
  );
}

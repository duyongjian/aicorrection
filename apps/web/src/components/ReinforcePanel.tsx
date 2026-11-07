/**
 * P1 强化中心面板（R09 错因聚合 / R10 薄弱点可视化 / R13 针对性多题 / R14 掌握判定 / R11 答案沉淀）。
 * 自包含：直接调用 api，不依赖 useLoop 内部状态，便于在归因页或独立页挂载。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  LinearProgress,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { api } from '../api/client';
import {
  CAUSE_TAXONOMY,
  MASTERY_LABELS,
  type MasteryLevel,
  type WeakPointItem,
  type CauseAggregationItem,
  type GenerateGroupResponse,
  type MasteryState,
} from '@aicorrection/shared';

interface Props {
  anonUserId: string;
}

const MASTERY_COLOR: Record<MasteryLevel, 'default' | 'warning' | 'info' | 'success'> = {
  not_started: 'default',
  learning: 'warning',
  familiar: 'info',
  mastered: 'success',
};

export default function ReinforcePanel({ anonUserId }: Props) {
  const [causes, setCauses] = useState<CauseAggregationItem[]>([]);
  const [weak, setWeak] = useState<WeakPointItem[]>([]);
  const [mastery, setMastery] = useState<MasteryState[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  // R13 针对性练习
  const [group, setGroup] = useState<GenerateGroupResponse | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [grades, setGrades] = useState<Record<string, { is_correct: 0 | 1; feedback: string }>>({});
  const [groupBusy, setGroupBusy] = useState(false);

  // R11 答案沉淀
  const [showSediment, setShowSediment] = useState(false);
  const [sedQ, setSedQ] = useState('');
  const [sedA, setSedA] = useState('');
  const [sedKp, setSedKp] = useState('');
  const [sedMsg, setSedMsg] = useState('');

  const refresh = useCallback(async () => {
    if (!anonUserId) return;
    setLoading(true);
    setErr('');
    try {
      const [c, w, m] = await Promise.all([
        api.getCauseAggregation(anonUserId),
        api.getWeakPoints(anonUserId),
        api.getMastery(anonUserId),
      ]);
      setCauses(c.items);
      setWeak(w.items);
      setMastery(m.items);
    } catch (e) {
      setErr((e as Error).message || '加载强化数据失败');
    } finally {
      setLoading(false);
    }
  }, [anonUserId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const startGroup = async (kpText: string, kpKey?: string) => {
    setGroupBusy(true);
    setErr('');
    setGroup(null);
    setAnswers({});
    setGrades({});
    try {
      const g = await api.generateTargetedGroup({
        anon_user_id: anonUserId,
        target_kp: kpText,
        count: 3,
        kp_key: kpKey ?? null,
      });
      setGroup(g);
    } catch (e) {
      setErr((e as Error).message || '生成针对性题组失败');
    } finally {
      setGroupBusy(false);
    }
  };

  const gradeOne = async (practiceId: string, questionText: string) => {
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
      // 刷新掌握度（R14 应随判分更新）
      const m = await api.getMastery(anonUserId);
      setMastery(m.items);
      void questionText;
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
      setShowSediment(false);
    } catch (e) {
      setErr((e as Error).message || '沉淀失败');
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2, mt: 3 }}>
      <Typography variant="h6" sx={{ mb: 1 }}>
        强化中心
      </Typography>
      {loading && <LinearProgress sx={{ mb: 1 }} />}

      {/* R09 错因聚合 */}
      <Typography variant="subtitle2" color="text.secondary" sx={{ mt: 1 }}>
        错因分布（共 {causes.reduce((s, c) => s + c.count, 0)} 次）
      </Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1 }}>
        {causes.length === 0 && <Typography variant="body2" color="text.secondary">暂无归因数据</Typography>}
        {causes.map((c) => (
          <Chip
            key={c.cause_id}
            label={`${CAUSE_TAXONOMY[c.cause_id] ?? c.cause_id} · ${c.count}（${Math.round(c.pct * 100)}%）`}
            color="primary"
            variant="outlined"
          />
        ))}
      </Box>

      {/* R10 薄弱点 + R14 掌握度 */}
      <Typography variant="subtitle2" color="text.secondary" sx={{ mt: 2 }}>
        薄弱知识点（按错误数排序）
      </Typography>
      <Stack spacing={1} sx={{ mt: 1 }}>
        {weak.length === 0 && <Typography variant="body2" color="text.secondary">暂无薄弱点数据</Typography>}
        {weak.map((w) => {
          const m = mastery.find((x) => x.kp_key === w.kp_key);
          return (
            <Paper key={w.kp_key} variant="outlined" sx={{ p: 1.5 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
                <Box>
                  <Typography variant="body1">{w.kp_text}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    错误 {w.error_count} 次 · 练习 {w.practice_count} 次
                    {w.top_cause_label ? ` · 主要错因：${w.top_cause_label}` : ''}
                  </Typography>
                </Box>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                  <Chip
                    size="small"
                    label={`掌握：${MASTERY_LABELS[m?.level ?? w.mastery_level]}`}
                    color={MASTERY_COLOR[m?.level ?? w.mastery_level]}
                  />
                  <Button size="small" variant="contained" onClick={() => startGroup(w.kp_text, w.kp_key)} disabled={groupBusy}>
                    刷一组题
                  </Button>
                </Box>
              </Box>
            </Paper>
          );
        })}
      </Stack>

      {/* R13 针对性练习题组 */}
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
                  <Button
                    size="small"
                    variant="outlined"
                    sx={{ mt: 1 }}
                    onClick={() => gradeOne(it.practice_id, it.question_text)}
                  >
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

      {/* R11 答案沉淀 */}
      <Box sx={{ mt: 2 }}>
        {!showSediment ? (
          <Button size="small" variant="text" onClick={() => setShowSediment(true)}>
            沉淀一道好题到题库
          </Button>
        ) : (
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              答案沉淀（UGC，待审）
            </Typography>
            <Stack spacing={1}>
              <TextField size="small" label="题干" multiline minRows={2} value={sedQ} onChange={(e) => setSedQ(e.target.value)} />
              <TextField size="small" label="解析/答案" multiline minRows={2} value={sedA} onChange={(e) => setSedA(e.target.value)} />
              <TextField size="small" label="知识点（可选）" value={sedKp} onChange={(e) => setSedKp(e.target.value)} />
              <Box sx={{ display: 'flex', gap: 1 }}>
                <Button size="small" variant="contained" onClick={submitSediment}>
                  沉淀
                </Button>
                <Button size="small" variant="text" onClick={() => setShowSediment(false)}>
                  取消
                </Button>
              </Box>
            </Stack>
          </Paper>
        )}
        {sedMsg && <Alert severity="success" sx={{ mt: 1 }}>{sedMsg}</Alert>}
      </Box>

      <Box sx={{ mt: 2 }}>
        <Button size="small" variant="outlined" onClick={refresh} disabled={loading}>
          刷新强化数据
        </Button>
      </Box>

      {err && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {err}
        </Alert>
      )}
    </Paper>
  );
}

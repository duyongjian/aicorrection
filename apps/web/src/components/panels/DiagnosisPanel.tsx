/**
 * 诊断总览面板：R09 错因分布 / R10 薄弱知识点 / R14 掌握度 / R13 针对性练习（同类题）。
 * 自包含：直接调用 api，不依赖 useLoop 内部状态。
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
import { api } from '../../api/client';
import {
  CAUSE_TAXONOMY,
  MASTERY_LABELS,
  type MasteryLevel,
  type WeakPointItem,
  type CauseAggregationItem,
  type MasteryState,
  type GenerateGroupResponse,
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

export default function DiagnosisPanel({ anonUserId }: Props) {
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
      setErr((e as Error).message || '加载诊断数据失败');
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
      const m = await api.getMastery(anonUserId);
      setMastery(m.items);
    } catch (e) {
      setErr((e as Error).message || '判分失败');
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="h6" sx={{ mb: 1 }}>
        诊断总览
      </Typography>
      {loading && <LinearProgress sx={{ mb: 1 }} />}

      {/* R09 错因分布 */}
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

      {/* R13 针对性练习题组（同类题） */}
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

      <Box sx={{ mt: 2 }}>
        <Button size="small" variant="outlined" onClick={refresh} disabled={loading}>
          刷新
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

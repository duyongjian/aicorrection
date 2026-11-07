/**
 * P1+P2 强化中心面板：
 *  P1：R09 错因聚合 / R10 薄弱点 / R13 针对性多题 / R14 掌握判定 / R11 答案沉淀
 *  P2：R15 间隔复习 / R16 复习列表 / R12 变式题 / R17 自定义知识点 / R20 手动错因 / R18 知识图谱
 * 自包含：直接调用 api，不依赖 useLoop 内部状态，便于在归因页或独立页挂载。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
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
  type ReviewScheduleItem,
  type StartReviewResponse,
  type CompleteReviewResponse,
  type CustomKpItem,
  type KnowledgeGraphResponse,
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

  // P2：R16 复习列表 + R15/R12 复测
  const [reviews, setReviews] = useState<ReviewScheduleItem[]>([]);
  const [activeReview, setActiveReview] = useState<StartReviewResponse | null>(null);
  const [reviewAnswer, setReviewAnswer] = useState('');
  const [reviewResult, setReviewResult] = useState<CompleteReviewResponse | null>(null);

  // P2：R17 自定义知识点
  const [customKps, setCustomKps] = useState<CustomKpItem[]>([]);
  const [newKp, setNewKp] = useState('');

  // P2：R18 知识图谱
  const [graph, setGraph] = useState<KnowledgeGraphResponse | null>(null);

  // P2：R20 手动错因
  const [manualLoop, setManualLoop] = useState('');
  const [manualCause, setManualCauseSel] = useState('');
  const [manualMsg, setManualMsg] = useState('');

  const refresh = useCallback(async () => {
    if (!anonUserId) return;
    setLoading(true);
    setErr('');
    try {
      const [c, w, m, rev, kps, g] = await Promise.all([
        api.getCauseAggregation(anonUserId),
        api.getWeakPoints(anonUserId),
        api.getMastery(anonUserId),
        api.getReviewList(anonUserId),
        api.listCustomKps(anonUserId),
        api.getKnowledgeGraph(anonUserId),
      ]);
      setCauses(c.items);
      setWeak(w.items);
      setMastery(m.items);
      setReviews(rev.items);
      setCustomKps(kps.items);
      setGraph(g);
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

  // P2 R15/R12 复测
  const beginReview = async (kpKey: string, kpText: string | null) => {
    try {
      const r = await api.startReview({ anon_user_id: anonUserId, kp_key: kpKey, kp_text: kpText });
      setActiveReview(r);
      setReviewAnswer('');
      setReviewResult(null);
    } catch (e) {
      setErr((e as Error).message || '发起复测失败');
    }
  };

  const finishReview = async (retest_result: 'correct' | 'wrong' | 'skip') => {
    if (!activeReview) return;
    try {
      const r = await api.completeReview({ review_id: activeReview.review_id, retest_result });
      setReviewResult(r);
      const rev = await api.getReviewList(anonUserId);
      setReviews(rev.items);
    } catch (e) {
      setErr((e as Error).message || '完成复测失败');
    }
  };

  // P2 R17 自定义知识点
  const addCustomKp = async () => {
    if (!newKp.trim()) return;
    try {
      await api.createCustomKp({ anon_user_id: anonUserId, kp_text: newKp.trim() });
      setNewKp('');
      const kps = await api.listCustomKps(anonUserId);
      setCustomKps(kps.items);
    } catch (e) {
      setErr((e as Error).message || '新增自定义知识点失败');
    }
  };

  // P2 R20 手动错因
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
    } catch (e) {
      setErr((e as Error).message || '手动标错因失败');
    }
  };

  // P2 R18 知识图谱：节点环形布局 + 边连线（轻量 SVG，无第三方依赖）
  const graphLayout = useMemo(() => {
    if (!graph || graph.nodes.length === 0) return null;
    const R = 120;
    const cx = 150;
    const cy = 150;
    const pos = new Map<string, { x: number; y: number }>();
    graph.nodes.forEach((n, i) => {
      const ang = (2 * Math.PI * i) / graph.nodes.length - Math.PI / 2;
      pos.set(n.kp_key, { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) });
    });
    return { cx, cy, pos };
  }, [graph]);

  const dueCount = reviews.filter((r) => r.is_due).length;

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

      <Divider sx={{ my: 2 }} />

      {/* P2 R16 复习列表 */}
      <Typography variant="subtitle2" color="text.secondary">
        间隔复习计划（到期 {dueCount} / 共 {reviews.length}）
      </Typography>
      <Stack spacing={1} sx={{ mt: 1 }}>
        {reviews.length === 0 && <Typography variant="body2" color="text.secondary">暂无复习计划（掌握度达到熟悉后会自动排程）</Typography>}
        {reviews.map((r) => (
          <Paper key={r.kp_key} variant="outlined" sx={{ p: 1.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
              <Box>
                <Typography variant="body1">{r.kp_text ?? r.kp_key}</Typography>
                <Typography variant="caption" color="text.secondary">
                  间隔 {r.interval_days} 天 · 下次 {r.next_review_ts ? new Date(r.next_review_ts).toLocaleDateString() : '—'}
                  {r.last_result ? ` · 上次：${r.last_result}` : ''}
                </Typography>
              </Box>
              <Chip
                size="small"
                label={r.is_due ? '到期' : '未到期'}
                color={r.is_due ? 'error' : 'default'}
              />
              {r.is_due && (
                <Button size="small" variant="contained" onClick={() => beginReview(r.kp_key, r.kp_text)}>
                  去复测
                </Button>
              )}
            </Box>
          </Paper>
        ))}
      </Stack>

      {/* P2 R15/R12 复测进行中 */}
      {activeReview && (
        <Paper variant="outlined" sx={{ p: 2, mt: 2, bgcolor: 'action.hover' }}>
          <Typography variant="subtitle2">
            复测（变式题）：{activeReview.kp_text}
          </Typography>
          <Typography variant="body1" sx={{ mt: 1, whiteSpace: 'pre-wrap' }}>
            {activeReview.question_text}
          </Typography>
          <Alert severity="info" sx={{ mt: 1 }}>
            这是同一知识点的「不同题」，用于检测是否真掌握（而非背答案）。
          </Alert>
          {reviewResult ? (
            <Alert severity="success" sx={{ mt: 1 }}>
              已完成 · 下次复习间隔 {reviewResult.interval_days} 天
            </Alert>
          ) : (
            <>
              <TextField
                size="small"
                fullWidth
                multiline
                minRows={2}
                placeholder="你的作答"
                value={reviewAnswer}
                onChange={(e) => setReviewAnswer(e.target.value)}
                sx={{ mt: 1 }}
              />
              <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
                <Button size="small" variant="contained" color="success" onClick={() => finishReview('correct')}>
                  做对了
                </Button>
                <Button size="small" variant="contained" color="error" onClick={() => finishReview('wrong')}>
                  做错了
                </Button>
                <Button size="small" variant="text" onClick={() => finishReview('skip')}>
                  跳过
                </Button>
              </Box>
            </>
          )}
          <Button size="small" variant="text" sx={{ mt: 1 }} onClick={() => { setActiveReview(null); setReviewResult(null); }}>
            收起
          </Button>
        </Paper>
      )}

      <Divider sx={{ my: 2 }} />

      {/* P2 R17 自定义知识点 */}
      <Typography variant="subtitle2" color="text.secondary">
        自定义知识点（R17）
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap' }}>
        <TextField size="small" label="新增知识点" value={newKp} onChange={(e) => setNewKp(e.target.value)} />
        <Button size="small" variant="contained" onClick={addCustomKp} disabled={!newKp.trim()}>
          添加
        </Button>
      </Box>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1 }}>
        {customKps.length === 0 && <Typography variant="body2" color="text.secondary">暂无自定义知识点</Typography>}
        {customKps.map((k) => (
          <Chip key={k.kp_id} label={k.kp_text} color="secondary" variant="outlined" />
        ))}
      </Box>

      {/* P2 R18 知识图谱 */}
      <Typography variant="subtitle2" color="text.secondary" sx={{ mt: 2 }}>
        知识图谱（R18 · 共现边=同错因聚类）
      </Typography>
      {graph && graph.nodes.length === 0 && (
        <Typography variant="body2" color="text.secondary">暂无图谱数据</Typography>
      )}
      {graphLayout && (
        <Box sx={{ mt: 1, display: 'flex', justifyContent: 'center' }}>
          <svg width={300} height={300} viewBox="0 0 300 300">
            {graph!.edges.map((e, i) => {
              const a = graphLayout.pos.get(e.source);
              const b = graphLayout.pos.get(e.target);
              if (!a || !b) return null;
              return (
                <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#90caf9" strokeWidth={Math.min(4, e.weight)} />
              );
            })}
            {graph!.nodes.map((n) => {
              const p = graphLayout.pos.get(n.kp_key)!;
              return (
                <g key={n.kp_key}>
                  <circle cx={p.x} cy={p.y} r={6} fill="#1976d2" />
                  <text x={p.x} y={p.y - 10} fontSize={11} textAnchor="middle" fill="#333">
                    {n.kp_text.length > 6 ? n.kp_text.slice(0, 6) + '…' : n.kp_text}
                  </text>
                </g>
              );
            })}
          </svg>
        </Box>
      )}

      <Divider sx={{ my: 2 }} />

      {/* P2 R20 手动错因 */}
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

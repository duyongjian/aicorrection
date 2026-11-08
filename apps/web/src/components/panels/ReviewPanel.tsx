/**
 * 复习记忆面板：R16 间隔复习计划 + R15/R12 变式题复测。自包含。
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
import type {
  ReviewScheduleItem,
  StartReviewResponse,
  CompleteReviewResponse,
} from '@aicorrection/shared';

interface Props {
  anonUserId: string;
}

export default function ReviewPanel({ anonUserId }: Props) {
  const [reviews, setReviews] = useState<ReviewScheduleItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const [activeReview, setActiveReview] = useState<StartReviewResponse | null>(null);
  const [reviewAnswer, setReviewAnswer] = useState('');
  const [reviewResult, setReviewResult] = useState<CompleteReviewResponse | null>(null);

  const refresh = useCallback(async () => {
    if (!anonUserId) return;
    setLoading(true);
    setErr('');
    try {
      const rev = await api.getReviewList(anonUserId);
      setReviews(rev.items);
    } catch (e) {
      setErr((e as Error).message || '加载复习计划失败');
    } finally {
      setLoading(false);
    }
  }, [anonUserId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

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

  const dueCount = reviews.filter((r) => r.is_due).length;

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="h6" sx={{ mb: 1 }}>
        复习记忆
      </Typography>
      {loading && <LinearProgress sx={{ mb: 1 }} />}

      <Typography variant="subtitle2" color="text.secondary">
        间隔复习计划（到期 {dueCount} / 共 {reviews.length}）
      </Typography>
      <Stack spacing={1} sx={{ mt: 1 }}>
        {reviews.length === 0 && (
          <Typography variant="body2" color="text.secondary">
            暂无复习计划（掌握度达到熟悉后会自动排程）
          </Typography>
        )}
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

      {/* R15/R12 复测进行中 */}
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
          <Button
            size="small"
            variant="text"
            sx={{ mt: 1 }}
            onClick={() => { setActiveReview(null); setReviewResult(null); }}
          >
            收起
          </Button>
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

import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { api } from '../api/client';
import { useLoopStore } from '../store/loopStore';
import MathText from '../components/MathText';

interface LoopDetailData {
  loop_id: string;
  image_url: string | null;
  attribution: {
    attribution_id: string;
    cause: string | null;
    knowledge_point: string | null;
    essence: string | null;
    correct_answer: string | null;
    derivation: string | null;
    pitfalls: string | null;
    rate_action: string | null;
    created_at: string;
  } | null;
  followups: Array<{ role: 'user' | 'ai'; content: string; seq: number }>;
  practice: Array<{
    practice_id: string;
    question_text: string;
    answer_text: string | null;
    user_answer: string | null;
    is_correct: number | null;
    created_at: string;
  }>;
  closure: {
    followup_rounds: number;
    has_practice: number | null;
    restate_len: number | null;
    restate_is_copy: number | null;
    restate_text: string | null;
    verify_result: string | null;
    verify_prompt: string | null;
    verify_response: string | null;
    verify_feedback: string | null;
  };
}

/** 闭环回看页（FLW-02 增强）：进入历史后完整可回顾——归因 + 追问 + 练习 + 复盘。 */
export default function LoopDetailPage() {
  const { loopId = '' } = useParams();
  const navigate = useNavigate();
  const anonUserId = useLoopStore((s) => s.anonUserId);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<LoopDetailData | null>(null);

  useEffect(() => {
    if (!anonUserId || !loopId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    api
      .getLoopDetail(loopId, anonUserId)
      .then((d) => {
        setDetail(d);
        setLoading(false);
      })
      .catch((e) => {
        setError((e as Error).message || '加载失败');
        setLoading(false);
      });
  }, [anonUserId, loopId]);

  if (loading) {
    return (
      <Box sx={{ textAlign: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error || !detail) {
    return (
      <Box>
        <Button startIcon={<ArrowBackIcon />} onClick={() => navigate('/history')} sx={{ mb: 2 }}>
          返回历史
        </Button>
        <Alert severity="error">{error || '未找到该闭环记录'}</Alert>
      </Box>
    );
  }

  const a = detail.attribution;
  const c = detail.closure;

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
        <Button startIcon={<ArrowBackIcon />} onClick={() => navigate('/history')}>
          返回历史
        </Button>
        {a?.rate_action && (
          <Chip
            label={a.rate_action === 'approve' ? '已认可' : '不准确'}
            size="small"
            color={a.rate_action === 'approve' ? 'success' : 'warning'}
            variant="outlined"
          />
        )}
      </Stack>

      <Typography variant="h6" sx={{ mb: 2 }}>
        闭环回看
      </Typography>

      {/* 原图 */}
      {detail.image_url && (
        <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
          <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
            上传原图
          </Typography>
          <img
            src={detail.image_url}
            alt="上传原图"
            style={{
              maxWidth: '100%',
              maxHeight: 320,
              objectFit: 'contain',
              borderRadius: 4,
              border: '1px solid rgba(0,0,0,0.12)',
              display: 'block',
            }}
          />
        </Paper>
      )}

      {/* 归因三要素 */}
      {a && (
        <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
            归因结论
          </Typography>
          <Stack spacing={1}>
            <Field label="知识点" value={a.knowledge_point} />
            <Field label="错因" value={a.cause} />
            <Field label="本质" value={a.essence} />
            <Field label="正确答案" value={a.correct_answer} />
            <Field label="正确推导" value={a.derivation} />
            <Field label="常见陷阱" value={a.pitfalls} />
          </Stack>
        </Paper>
      )}

      {/* 追问对话 */}
      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
          追问补充（{detail.followups.length} 条）
        </Typography>
        {detail.followups.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            本次闭环未发生追问。
          </Typography>
        ) : (
          <Stack spacing={1}>
            {detail.followups.map((f, i) => (
              <Paper
                key={i}
                elevation={0}
                sx={{
                  p: 1.5,
                  bgcolor: f.role === 'user' ? 'primary.light' : 'grey.100',
                  color: f.role === 'user' ? 'primary.contrastText' : 'text.primary',
                }}
              >
                <Typography variant="body2">{f.content}</Typography>
              </Paper>
            ))}
          </Stack>
        )}
      </Paper>

      {/* 练习 */}
      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
          巩固练习（{detail.practice.length} 题）
        </Typography>
        {detail.practice.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            本次闭环未做巩固练习。
          </Typography>
        ) : (
          <Stack spacing={1.5}>
            {detail.practice.map((p) => (
              <Box key={p.practice_id}>
                <MathText text={p.question_text} />
                {p.user_answer && (
                  <Typography variant="body2" sx={{ mt: 0.5 }}>
                    你的作答：{p.user_answer}
                  </Typography>
                )}
                <Chip
                  size="small"
                  sx={{ mt: 0.5 }}
                  label={
                    p.is_correct === 1
                      ? '做对了'
                      : p.is_correct === 0
                        ? '待加强'
                        : '未判分'
                  }
                  color={p.is_correct === 1 ? 'success' : p.is_correct === 0 ? 'warning' : 'default'}
                  variant="outlined"
                />
                {p.answer_text && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                    参考答案：{p.answer_text}
                  </Typography>
                )}
              </Box>
            ))}
          </Stack>
        )}
      </Paper>

      {/* 复盘：复述 + 验证 */}
      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
          复盘（复述 / 验证）
        </Typography>
        {c.restate_text ? (
          <Box sx={{ mb: 1 }}>
            <Typography variant="caption" color="text.secondary">
              复述（{c.restate_len} 字
              {c.restate_is_copy === 1 ? ' · 疑似照抄' : ''}）
            </Typography>
            <MathText text={c.restate_text} />
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            未提交复述。
          </Typography>
        )}
        {c.verify_response ? (
          <Box>
            <Typography variant="caption" color="text.secondary">
              验证问答
            </Typography>
            {c.verify_prompt && <MathText text={c.verify_prompt} />}
            <MathText text={c.verify_response} />
            {c.verify_feedback && (
              <Typography variant="caption" color="text.secondary">
                反馈：{c.verify_feedback}
              </Typography>
            )}
            <Chip
              size="small"
              sx={{ mt: 0.5 }}
              label={
                c.verify_result === 'pass'
                  ? '验证通过'
                  : c.verify_result === 'give_up'
                    ? '已跳过'
                    : c.verify_result === 'fail'
                      ? '待加强'
                      : '未完成'
              }
              color={c.verify_result === 'pass' ? 'success' : 'default'}
              variant="outlined"
            />
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">
            未发起验证。
          </Typography>
        )}
      </Paper>

      <Divider sx={{ my: 2 }} />
      <Typography variant="caption" color="text.disabled">
        闭环 ID：{detail.loop_id}
      </Typography>
    </Box>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <MathText text={value || '—'} />
    </Box>
  );
}

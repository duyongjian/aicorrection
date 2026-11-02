import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Box, Button, Paper, Stack, Typography } from '@mui/material';
import { useLoop } from '../hooks/useLoop';
import AttributionCard from '../components/AttributionCard';
import RateActions from '../components/RateActions';
import FollowupPanel from '../components/FollowupPanel';
import AnalyzingState from '../components/AnalyzingState';
import OcrFeedback from '../components/OcrFeedback';
import HistoryList from '../components/HistoryList';
import { tracker } from '../tracking/sdk';

type Status = 'idle' | 'loading' | 'ok' | 'analyzing' | 'incomplete' | 'error';

/** R02 + R03 归因展示 + 认可 / 追问；无进行中归因时回退展示历史（FLW-02）。 */
export default function AttributionPage() {
  const navigate = useNavigate();
  const { loop, attribution, runAttribution, rate, followup, resetLoop, error } =
    useLoop();

  const [status, setStatus] = useState<Status>('idle');
  const [showFollowup, setShowFollowup] = useState(false);
  const [rated, setRated] = useState(false);
  const [imageError, setImageError] = useState(false);

  /** 重新归因：保留已上传的 loop，仅重跑分析模型（不丢失原图/题干）。 */
  const handleRetry = useCallback(() => {
    setStatus('loading');
    runAttribution()
      .then((d) => {
        if (d.status === 'ok') setStatus('ok');
        else if (d.status === 'analyzing') setStatus('analyzing');
        else setStatus('incomplete');
      })
      .catch(() => setStatus('error'));
  }, [runAttribution]);

  useEffect(() => {
    if (!loop) {
      // 无进行中归因：不再把用户弹回上传页，而是展示历史记录（FLW-02）。
      return;
    }
    // T2: screen_view 埋点 — 归因页（screenName='attr_show'，与 followup 同页区分）
    tracker.screenView('attr_show');
    if (!attribution) {
      setStatus('loading');
      runAttribution()
        .then((d) => {
          if (d.status === 'ok') setStatus('ok');
          else if (d.status === 'analyzing') setStatus('analyzing');
          else setStatus('incomplete');
        })
        .catch(() => setStatus('error'));
    } else {
      setStatus('ok');
    }
  }, [loop, attribution, runAttribution, navigate]);

  // 无进行中归因：展示往期历史，并引导回到上传。
  if (!loop) {
    return (
      <Box>
        <Typography variant="h6" sx={{ mb: 2 }}>
          归因诊断
        </Typography>
        <Alert severity="info" sx={{ mb: 2 }}>
          当前没有进行中的归因。以下是你的历史归因记录；如需新建，请返回上传。
          <Box sx={{ mt: 1 }}>
            <Button
              size="small"
              variant="outlined"
              onClick={() => navigate('/')}
            >
              去上传
            </Button>
          </Box>
        </Alert>
        <HistoryList />
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 2 }}>
        归因诊断
      </Typography>

      <OcrFeedback ocrStatus={loop.ocr_status} />

      {/* 原图回显：仅图片入口有 image_url */}
      {loop.image_url && (
        <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
          <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
            上传原图
          </Typography>
          {imageError ? (
            <Alert severity="warning">原图加载失败（可能已被清理）</Alert>
          ) : (
            <Box
              component="a"
              href={loop.image_url}
              target="_blank"
              rel="noreferrer"
              sx={{ display: 'inline-block' }}
            >
              <Box
                component="img"
                src={loop.image_url}
                alt="上传原图"
                onError={() => setImageError(true)}
                sx={{
                  maxWidth: '100%',
                  maxHeight: 320,
                  objectFit: 'contain',
                  borderRadius: 1,
                  border: '1px solid',
                  borderColor: 'divider',
                  display: 'block',
                }}
              />
            </Box>
          )}
        </Paper>
      )}

      {/* 识别结果：让用户核对 OCR 是否准确 */}
      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
          识别结果（本地OCR + 视觉模型 MiniCPM-V 双通道，可对照核对）
        </Typography>
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
          {loop.question}
        </Typography>
        {loop.latex && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mt: 1, fontFamily: 'monospace' }}
          >
            LaTeX：{loop.latex}
          </Typography>
        )}
      </Paper>

      {status === 'loading' && <AnalyzingState />}

      {status === 'analyzing' && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          归因模型响应较慢，本次未在限定时间内完成（已转为后台分析态）。可重新归因，
          或改用更小的分析模型 / 调大 ATTRIBUTION_TIMEOUT_MS。
          <Box sx={{ mt: 1, display: 'flex', gap: 1 }}>
            <Button size="small" variant="outlined" onClick={handleRetry}>
              重新归因
            </Button>
            <Button
              size="small"
              variant="text"
              onClick={() => {
                resetLoop();
                navigate('/');
              }}
            >
              返回上传
            </Button>
          </Box>
        </Alert>
      )}

      {status === 'incomplete' && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          归因结果不完整（缺项），暂不展示。请重拍或补充文本后重试。
          <Box sx={{ mt: 1, display: 'flex', gap: 1 }}>
            <Button size="small" variant="outlined" onClick={handleRetry}>
              重新归因
            </Button>
            <Button
              size="small"
              variant="text"
              onClick={() => {
                resetLoop();
                navigate('/');
              }}
            >
              返回上传
            </Button>
          </Box>
        </Alert>
      )}

      {status === 'error' && (
        <Alert severity="error" sx={{ mb: 2 }}>
          归因请求失败：{error || '请返回重试'}
          <Box sx={{ mt: 1, display: 'flex', gap: 1 }}>
            <Button size="small" variant="outlined" onClick={handleRetry}>
              重新归因
            </Button>
            <Button
              size="small"
              variant="text"
              onClick={() => {
                resetLoop();
                navigate('/');
              }}
            >
              返回上传
            </Button>
          </Box>
        </Alert>
      )}

      {status === 'ok' && attribution && (
        <>
          <AttributionCard attr={attribution} />

          {!rated && (
            <RateActions
              onRate={async (a, r) => {
                await rate(a, r);
                setRated(true);
              }}
            />
          )}

          {rated && (
            <Stack spacing={2} sx={{ mt: 3 }}>
              <Alert severity="success">已记录你的反馈，感谢！</Alert>
              <Button
                variant="outlined"
                onClick={() => setShowFollowup(true)}
                disabled={showFollowup}
              >
                追问一次
              </Button>
              {showFollowup && (
                <FollowupPanel onFollowup={followup} />
              )}
              <Button
                onClick={() => {
                  resetLoop();
                  navigate('/');
                }}
              >
                完成 / 返回上传
              </Button>
            </Stack>
          )}
        </>
      )}
    </Box>
  );
}

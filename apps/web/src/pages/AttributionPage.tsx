import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Box, Button, Stack, Typography } from '@mui/material';
import { useLoop } from '../hooks/useLoop';
import AttributionCard from '../components/AttributionCard';
import RateActions from '../components/RateActions';
import FollowupPanel from '../components/FollowupPanel';
import AnalyzingState from '../components/AnalyzingState';
import OcrFeedback from '../components/OcrFeedback';
import { tracker } from '../tracking/sdk';

type Status = 'idle' | 'loading' | 'ok' | 'analyzing' | 'incomplete' | 'error';

/** R02 + R03 归因展示 + 认可 / 追问 */
export default function AttributionPage() {
  const navigate = useNavigate();
  const { loop, attribution, runAttribution, rate, followup, resetLoop } =
    useLoop();

  const [status, setStatus] = useState<Status>('idle');
  const [showFollowup, setShowFollowup] = useState(false);
  const [rated, setRated] = useState(false);

  useEffect(() => {
    if (!loop) {
      navigate('/');
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

  if (!loop) return null;

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 2 }}>
        归因诊断
      </Typography>

      <OcrFeedback ocrStatus={loop.ocr_status} />

      {(status === 'loading' || status === 'analyzing') && <AnalyzingState />}

      {status === 'incomplete' && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          归因结果不完整（缺项），暂不展示。请重拍或补充文本后重试。
        </Alert>
      )}
      {status === 'error' && (
        <Alert severity="error" sx={{ mb: 2 }}>
          归因请求失败，请返回重试。
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

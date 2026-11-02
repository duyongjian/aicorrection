import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Stack,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { api } from '../api/client';
import { useLoopStore } from '../store/loopStore';
import type { HistoryItem } from '@aicorrection/shared';

const RATE_LABEL: Record<string, string> = {
  approve: '已认可',
  inaccurate: '不准确',
  report: '已举报',
};

function formatTime(iso: string): string {
  // SQLite datetime('now') 为 UTC（无时区）。本地浏览器展示，补 Z 当 UTC 解析。
  const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 单条历史的展开详情：完整三要素 + 原图。 */
function HistoryDetail({ item }: { item: HistoryItem }) {
  return (
    <Box>
      {item.image_url && (
        <Box
          component="img"
          src={item.image_url}
          alt="原图"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = 'none';
          }}
          sx={{
            width: '100%',
            maxHeight: 280,
            objectFit: 'contain',
            borderRadius: 1,
            border: '1px solid',
            borderColor: 'divider',
            display: 'block',
            mb: 2,
          }}
        />
      )}
      <Stack spacing={1}>
        <Field label="知识点" value={item.knowledge_point} />
        <Field label="错因" value={item.cause} />
        <Field label="本质" value={item.essence} />
        {item.attr_model_version && (
          <Typography variant="caption" color="text.secondary">
            模型：{item.attr_model_version}
            {item.attr_latency_ms
              ? ` · ${Math.round(item.attr_latency_ms / 1000)}s`
              : ''}
          </Typography>
        )}
      </Stack>
    </Box>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
        {value || '—'}
      </Typography>
    </Box>
  );
}

/** 归因历史列表（FLW-02）：从 DB 按当前匿名用户拉取往期归因，可展开查看。 */
export default function HistoryList() {
  const navigate = useNavigate();
  const anonUserId = useLoopStore((s) => s.anonUserId);
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!anonUserId) {
      setItems([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .getHistory(anonUserId)
      .then((d) => {
        if (!cancelled) {
          setItems(d);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError('历史记录获取失败');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [anonUserId]);

  if (loading) {
    return (
      <Box sx={{ textAlign: 'center', py: 4 }}>
        <CircularProgress size={28} />
      </Box>
    );
  }

  if (error) {
    return <Alert severity="error">{error}</Alert>;
  }

  if (!items || items.length === 0) {
    return (
      <Box sx={{ textAlign: 'center', py: 4 }}>
        <Typography color="text.secondary" sx={{ mb: 2 }}>
          暂无归因记录，先去上传一道错题吧。
        </Typography>
        <Button variant="contained" onClick={() => navigate('/')}>
          去上传
        </Button>
      </Box>
    );
  }

  return (
    <Stack spacing={1.5}>
      {items.map((it) => (
        <Accordion key={it.attribution_id} disableGutters elevation={0}
          sx={{ border: '1px solid', borderColor: 'divider', '&:before': { display: 'none' } }}>
          <AccordionSummary expandIcon={<ExpandMoreIcon />} sx={{ px: 2 }}>
            <Stack
              direction="row"
              spacing={2}
              alignItems="center"
              sx={{ width: '100%', mr: 1 }}
            >
              {it.image_url ? (
                <Box
                  component="img"
                  src={it.image_url}
                  alt="原图"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display =
                      'none';
                  }}
                  sx={{
                    width: 48,
                    height: 48,
                    objectFit: 'cover',
                    borderRadius: 1,
                    border: '1px solid',
                    borderColor: 'divider',
                    flexShrink: 0,
                  }}
                />
              ) : (
                <Box
                  sx={{
                    width: 48,
                    height: 48,
                    borderRadius: 1,
                    border: '1px solid',
                    borderColor: 'divider',
                    flexShrink: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: 'text.disabled',
                    fontSize: 12,
                  }}
                >
                  文本
                </Box>
              )}
              <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                <Stack
                  direction="row"
                  spacing={1}
                  alignItems="center"
                  sx={{ mb: 0.25 }}
                >
                  {it.subject && (
                    <Chip label={it.subject} size="small" color="primary" />
                  )}
                  <Typography variant="caption" color="text.secondary">
                    {formatTime(it.created_at)}
                  </Typography>
                  {it.rate_action && (
                    <Chip
                      label={RATE_LABEL[it.rate_action] ?? it.rate_action}
                      size="small"
                      color={
                        it.rate_action === 'approve' ? 'success' : 'warning'
                      }
                      variant="outlined"
                    />
                  )}
                </Stack>
                <Typography
                  variant="body2"
                  sx={{
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {it.knowledge_point || '（无知识点）'}
                </Typography>
              </Box>
            </Stack>
          </AccordionSummary>
          <AccordionDetails sx={{ px: 2, pb: 2 }}>
            <HistoryDetail item={it} />
          </AccordionDetails>
        </Accordion>
      ))}
    </Stack>
  );
}

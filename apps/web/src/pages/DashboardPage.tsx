import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Grid,
  Typography,
} from '@mui/material';
import { api } from '../api/client';
import type { M1Stats } from '@aicorrection/shared';

/** QAL-02 验收看板：M1 闸门指标 */
export default function DashboardPage() {
  const [stats, setStats] = useState<M1Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .dashboardM1(14)
      .then((s) => {
        setStats(s);
        setLoading(false);
      })
      .catch(() => {
        setError('看板数据获取失败');
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <Box sx={{ textAlign: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }
  if (error || !stats) {
    return <Alert severity="error">{error}</Alert>;
  }

  const gateColor = stats.gate === 'go' ? 'success' : 'error';

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 2 }}>
        M1 验收看板
      </Typography>

      <Grid container spacing={2}>
        <Grid item xs={6}>
          <Card>
            <CardContent>
              <Typography color="text.secondary">归因认可率</Typography>
              <Typography variant="h4">
                {(stats.approval_rate * 100).toFixed(1)}%
              </Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={6}>
          <Card>
            <CardContent>
              <Typography color="text.secondary">三项齐全率</Typography>
              <Typography variant="h4">
                {(stats.three_item_rate * 100).toFixed(1)}%
              </Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={6}>
          <Card>
            <CardContent>
              <Typography color="text.secondary">上传失败率</Typography>
              <Typography variant="h4">
                {(stats.upload_fail_rate * 100).toFixed(1)}%
              </Typography>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={6}>
          <Card>
            <CardContent>
              <Typography color="text.secondary">
                上传→归因时延 p50/p95
              </Typography>
              <Typography variant="h6">
                {stats.upload_to_attr_latency_ms.p50} /{' '}
                {stats.upload_to_attr_latency_ms.p95} ms
              </Typography>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      <Box sx={{ mt: 3, display: 'flex', alignItems: 'center', gap: 2 }}>
        <Chip
          label={`闸门：${stats.gate === 'go' ? 'GO' : 'NO-GO'}`}
          color={gateColor}
        />
        <Typography color="text.secondary">
          窗口 {stats.window}（认可率 ≥ 70% 为 GO）
        </Typography>
      </Box>
    </Box>
  );
}

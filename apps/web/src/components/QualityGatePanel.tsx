/**
 * 质量优化面板（Q）：
 *  - G1 质量闸门：聚合 M1 / 闭环健康 / 盲评覆盖，给出可发布判定（passed / 综合分 / blocker / warning）。
 *  - B·C·D 分层覆盖：各知识点分层与各层盲评覆盖率，指导正式盲评按层抽样。
 *  - 代理↔质量校准：演示代理自报分如何按置信度收敛到先验（保守校准）。
 * 自包含：直接调用 api，可在归因页或独立页挂载。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  LinearProgress,
  Paper,
  Slider,
  Stack,
  Typography,
} from '@mui/material';
import { api } from '../api/client';

/**
 * 质量闸门分色：通过用绿、hold 用红、有 warning 用黄。
 */
const GATE_COLOR: Record<'ship' | 'hold', 'success' | 'error'> = {
  ship: 'success',
  hold: 'error',
};

const STRATUM_COLOR: Record<string, 'default' | 'info' | 'warning' | 'error'> = {
  A: 'default',
  B: 'info',
  C: 'warning',
  D: 'error',
};

export default function QualityGatePanel() {
  const [gate, setGate] = useState<{
    passed: boolean;
    score: number;
    readiness: 'ship' | 'hold';
    blockers: string[];
    warnings: string[];
    checks: Array<{
      name: string;
      label: string;
      value: number;
      comparator: 'min' | 'max';
      threshold: number;
      pass: boolean;
      severity: 'blocker' | 'warning';
      detail: string;
    }>;
    window: string;
  } | null>(null);

  const [strata, setStrata] = useState<{
    items: Array<{
      stratum: 'A' | 'B' | 'C' | 'D';
      label: string;
      kp_count: number;
      reviewed_count: number;
      coverage: number;
    }>;
    total_kp: number;
  } | null>(null);

  // 校准演示本地状态
  const [rawScore, setRawScore] = useState(0.8);
  const [confidence, setConfidence] = useState(0.6);
  const [calibrated, setCalibrated] = useState<{
    raw_score: number;
    confidence: number;
    prior: number;
    calibrated: number;
  } | null>(null);

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setErr('');
    try {
      const [g, s] = await Promise.all([api.getQualityGate(), api.getStrataReport()]);
      setGate(g);
      setStrata(s);
    } catch (e) {
      setErr((e as Error).message || '质量数据加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runCalibrate = useCallback(async () => {
    try {
      const r = await api.calibrateQuality({ raw_score: rawScore, confidence });
      setCalibrated(r);
    } catch (e) {
      setErr((e as Error).message || '校准调用失败');
    }
  }, [rawScore, confidence]);

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle1" sx={{ mb: 1, fontWeight: 600 }}>
        质量优化看板（G1 闸门 / B·C·D 分层 / 代理校准）
      </Typography>

      {err && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {err}
        </Alert>
      )}

      <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
        <Button size="small" variant="outlined" onClick={load} disabled={loading}>
          {loading ? '加载中…' : '刷新'}
        </Button>
      </Stack>

      {/* ---- G1 闸门 ---- */}
      <Typography variant="subtitle2" sx={{ mt: 1, mb: 1, color: 'text.secondary' }}>
        G1 质量闸门（可发布判定）
      </Typography>
      {gate ? (
        <Box>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
            <Chip
              label={gate.passed ? '可发布 (ship)' : '暂缓 (hold)'}
              color={GATE_COLOR[gate.readiness]}
              size="small"
            />
            <Chip label={`综合分 ${(gate.score * 100).toFixed(0)}%`} variant="outlined" size="small" />
            <Chip label={`窗口 ${gate.window}`} variant="outlined" size="small" />
          </Stack>

          {gate.blockers.length > 0 && (
            <Alert severity="error" sx={{ mb: 1 }}>
              阻断项：{gate.blockers.join('；')}
            </Alert>
          )}
          {gate.warnings.length > 0 && (
            <Alert severity="warning" sx={{ mb: 1 }}>
              告警项：{gate.warnings.join('；')}
            </Alert>
          )}

          <Stack spacing={1}>
            {gate.checks.map((c) => (
              <Box key={c.name}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip
                    label={c.pass ? '通过' : '未达标'}
                    color={c.pass ? 'success' : c.severity === 'blocker' ? 'error' : 'warning'}
                    size="small"
                    variant={c.pass ? 'filled' : 'outlined'}
                  />
                  <Typography variant="body2">{c.label}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {c.value}（阈值 {c.comparator === 'min' ? '≥' : '≤'} {c.threshold}）
                  </Typography>
                </Stack>
              </Box>
            ))}
          </Stack>
        </Box>
      ) : (
        <Typography variant="body2" color="text.secondary">
          暂无闸门数据。
        </Typography>
      )}

      <Box sx={{ borderTop: '1px solid', borderColor: 'divider', my: 2 }} />

      {/* ---- B·C·D 分层覆盖 ---- */}
      <Typography variant="subtitle2" sx={{ mb: 1, color: 'text.secondary' }}>
        B·C·D 分层覆盖（正式盲评按层抽样）
      </Typography>
      {strata ? (
        <Stack spacing={1}>
          {strata.items.map((s) => (
            <Box key={s.stratum}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                <Chip label={`${s.stratum} · ${s.label}`} color={STRATUM_COLOR[s.stratum]} size="small" />
                <Typography variant="caption" color="text.secondary">
                  知识点 {s.kp_count} 个 · 已盲评 {s.reviewed_count} · 覆盖{' '}
                  {(s.coverage * 100).toFixed(0)}%
                </Typography>
              </Stack>
              <LinearProgress
                variant="determinate"
                value={s.coverage * 100}
                color={s.coverage >= 0.3 ? 'success' : 'warning'}
              />
            </Box>
          ))}
          <Typography variant="caption" color="text.secondary">
            总计 {strata.total_kp} 个知识点
          </Typography>
        </Stack>
      ) : (
        <Typography variant="body2" color="text.secondary">
          暂无分层数据。
        </Typography>
      )}

      <Box sx={{ borderTop: '1px solid', borderColor: 'divider', my: 2 }} />

      {/* ---- 代理↔质量校准演示 ---- */}
      <Typography variant="subtitle2" sx={{ mb: 1, color: 'text.secondary' }}>
        代理↔质量校准（自报分 → 先验收敛）
      </Typography>
      <Stack spacing={1.5}>
        <Box>
          <Typography variant="caption" color="text.secondary">
            代理自报分 raw_score：{rawScore.toFixed(2)}
          </Typography>
          <Slider
            value={rawScore}
            min={0}
            max={1}
            step={0.01}
            onChange={(_, v) => setRawScore(v as number)}
            size="small"
          />
        </Box>
        <Box>
          <Typography variant="caption" color="text.secondary">
            置信度 confidence：{confidence.toFixed(2)}（越高越信任代理）
          </Typography>
          <Slider
            value={confidence}
            min={0}
            max={1}
            step={0.01}
            onChange={(_, v) => setConfidence(v as number)}
            size="small"
          />
        </Box>
        <Button size="small" variant="contained" onClick={runCalibrate}>
          校准
        </Button>
        {calibrated && (
          <Alert severity="info">
            校准分 = {confidence.toFixed(2)} × {rawScore.toFixed(2)} + (1 − {confidence.toFixed(2)}) ×{' '}
            {calibrated.prior.toFixed(2)} = <strong>{calibrated.calibrated.toFixed(3)}</strong>
            （先验 0.5，保守下限）
          </Alert>
        )}
      </Stack>
    </Paper>
  );
}

/**
 * 线下分发 MVP 卡密激活门：冷启动校验凭证，未激活/失效时渲染激活页。
 * 业务请求的凭证由 client.ts 请求拦截器统一注入；401 失效事件在此回到激活页。
 */
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import {
  ANON_USER_STORAGE_KEY,
  LICENSE_TOKEN_STORAGE_KEY,
  SEGMENTS,
  SEGMENT_LABELS,
} from '@aicorrection/shared';
import type { Segment } from '@aicorrection/shared';
import { api, describeError } from '../api/client';

const LICENSE_LOST_EVENT = 'aicorrection:license-lost';
const HONEST_NOTE = '本版为线下内测版，归因质量尚未通过正式验收，请仅用于体验与反馈。';

type Phase = 'checking' | 'active' | 'activate' | 'error';

/** 输入归一化：转大写，去掉空格与除连字符外的多余符号（保留 AC-XXXX-XXXX-XXXX 分组格式）。 */
function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9-]/g, '');
}

export default function LicenseGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [checkError, setCheckError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [segment, setSegment] = useState<Segment>('kaoyan');
  const [submitting, setSubmitting] = useState(false);
  const [redeemError, setRedeemError] = useState<string | null>(null);

  const checkStatus = useCallback(async () => {
    setPhase('checking');
    setCheckError(null);
    try {
      const status = await api.getLicenseStatus();
      // 服务端未开启门禁（默认开发/未分发模式）时，active 为 true 且 gate_enabled 为 false。
      // 两重判断都放行：避免把「本就无需激活」误显示成一张永远通不过的激活页。
      setPhase(status.active || !status.gate_enabled ? 'active' : 'activate');
    } catch (e) {
      setCheckError(describeError(e));
      setPhase('error');
    }
  }, []);

  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  useEffect(() => {
    const onLost = () => {
      setRedeemError(null);
      setPhase('activate');
    };
    window.addEventListener(LICENSE_LOST_EVENT, onLost);
    return () => window.removeEventListener(LICENSE_LOST_EVENT, onLost);
  }, []);

  const handleActivate = async () => {
    setRedeemError(null);
    setSubmitting(true);
    try {
      const res = await api.redeemLicense({ code, segment });
      localStorage.setItem(LICENSE_TOKEN_STORAGE_KEY, res.license_token);
      // 与 loopStore.ts 的 PersistedUser 结构逐字一致：{ anonUserId, segment }。
      // reload 后 zustand store 重新读取该持久化身份，主流程不再调用 createAccount。
      localStorage.setItem(
        ANON_USER_STORAGE_KEY,
        JSON.stringify({ anonUserId: res.anon_user_id, segment: res.segment })
      );
      window.location.reload();
    } catch (e) {
      setRedeemError(describeError(e));
      setSubmitting(false);
    }
  };

  if (phase === 'checking') {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <Stack alignItems="center" spacing={2}>
          <CircularProgress />
          <Typography variant="body2" color="text.secondary">
            正在校验使用凭证…
          </Typography>
        </Stack>
      </Box>
    );
  }

  if (phase === 'active') {
    return <>{children}</>;
  }

  if (phase === 'error') {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', bgcolor: 'grey.50', p: 2 }}>
        <Card sx={{ width: '100%', maxWidth: 420 }}>
          <CardContent sx={{ p: 3 }}>
            <Stack spacing={2.5}>
              <Typography variant="h6" fontWeight={700} align="center">
                暂时无法连接服务
              </Typography>
              <Alert severity="error">{checkError}</Alert>
              <Button variant="contained" onClick={() => void checkStatus()}>
                重试
              </Button>
              <Typography variant="caption" color="text.secondary" align="center">
                {HONEST_NOTE}
              </Typography>
            </Stack>
          </CardContent>
        </Card>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', bgcolor: 'grey.50', p: 2 }}>
      <Card sx={{ width: '100%', maxWidth: 420 }}>
        <CardContent sx={{ p: 3 }}>
          <Stack spacing={2.5}>
            <Typography variant="h6" fontWeight={700} align="center">
              错题强化闭环 · 内测版
            </Typography>
            <TextField
              label="卡密"
              placeholder="AC-XXXX-XXXX-XXXX"
              value={code}
              onChange={(e) => setCode(normalizeCode(e.target.value))}
              fullWidth
              autoFocus
              autoComplete="off"
            />
            <TextField
              select
              label="使用分段"
              value={segment}
              onChange={(e) => setSegment(e.target.value as Segment)}
              fullWidth
            >
              {SEGMENTS.map((s) => (
                <MenuItem key={s} value={s}>
                  {SEGMENT_LABELS[s]}
                </MenuItem>
              ))}
            </TextField>
            {redeemError && <Alert severity="error">{redeemError}</Alert>}
            <Button
              variant="contained"
              size="large"
              disabled={submitting || !code}
              onClick={() => void handleActivate()}
            >
              {submitting ? <CircularProgress size={20} color="inherit" /> : '激活'}
            </Button>
            <Typography variant="caption" color="text.secondary" align="center">
              {HONEST_NOTE}
            </Typography>
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}

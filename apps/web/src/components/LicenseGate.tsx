/**
 * 统一身份编排器（卡密激活 + 真实账号登录/注册）。
 * - 校验通过后渲染 AppShell（抽屉式侧边栏）+ 业务页面；
 * - 未激活时渲染侧边栏 + 友好占位，并叠加阻塞式 AccountPanel（设置风格面板）；
 * - 业务请求的凭证由 client.ts 请求拦截器统一注入；401 失效事件在此回到激活。
 *
 * 设计：anon_user_id 仍是唯一身份主键。卡密与真实账号两条路径最终都写入同一个
 * ANON_USER_STORAGE_KEY（{ anonUserId, segment }），主流程（loopStore）零改动即可复用。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Alert, Box, Button, CircularProgress, Stack, Typography } from '@mui/material';
import AccountCircleOutlinedIcon from '@mui/icons-material/AccountCircleOutlined';
import {
  ANON_USER_STORAGE_KEY,
  AUTH_TOKEN_STORAGE_KEY,
  LICENSE_TOKEN_STORAGE_KEY,
} from '@aicorrection/shared';
import type { Segment } from '@aicorrection/shared';
import { api, describeError } from '../api/client';
import AppShell from './AppShell';
import AccountPanel from './AccountPanel';

const LICENSE_LOST_EVENT = 'aicorrection:license-lost';
const AUTH_LOST_EVENT = 'aicorrection:auth-lost';

type Phase = 'checking' | 'active' | 'activate' | 'error';

/** 写入统一匿名身份（卡密/账号两条路径共用，主流程据此复用同一用户）。 */
function persistIdentity(anonUserId: string, segment: Segment): void {
  try {
    localStorage.setItem(ANON_USER_STORAGE_KEY, JSON.stringify({ anonUserId, segment }));
  } catch {
    /* 隐私模式 / 配额超限忽略 */
  }
}

function readAuthToken(): string | null {
  try {
    return localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export default function LicenseGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [checkError, setCheckError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<{
    anonUserId: string;
    segment: Segment;
    identifier?: string | null;
    providers?: string[];
  } | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);

  const checkStatus = useCallback(async () => {
    setPhase('checking');
    setCheckError(null);
    try {
      // 1. 真实账号优先
      const authTok = readAuthToken();
      if (authTok) {
        try {
          const a = await api.getAuthStatus();
          if (a.active && a.anon_user_id) {
            const seg = (a.segment as Segment) ?? 'gaozhong';
            persistIdentity(a.anon_user_id, seg);
            setIdentity({
              anonUserId: a.anon_user_id,
              segment: seg,
              identifier: a.identifier ?? null,
              providers: a.providers ?? [],
            });
            setPhase('active');
            return;
          }
        } catch {
          /* 忽略，回落卡密校验 */
        }
      }
      // 2. 卡密 / 门禁状态
      const l = await api.getLicenseStatus();
      if (l.active || !l.gate_enabled) {
        if (l.active && l.anon_user_id) {
          const seg = (l.segment as Segment) ?? 'gaozhong';
          persistIdentity(l.anon_user_id, seg);
          setIdentity({ anonUserId: l.anon_user_id, segment: seg });
        }
        setPhase('active');
        return;
      }
      setPhase('activate');
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
      void checkStatus();
    };
    window.addEventListener(LICENSE_LOST_EVENT, onLost);
    window.addEventListener(AUTH_LOST_EVENT, onLost);
    return () => {
      window.removeEventListener(LICENSE_LOST_EVENT, onLost);
      window.removeEventListener(AUTH_LOST_EVENT, onLost);
    };
  }, [checkStatus]);

  // 未激活时自动打开面板（阻塞式）
  useEffect(() => {
    if (phase === 'activate') setAccountOpen(true);
  }, [phase]);

  const openAccount = useCallback(() => setAccountOpen(true), []);
  const closeAccount = useCallback(() => {
    if (phase === 'active') setAccountOpen(false);
  }, [phase]);

  const handleLogout = useCallback(() => {
    try {
      localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
      localStorage.removeItem(LICENSE_TOKEN_STORAGE_KEY);
      localStorage.removeItem(ANON_USER_STORAGE_KEY);
    } catch {
      /* ignore */
    }
    setAccountOpen(false);
    void checkStatus();
  }, [checkStatus]);

  if (phase === 'checking') {
    return (
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          bgcolor: 'background.default',
        }}
      >
        <Stack alignItems="center" spacing={2}>
          <CircularProgress />
          <Typography variant="body2" color="text.secondary">
            正在校验使用凭证…
          </Typography>
        </Stack>
      </Box>
    );
  }

  if (phase === 'error') {
    return (
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          bgcolor: 'background.default',
          p: 2,
        }}
      >
        <Box
          sx={{
            width: '100%',
            maxWidth: 420,
            p: 3,
            borderRadius: '4px',
            bgcolor: 'background.paper',
            boxShadow: '0 12px 40px rgba(31,36,48,0.12)',
          }}
        >
          <Stack spacing={2.5}>
            <Typography variant="h6" fontWeight={700} align="center">
              暂时无法连接服务
            </Typography>
            <Alert severity="error">{checkError}</Alert>
            <Button variant="contained" onClick={() => void checkStatus()}>
              重试
            </Button>
          </Stack>
        </Box>
      </Box>
    );
  }

  // active 或 activate 都渲染应用外壳；未激活时叠加阻塞式面板
  return (
    <>
      <AppShell onOpenAccount={openAccount} identity={identity}>
        {phase === 'active' ? (
          children
        ) : (
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: '60vh',
              textAlign: 'center',
              color: 'text.secondary',
            }}
          >
            <AccountCircleOutlinedIcon sx={{ fontSize: 56, color: 'primary.light', mb: 1.5 }} />
            <Typography variant="h6" sx={{ color: 'text.primary', mb: 0.5 }}>
              登录后即可开始错题归因
            </Typography>
            <Typography variant="body2">点击左下角「登录 / 注册」激活你的账号</Typography>
          </Box>
        )}
      </AppShell>
      <AccountPanel
        open={accountOpen}
        blocking={phase === 'activate'}
        onClose={closeAccount}
        onLogout={handleLogout}
        onDeleteAccount={handleLogout}
        identity={identity}
      />
    </>
  );
}

/**
 * 统一身份门（卡密激活 + 真实账号登录/注册）。
 * 业务请求的凭证由 client.ts 请求拦截器统一注入；401 失效事件在此回到激活页。
 *
 * 设计：anon_user_id 仍是唯一身份主键。卡密与真实账号两条路径最终都写入同一个
 * ANON_USER_STORAGE_KEY（{ anonUserId, segment }），主流程（loopStore）零改动即可复用。
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
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import {
  ANON_USER_STORAGE_KEY,
  AUTH_TOKEN_STORAGE_KEY,
  LICENSE_TOKEN_STORAGE_KEY,
  SEGMENTS,
  SEGMENT_LABELS,
} from '@aicorrection/shared';
import type { Segment } from '@aicorrection/shared';
import { api, describeError } from '../api/client';

const LICENSE_LOST_EVENT = 'aicorrection:license-lost';
const AUTH_LOST_EVENT = 'aicorrection:auth-lost';
const HONEST_NOTE = '本版为线下内测版，归因质量尚未通过正式验收，请仅用于体验与反馈。';

type Phase = 'checking' | 'active' | 'activate' | 'error';

/** 输入归一化：转大写，去掉空格与除连字符外的多余符号（保留 AC-XXXX-XXXX-XXXX 分组格式）。 */
function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9-]/g, '');
}

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

  // 卡密表单
  const [code, setCode] = useState('');
  // 账号表单
  const [tab, setTab] = useState<'card' | 'account'>('card');
  const [acctTab, setAcctTab] = useState<'pwd' | 'sms' | 'wechat' | 'magic'>('pwd');
  const [pwdMode, setPwdMode] = useState<'login' | 'register'>('login');
  const [segment, setSegment] = useState<Segment>('kaoyan');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [smsCode, setSmsCode] = useState('');
  const [magicEmail, setMagicEmail] = useState('');
  const [magicToken, setMagicToken] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [devHint, setDevHint] = useState<string | null>(null);

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
            persistIdentity(a.anon_user_id, (a.segment as Segment) ?? 'gaozhong');
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
          persistIdentity(l.anon_user_id, (l.segment as Segment) ?? 'gaozhong');
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
      setFormError(null);
      void checkStatus();
    };
    window.addEventListener(LICENSE_LOST_EVENT, onLost);
    window.addEventListener(AUTH_LOST_EVENT, onLost);
    return () => {
      window.removeEventListener(LICENSE_LOST_EVENT, onLost);
      window.removeEventListener(AUTH_LOST_EVENT, onLost);
    };
  }, [checkStatus]);

  // 魔法链接：若 URL 带 ?token= 自动进入账号→魔法页并回填，便于点链接直达
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('token');
    if (t) {
      setMagicToken(t);
      setTab('account');
      setAcctTab('magic');
    }
  }, []);

  // ---------- 卡密激活 ----------
  const handleActivate = async () => {
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await api.redeemLicense({ code, segment });
      try {
        localStorage.setItem(LICENSE_TOKEN_STORAGE_KEY, res.license_token);
        persistIdentity(res.anon_user_id, res.segment);
      } catch {
        /* ignore */
      }
      window.location.reload();
    } catch (e) {
      setFormError(describeError(e));
      setSubmitting(false);
    }
  };

  // ---------- 邮箱密码 登录/注册 ----------
  const handlePwd = async () => {
    setFormError(null);
    setDevHint(null);
    setSubmitting(true);
    try {
      const res =
        pwdMode === 'register'
          ? await api.registerWithPassword({ email, password, segment })
          : await api.loginWithPassword({ email, password });
      try {
        localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, res.auth_token);
        persistIdentity(res.anon_user_id, res.segment);
      } catch {
        /* ignore */
      }
      window.location.reload();
    } catch (e) {
      setFormError(describeError(e));
      setSubmitting(false);
    }
  };

  // ---------- 短信验证码 ----------
  const handleSmsSend = async () => {
    setFormError(null);
    setDevHint(null);
    setSubmitting(true);
    try {
      const r = await api.sendSmsCode({ phone });
      if (r.dev_code) setDevHint(`dev 模式验证码：${r.dev_code}（生产环境由短信下发）`);
    } catch (e) {
      setFormError(describeError(e));
    } finally {
      setSubmitting(false);
    }
  };
  const handleSmsVerify = async () => {
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await api.verifySmsLogin({ phone, code: smsCode, segment });
      try {
        localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, res.auth_token);
        persistIdentity(res.anon_user_id, res.segment);
      } catch {
        /* ignore */
      }
      window.location.reload();
    } catch (e) {
      setFormError(describeError(e));
      setSubmitting(false);
    }
  };

  // ---------- 微信 ----------
  const handleWechat = async () => {
    setFormError(null);
    setSubmitting(true);
    try {
      const urlCode = new URLSearchParams(window.location.search).get('code') || 'dev';
      await api.wechatAuth({ code: urlCode });
      window.location.reload();
    } catch (e) {
      setFormError(describeError(e));
      setSubmitting(false);
    }
  };

  // ---------- 魔法链接 ----------
  const handleMagicSend = async () => {
    setFormError(null);
    setDevHint(null);
    setSubmitting(true);
    try {
      const r = await api.magicSend({ email: magicEmail });
      if (r.dev_token) {
        setMagicToken(r.dev_token);
        setDevHint('dev 模式令牌已回填，点击「用令牌登录」即可（生产环境由邮件下发链接）');
      }
    } catch (e) {
      setFormError(describeError(e));
    } finally {
      setSubmitting(false);
    }
  };
  const handleMagicVerify = async () => {
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await api.magicVerify({ token: magicToken, segment });
      try {
        localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, res.auth_token);
        persistIdentity(res.anon_user_id, res.segment);
      } catch {
        /* ignore */
      }
      window.location.reload();
    } catch (e) {
      setFormError(describeError(e));
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

  // phase === 'activate'
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', bgcolor: 'grey.50', p: 2 }}>
      <Card sx={{ width: '100%', maxWidth: 440 }}>
        <CardContent sx={{ p: 3 }}>
          <Stack spacing={2.5}>
            <Typography variant="h6" fontWeight={700} align="center">
              错题强化闭环 · 内测版
            </Typography>
            <Tabs
              value={tab}
              onChange={(_e, v) => {
                setTab(v);
                setFormError(null);
                setDevHint(null);
              }}
              centered
            >
              <Tab value="card" label="卡密激活" />
              <Tab value="account" label="账号登录 / 注册" />
            </Tabs>

            {tab === 'card' && (
              <>
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
                {formError && <Alert severity="error">{formError}</Alert>}
                <Button variant="contained" size="large" disabled={submitting || !code} onClick={() => void handleActivate()}>
                  {submitting ? <CircularProgress size={20} color="inherit" /> : '激活'}
                </Button>
              </>
            )}

            {tab === 'account' && (
              <>
                <Tabs
                  value={acctTab}
                  onChange={(_e, v) => {
                    setAcctTab(v);
                    setFormError(null);
                    setDevHint(null);
                  }}
                  variant="fullWidth"
                  sx={{ mb: 1 }}
                >
                  <Tab value="pwd" label="邮箱" />
                  <Tab value="sms" label="短信" />
                  <Tab value="magic" label="链接" />
                  <Tab value="wechat" label="微信" />
                </Tabs>

                {acctTab === 'pwd' && (
                  <>
                    <TextField label="邮箱" value={email} onChange={(e) => setEmail(e.target.value)} fullWidth autoComplete="email" />
                    <TextField label="密码（至少 8 位）" type="password" value={password} onChange={(e) => setPassword(e.target.value)} fullWidth autoComplete="current-password" />
                    {pwdMode === 'register' && (
                      <TextField select label="使用分段" value={segment} onChange={(e) => setSegment(e.target.value as Segment)} fullWidth>
                        {SEGMENTS.map((s) => (
                          <MenuItem key={s} value={s}>
                            {SEGMENT_LABELS[s]}
                          </MenuItem>
                        ))}
                      </TextField>
                    )}
                    <Button onClick={() => setPwdMode(pwdMode === 'login' ? 'register' : 'login')} size="small">
                      {pwdMode === 'login' ? '没有账号？去注册' : '已有账号？去登录'}
                    </Button>
                  </>
                )}

                {acctTab === 'sms' && (
                  <>
                    <TextField label="手机号" value={phone} onChange={(e) => setPhone(e.target.value)} fullWidth autoComplete="tel" />
                    <Stack direction="row" spacing={1}>
                      <TextField label="验证码" value={smsCode} onChange={(e) => setSmsCode(e.target.value)} fullWidth />
                      <Button variant="outlined" onClick={() => void handleSmsSend()} disabled={submitting || !phone}>
                        获取验证码
                      </Button>
                    </Stack>
                    <TextField select label="使用分段" value={segment} onChange={(e) => setSegment(e.target.value as Segment)} fullWidth>
                      {SEGMENTS.map((s) => (
                        <MenuItem key={s} value={s}>
                          {SEGMENT_LABELS[s]}
                        </MenuItem>
                      ))}
                    </TextField>
                  </>
                )}

                {acctTab === 'magic' && (
                  <>
                    <TextField label="邮箱" value={magicEmail} onChange={(e) => setMagicEmail(e.target.value)} fullWidth autoComplete="email" />
                    <Button variant="outlined" onClick={() => void handleMagicSend()} disabled={submitting || !magicEmail}>
                      发送登录链接
                    </Button>
                    <TextField label="登录令牌 / 链接 token" value={magicToken} onChange={(e) => setMagicToken(e.target.value)} fullWidth />
                  </>
                )}

                {acctTab === 'wechat' && (
                  <Alert severity="info">
                    微信登录需在服务端配置 WECHAT_APP_ID / WECHAT_APP_SECRET 后可用；当前未配置时点击会提示「未配置」。
                  </Alert>
                )}

                {devHint && <Alert severity="info">{devHint}</Alert>}
                {formError && <Alert severity="error">{formError}</Alert>}

                {acctTab === 'pwd' && (
                  <Button variant="contained" size="large" disabled={submitting || !email || !password} onClick={() => void handlePwd()}>
                    {submitting ? <CircularProgress size={20} color="inherit" /> : pwdMode === 'login' ? '登录' : '注册并登录'}
                  </Button>
                )}
                {acctTab === 'sms' && (
                  <Button variant="contained" size="large" disabled={submitting || !phone || !smsCode} onClick={() => void handleSmsVerify()}>
                    {submitting ? <CircularProgress size={20} color="inherit" /> : '登录 / 注册'}
                  </Button>
                )}
                {acctTab === 'magic' && (
                  <Button variant="contained" size="large" disabled={submitting || !magicToken} onClick={() => void handleMagicVerify()}>
                    {submitting ? <CircularProgress size={20} color="inherit" /> : '用令牌登录'}
                  </Button>
                )}
                {acctTab === 'wechat' && (
                  <Button variant="contained" size="large" disabled={submitting} onClick={() => void handleWechat()}>
                    {submitting ? <CircularProgress size={20} color="inherit" /> : '微信登录'}
                  </Button>
                )}
              </>
            )}

            <Typography variant="caption" color="text.secondary" align="center">
              {HONEST_NOTE}
            </Typography>
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}

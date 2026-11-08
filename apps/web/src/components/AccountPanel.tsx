import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  Divider,
  IconButton,
  MenuItem,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import LogoutOutlinedIcon from '@mui/icons-material/LogoutOutlined';
import {
  AUTH_TOKEN_STORAGE_KEY,
  LICENSE_TOKEN_STORAGE_KEY,
  SEGMENTS,
  SEGMENT_LABELS,
} from '@aicorrection/shared';
import type { Segment } from '@aicorrection/shared';
import { api, describeError } from '../api/client';

const HONEST_NOTE = '本版为线下内测版，归因质量尚未通过正式验收，请仅用于体验与反馈。';

/** 输入归一化：转大写，去掉空格与除连字符外的多余符号。 */
function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9-]/g, '');
}

interface AccountPanelProps {
  open: boolean;
  /** 未激活时阻塞式打开（禁用关闭 / ESC）。 */
  blocking: boolean;
  onClose: () => void;
  onLogout: () => void;
  /** 已激活时的身份分段（用于设置视图展示）。 */
  segment?: Segment | null;
}

export default function AccountPanel({ open, blocking, onClose, onLogout, segment }: AccountPanelProps) {
  // 卡密表单
  const [code, setCode] = useState('');
  // 账号表单
  const [tab, setTab] = useState<'card' | 'account'>('card');
  const [acctTab, setAcctTab] = useState<'pwd' | 'sms' | 'wechat' | 'magic'>('pwd');
  const [pwdMode, setPwdMode] = useState<'login' | 'register'>('login');
  const [seg, setSeg] = useState<Segment>(segment ?? 'kaoyan');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [smsCode, setSmsCode] = useState('');
  const [magicEmail, setMagicEmail] = useState('');
  const [magicToken, setMagicToken] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [devHint, setDevHint] = useState<string | null>(null);

  // 魔法链接：若 URL 带 ?token= 自动进入账号→魔法页并回填
  useEffect(() => {
    if (!open) return;
    const t = new URLSearchParams(window.location.search).get('token');
    if (t) {
      setMagicToken(t);
      setTab('account');
      setAcctTab('magic');
    }
  }, [open]);

  // ---------- 卡密激活 ----------
  const handleActivate = async () => {
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await api.redeemLicense({ code, segment: seg });
      try {
        localStorage.setItem(LICENSE_TOKEN_STORAGE_KEY, res.license_token);
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
          ? await api.registerWithPassword({ email, password, segment: seg })
          : await api.loginWithPassword({ email, password });
      try {
        localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, res.auth_token);
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
      const res = await api.verifySmsLogin({ phone, code: smsCode, segment: seg });
      try {
        localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, res.auth_token);
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
      const res = await api.magicVerify({ token: magicToken, segment: seg });
      try {
        localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, res.auth_token);
      } catch {
        /* ignore */
      }
      window.location.reload();
    } catch (e) {
      setFormError(describeError(e));
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={blocking ? undefined : onClose}
      disableEscapeKeyDown={blocking}
      fullWidth
      maxWidth="sm"
      PaperProps={{ sx: { borderRadius: 20, overflow: 'hidden' } }}
    >
      {/* 标题栏 */}
      <Box
        sx={{
          px: 3,
          py: 2.2,
          display: 'flex',
          alignItems: 'center',
          background: blocking
            ? 'linear-gradient(135deg,#4f46e5,#7c3aed)'
            : 'linear-gradient(135deg,#0ea5e9,#4f46e5)',
          color: '#fff',
        }}
      >
        <Box sx={{ flexGrow: 1 }}>
          <Typography sx={{ fontWeight: 800, fontSize: 18 }}>
            {blocking ? '欢迎使用错题强化闭环' : '账号与设置'}
          </Typography>
          <Typography sx={{ fontSize: 12.5, opacity: 0.9, mt: 0.3 }}>
            {blocking ? '请先激活或登录，即可开始 AI 错题归因' : '管理你的身份与偏好'}
          </Typography>
        </Box>
        {!blocking && (
          <IconButton onClick={onClose} aria-label="关闭" sx={{ color: '#fff' }}>
            <CloseIcon />
          </IconButton>
        )}
      </Box>

      <Box sx={{ px: 3, py: 2.5, maxHeight: '70vh', overflowY: 'auto' }}>
        {blocking ? (
          <Stack spacing={2.5}>
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
                  value={seg}
                  onChange={(e) => setSeg(e.target.value as Segment)}
                  fullWidth
                >
                  {SEGMENTS.map((s) => (
                    <MenuItem key={s} value={s}>
                      {SEGMENT_LABELS[s]}
                    </MenuItem>
                  ))}
                </TextField>
                {formError && <Alert severity="error">{formError}</Alert>}
                <Button
                  variant="contained"
                  size="large"
                  disabled={submitting || !code}
                  onClick={() => void handleActivate()}
                >
                  {submitting ? '激活中…' : '激活并进入'}
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
                    <TextField
                      label="邮箱"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      fullWidth
                      autoComplete="email"
                    />
                    <TextField
                      label="密码（至少 8 位）"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      fullWidth
                      autoComplete="current-password"
                    />
                    {pwdMode === 'register' && (
                      <TextField
                        select
                        label="使用分段"
                        value={seg}
                        onChange={(e) => setSeg(e.target.value as Segment)}
                        fullWidth
                      >
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
                    <TextField
                      label="手机号"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      fullWidth
                      autoComplete="tel"
                    />
                    <Stack direction="row" spacing={1}>
                      <TextField
                        label="验证码"
                        value={smsCode}
                        onChange={(e) => setSmsCode(e.target.value)}
                        fullWidth
                      />
                      <Button variant="outlined" onClick={() => void handleSmsSend()} disabled={submitting || !phone}>
                        获取验证码
                      </Button>
                    </Stack>
                    <TextField
                      select
                      label="使用分段"
                      value={seg}
                      onChange={(e) => setSeg(e.target.value as Segment)}
                      fullWidth
                    >
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
                    <TextField
                      label="邮箱"
                      value={magicEmail}
                      onChange={(e) => setMagicEmail(e.target.value)}
                      fullWidth
                      autoComplete="email"
                    />
                    <Button
                      variant="outlined"
                      onClick={() => void handleMagicSend()}
                      disabled={submitting || !magicEmail}
                    >
                      发送登录链接
                    </Button>
                    <TextField
                      label="登录令牌 / 链接 token"
                      value={magicToken}
                      onChange={(e) => setMagicToken(e.target.value)}
                      fullWidth
                    />
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
                  <Button
                    variant="contained"
                    size="large"
                    disabled={submitting || !email || !password}
                    onClick={() => void handlePwd()}
                  >
                    {submitting ? '处理中…' : pwdMode === 'login' ? '登录' : '注册并登录'}
                  </Button>
                )}
                {acctTab === 'sms' && (
                  <Button
                    variant="contained"
                    size="large"
                    disabled={submitting || !phone || !smsCode}
                    onClick={() => void handleSmsVerify()}
                  >
                    {submitting ? '处理中…' : '登录 / 注册'}
                  </Button>
                )}
                {acctTab === 'magic' && (
                  <Button
                    variant="contained"
                    size="large"
                    disabled={submitting || !magicToken}
                    onClick={() => void handleMagicVerify()}
                  >
                    {submitting ? '处理中…' : '用令牌登录'}
                  </Button>
                )}
                {acctTab === 'wechat' && (
                  <Button
                    variant="contained"
                    size="large"
                    disabled={submitting}
                    onClick={() => void handleWechat()}
                  >
                    {submitting ? '处理中…' : '微信登录'}
                  </Button>
                )}
              </>
            )}

            <Alert severity="info" variant="outlined" sx={{ alignItems: 'center' }}>
              {HONEST_NOTE}
            </Alert>
          </Stack>
        ) : (
          // 已激活：设置视图
          <Stack spacing={2.5}>
            <Box
              sx={{
                p: 2,
                borderRadius: 3,
                background: 'linear-gradient(135deg, rgba(79,70,229,0.08), rgba(14,165,233,0.08))',
                border: '1px solid rgba(79,70,229,0.15)',
              }}
            >
              <Typography sx={{ fontWeight: 700, fontSize: 14, color: 'text.secondary' }}>
                当前身份
              </Typography>
              <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mt: 0.5 }}>
                <Chip
                  label={segment ? SEGMENT_LABELS[segment] : '未指定分段'}
                  color="primary"
                  variant="outlined"
                />
                <Typography sx={{ fontSize: 13, color: 'text.secondary' }}>
                  本地匿名标识，数据仅用于归因闭环
                </Typography>
              </Stack>
            </Box>

            <Divider />

            <Button
              variant="outlined"
              color="error"
              startIcon={<LogoutOutlinedIcon />}
              onClick={onLogout}
              sx={{ alignSelf: 'flex-start' }}
            >
              退出登录 / 切换身份
            </Button>

            <Alert severity="info" variant="outlined">
              {HONEST_NOTE}
            </Alert>

            <Typography variant="caption" color="text.disabled" align="center">
              错题强化闭环 · 内测版 v0.1
            </Typography>
          </Stack>
        )}
      </Box>
    </Dialog>
  );
}

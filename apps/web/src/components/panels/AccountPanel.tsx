/**
 * 账户权益面板：R-plan 当前档位 / 权益 / 续费。自包含。
 * 注意：无期限时不再误标「免费版」，旗舰版无期限显示「无期限」。
 */
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  LinearProgress,
  Paper,
  Typography,
} from '@mui/material';
import { api } from '../../api/client';
import { LICENSE_TIER_LABELS, type Entitlement, type LicensePlanResponse } from '@aicorrection/shared';

interface Props {
  anonUserId: string;
}

export default function AccountPanel({ anonUserId }: Props) {
  const [plan, setPlan] = useState<LicensePlanResponse | null>(null);
  const [renewing, setRenewing] = useState(false);
  const [renewMsg, setRenewMsg] = useState('');
  const [err, setErr] = useState('');

  const refresh = useCallback(async () => {
    try {
      const p = await api.getLicensePlan();
      setPlan(p);
    } catch (e) {
      setErr((e as Error).message || '加载权益失败');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const doRenew = async () => {
    setRenewing(true);
    setRenewMsg('');
    try {
      const r = await api.renewLicense({});
      setRenewMsg(r.message);
      const p = await api.getLicensePlan();
      setPlan(p);
    } catch (e) {
      setErr((e as Error).message || '续费失败');
    } finally {
      setRenewing(false);
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="h6" sx={{ mb: 1 }}>
        账户权益
      </Typography>
      {!plan && <LinearProgress sx={{ mb: 1 }} />}

      {plan && (
        <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'background.default' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1, flexWrap: 'wrap' }}>
            <Box>
              <Typography variant="subtitle2">
                我的权益：{LICENSE_TIER_LABELS[plan.tier] ?? plan.tier}
                {plan.is_expired && (
                  <Chip size="small" color="error" label="已过期" sx={{ ml: 1 }} />
                )}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {plan.expires_at
                  ? `有效期至 ${new Date(plan.expires_at).toLocaleDateString('zh-CN')}`
                  : '无期限'}
              </Typography>
            </Box>
            {plan.tier !== 'max' && (
              <Button size="small" variant="contained" onClick={doRenew} disabled={renewing || !plan.can_renew}>
                {renewing ? '续费中…' : '续费 / 升级'}
              </Button>
            )}
          </Box>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1 }}>
            {plan.entitlements.map((e: Entitlement) => (
              <Chip key={e} size="small" variant="outlined" label={e} />
            ))}
          </Box>
          {renewMsg && <Alert severity="success" sx={{ mt: 1 }}>{renewMsg}</Alert>}
        </Paper>
      )}

      {err && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {err}
        </Alert>
      )}
    </Paper>
  );
}

/**
 * 付费功能锁定引导：当账号缺少某权益时，在对应页面渲染此卡片，
 * 说明缺哪个权益并引导前往「账户权益」页升级。与后端 requireEntitlement 的 403 拦截对称——
 * 前端提前锁，后端兜底拦，双重保险。
 */
import { useNavigate } from 'react-router-dom';
import { Button, Paper, Stack, Typography } from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import { ENTITLEMENT_LABELS, type Entitlement } from '@aicorrection/shared';

export default function UpgradePrompt({
  entitlement,
  featureName,
}: {
  entitlement: Entitlement;
  featureName: string;
}) {
  const navigate = useNavigate();
  return (
    <Paper
      variant="outlined"
      sx={{
        p: { xs: 3, sm: 4 },
        textAlign: 'center',
        maxWidth: 460,
        mx: 'auto',
        mt: 4,
        borderRadius: '16px',
      }}
    >
      <Stack spacing={1.5} alignItems="center">
        <LockOutlinedIcon sx={{ fontSize: 48, color: 'text.disabled' }} />
        <Typography variant="h6" fontWeight={700}>
          「{featureName}」为付费专属功能
        </Typography>
        <Typography variant="body2" color="text.secondary">
          当前账号未解锁「{ENTITLEMENT_LABELS[entitlement]}」权益。升级专业版或旗舰版后，即可使用
          {featureName}等进阶能力。
        </Typography>
        <Button
          variant="contained"
          sx={{ mt: 1 }}
          onClick={() => navigate('/reinforce/account')}
        >
          查看权益 / 升级
        </Button>
      </Stack>
    </Paper>
  );
}

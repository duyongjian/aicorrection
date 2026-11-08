import { Box, Typography } from '@mui/material';
import { useLoopStore } from '../store/loopStore';
import AccountPanel from '../components/panels/AccountPanel';

export default function AccountPage() {
  const anonUserId = useLoopStore((s) => s.anonUserId);
  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 2 }}>账户权益</Typography>
      {anonUserId ? <AccountPanel anonUserId={anonUserId} /> : (
        <Typography color="text.secondary">正在读取身份，请稍候…</Typography>
      )}
    </Box>
  );
}

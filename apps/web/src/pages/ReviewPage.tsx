import { Box, Typography } from '@mui/material';
import { useLoopStore } from '../store/loopStore';
import ReviewPanel from '../components/panels/ReviewPanel';

export default function ReviewPage() {
  const anonUserId = useLoopStore((s) => s.anonUserId);
  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 2 }}>复习记忆</Typography>
      {anonUserId ? <ReviewPanel anonUserId={anonUserId} /> : (
        <Typography color="text.secondary">正在读取身份，请稍候…</Typography>
      )}
    </Box>
  );
}

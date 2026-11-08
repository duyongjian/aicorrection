import { Box, Typography } from '@mui/material';
import { useLoopStore } from '../store/loopStore';
import PracticePanel from '../components/panels/PracticePanel';

export default function PracticePage() {
  const anonUserId = useLoopStore((s) => s.anonUserId);
  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 2 }}>强化练习</Typography>
      {anonUserId ? <PracticePanel anonUserId={anonUserId} /> : (
        <Typography color="text.secondary">正在读取身份，请稍候…</Typography>
      )}
    </Box>
  );
}

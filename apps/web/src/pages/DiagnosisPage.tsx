import { Box, Typography } from '@mui/material';
import { useLoopStore } from '../store/loopStore';
import DiagnosisPanel from '../components/panels/DiagnosisPanel';

export default function DiagnosisPage() {
  const anonUserId = useLoopStore((s) => s.anonUserId);
  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 2 }}>诊断总览</Typography>
      {anonUserId ? <DiagnosisPanel anonUserId={anonUserId} /> : (
        <Typography color="text.secondary">正在读取身份，请稍候…</Typography>
      )}
    </Box>
  );
}

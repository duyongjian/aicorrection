import { Box, Typography } from '@mui/material';
import { useLoopStore } from '../store/loopStore';
import KnowledgePanel from '../components/panels/KnowledgePanel';

export default function KnowledgePage() {
  const anonUserId = useLoopStore((s) => s.anonUserId);
  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 2 }}>知识管理</Typography>
      {anonUserId ? <KnowledgePanel anonUserId={anonUserId} /> : (
        <Typography color="text.secondary">正在读取身份，请稍候…</Typography>
      )}
    </Box>
  );
}

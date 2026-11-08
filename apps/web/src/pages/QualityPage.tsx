import { Box, Typography } from '@mui/material';
import QualityGatePanel from '../components/QualityGatePanel';

/**
 * 质量优化看板（G1 闸门 / B·C·D 分层 / 代理校准）。原为归因页"认可后"长列表的一部分，
 * 现独立为侧边栏模块。
 */
export default function QualityPage() {
  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 2 }}>
        质量优化看板
      </Typography>
      <QualityGatePanel />
    </Box>
  );
}

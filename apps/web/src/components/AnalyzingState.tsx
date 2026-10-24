import { Box, CircularProgress, Typography } from '@mui/material';

/** "正在分析"降级态（归因超时 / 加载中） */
export default function AnalyzingState() {
  return (
    <Box sx={{ textAlign: 'center', py: 6 }}>
      <CircularProgress />
      <Typography sx={{ mt: 2 }} color="text.secondary">
        正在分析归因…（若长时间无结果，可返回重试）
      </Typography>
    </Box>
  );
}

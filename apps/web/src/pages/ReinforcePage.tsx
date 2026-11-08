import { Box, Typography } from '@mui/material';
import { useLoopStore } from '../store/loopStore';
import ReinforcePanel from '../components/ReinforcePanel';

/**
 * 强化中心（账户级总览）：错因分布 / 薄弱知识点 / 间隔复习 / 自定义知识点 /
 * 知识图谱 / 手动错因 / 我的权益。原为归因页"认可后"长列表的一部分，
 * 现独立为侧边栏模块，避免归因页堆砌。
 */
export default function ReinforcePage() {
  const anonUserId = useLoopStore((s) => s.anonUserId);

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 2 }}>
        强化中心
      </Typography>
      {anonUserId ? (
        <ReinforcePanel anonUserId={anonUserId} />
      ) : (
        <Typography color="text.secondary">
          正在读取身份，请稍候…
        </Typography>
      )}
    </Box>
  );
}

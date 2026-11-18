import { Box, Typography } from '@mui/material';
import { useLoopStore } from '../store/loopStore';
import KnowledgePanel from '../components/panels/KnowledgePanel';
import UpgradePrompt from '../components/UpgradePrompt';
import { useLicensePlan } from '../context/LicensePlanContext';

export default function KnowledgePage() {
  const anonUserId = useLoopStore((s) => s.anonUserId);
  const { has, loading } = useLicensePlan();
  // 该页同时调用 /custom-kp（custom_kp）与 /graph、/graph/mistakes（knowledge_graph），
  // 两个权益都要有，否则正常开通用户会在其中一个请求上收到 403。
  const locked = !loading && (!has('custom_kp') || !has('knowledge_graph'));

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 2 }}>知识管理</Typography>
      {locked ? (
        <UpgradePrompt entitlement="knowledge_graph" featureName="知识管理" />
      ) : anonUserId ? (
        <KnowledgePanel anonUserId={anonUserId} />
      ) : (
        <Typography color="text.secondary">正在读取身份，请稍候…</Typography>
      )}
    </Box>
  );
}

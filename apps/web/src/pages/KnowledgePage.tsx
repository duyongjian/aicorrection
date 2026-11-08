import { Box, Typography } from '@mui/material';
import { useLoopStore } from '../store/loopStore';
import KnowledgePanel from '../components/panels/KnowledgePanel';
import UpgradePrompt from '../components/UpgradePrompt';
import { useLicensePlan } from '../context/LicensePlanContext';

export default function KnowledgePage() {
  const anonUserId = useLoopStore((s) => s.anonUserId);
  const { has, loading } = useLicensePlan();
  const locked = !loading && !has('custom_kp');

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 2 }}>知识管理</Typography>
      {locked ? (
        <UpgradePrompt entitlement="custom_kp" featureName="知识管理" />
      ) : anonUserId ? (
        <KnowledgePanel anonUserId={anonUserId} />
      ) : (
        <Typography color="text.secondary">正在读取身份，请稍候…</Typography>
      )}
    </Box>
  );
}

import { Box, Typography } from '@mui/material';
import { useLoopStore } from '../store/loopStore';
import ReviewPanel from '../components/panels/ReviewPanel';
import UpgradePrompt from '../components/UpgradePrompt';
import { useLicensePlan } from '../context/LicensePlanContext';

export default function ReviewPage() {
  const anonUserId = useLoopStore((s) => s.anonUserId);
  const { has, loading } = useLicensePlan();
  const locked = !loading && !has('spaced_review');

  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 2 }}>复习记忆</Typography>
      {locked ? (
        <UpgradePrompt entitlement="spaced_review" featureName="复习记忆" />
      ) : anonUserId ? (
        <ReviewPanel anonUserId={anonUserId} />
      ) : (
        <Typography color="text.secondary">正在读取身份，请稍候…</Typography>
      )}
    </Box>
  );
}

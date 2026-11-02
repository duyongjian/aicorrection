import { Box, Typography } from '@mui/material';
import HistoryList from '../components/HistoryList';

/** FLW-02：归因历史总览页（顶部导航「历史」入口）。 */
export default function HistoryPage() {
  return (
    <Box>
      <Typography variant="h6" sx={{ mb: 2 }}>
        归因历史
      </Typography>
      <HistoryList />
    </Box>
  );
}

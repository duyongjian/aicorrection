import { AppBar, Toolbar, Typography, Container, Button, Box } from '@mui/material';
import { Link, Route, Routes } from 'react-router-dom';
import UploadPage from './pages/UploadPage';
import AttributionPage from './pages/AttributionPage';
import DashboardPage from './pages/DashboardPage';

export default function App() {
  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'grey.50' }}>
      <AppBar position="static" elevation={1}>
        <Toolbar>
          <Typography variant="h6" sx={{ flexGrow: 1, fontWeight: 700 }}>
            错题强化闭环 v0.1
          </Typography>
          <Button color="inherit" component={Link} to="/">
            上传
          </Button>
          <Button color="inherit" component={Link} to="/attr">
            归因
          </Button>
          <Button color="inherit" component={Link} to="/dashboard">
            看板
          </Button>
        </Toolbar>
      </AppBar>
      <Container maxWidth="sm" sx={{ mt: 3, pb: 6 }}>
        <Routes>
          <Route path="/" element={<UploadPage />} />
          <Route path="/attr" element={<AttributionPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
        </Routes>
      </Container>
    </Box>
  );
}

import { Route, Routes } from 'react-router-dom';
import UploadPage from './pages/UploadPage';
import AttributionPage from './pages/AttributionPage';
import DashboardPage from './pages/DashboardPage';
import HistoryPage from './pages/HistoryPage';

/**
 * 仅负责路由装配；整体布局（抽屉式侧边栏 + 顶栏 + 内容容器）
 * 由 LicenseGate → AppShell 统一提供，页面组件无需关心外框。
 */
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<UploadPage />} />
      <Route path="/attr" element={<AttributionPage />} />
      <Route path="/history" element={<HistoryPage />} />
      <Route path="/dashboard" element={<DashboardPage />} />
      <Route path="*" element={<UploadPage />} />
    </Routes>
  );
}

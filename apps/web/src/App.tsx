import { Route, Routes } from 'react-router-dom';
import UploadPage from './pages/UploadPage';
import AttributionPage from './pages/AttributionPage';
import DashboardPage from './pages/DashboardPage';
import HistoryPage from './pages/HistoryPage';
import LoopDetailPage from './pages/LoopDetailPage';
import ReinforcePage from './pages/ReinforcePage';
import QualityPage from './pages/QualityPage';
import DiagnosisPage from './pages/DiagnosisPage';
import PracticePage from './pages/PracticePage';
import ReviewPage from './pages/ReviewPage';
import KnowledgePage from './pages/KnowledgePage';
import AccountPage from './pages/AccountPage';

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
      <Route path="/history/:loopId" element={<LoopDetailPage />} />
      <Route path="/reinforce" element={<ReinforcePage />} />
      <Route path="/reinforce/diagnosis" element={<DiagnosisPage />} />
      <Route path="/reinforce/practice" element={<PracticePage />} />
      <Route path="/reinforce/review" element={<ReviewPage />} />
      <Route path="/reinforce/knowledge" element={<KnowledgePage />} />
      <Route path="/reinforce/account" element={<AccountPage />} />
      <Route path="/quality" element={<QualityPage />} />
      <Route path="/dashboard" element={<DashboardPage />} />
      <Route path="*" element={<UploadPage />} />
    </Routes>
  );
}

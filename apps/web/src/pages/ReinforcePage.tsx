import { Navigate } from 'react-router-dom';

/**
 * 强化中心已拆分为 5 个侧边栏子模块（诊断/练习/复习/知识/账户），
 * /reinforce 重定向到首个模块，保证旧书签不 404。
 */
export default function ReinforcePage() {
  return <Navigate to="/reinforce/diagnosis" replace />;
}

import { useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  AppBar,
  Avatar,
  Box,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Toolbar,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import MenuIcon from '@mui/icons-material/Menu';
import CloudUploadOutlinedIcon from '@mui/icons-material/CloudUploadOutlined';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import HistoryEduOutlinedIcon from '@mui/icons-material/HistoryEduOutlined';
import DashboardOutlinedIcon from '@mui/icons-material/DashboardOutlined';
import AccountCircleOutlinedIcon from '@mui/icons-material/AccountCircleOutlined';
import LoginOutlinedIcon from '@mui/icons-material/LoginOutlined';
import AssessmentOutlinedIcon from '@mui/icons-material/AssessmentOutlined';
import InsightsOutlinedIcon from '@mui/icons-material/InsightsOutlined';
import FitnessCenterOutlinedIcon from '@mui/icons-material/FitnessCenterOutlined';
import RepeatOutlinedIcon from '@mui/icons-material/RepeatOutlined';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import WorkspacePremiumOutlinedIcon from '@mui/icons-material/WorkspacePremiumOutlined';
import { BRAND_GRADIENT } from '../theme';
import { SEGMENT_LABELS, type Segment } from '@aicorrection/shared';

const DRAWER_WIDTH = 264;

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    title: '学习闭环',
    items: [
      { to: '/', label: '上传错题', icon: <CloudUploadOutlinedIcon /> },
      { to: '/attr', label: '归因分析', icon: <AutoAwesomeOutlinedIcon /> },
    ],
  },
  {
    title: '强化训练',
    items: [
      { to: '/reinforce/diagnosis', label: '诊断总览', icon: <InsightsOutlinedIcon /> },
      { to: '/reinforce/practice', label: '强化练习', icon: <FitnessCenterOutlinedIcon /> },
      { to: '/reinforce/review', label: '复习记忆', icon: <RepeatOutlinedIcon /> },
      { to: '/reinforce/knowledge', label: '知识管理', icon: <AccountTreeOutlinedIcon /> },
      { to: '/reinforce/account', label: '账户权益', icon: <WorkspacePremiumOutlinedIcon /> },
    ],
  },
  {
    title: '回顾与验收',
    items: [
      { to: '/history', label: '归因历史', icon: <HistoryEduOutlinedIcon /> },
      { to: '/dashboard', label: '验收看板', icon: <DashboardOutlinedIcon /> },
      { to: '/quality', label: '质量看板', icon: <AssessmentOutlinedIcon /> },
    ],
  },
];

function titleForPath(pathname: string): string {
  for (const g of NAV_GROUPS) {
    for (const it of g.items) {
      if (it.to === '/') {
        if (pathname === '/') return it.label;
      } else if (pathname.startsWith(it.to)) {
        return it.label;
      }
    }
  }
  return '错题强化闭环';
}

interface AppShellProps {
  children: ReactNode;
  /** 点击左下角账号区时触发（由 LicenseGate 注入）。 */
  onOpenAccount: () => void;
  /** 当前身份（已激活时存在）。 */
  identity?: { segment: Segment } | null;
}

export default function AppShell({ children, onOpenAccount, identity }: AppShellProps) {
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'));
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const pageTitle = titleForPath(location.pathname);

  const drawerContent = (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* 品牌头部 */}
      <Box
        sx={{
          px: 2.5,
          py: 2.6,
          background: BRAND_GRADIENT,
          color: '#fff',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.4 }}>
          <Avatar
            sx={{
              width: 38,
              height: 38,
              bgcolor: 'rgba(255,255,255,0.18)',
              color: '#fff',
              fontWeight: 800,
              fontSize: 18,
            }}
          >
            错
          </Avatar>
          <Box>
            <Typography sx={{ fontWeight: 800, fontSize: 17, lineHeight: 1.2 }}>
              错题强化闭环
            </Typography>
            <Typography sx={{ fontSize: 11.5, opacity: 0.85, letterSpacing: 0.3 }}>
              AI 归因 · 智能复盘
            </Typography>
          </Box>
        </Box>
      </Box>

      {/* 逻辑分组导航 */}
      <Box sx={{ flexGrow: 1, overflowY: 'auto', py: 1.5 }}>
        {NAV_GROUPS.map((group) => (
          <Box key={group.title} sx={{ mb: 1 }}>
            <Typography
              sx={{
                px: 2.6,
                pt: 1.5,
                pb: 0.5,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: 1,
                color: 'text.disabled',
                textTransform: 'uppercase',
              }}
            >
              {group.title}
            </Typography>
            <List disablePadding>
              {group.items.map((item) => (
                <ListItemButton
                  key={item.to}
                  component={NavLink}
                  to={item.to}
                  onClick={() => setMobileOpen(false)}
                  sx={{ mx: 1, my: 0.3 }}
                >
                  <ListItemIcon sx={{ minWidth: 38 }}>{item.icon}</ListItemIcon>
                  <ListItemText
                    primary={item.label}
                    primaryTypographyProps={{ fontWeight: 600, fontSize: 14.5 }}
                  />
                </ListItemButton>
              ))}
            </List>
          </Box>
        ))}
      </Box>

      <Divider />

      {/* 左下角账号区 */}
      <Box sx={{ p: 1.5 }}>
        <ListItemButton
          onClick={onOpenAccount}
          sx={{
            borderRadius: '14px',
            py: 1.2,
            px: 1.4,
            '&:hover': { backgroundColor: 'rgba(79,70,229,0.08)' },
          }}
        >
          <Avatar
            sx={{
              width: 36,
              height: 36,
              bgcolor: identity ? 'primary.main' : 'rgba(79,70,229,0.12)',
              color: identity ? '#fff' : 'primary.main',
            }}
          >
            {identity ? <AccountCircleOutlinedIcon /> : <LoginOutlinedIcon />}
          </Avatar>
          <Box sx={{ ml: 1.2, minWidth: 0 }}>
            {identity ? (
              <>
                <Typography sx={{ fontWeight: 700, fontSize: 13.5, lineHeight: 1.2 }}>
                  已激活账号
                </Typography>
                <Typography sx={{ fontSize: 12, color: 'text.secondary', lineHeight: 1.3 }}>
                  {SEGMENT_LABELS[identity.segment]} · 点此设置
                </Typography>
              </>
            ) : (
              <>
                <Typography sx={{ fontWeight: 700, fontSize: 13.5, lineHeight: 1.2 }}>
                  登录 / 注册
                </Typography>
                <Typography sx={{ fontSize: 12, color: 'text.secondary', lineHeight: 1.3 }}>
                  点此激活以开始使用
                </Typography>
              </>
            )}
          </Box>
        </ListItemButton>
      </Box>
    </Box>
  );

  return (
    <Box sx={{ display: 'flex', minHeight: '100vh', bgcolor: 'background.default' }}>
      {/* 移动端临时抽屉 + 桌面常驻抽屉 */}
      {isDesktop ? (
        <Drawer
          variant="permanent"
          sx={{
            width: DRAWER_WIDTH,
            flexShrink: 0,
            '& .MuiDrawer-paper': {
              width: DRAWER_WIDTH,
              borderRight: '1px solid',
              borderColor: 'divider',
              boxSizing: 'border-box',
            },
          }}
        >
          {drawerContent}
        </Drawer>
      ) : (
        <Drawer
          variant="temporary"
          open={mobileOpen}
          onClose={() => setMobileOpen(false)}
          ModalProps={{ keepMounted: true }}
          sx={{
            '& .MuiDrawer-paper': {
              width: DRAWER_WIDTH,
              boxSizing: 'border-box',
              boxShadow: '0 12px 40px rgba(31,36,48,0.18)',
            },
          }}
        >
          {drawerContent}
        </Drawer>
      )}

      {/* 主区域 */}
      <Box sx={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <AppBar
          position="sticky"
          elevation={0}
          sx={{
            bgcolor: 'background.paper',
            borderBottom: '1px solid',
            borderColor: 'divider',
            color: 'text.primary',
          }}
        >
          <Toolbar variant="dense" sx={{ gap: 1 }}>
            {!isDesktop && (
              <IconButton edge="start" onClick={() => setMobileOpen(true)} aria-label="打开菜单">
                <MenuIcon />
              </IconButton>
            )}
            <Typography variant="h6" sx={{ fontWeight: 700, flexGrow: 1 }}>
              {pageTitle}
            </Typography>
            {!isDesktop && (
              <IconButton edge="end" onClick={onOpenAccount} aria-label="账号">
                <AccountCircleOutlinedIcon />
              </IconButton>
            )}
          </Toolbar>
        </AppBar>

        <Box
          component="main"
          sx={{
            flexGrow: 1,
            width: '100%',
            mx: 'auto',
            maxWidth: 920,
            px: { xs: 2, sm: 3 },
            py: { xs: 2.5, sm: 3.5 },
          }}
        >
          {children}
        </Box>
      </Box>
    </Box>
  );
}

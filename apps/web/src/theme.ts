import { createTheme } from '@mui/material/styles';

/**
 * 友好型主题：靛蓝主色 + 青色强调，大圆角、柔和阴影、中文友好字体。
 * 统一在 main.tsx 注入，AppShell / AccountPanel 等组件直接复用。
 */
export const theme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: '#4f46e5',
      light: '#7c75f0',
      dark: '#3730a3',
      contrastText: '#ffffff',
    },
    secondary: {
      main: '#0ea5e9',
      light: '#67c8f3',
      dark: '#0369a1',
      contrastText: '#ffffff',
    },
    success: { main: '#16a34a', light: '#4ade80', dark: '#15803d' },
    warning: { main: '#f59e0b' },
    error: { main: '#ef4444' },
    background: {
      default: '#f4f5fb',
      paper: '#ffffff',
    },
    text: {
      primary: '#1f2430',
      secondary: '#5b6472',
    },
    divider: 'rgba(31,36,48,0.08)',
  },
  shape: { borderRadius: 14 },
  typography: {
    fontFamily:
      '"PingFang SC","Microsoft YaHei","Hiragino Sans GB",system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif',
    h5: { fontWeight: 800, letterSpacing: -0.2 },
    h6: { fontWeight: 700 },
    subtitle1: { fontWeight: 600 },
    subtitle2: { fontWeight: 600 },
    button: { fontWeight: 600 },
  },
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: { textTransform: 'none', fontWeight: 600, borderRadius: '10px', paddingInline: 18 },
        containedPrimary: { boxShadow: '0 6px 16px rgba(79,70,229,0.28)' },
      },
    },
    MuiCard: { styleOverrides: { root: { borderRadius: '18px', border: '1px solid rgba(31,36,48,0.06)' } } },
    MuiPaper: {
      styleOverrides: {
        rounded: { borderRadius: '18px' },
        outlined: { borderColor: 'rgba(31,36,48,0.08)' },
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          borderRadius: '12px',
          marginInline: 8,
          '&.Mui-selected': {
            backgroundColor: 'rgba(79,70,229,0.10)',
            color: '#3730a3',
            '& .MuiListItemIcon-root': { color: '#4f46e5' },
            '&:hover': { backgroundColor: 'rgba(79,70,229,0.16)' },
          },
        },
      },
    },
    MuiChip: { styleOverrides: { root: { fontWeight: 600 } } },
    MuiTextField: { defaultProps: { variant: 'outlined', size: 'small' } },
  },
});

/** 品牌渐变（侧边栏头部 / 关键 CTA 使用），作为 CSS 背景字符串复用。 */
export const BRAND_GRADIENT = 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 55%, #0ea5e9 100%)';

import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { CssBaseline, ThemeProvider } from '@mui/material';
import App from './App';
import { theme } from './theme';
import LicenseGate from './components/LicenseGate';
import { trackingContext } from './tracking/context';

// 从 URL 参数读取渠道 / UTM 信息
trackingContext.readUrlParams();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <BrowserRouter>
        <LicenseGate>
          <App />
        </LicenseGate>
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>
);

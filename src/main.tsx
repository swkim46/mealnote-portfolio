import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { ToastProvider } from './components/Toast';
import { DevBanner } from './components/DevBanner';
import './styles.css';
import { applyTextSize, getTextSize } from './lib/textSize';
import { startTheme } from './lib/theme';
import { BUILD_ID, startUpdateChecks } from './lib/appUpdate';
import { UpdateBanner } from './components/UpdateBanner';

// 첫 화면부터 저장된 글씨 크기로 그린다(깜빡임 방지)
applyTextSize(getTextSize());
// 화면 테마: index.html이 이미 적용했다. 여기서는 브라우저 상단 색을 맞추고 다른 탭의 변경을 따라간다
startTheme();
document.documentElement.dataset.build = BUILD_ID;
startUpdateChecks();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <DevBanner />
      <App />
      <UpdateBanner />
    </ToastProvider>
  </StrictMode>,
);

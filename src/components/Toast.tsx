import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

const ToastContext = createContext<(message: string) => void>(() => {});

/**
 * 짧은 안내. 브라우저 맨 위층(top layer, Popover API)에 띄운다 — 기록 창 같은 모달 창(dialog)도 맨 위층이라, 일반 화면 위에 두면
 * 창이 열린 동안의 안내(사진을 열지 못함·저장 실패 등)가 창 뒤에 가려 보이지 않았다(2026-11-03, 안드로이드 사진 제보를 살피다 확인).
 * 맨 위층은 나중에 띄운 것이 위라 안내마다 다시 띄운다. Popover API가 없는 브라우저는 예전처럼 일반 화면 위에 둔다
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState('');
  const [visible, setVisible] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const el = useRef<HTMLDivElement>(null);
  const show = useCallback((text: string) => {
    const t = el.current;
    if (t && typeof t.showPopover === 'function') {
      try {
        if (t.matches(':popover-open')) t.hidePopover();
        t.showPopover();
      } catch {
        /* 맨 위층에 못 띄우면 일반 화면 위에 그대로 */
      }
    }
    setMessage(text);
    setVisible(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setVisible(false), 3400);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div ref={el} popover="manual" className={`toast ${visible ? 'visible' : ''}`} role="status" aria-live="polite">
        {message}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

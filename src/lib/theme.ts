// 화면 테마(라이트 = 오렌지·블랙, 다크 = 라임·차콜). 기기(브라우저·설치 앱 저장소)마다 기억한다. 계정과는 무관.
// <html data-theme="light|dark">로 CSS 변수를 바꾼다. 첫 화면은 index.html의 짧은 스크립트가 먼저 적용한다(깜빡임 방지).
// 상단 버튼과 내 정보 설정이 같은 값을 보도록 작은 공용 저장소로 둔다. 다른 탭에서 바꾸면 storage 이벤트로 맞춘다.
import { useCallback, useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';
export const THEME_KEY = 'mealnote:theme';
/** 브라우저 상단·상태 표시줄 색(테마 바탕색) */
const BAR_COLOR: Record<Theme, string> = { light: '#F5F5F5', dark: '#171B19' };
const listeners = new Set<() => void>();

/** 저장값 해석: 'dark'만 다크, 없거나 알 수 없는 값은 라이트 */
export const parseTheme = (v: string | null | undefined): Theme => (v === 'dark' ? 'dark' : 'light');

export function readTheme(): Theme {
  try {
    return parseTheme(localStorage.getItem(THEME_KEY));
  } catch {
    return parseTheme(document.documentElement.dataset.theme);
  }
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  root.style.background = BAR_COLOR[theme]; // index.html이 첫 화면에 넣은 바탕색도 함께 바꾼다(위아래로 당겨 보이는 여백)
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', BAR_COLOR[theme]));
}

function notify() {
  listeners.forEach((l) => l());
}

/** 바꾸면 화면에 바로 적용하고 저장한다. 저장이 안 돼도(사생활 보호 모드 등) 이번 실행에서는 바뀐 테마를 유지한다. */
export function setTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* 저장 못 해도 이번 화면에는 적용 */
  }
  applyTheme(theme);
  notify();
}

/** 앱 시작 때 한 번: 저장된 테마 적용 + 다른 탭의 변경 따라가기(화면만 다시 칠하고 입력은 건드리지 않는다) */
export function startTheme() {
  applyTheme(readTheme());
  window.addEventListener('storage', (e) => {
    if (e.key !== THEME_KEY) return;
    applyTheme(parseTheme(e.newValue));
    notify();
  });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = (): Theme => parseTheme(document.documentElement.dataset.theme);

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, snapshot);
  const change = useCallback((next: Theme) => setTheme(next), []);
  return { theme, change };
}

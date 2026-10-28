// 글씨 크기 설정(보통 / 크게). 기기마다 기억하고, <html data-text="large">로 CSS 배율을 바꾼다.
// 머리글 버튼과 내 정보 화면이 같은 값을 보도록 작은 공용 저장소로 둔다.
import { useCallback, useSyncExternalStore } from 'react';

export type TextSize = 'normal' | 'large';
const KEY = 'mealnote:text-size';
const listeners = new Set<() => void>();

export function getTextSize(): TextSize {
  try {
    return localStorage.getItem(KEY) === 'large' ? 'large' : 'normal';
  } catch {
    return document.documentElement.dataset.text === 'large' ? 'large' : 'normal';
  }
}

export function applyTextSize(size: TextSize) {
  if (size === 'large') document.documentElement.dataset.text = 'large';
  else delete document.documentElement.dataset.text;
}

function setTextSize(size: TextSize) {
  try {
    localStorage.setItem(KEY, size);
  } catch {
    /* 저장 못 해도 이번 화면에는 적용 */
  }
  applyTextSize(size);
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = (): TextSize => (document.documentElement.dataset.text === 'large' ? 'large' : 'normal');

export function useTextSize() {
  const size = useSyncExternalStore(subscribe, snapshot);
  const change = useCallback((next: TextSize) => setTextSize(next), []);
  return { size, change };
}

import { useTheme } from '../lib/theme';
import { Icon } from './Icon';

/**
 * 상단(로그인 전후 공통): 제목과 같은 줄에 들어가도록 달 아이콘 버튼 하나(2026-10-26 사용자 요청: 글자 빼고 한 줄로).
 * 누르면 다크, 다시 누르면 라이트. 상태는 눌림 표시(aria-pressed)와 이름으로 전한다. 글자 설명이 있는 선택은 내 정보에.
 */
export function ThemeToggle() {
  const { theme, change } = useTheme();
  const dark = theme === 'dark';
  return (
    <button
      type="button"
      className="theme-toggle"
      aria-pressed={dark}
      aria-label="다크 화면"
      title={dark ? '라이트 화면으로 바꾸기' : '다크 화면으로 바꾸기'}
      onClick={() => change(dark ? 'light' : 'dark')}
    >
      <Icon name="moon" />
    </button>
  );
}

/** 내 정보 화면: 같은 값을 쓰는 화면 테마 설정 */
export function ThemeSetting() {
  const { theme, change } = useTheme();
  return (
    <div className="theme-row">
      <span>화면 테마</span>
      <div className="role-switch" role="group" aria-label="화면 테마">
        <button type="button" aria-pressed={theme === 'light'} onClick={() => change('light')}>
          라이트 · 오렌지
        </button>
        <button type="button" aria-pressed={theme === 'dark'} onClick={() => change('dark')}>
          다크 · 라임
        </button>
      </div>
    </div>
  );
}

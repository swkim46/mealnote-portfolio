import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { TextSizeToggle } from './TextSizeControls';
import { ThemeToggle } from './ThemeControls';

export interface Tab {
  id: string;
  icon: string;
  label: string;
  dot?: boolean;
  count?: number;
}

interface Props {
  title: string;
  sub: string;
  tabs: Tab[];
  active: string;
  onTab: (id: string) => void;
  mainRef?: React.Ref<HTMLElement>;
  /** 알림 모아보기 종 버튼(새 소식이 있으면 점) */
  bell?: { dot: boolean; onClick: () => void };
  children: ReactNode;
}

/** 로그인 뒤 공통 틀: 머리글 · 본문 · 아래 탭 */
export function Shell({ title, sub, tabs, active, onTab, mainRef, bell, children }: Props) {
  return (
    <div className="workspace">
      <section className="prototype" aria-label="식단노트">
        <header className="app-header">
          <div>
            <h2>{title}</h2>
            <p>{sub}</p>
          </div>
          <div className="header-controls">
            {bell && (
              <button type="button" className="bell-toggle" aria-label={bell.dot ? '알림 목록, 새 소식 있음' : '알림 목록'} title="알림 목록" onClick={bell.onClick}>
                <Icon name="bell" />
                {bell.dot && <span className="bell-dot" />}
              </button>
            )}
            <ThemeToggle />
            <TextSizeToggle />
          </div>
        </header>
        <main className="app-main" ref={mainRef}>
          {children}
        </main>
        <nav className="bottom-nav" aria-label="앱 메뉴">
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`nav-item ${active === t.id ? 'active' : ''}`}
              aria-current={active === t.id ? 'page' : undefined}
              onClick={() => onTab(t.id)}
            >
              <Icon name={t.icon} />
              <span>
                {t.label}
                {t.count ? ` ${t.count}` : ''}
              </span>
              {t.dot && <span className="nav-dot" aria-label="새 소식 있음" />}
            </button>
          ))}
        </nav>
      </section>
    </div>
  );
}

import { useEdgeSwipeBack } from '../lib/backNav';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { ActionSlot } from '../ui/kit';
import { APP_NAME } from '../lib/brand';

export interface Tab {
  id: string;
  icon: string;
  label: string;
  dot?: boolean;
  count?: number;
}

interface Props {
  title: string;
  tabs: Tab[];
  active: string;
  onTab: (id: string) => void;
  mainRef?: React.Ref<HTMLElement>;
  /** 왼쪽 끝을 미는 동안 지금 화면 아래에 보이는 이전 화면 */
  under?: React.ReactNode;
  /** 알림 모아보기 종 버튼(새 소식이 있으면 점) */
  bell?: { dot: boolean; onClick: () => void };
  /** 사용 안내(2.0 시작 안내 다시 보기) 버튼 — 종 버튼 옆(2026-11-01 사용자 결정: 설정 안이 아니라 맨 위에) */
  onHelp?: () => void;
  children: ReactNode;
}

/** 왼쪽 끝을 미는 동안 지금 화면 아래에 깔리는 이전 화면. anchor가 있으면 돌아갔을 때 보일 그 칸의 위치로 맞춰 둔다 */
export function SwipeUnder({ title, anchor, children }: { title: string; anchor?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const main = ref.current;
    const card = anchor ? main?.querySelector(anchor) : null;
    if (main && card) main.scrollTop = card.getBoundingClientRect().top - main.getBoundingClientRect().top;
  }, [anchor]);
  return (
    <>
      <header className="app-header">
        <h2>{title}</h2>
      </header>
      <div className="app-main" ref={ref}>
        {children}
      </div>
    </>
  );
}

/** 로그인 뒤 공통 틀: 머리글(제목 한 줄 + 사용 안내·종 버튼, 2.0 원칙 1) · 본문 · 아래 탭. 테마·글씨는 설정 탭에(로그인 화면에는 그대로) */
export function Shell({ title, tabs, active, onTab, mainRef, bell, onHelp, under, children }: Props) {
  useEdgeSwipeBack();
  // 주요 버튼(PrimaryAction)은 본문 스크롤 영역 밖, 아래 탭 바로 위 칸에 그린다(ui/kit ActionSlot)
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <div className="workspace">
      <section className="prototype" aria-label={APP_NAME}>
        {under && (
          <div className="swipe-under" aria-hidden="true" inert>
            {under}
          </div>
        )}
        <header className="app-header">
          <h2>{title}</h2>
          <div className="header-controls">
            {onHelp && (
              <button type="button" className="help-toggle" aria-label="사용 안내" title="사용 안내" data-testid="help-button" onClick={onHelp}>
                <Icon name="help" />
              </button>
            )}
            {bell && (
              <button type="button" className="bell-toggle" aria-label={bell.dot ? '알림 목록, 새 소식 있음' : '알림 목록'} title="알림 목록" onClick={bell.onClick}>
                <Icon name="bell" />
                {bell.dot && <span className="bell-dot" />}
              </button>
            )}
          </div>
        </header>
        <ActionSlot.Provider value={slot}>
          <main className="app-main" ref={mainRef}>
            {children}
          </main>
        </ActionSlot.Provider>
        <div className="action-bar" ref={setSlot} />
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

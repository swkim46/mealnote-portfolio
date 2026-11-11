// 2.0 공통 화면 부품. 모든 탭이 같은 문법을 쓰게 한다(계획서 '2.0 화면 원칙').
//  - 화면 안의 나눔은 Segmented 하나까지 · 주요 행동은 PrimaryAction 하나(아래 고정)
//  - 불러오는 중·빈 상태·실패는 StatePanel 하나로 같은 모양(실패 때 다시 시도)
//  - 설정은 SettingsGroup·SettingsRow 목록
import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../components/Icon';

/**
 * 주요 버튼 자리(Shell이 본문 스크롤 영역과 아래 탭 사이에 두는 칸). undefined = 자리 없음(그 자리에 그대로 그림),
 * null = 자리가 아직 붙지 않음(그리지 않음). 2026-11-03 사용자 제보: 본문 안에 붙인 버튼이 목록이 짧으면 글 아래에 떠 있고,
 * 스크롤 중에는 버튼 둘레의 바탕색 띠가 카드를 덮어 회색 덩어리처럼 보였다 — 버튼을 스크롤 영역 밖 고정 칸으로 옮겼다
 */
export const ActionSlot = createContext<HTMLElement | null | undefined>(undefined);

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(([id, text]) => (
        <button key={id} type="button" aria-pressed={value === id} onClick={() => onChange(id)}>
          {text}
        </button>
      ))}
    </div>
  );
}

export function Section({ title, count, action, children }: { title: string; count?: number | string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="ui-section">
      <div className="section-title">
        <h3>
          {title} {count !== undefined && <span className="count">{count}</span>}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** 화면의 주요 행동 하나. 목록을 가리지 않게 화면 아래쪽에 붙는다 */
export function PrimaryAction({ children, onClick, disabled, testId }: { children: ReactNode; onClick: () => void; disabled?: boolean; testId?: string }) {
  const slot = useContext(ActionSlot);
  const button = (
    <div className="primary-action">
      <button type="button" className="primary full" onClick={onClick} disabled={disabled} data-testid={testId}>
        {children}
      </button>
    </div>
  );
  if (slot === undefined) return button;
  return slot ? createPortal(button, slot) : null;
}

type PanelState = { kind: 'loading' } | { kind: 'empty'; title: string; description?: string; action?: ReactNode } | { kind: 'failed'; title: string; onRetry: () => void };

export function StatePanel(s: PanelState) {
  if (s.kind === 'loading')
    return (
      <div className="state-panel loading" role="status" aria-label="불러오는 중">
        <span className="spinner" />
      </div>
    );
  if (s.kind === 'failed')
    return (
      <div className="state-panel" role="status">
        <strong>{s.title}</strong>
        <p>연결을 확인한 뒤 다시 시도해 주세요.</p>
        <button type="button" className="secondary small" onClick={s.onRetry}>
          다시 불러오기
        </button>
      </div>
    );
  return (
    <div className="state-panel">
      <strong>{s.title}</strong>
      {s.description && <p>{s.description}</p>}
      {s.action}
    </div>
  );
}

/** 마지막 정상 값 위에 붙이는 '새로 받지 못함' 한 줄 */
export function StaleNotice({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <p className="stale-notice" role="status">
      {text}{' '}
      <button type="button" className="text-button" onClick={onRetry}>
        다시 불러오기
      </button>
    </p>
  );
}

export function SettingsGroup({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-group" aria-label={title}>
      <h3>{title}</h3>
      <div className="settings-card">{children}</div>
      {note && <p className="hint settings-note">{note}</p>}
    </section>
  );
}

/** 설정 한 줄: onClick이 있으면 눌러서 여는 줄, 없으면 오른쪽에 control(스위치·선택)을 둔다 */
export function SettingsRow({ icon, label, value, onClick, control, attention }: { icon?: string; label: string; value?: ReactNode; onClick?: () => void; control?: ReactNode; attention?: boolean }) {
  const inner = (
    <>
      {icon && <Icon name={icon} />}
      <span className="settings-label">
        {label}
        {attention && <span className="new-badge">필요</span>}
      </span>
      {value !== undefined && <span className="settings-value">{value}</span>}
      {control}
      {onClick && <Icon name="right" />}
    </>
  );
  return onClick ? (
    <button type="button" className="settings-row" onClick={onClick}>
      {inner}
    </button>
  ) : (
    <div className="settings-row">{inner}</div>
  );
}

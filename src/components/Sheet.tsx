import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { BACK_LEVEL, BackOwner, closeTopLayer, innerOnTop, useBackLayer } from '../lib/backNav';

type Draft = { dirty: boolean; busy: boolean };
const SheetDraft = createContext<((id: string, draft: Draft | null) => void) | null>(null);

/**
 * 창 안의 폼이 저장하지 않은 변경(dirty)과 저장 중(busy)을 창에 알린다. 칸을 쓰지 않는 변경 — 세트 완료, 끼니 버튼, 사진, 표로 읽기 —
 * 은 폼만 안다(적대 검토 11-05). 창 밖에서 그려지면 아무 일도 하지 않는다
 */
export function useSheetDraft(dirty: boolean, busy = false) {
  const report = useContext(SheetDraft);
  const id = useId();
  useEffect(() => {
    report?.(id, { dirty, busy });
    return () => report?.(id, null);
  }, [report, id, dirty, busy]);
}

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
const NOT_TEXT = ['checkbox', 'radio', 'range', 'hidden', 'file', 'button', 'submit'];
/** 쓰던 내용으로 볼 칸: 켜고 끄는 칸과 읽기 전용 칸(시트에 붙여 넣을 값 등)은 뺀다 */
const isField = (el: HTMLElement): el is Field =>
  (el instanceof HTMLTextAreaElement && !el.readOnly) || el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && !el.readOnly && !NOT_TEXT.includes(el.type));

/** 와이어프레임의 <dialog> 시트. open이 바뀌면 열고 닫는다. */
export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  // 앱 화면과 보안 알림의 창이 한 문서에 있어, 고정 ID면 뒤의 창 제목이 앞 창의 빈 제목을 가리킨다(Codex v2.3.1 2차 리뷰 3번)
  const titleId = useId();
  const [owner] = useState(() => ({}));
  // 뒤로 가기·밀기는 손이 잘못 닿아도 일어난다. 쓰던 내용이 있으면 물어본다(✕·바깥 누르기는 뜻이 분명해 그대로 닫는다).
  // 쓰던 내용 = 폼이 알린 변경, 또는 신호가 없는 폼(댓글 등)에서 칸에 처음 들어갔을 때의 값과 달라진 칸
  const drafts = useRef(new Map<string, Draft>());
  const report = useCallback((id: string, draft: Draft | null) => {
    if (draft) drafts.current.set(id, draft);
    else drafts.current.delete(id);
  }, []);
  const started = useRef(new Map<Field, string>());
  // 브라우저가 닫기를 막지 못하게 한 경우(Esc를 거듭 누름 등)에는 닫힌 뒤 다시 연다. 창 내용은 그대로다
  const reopen = useRef(false);
  // 그리기 전에 열고 닫는다. 앞 창의 닫힘 소식은 다음 화면 틀에 오므로, 그때는 이 창이 이미 열려 있어야 늦은 소식으로 가려낼 수 있다
  useLayoutEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      started.current.clear();
      d.showModal();
      d.scrollTop = 0;
    } else if (!open && d.open) d.close();
  }, [open]);
  const hasDraft = () =>
    [...drafts.current.values()].some((d) => d.dirty) ||
    [...started.current].some(([el, start]) => el.isConnected && !el.closest('[data-saved]') && el.value !== start);
  // 저장 중이면 닫지 않는다: 곧 끝나고, '사라져요'는 사실이 아니다
  const saving = () => [...drafts.current.values()].some((d) => d.busy) || !!ref.current?.querySelector('fieldset[disabled]');
  const mayLeave = () => !saving() && (!hasDraft() || window.confirm('쓰던 내용이 사라져요. 창을 닫을까요?'));
  useBackLayer(
    open,
    () => {
      if (!mayLeave()) return false;
      onClose();
    },
    { level: BACK_LEVEL.sheet, own: owner, surface: () => [ref.current] },
  );
  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby={titleId}
      onClose={() => {
        const again = reopen.current;
        reopen.current = false;
        // 코드로 닫은 뒤 늦게 온 소식이다. 그대로 받으면 그사이 연 다음 창이 닫혀, 설정 권유가 하루 표시만 남기고 사라졌다
        if (!open || ref.current?.open) return;
        if (again) ref.current?.showModal();
        else onClose();
      }}
      onFocus={(e) => {
        const el = e.target as HTMLElement;
        if (isField(el) && !started.current.has(el)) started.current.set(el, el.value);
      }}
      onCancel={(e) => {
        // 사진 고르기를 취소한 파일 칸의 cancel도 여기까지 올라온다 — 창을 닫으라는 뜻이 아니다
        if (e.target !== e.currentTarget) return;
        // 안드로이드 뒤로·Esc는 기록보다 창이 먼저 받는다. 창 안의 안내가 열려 있으면 안내만 닫는다
        const inner = innerOnTop();
        if (!inner && mayLeave()) return;
        if (inner) closeTopLayer();
        e.preventDefault();
        reopen.current = !e.cancelable;
      }}
      onClick={(e) => {
        if (e.target !== ref.current) return;
        const r = ref.current.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose();
      }}
    >
      <div className="sheet-top">
        <h2 id={titleId}>{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="창 닫기">
          ✕
        </button>
      </div>
      <SheetDraft.Provider value={report}>
        <BackOwner.Provider value={owner}>
          <div className="sheet-body">{open ? children : null}</div>
        </BackOwner.Provider>
      </SheetDraft.Provider>
    </dialog>
  );
}

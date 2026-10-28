import { useEffect, useRef, type ReactNode } from 'react';

/** 와이어프레임의 <dialog> 시트. open이 바뀌면 열고 닫는다. */
export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      d.scrollTop = 0;
    } else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby="sheet-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target !== ref.current) return;
        const r = ref.current.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose();
      }}
    >
      <div className="sheet-top">
        <h2 id="sheet-title">{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="창 닫기">
          ✕
        </button>
      </div>
      <div className="sheet-body">{open ? children : null}</div>
    </dialog>
  );
}

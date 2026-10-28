import { useEffect, useState } from 'react';
import { applyUpdate, onUpdateReady } from '../lib/appUpdate';

/** 입력 중이라 바로 바꾸지 못한 새 버전이 있을 때만 화면 아래에 뜬다 */
export function UpdateBanner() {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const off = onUpdateReady(setReady);
    return () => {
      off();
    };
  }, []);
  if (!ready) return null;
  return (
    <div className="update-banner" role="status">
      <span>새 버전이 준비됐어요</span>
      <button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void applyUpdate();
        }}
      >
        {busy ? '바꾸는 중…' : '지금 적용'}
      </button>
    </div>
  );
}

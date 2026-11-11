// 쉬는 시간 타이머(v2.1, 2026-11-02 사용자 피드백 "쉬는 시간 표시 추가" — 표시와 타이머 둘 다).
// 운동 기록 화면에서 세트 완료를 누르면 그 운동의 쉬는 시간이 줄어든다. 남은 시간은 '끝나는 시각'으로 계산해,
// 화면을 껐다 켜거나 다른 앱에 다녀와도 맞게 보인다. 그동안 알림은 오지 않는다(웹앱 한계). 진동은 되는 기기에서만(아이폰은 안 됨).
// 끝나면 소리를 세 번 울리고 저절로 꺼진다(2.3). 끝난 뒤 한참 지나 돌아왔으면 울리지 않는다.
import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { playRestBeep } from '../lib/restBeep';

export type RestRun = { name: string; until: number; total: number };

const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
/** 끝난 뒤 이만큼 '쉬는 시간 끝'을 보이고 닫는다 */
const OVER_MS = 5000;
/** 끝난 지 이보다 오래 지나 알게 됐으면(다른 앱에 다녀옴) 소리를 내지 않는다 */
const BEEP_LATE_MS = 3000;

export function RestTimer({ run, onChange }: { run: RestRun; onChange: Dispatch<SetStateAction<RestRun | null>> }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const id = window.setInterval(tick, 250);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  const left = Math.max(0, Math.ceil((run.until - now) / 1000));
  const over = left === 0;
  useEffect(() => {
    if (!over) return;
    if (Date.now() - run.until < BEEP_LATE_MS) playRestBeep();
    try {
      navigator.vibrate?.([200, 100, 200]);
    } catch {
      /* 진동을 못 하는 기기 */
    }
    // 이 타이머(끝나는 시각이 같은 것)일 때만 닫는다 — 그사이 다른 세트를 완료해 새 타이머가 돌면 그대로 둔다
    const id = window.setTimeout(() => onChange((cur) => (cur?.until === run.until ? null : cur)), OVER_MS);
    return () => window.clearTimeout(id);
  }, [over, run.until, onChange]);
  const pct = over ? 0 : Math.min(100, ((run.until - now) / run.total) * 100);
  // 바깥 칸(rest-dock)이 기록 창 아래에 붙고 홈 표시줄 높이만큼 띄운다 — 카드가 화면 밖으로 잘려 아래 끝의 남은 시간 막대만
  // 형광색 줄로 비치던 것(2026-11-03 사용자 제보, 아이폰). 막대는 회색 바탕 줄 위에서 줄어든다
  return (
    <div className="rest-dock">
      <div className={`rest-timer${over ? ' over' : ''}`} role="timer" data-testid="rest-timer">
        <div className="rest-timer-track" aria-hidden="true">
          <div className="rest-timer-bar" style={{ width: `${pct}%` }} />
        </div>
        <span>
          {/* 초마다 바뀌는 글자는 읽어 주지 않고, 끝났을 때만 알린다 */}
          <strong>{over ? '쉬는 시간 끝' : `쉬는 시간 ${clock(left)}`}</strong>
          <small>{run.name}</small>
          <span className="rest-timer-said" aria-live="polite">
            {over ? '쉬는 시간이 끝났어요' : ''}
          </span>
        </span>
        {!over && (
          <button type="button" className="text-button" onClick={() => onChange((cur) => (cur ? { ...cur, until: cur.until + 30000, total: cur.total + 30000 } : cur))}>
            +30초
          </button>
        )}
        <button type="button" className="secondary small" onClick={() => onChange(null)}>
          {over ? '닫기' : '건너뛰기'}
        </button>
      </div>
    </div>
  );
}

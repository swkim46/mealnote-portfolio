// 아직 안 한 설정을 하루 한 번 알린다(사용자 요청 11-06: 알림·운동 시트를 안 한 사람). 기기마다 하루 한 번이다.
import { useEffect, useRef } from 'react';
import { fetchRoutineSheet, sessionAlive } from './api';
import { isBusy } from './appUpdate';
import { todayKey } from './dates';
import { deviceState, pushSupport } from './push';

export type SetupItem = 'push' | 'sheet';
const KEY = 'mealnote:setup-nudge';

const shownToday = (today: string) => {
  try {
    return (localStorage.getItem(KEY) ?? '') >= today;
  } catch {
    return true; // 저장소를 못 쓰는 브라우저에서는 매번 띄우지 않는다
  }
};
const markShown = (today: string) => {
  try {
    localStorage.setItem(KEY, today);
  } catch {
    /* 못 적어도 이번 화면에서는 닫힌다 */
  }
};

let saving = 0;
let saved = 0;
/**
 * 시트 연결·알림 켜기를 감싼다. 저장 중이거나 저장이 끝나기 전에 시작한 확인은 옛 상태를 본 것이라 버린다(Codex v2.3.3 1차 리뷰).
 * 서버에 저장된 뒤 응답을 기다리는 동안 창을 닫을 수 있어 끝난 때만 세면 늦다. 실패해도 버리고, 앱으로 돌아올 때 지금 상태로 다시 확인한다.
 */
export async function savingSetup<T>(job: () => Promise<T>): Promise<T> {
  saving++;
  try {
    return await job();
  } finally {
    saving--;
    saved++;
  }
}

/** 아직 안 한 설정. 확인하지 못한 항목은 넣지 않는다(조회 실패를 '안 했다'로 말하지 않는다). 기기가 알림을 못 받으면 권하지 않는다 */
export async function missingSetup(userId: string, member: boolean): Promise<SetupItem[]> {
  // 서버에서 로그인이 끊긴 기기에는 권하지 않는다 — 조회가 비어 '안 한 설정'처럼 보인다(2.4). 확인하지 못해도 권하지 않는다
  if (!(await sessionAlive(userId).catch(() => false))) return [];
  const support = pushSupport();
  const [push, sheet] = await Promise.all([
    support === 'install' ? true : support === 'ok' ? deviceState().then((s) => s !== 'on', () => false) : false,
    member ? fetchRoutineSheet(userId).then((link) => !link, () => false) : false,
  ]);
  return [...(push ? (['push'] as const) : []), ...(sheet ? (['sheet'] as const) : [])];
}

/** 앱을 열 때·앱으로 돌아올 때 확인한다. 다른 창이 열려 있거나 입력 중이거나 앱이 숨어 있으면 표시를 남기지 않고, 다음에 돌아올 때 띄운다 */
export function useSetupNudge(userId: string, member: boolean, ready: boolean, show: (items: SetupItem[]) => void) {
  const latest = useRef(show);
  useEffect(() => {
    latest.current = show;
  });
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    const check = async () => {
      const today = todayKey();
      if (shownToday(today)) return;
      const started = saved;
      const items = await missingSetup(userId, member);
      if (!alive || saving || started !== saved || !items.length || isBusy() || document.visibilityState !== 'visible' || shownToday(today)) return;
      markShown(today);
      latest.current(items);
    };
    void check();
    const onVisible = () => document.visibilityState === 'visible' && void check();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [userId, member, ready]);
}

import type { Streak } from './api';

export const STREAK_MILESTONES = [3, 7, 14, 30, 50, 100] as const;

/** 연속 기록 문구. 오늘을 아직 안 남겼으면 어제까지 이어진 날 수를 보여 주고 오늘 남기면 며칠째인지 알려 준다. */
export function streakText(s: Streak): { main: string; sub: string; milestone: boolean } {
  const best = s.best > s.current ? `최고 기록 ${s.best}일` : '';
  if (s.current === 0)
    return { main: '오늘 한 끼를 남기면 연속 기록이 시작돼요.', sub: best, milestone: false };
  if (s.today_logged) {
    const milestone = (STREAK_MILESTONES as readonly number[]).includes(s.current);
    return {
      main: milestone ? `${s.current}일 연속 기록을 달성했어요!` : `${s.current}일째 연속 기록 중이에요.`,
      sub: best,
      milestone,
    };
  }
  return { main: `어제까지 ${s.current}일 연속이에요.`, sub: `오늘도 남기면 ${s.current + 1}일째예요.`, milestone: false };
}

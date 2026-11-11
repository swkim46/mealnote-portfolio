// 오늘 날짜(기기, YYYY-MM-DD)를 화면 상태로 — 앱을 켜 둔 채 자정을 넘기거나 앱으로 돌아오면 새 날짜로 다시 그린다.
// 날짜로 기간을 정하는 조회(운동 요약 — 이번 주·이번 달)가 날짜를 조회 기준에 넣어, 날이 바뀌면 새 기간으로 다시 받게 한다(Codex v2.1.0 4차 리뷰 P2).
import { useEffect, useState } from 'react';
import { todayKey } from './dates';

export function useToday(): string {
  const [today, setToday] = useState(todayKey);
  useEffect(() => {
    let timer = 0;
    const check = () => {
      setToday(todayKey());
      window.clearTimeout(timer);
      // 다음 자정 1초 뒤에 다시 본다(잠자기·시계 변경으로 늦어져도 앱 복귀 때 다시 본다)
      const now = new Date();
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
      timer = window.setTimeout(check, Math.max(1000, next.getTime() - now.getTime()));
    };
    check();
    const onVisible = () => document.visibilityState === 'visible' && check();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  return today;
}

// 인바디 변화 보고서의 계산(2.3 — 시안 design/v23-20261105): 기간 달력 · 식단 평가 흐름 · 운동 변화.
import type { DietPeriod, WorkoutSession } from './api';
import { shiftDay } from './dates';
import { scoreText } from './report';
import { isWorkout, weekStart } from './workoutStats';

export type DayTone = 'great' | 'good' | 'care' | 'wait';
type DietDay = DietPeriod['days'][number];

const dayCount = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00`) - Date.parse(`${from}T12:00:00`)) / 86_400_000) + 1;
const shortDay = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;

/** 그날의 색: 평가 평균이 어느 평가(5·3·1점)에 가까운가. 기록은 있는데 평가가 없으면 평가 전 */
export const dayTone = (d: DietDay): DayTone => {
  if (!d.rated) return 'wait';
  const avg = d.score_sum / d.rated;
  return avg >= 4 ? 'great' : avg >= 2 ? 'good' : 'care';
};

export type PeriodCell = { day: string; label: string; inside: boolean; tone: DayTone | null; work: 'routine' | 'cardio' | null };

/** 기간을 품는 주들(일요일부터). 달이 바뀌는 1일은 달까지 적는다 */
export function periodCalendar(from: string, to: string, days: DietDay[], sessions: WorkoutSession[]): PeriodCell[] {
  const diet = new Map(days.map((d) => [d.day, d]));
  const done = sessions.filter(isWorkout);
  const end = shiftDay(weekStart(to), 6);
  const cells: PeriodCell[] = [];
  for (let day = weekStart(from); day <= end; day = shiftDay(day, 1)) {
    const inside = day >= from && day <= to;
    const d = inside ? diet.get(day) : undefined;
    const today = inside ? done.filter((s) => s.day === day) : [];
    const n = Number(day.slice(8, 10));
    cells.push({ day, label: n === 1 ? shortDay(day) : String(n), inside, tone: d ? dayTone(d) : null, work: today.some((s) => s.sets.some((x) => x.done)) ? 'routine' : today.length ? 'cardio' : null });
  }
  return cells;
}

const WEEK_BARS = 8;
/** 평가 평균의 흐름. 기간을 앞에서부터 7일씩, 막대가 여덟 개를 넘으면 그만큼 넓혀 나눈다. 평가가 없는 구간은 점수가 없다 */
export function scoreWeeks(from: string, to: string, days: DietDay[]) {
  const total = dayCount(from, to);
  const weekly = Math.ceil(total / 7) <= WEEK_BARS;
  const size = weekly ? 7 : Math.ceil(total / WEEK_BARS);
  return Array.from({ length: Math.ceil(total / size) }, (_, i) => {
    const start = shiftDay(from, i * size), stop = shiftDay(start, size - 1);
    const list = days.filter((d) => d.day >= start && d.day <= stop);
    const rated = list.reduce((n, d) => n + d.rated, 0);
    const score = rated ? list.reduce((n, d) => n + d.score_sum, 0) / rated : null;
    return { label: weekly ? `${i + 1}주` : shortDay(start), score, text: score === null ? '–' : scoreText(Math.round(score * 10) / 10) };
  });
}

/** 루틴별 횟수와 유산소 횟수 */
export function routineCounts(sessions: WorkoutSession[]) {
  const done = sessions.filter(isWorkout);
  const lifted = done.filter((s) => s.sets.some((x) => x.done));
  const nos = [...new Set(lifted.flatMap((s) => (s.day_no ? [s.day_no] : [])))].sort((a, b) => a - b);
  const rows = nos.map((n) => ({ label: `루틴 ${n}`, count: lifted.filter((s) => s.day_no === n).length }));
  const free = lifted.filter((s) => !s.day_no).length;
  const cardio = done.filter((s) => s.cardio.length).length;
  return [...rows, ...(free ? [{ label: '그 밖의 운동', count: free }] : []), ...(cardio ? [{ label: '유산소', count: cardio }] : [])];
}

export type LiftChange = { name: string; first: number; last: number; delta: number };

/** 운동마다 가장 무거운 세트의 기간 처음과 끝. 숫자로 적힌 무게만, 두 번 이상 한 운동만, 달라진 것만. 많이 오른 순서로 */
export function liftChanges(sessions: WorkoutSession[]): LiftChange[] {
  const byName = new Map<string, { day: string; kg: number }[]>();
  for (const s of [...sessions].sort((a, b) => a.day.localeCompare(b.day) || a.started_at.localeCompare(b.started_at))) {
    const best = new Map<string, number>();
    for (const x of s.sets) {
      if (!x.done || !/^\d+(\.\d+)?$/.test((x.kg ?? '').trim())) continue;
      best.set(x.name, Math.max(best.get(x.name) ?? 0, Number(x.kg)));
    }
    for (const [name, kg] of best) byName.set(name, [...(byName.get(name) ?? []), { day: s.day, kg }]);
  }
  return [...byName]
    .filter(([, list]) => list.length >= 2)
    .map(([name, list]) => {
      const first = list[0].kg, last = list[list.length - 1].kg;
      return { name, first, last, delta: Math.round((last - first) * 10) / 10 };
    })
    .filter((c) => c.delta !== 0)
    .sort((a, b) => b.delta - a.delta || a.name.localeCompare(b.name, 'ko'));
}

/** 공복 체중 줄: 다섯 번까지는 다 보이고, 그보다 많으면 처음과 끝만 */
export function fastingLine(list: { day: string; kg: number }[]) {
  if (!list.length) return null;
  const shown = list.length <= 5 ? list : [list[0], list[list.length - 1]];
  return `공복 체중 ${list.length}번: ${shown.map((w) => w.kg.toFixed(1)).join(' → ')}kg`;
}

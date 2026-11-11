// 트레이너 화면의 운동 한 줄(2.3 — 사용자 요청 11-03 '회원 운동 기록·루틴에 쉽게 접근', 시안 design/v23-20261105).
// 회원 하루 카드의 운동 줄과 확인 탭의 새 운동 기록이 같은 문장을 쓴다.
import { routineFocus } from './bodyParts';
import { cardioLine } from './cardio';
import { prettyDay, shiftDay } from './dates';
import { bestRows, isWorkout } from './workoutStats';
import type { WorkoutSession } from './api';

/** 카드 운동 줄을 만들 때 살피는 기간(일) */
export const WORKOUT_WINDOW_DAYS = 14;

const dayGap = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00`) - Date.parse(`${from}T12:00:00`)) / 86_400_000);

/** '루틴 2 · 등' · 루틴 없이 한 운동은 부위 · 유산소만이면 '유산소' */
export function sessionTitle(s: WorkoutSession) {
  const names = [...new Set(s.sets.map((x) => x.name))];
  const focus = names.length ? routineFocus(names) : '';
  if (s.day_no) return `루틴 ${s.day_no}${focus ? ` · ${focus}` : ''}`;
  return names.length ? focus || '운동' : '유산소';
}

/** '루틴 2 · 등 · 완료 16/16세트' · 유산소만이면 '유산소 · 러닝 30분 · 5km' */
export function sessionBrief(s: WorkoutSession) {
  if (s.sets.length) return `${sessionTitle(s)} · 완료 ${s.sets.filter((x) => x.done).length}/${s.sets.length}세트`;
  return [sessionTitle(s), ...s.cardio.slice(0, 1).map(cardioLine)].join(' · ');
}

/** 첫 운동의 가장 무거운 세트까지 붙인 문장(확인 탭) */
export function sessionDetail(s: WorkoutSession) {
  const top = bestRows(s, null)[0];
  return top ? `${sessionBrief(s)} · ${top.name} ${top.best}` : sessionBrief(s);
}

export type WorkoutLine = { kind: 'today' | 'recent' | 'none'; text: string; session: WorkoutSession | null };

/** 회원 한 명의 운동 줄. sessions는 최근 것부터 */
export function memberWorkoutLine(sessions: WorkoutSession[], today: string): WorkoutLine {
  // 시트 날짜 오기 등으로 오늘 뒤의 기록이 있어도 '오늘'까지만 본다
  const done = sessions.filter((s) => isWorkout(s) && s.day <= today);
  const last = done[0];
  if (!last) return { kind: 'none', text: '최근 2주 운동 기록 없음', session: null };
  if (last.day === today) return { kind: 'today', text: `오늘 ${sessionBrief(last)}`, session: last };
  const gap = dayGap(last.day, today);
  return { kind: 'recent', text: `최근 운동 ${prettyDay(last.day)}(${gap === 1 ? '어제' : `${gap}일 전`}) · ${sessionTitle(last)}`, session: last };
}

/** 기록 시각 글자: 오늘 07:40 · 어제 20:30 · 11월 2일. 시트 기록은 시각을 모른다 */
export function sessionWhen(s: WorkoutSession, today: string) {
  const day = s.day === today ? '오늘' : s.day === shiftDay(today, -1) ? '어제' : prettyDay(s.day);
  if (s.source === 'sheet') return day;
  const d = new Date(s.started_at);
  return `${day} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * 새 기록을 가르는 기록의 시각. 앱 기록은 저장한 시각으로 본다.
 * 시트 기록은 운동한 날로 본다(그날 0시로 적힌다) — 자동 반영 때마다 수정 시각이 새로 적혀 수정 시각으로 보면 같은 기록이 다시 새 기록으로 뜬다
 */
export const newStamp = (s: WorkoutSession) => new Date(s.source === 'sheet' ? s.started_at : s.updated_at).toISOString();

/**
 * 트레이너가 본 운동 기록(기기에 적는다). base 뒤의 기록이 새 기록이고, marks는 기록마다 본 판(시각)이다.
 * 시각 하나를 앞으로 옮기는 방식은 쓰지 않는다: 아직 받지 못한 기록까지 넘어간다 — 명단이 늦게 온 회원의 기록, 먼저 시작해 늦게 끝난 저장(v2.3.0 4차 리뷰).
 * base는 처음 정한 뒤 옮기지 않는다
 */
export type SeenWorkouts = { base: string; marks: Record<string, string> };

export const isUnseen = (s: WorkoutSession, seen: SeenWorkouts) => newStamp(s) > (seen.marks[s.id] ?? seen.base);

/** 화면에 보인 기록만 그 판으로 적는다. 살피는 기간 밖으로 나간 기록의 표시는 지운다(시각은 서버가 정한 기록의 시각으로 잰다) */
export function markWorkouts(seen: SeenWorkouts, shown: WorkoutSession[]): SeenWorkouts {
  const marks: Record<string, string> = { ...seen.marks };
  for (const s of shown) marks[s.id] = newStamp(s);
  const last = Object.values(marks).sort().at(-1);
  if (!last) return seen;
  const keepFrom = new Date(Date.parse(last) - (WORKOUT_WINDOW_DAYS + 2) * 86_400_000).toISOString();
  return { base: seen.base, marks: Object.fromEntries(Object.entries(marks).filter(([, at]) => at >= keepFrom)) };
}

const stampOf = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

/**
 * 기기에 적힌 값. 시각 하나만 적혀 있으면(2.3 개발 중의 옛 형식) 그 시각부터를 새 기록으로 본다.
 * 읽지 못하는 값은 버린다: 비교가 전부 거짓이면 목록이 말없이 비어 스스로 돌아오지 못한다
 */
export function parseSeen(raw: string): SeenWorkouts | null {
  const v = (raw.startsWith('{') ? JSON.parse(raw) : { base: raw }) as { base?: unknown; marks?: unknown };
  const base = stampOf(v.base);
  if (!base) return null;
  const marks: Record<string, string> = {};
  for (const [id, at] of Object.entries(v.marks ?? {})) {
    const stamp = stampOf(at);
    if (stamp) marks[id] = stamp;
  }
  return { base, marks };
}

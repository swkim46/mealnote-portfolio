// 운동 탭(2.1 시안 3·4, 2026-11-03 사용자 확정)의 계산 규칙. 화면 부품은 이 결과만 그린다.
//  - 루틴 차이: 직전 판과 견줘 빠진·새·목표가 바뀐 운동(루틴 번호와 이름이 같으면 같은 운동)
//  - 새 루틴 한 바퀴: 지금 판의 루틴마다 그 판으로 한 번 이상 기록했는가 — 돌기 전에는 바뀐 점을 위에, 돈 뒤에는 아래에 둔다
//  - 꾸준함(이번 주·이번 달 횟수, 연속 주)은 서버 workout_overview가 센다 — 앱이 받는 최근 30개로는 모자란다(Codex 3차 리뷰 P2). 여기서는 최근 5주 달력만 그린다
//  - 기록 카드: 운동마다 가장 무거운 세트, 최고 기록·지난번보다 무거워진 무게(비교 값은 서버 workout_compare — 그 앞의 모든 기록)
// 근거: 문서/기획/운동탭_레퍼런스조사_261103.md
import { heavier, weightKey } from './routineSheet';
import { kstDateKey, shiftDay } from './dates';
import type { Routine, RoutineItem, WorkoutOverview, WorkoutSession, WorkoutSet } from './api';

/** 운동한 기록: 완료한 세트나 유산소가 있다(DB private.is_workout_session과 같은 기준) */
export const isWorkout = (s: Pick<WorkoutSession, 'sets' | 'cardio'>) => s.sets.some((x) => x.done) || s.cardio.length > 0;

export const dayNos = (items: { day_no: number }[]) => [...new Set(items.map((i) => i.day_no))].sort((a, b) => a - b);

const kg = (w: string) => (/^\d+(\.\d+)?([+/]\d+(\.\d+)?)*$/.test(w) ? `${w}kg` : w);
const reps = (r: string) => (/^\d+$/.test(r) ? `${r}회` : r);
/** '40kg · 10회 · 3세트' */
export const itemDetail = (i: Pick<RoutineItem, 'weight' | 'reps' | 'sets'>) =>
  [i.weight && kg(i.weight), i.reps && reps(i.reps), i.sets && `${i.sets}세트`].filter(Boolean).join(' · ');

export type DiffRow = { kind: 'del' | 'add' | 'chg'; day_no: number; name: string; detail: string; key: string };
/**
 * 직전 판과의 차이(루틴 번호 순, 그 안에서 빠짐 → 새로 → 목표 바뀜).
 * 같은 루틴에 같은 이름이 둘 이상이면(준비 세트·본 세트 등) 루틴 안 순서로 짝짓는다 — 첫째는 첫째와, 둘째는 둘째와(시트 쓰기의 'name#2'와 같은 규칙)
 */
export function routineDiff(cur: Routine, prev: Routine | null): DiffRow[] {
  if (!prev) return [];
  const keyed = (items: RoutineItem[]) => {
    const seen = new Map<string, number>();
    return [...items].sort((a, b) => a.day_no - b.day_no || a.ord - b.ord).map((i) => {
      const base = `${i.day_no}:${i.name}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      return { i, key: n > 1 ? `${base}#${n}` : base };
    });
  };
  const prevK = keyed(prev.items), curK = keyed(cur.items);
  const before = new Map(prevK.map((x) => [x.key, x.i]));
  const now = new Set(curK.map((x) => x.key));
  const rows: DiffRow[] = [];
  for (const { i: b, key } of prevK) if (!now.has(key)) rows.push({ kind: 'del', day_no: b.day_no, name: b.name, detail: `지난 루틴 ${itemDetail(b)}`, key: `del:${key}` });
  for (const { i, key } of curK) {
    const b = before.get(key);
    if (!b) rows.push({ kind: 'add', day_no: i.day_no, name: i.name, detail: `목표 ${itemDetail(i)}`, key: `add:${key}` });
    else if (b.weight !== i.weight || b.reps !== i.reps || b.sets !== i.sets) {
      const parts = [
        b.weight !== i.weight && `${b.weight ? kg(b.weight) : '-'} → ${i.weight ? kg(i.weight) : '-'}`,
        b.reps !== i.reps && `${b.reps ? reps(b.reps) : '-'} → ${i.reps ? reps(i.reps) : '-'}`,
        b.sets !== i.sets && `${b.sets ?? '-'}세트 → ${i.sets ?? '-'}세트`,
      ].filter(Boolean);
      rows.push({ kind: 'chg', day_no: i.day_no, name: i.name, detail: parts.join(' · '), key: `chg:${key}` });
    }
  }
  const order = { del: 0, add: 1, chg: 2 };
  return rows.sort((a, b) => a.day_no - b.day_no || order[a.kind] - order[b.kind]);
}

/** 지금 판의 루틴마다 그 판으로 한 번 이상 운동했는지 */
/**
 * 그 판(루틴 버전)을 받은 날 — 한국 날짜. created_at을 그대로 자르면 UTC 날짜라 오전 9시 전 판은 전날로 보이고,
 * 기기 시간대로 바꾸면 해외 시간대 기기에서 서버(workout_overview — Asia/Seoul)와 다른 날이 된다(Codex v2.2.0 3차 리뷰 P3)
 */
export const versionDay = (routine: Pick<Routine, 'created_at'>) => kstDateKey(new Date(routine.created_at));
/**
 * 이 판으로 한 운동: 그 판을 가리키는, 완료 세트나 유산소가 있는 기록. 앱 기록은 저장할 때 고른 판을 그대로 믿는다.
 * 시트에서 가져온 기록은 그 탭의 최신 판을 가리키므로(sheet_records_save) 판을 받은 다음 날부터만 센다 — 판을 받은 날의 시트 회차는
 * 옛 판으로 했는지 알 수 없다(적대 검토 11-03, 서버 workout_overview와 같은 규칙)
 */
const onVersion = (routine: Routine, s: WorkoutSession) => s.routine_id === routine.id && isWorkout(s) && (s.source !== 'sheet' || s.day > versionDay(routine));

/**
 * 지금 판의 진행: 루틴 번호마다 그 판으로 마지막에 한 날.
 * checking: 받아 둔 기록 밖(최근 30개 밖)의 진행을 아직 확인하는 중 — 마지막 날이 없는 루틴은 '아직 안 함' 대신 '확인 중'
 */
export type RoutineProgress = { last: Record<number, string>; checking?: boolean };
/** 받아 둔 기록(최근 것부터)으로 센 진행 — 서버 집계를 못 받았을 때 */
export function localProgress(routine: Routine, sessions: WorkoutSession[]): RoutineProgress {
  const mine = sessions.filter((s) => s.day_no !== null && onVersion(routine, s));
  const last: Record<number, string> = {};
  for (const s of mine) if (!last[s.day_no!] || s.day > last[s.day_no!]) last[s.day_no!] = s.day;
  return { last };
}
/**
 * 화면이 쓰는 진행. 루틴 카드(마지막 한 날)·바뀐 점(한 바퀴)이 이것을 쓴다(Codex 3차 리뷰 P2).
 * 받아 둔 기록(최근 기록)은 그 기간 안에서 정본이다 — 지우거나 완료를 끈 기록은 목록에서 이미 빠졌다. 그래서
 *  - 목록이 한도로 잘리지 않았으면(truncated 아님) 목록이 전부라 서버 요약을 쓰지 않는다
 *  - 잘렸으면 목록의 가장 오래된 날까지의 진행만 서버 요약(workout_overview — 목록 밖 기록까지)에서 가져온다
 * 요약이 옛 값(다시 받기 실패·받는 중)이어도 목록 기간 안의 사실을 되살리거나 순서를 뒤집지 않는다(Codex v2.2.0 2차 리뷰 P2-1 —
 * 날짜를 더 늦은 쪽으로 합치면 지운 기록이 되살아났다). 목록 기간 안에서 사라진 진행은 확정하지 않는다
 */
export function progressOf(routine: Routine, sessions: WorkoutSession[], overview?: WorkoutOverview | null, truncated = false): RoutineProgress {
  const local = localProgress(routine, sessions);
  if (!truncated || !sessions.length) return local;
  const from = sessions.reduce((m, s) => (s.day < m ? s.day : m), sessions[0].day);
  // 판을 받은 날(새 기록은 최근 7일 날짜까지 — 여유를 둠)이 목록의 가장 오래된 날보다 뒤면, 이 판의 기록은 모두 목록 안이다 — 요약이 필요 없다
  if (shiftDay(versionDay(routine), -7) > from) return local;
  const r = overview?.routine;
  // 목록 밖을 볼 요약이 없음(받는 중·실패·다른 판) — 받아 둔 기록만 쓴다
  if (!r || r.id !== routine.id) return local;
  const last = { ...local.last };
  for (const [k, day] of Object.entries(r.last)) if (!last[Number(k)] && day <= from) last[Number(k)] = day;
  return { last };
}
export function routineCycle(routine: Routine, progress: RoutineProgress) {
  const days = dayNos(routine.items);
  const done = new Set(days.filter((d) => progress.last[d]));
  return { days, done, complete: days.length > 0 && days.every((d) => done.has(d)) };
}

/** 그 판으로 그 루틴을 마지막에 한 날(없으면 null) */
export const lastDoneDay = (progress: RoutineProgress, dayNo: number) => progress.last[dayNo] ?? null;

/** 그 날이 든 주의 일요일 */
export const weekStart = (day: string) => shiftDay(day, -new Date(`${day}T12:00:00`).getDay());

/** 달력에 쓰는 기록 한 줄(서버 workout_overview의 days와 같은 꼴) */
export type CalendarRow = WorkoutOverview['days'][number];
/** 받아 둔 기록 → 달력 줄(운동한 기록만) */
export const calendarRows = (sessions: WorkoutSession[]): CalendarRow[] =>
  sessions.filter(isWorkout).map((s) => ({ day: s.day, day_no: s.day_no, started_at: s.started_at, strength: s.sets.some((x) => x.done), cardio: s.cardio.length > 0 }));

export type CalendarCell = { day: string; label: string; kind: 'routine' | 'cardio' | null; today: boolean; future: boolean };
/**
 * 최근 몇 주 달력(일요일 시작, 이번 주 포함). 근력 운동(완료 세트)을 한 날은 채우고 루틴 번호(루틴 없이 직접 기록했으면 '운동'),
 * 유산소만 한 날은 테두리와 '유산소'. 같은 날 여러 번이면 먼저 시작한 기록. rows는 그 기간의 운동 기록 전부여야 한다(서버 집계)
 */
export function recentCalendar(rows: CalendarRow[], today: string, weeks = 5): CalendarCell[] {
  const start = shiftDay(weekStart(today), -7 * (weeks - 1));
  const cells: CalendarCell[] = [];
  for (let k = 0; k < weeks * 7; k++) {
    const day = shiftDay(start, k);
    const list = rows.filter((s) => s.day === day).sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0));
    const strength = list.find((s) => s.strength);
    cells.push({
      day,
      label: strength ? (strength.day_no ? `루틴${strength.day_no}` : '운동') : list.length ? '유산소' : '',
      kind: strength ? 'routine' : list.length ? 'cardio' : null,
      today: day === today,
      future: day > today,
    });
  }
  return cells;
}

/** 완료한 세트 가운데 가장 무거운 세트(무게가 같으면 앞 세트). 무게 없이 한 세트만 있으면 그중 첫 세트 */
export function heaviestSet<T extends Pick<WorkoutSet, 'kg' | 'done'>>(sets: T[]): T | null {
  const done = sets.filter((x) => x.done);
  if (!done.length) return null;
  return done.reduce((best, x) => (heavier(weightKey(x.kg ?? ''), weightKey(best.kg ?? '')) ? x : best));
}

/** '72.5kg × 8' · 무게 없이 한 세트는 '12회'처럼 횟수만 */
export const setText = (s: Pick<WorkoutSet, 'kg' | 'reps'>) => (s.kg ? [kg(s.kg), s.reps].filter(Boolean).join(' × ') : s.reps ? reps(s.reps) : '무게 없이');

export type BestRow = { name: string; best: string; record: boolean; up: number | null };
/**
 * 기록 카드의 운동별 줄(기록 안 운동 순서): 가장 무거운 세트, 최고 기록, 지난번보다 무거워진 무게(숫자 무게끼리만).
 * cmp = 서버 비교(workout_compare)의 이 기록 몫 — 그 앞의 모든 기록(같은 날 먼저 한 기록 포함, 최근 30개 밖 포함)에서
 *  prior(무게를 단 세트 가운데 가장 무거운 무게)·prev(지난번 가장 무거운 세트 무게). 없으면(받지 못함) 최고·오름 표시를 하지 않는다.
 * 최고 기록 = prior보다 무거움. 무게를 단 이전 세트가 없으면(맨몸으로만 하던 운동의 첫 무게·첫 기록) 견줄 기록이 없어 최고가 아니다
 */
export function bestRows(session: WorkoutSession, cmp?: Record<string, { prior: number[] | null; prev: string | null }> | null): BestRow[] {
  const names = [...new Set(session.sets.filter((x) => x.done).map((x) => x.name))];
  return names.map((name) => {
    const best = heaviestSet(session.sets.filter((x) => x.name === name))!;
    const c = cmp?.[name];
    const key = weightKey(best.kg ?? '');
    const record = !!c?.prior && c.prior.length > 0 && key.length > 0 && heavier(key, c.prior.map(Number));
    const plain = (v: string | null | undefined) => (v && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : null);
    const a = plain(best.kg), b = plain(c?.prev);
    const up = !record && a !== null && b !== null && a > b ? Math.round((a - b) * 10) / 10 : null;
    return { name, best: setText(best), record, up };
  });
}

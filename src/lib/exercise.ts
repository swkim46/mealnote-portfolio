// v2.4 운동 찾기 · 운동별 기록 · 지난번 · 동작별 메모의 계산 규칙(문서/기획/2_4_범위와_결정_261107.md). 화면 부품은 이 결과만 그린다.
//  - 같은 운동: 비교용 이름이 같으면 같은 운동. 공백을 빼고 영문은 소문자로(DB private.exercise_key와 같은 규칙)
//  - 무게 비교는 기록 카드와 같은 규칙(weightKey·heavier — 글자 무게도 앞 숫자부터 견줌)
import { heavier, weightKey } from './routineSheet';
import { heaviestSet, setText } from './workoutStats';
import { CARDIO_KINDS, cardioLabel } from './cardio';
import type { CardioKindEntry, ExerciseDay, ExerciseEntry, ExerciseMemo, LastSets } from './api';

// 지우는 공백은 \s(U+FEFF 포함)와 U+0085 — DB private.exercise_key의 [[:space:]]+U+0085+U+FEFF와 같은 글자(넘기기 전 적대 검토 10)
export const exerciseKey = (name: string) => name.replace(/[\s\u0085]+/g, '').toLowerCase();

/** 찾기: 이름에 친 글자가 든 운동(공백·대소문자 무시). 빈 글이면 전부(많이 한 순서 그대로). 유산소는 종류 이름으로 */
export function findExercises(list: { strength: ExerciseEntry[]; cardio: CardioKindEntry[] }, query: string) {
  const q = exerciseKey(query);
  return {
    strength: q ? list.strength.filter((x) => x.key.includes(q)) : list.strength,
    cardio: q ? list.cardio.filter((c) => exerciseKey(cardioLabel(c.kind)).includes(q)) : list.cardio,
  };
}

/** 이름이 친 글자를 처음 담은 자리(공백 무시) — 찾은 글자 강조용. 없으면 null */
export function matchRange(name: string, query: string): [number, number] | null {
  const q = exerciseKey(query);
  if (!q) return null;
  const idx: number[] = [];
  let flat = '';
  [...name].forEach((ch, i) => {
    if (/\s/.test(ch)) return;
    flat += ch.toLowerCase();
    idx.push(i);
  });
  const at = flat.indexOf(q);
  if (at < 0) return null;
  return [idx[at], idx[at + q.length - 1] + 1];
}

export const knownCardio = (kind: string) => CARDIO_KINDS.some((k) => k.code === kind);

const done = <T extends { kg: string | null; reps: string | null }>(sets: T[]) => sets.map((s) => ({ ...s, done: true }));

/**
 * 새 기록을 루틴으로 채울 때 그 세트에 넣을 최신 무게(2.4.1 — 2026-11-10 사용자 의견 '처음 불러온 무게가 아니라 최신 무게').
 * 그 운동을 마지막으로 한 기록(이전 기록 줄과 같은 기록)의 같은 번호 세트 무게, 그 세트가 없으면 그 기록의 마지막 세트 무게.
 * 한 적이 없거나 그 세트에 무게를 적지 않았으면 null — 루틴에 적힌 무게를 그대로 둔다
 */
export function latestWeight(last: LastSets[string] | undefined, setNo: number): string | null {
  const sets = last?.sets ?? [];
  if (!sets.length) return null;
  const kg = (sets.find((s) => s.set_no === setNo) ?? sets[sets.length - 1]).kg?.trim();
  return kg ? kg : null;
}

/** 이전 기록 줄(운동 기록 창): 마지막으로 한 날과 그날 가장 무거운 세트('70kg × 8'). 한 적이 없으면 null */
export function lastLine(last: LastSets, name: string): { day: string; text: string } | null {
  const l = last[name];
  if (!l || !l.sets.length) return null;
  const best = heaviestSet(done(l.sets));
  return best ? { day: l.day, text: setText(best) } : null;
}

export type HistoryRow = ExerciseDay & { best: string; record: boolean };
/**
 * 운동별 기록의 날짜 줄과 맨 위 숫자. 최고 = 그 앞의 모든 기록에서 무게를 단 세트보다 무거움(기록 카드와 같은 기준 —
 * 무게를 단 이전 세트가 없으면 견줄 기록이 없어 최고가 아니다)
 */
export function historySummary(days: ExerciseDay[]) {
  const rows: HistoryRow[] = [];
  let prior: number[] | null = null;
  for (const d of [...days].reverse()) {
    const best = heaviestSet(done(d.sets));
    const key = weightKey(best?.kg ?? '');
    const record = !!prior && prior.length > 0 && key.length > 0 && heavier(key, prior);
    if (key.length > 0 && (!prior || heavier(key, prior))) prior = key;
    rows.unshift({ ...d, best: best ? setText(best) : '', record });
  }
  const top = heaviestSet(done(days.flatMap((d) => d.sets)));
  return { rows, heaviest: top?.kg ? setText({ kg: top.kg, reps: null }) : null, count: days.length, last: days[0]?.day ?? null };
}

/** 날짜 줄을 달마다 묶는다(최근 달부터) */
export function byMonth<T extends { day: string }>(rows: T[]) {
  const out: { month: string; rows: T[] }[] = [];
  for (const r of rows) {
    const m = r.day.slice(0, 7);
    const last = out[out.length - 1];
    if (last && last.month === m) last.rows.push(r);
    else out.push({ month: m, rows: [r] });
  }
  return out;
}

/** 그날 세트 한 줄: '60kg × 10 · 70kg × 8 · 70kg × 8' */
export const setsLine = (sets: { kg: string | null; reps: string | null }[]) => sets.map((s) => setText(s)).join(' · ');

export type MemoPair = { member: ExerciseMemo | null; trainer: ExerciseMemo | null };
/** 그 운동의 회원 칸·트레이너 칸 */
export function memoPair(memos: ExerciseMemo[] | null | undefined, name: string): MemoPair {
  const k = exerciseKey(name);
  const mine = (memos ?? []).filter((m) => m.key === k);
  return { member: mine.find((m) => m.author === 'member') ?? null, trainer: mine.find((m) => m.author === 'trainer') ?? null };
}

export const MEMO_MAX = 200;

// 메모 칸의 상태(없음·쓰는 중·저장 중). 화면 부품(MemoBox)이 알리고, 그 칸을 담은 층·폼이 떠나기 전에 본다
export type MemoState = 'clean' | 'dirty' | 'saving';
/** 메모 칸 여럿의 상태를 하나로: 쓰는 중이 하나라도 있으면 쓰는 중(물어야 한다), 아니면 저장 중이 있으면 저장 중 */
export const memoStateOf = (states: Iterable<MemoState>): MemoState => {
  let out: MemoState = 'clean';
  for (const st of states) if (st === 'dirty') return 'dirty';
  else if (st === 'saving') out = 'saving';
  return out;
};
/**
 * 메모 칸을 두고 떠나도 되는지(층 닫기·날짜 열기·루틴 바꾸기·운동 기록 저장 전). 쓰는 중이면 묻는다.
 * 저장 중이면 그대로 떠난다(사용자 결정 11-09) — 결과는 lib/memoSaves가 받고, 실패하면 다음에 그 칸에서 보여 준다
 */
export function leaveMemo(state: MemoState, ask = '메모를 저장하지 않고 이동할까요?') {
  return state !== 'dirty' || window.confirm(ask);
}

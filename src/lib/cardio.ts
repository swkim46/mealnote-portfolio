// 유산소 기록(v2.1, 2026-11-02 사용자 피드백 "유산소 운동 기록 추가(몇키로 몇분)(러닝, 사이클 등 유형 선택)").
// 유형은 코드로 저장하고 화면 글자는 여기서 정한다(DB 확인 목록: supabase/migrations/20261102000003_workout_cardio.sql).
// 시간(분)은 필수, 거리(km)·속도(km/h)는 필요에 따라 하나만 또는 둘 다(사용자 11-02). 서로 계산해 채우지 않는다.

export const CARDIO_KINDS = [
  { code: 'run', label: '러닝' },
  { code: 'walk', label: '걷기' },
  { code: 'cycle', label: '사이클' },
  { code: 'row', label: '로잉' },
  { code: 'stair', label: '스텝밀' },
  { code: 'elliptical', label: '일립티컬' },
  { code: 'swim', label: '수영' },
  { code: 'rope', label: '줄넘기' },
  { code: 'other', label: '기타' },
] as const;
export type CardioKind = (typeof CARDIO_KINDS)[number]['code'];

export interface CardioEntry {
  kind: CardioKind;
  minutes: number;
  km: number | null;
  speed: number | null;
}

export const cardioLabel = (kind: string) => CARDIO_KINDS.find((k) => k.code === kind)?.label ?? '유산소';
const num = (n: number) => String(Math.round(n * 100) / 100);

/** 종류 없이: '30분 · 5km · 시속 10km' (운동별 기록 — 종류는 제목에 있다) */
export const cardioDetail = (c: Omit<CardioEntry, 'kind'>) =>
  [`${num(c.minutes)}분`, c.km !== null && `${num(c.km)}km`, c.speed !== null && `시속 ${num(c.speed)}km`].filter(Boolean).join(' · ');

/** 한 줄: '러닝 30분 · 5km' · '사이클 20분 · 시속 24.5km' */
export const cardioLine = (c: CardioEntry) => `${cardioLabel(c.kind)} ${cardioDetail(c)}`;

/** 입력 칸 글자 → 숫자(빈 칸 null, 범위 밖·숫자 아님 NaN). 서버 확인 범위와 같다 */
export function cardioNumber(text: string, min: number, max: number): number | null {
  const t = text.trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= min && n <= max ? n : NaN;
}
export const CARDIO_RANGE = { minutes: [1, 600], km: [0.01, 200], speed: [0.1, 80] } as const;

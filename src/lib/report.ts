// 결산: 직전 인바디 다음 날 ~ 이번 인바디 날짜 사이의 식단 평가 점수와 인바디 변화(2026-10-23 사용자 결정).
// 한 줄 정리는 규칙 2×2(식단 평가 평균 3.5점 이상(5점 만점) × 인바디 개선)로 만든다. 식단 때문에 인바디가 바뀌었다고 단정하지 않는다.
import type { InbodyRecord } from './types';

export interface DietReport {
  days: number;
  logged_days: number;
  meals: number;
  great: number;
  good: number;
  care: number;
  rated: number;
  score: number | null;
}

/** 5점 만점 평균의 '좋음' 기준. 예전 100점 만점 70점과 같은 자리(5·3·1 사이 비례) */
export const GOOD_SCORE = 3.5;

/** 점수 표기: 4.3 / 5 (정수면 소수점 없이) */
export const scoreText = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

export interface Change {
  weight: number;
  smm: number | null;
  pbf: number | null;
}

const diff = (a: number | null, b: number | null) => (a === null || b === null ? null : Math.round((a - b) * 10) / 10);

export const changeOf = (cur: InbodyRecord, prev: InbodyRecord): Change => ({
  weight: diff(cur.weight_kg, prev.weight_kg)!,
  smm: diff(cur.smm_kg, prev.smm_kg),
  pbf: diff(cur.pbf_pct, prev.pbf_pct),
});

/** 다음 날짜(YYYY-MM-DD) */
export const dayAfter = (day: string) => {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** 측정 변화 문장. 기록된 항목만 말하고, 한쪽 측정에 값이 없는 항목은 비교할 수 없다고 말한다(Codex 재검토 v1.4 P2). */
export function changeSentences(c: Change): string {
  const out: string[] = [];
  const missing: string[] = [];
  if (c.pbf === null) missing.push('체지방률');
  else if (c.pbf < 0) out.push(`체지방률이 ${Math.abs(c.pbf).toFixed(1)}%p 내려갔어요.`);
  else if (c.pbf > 0) out.push(`체지방률은 ${c.pbf.toFixed(1)}%p 늘었어요.`);
  else out.push('체지방률은 그대로예요.');
  if (c.smm === null) missing.push('골격근량');
  else if (c.smm > 0) out.push(`골격근량이 ${c.smm.toFixed(1)}kg 늘었어요.`);
  else if (c.smm < 0) out.push(`골격근량은 ${Math.abs(c.smm).toFixed(1)}kg 줄었어요.`);
  else out.push('골격근량은 그대로예요.');
  if (missing.length === 2) out.push('골격근량·체지방률도 기록하면 변화를 함께 볼 수 있어요.');
  else if (missing.length === 1) out.push(`${missing[0]}은 기록이 없어 비교할 수 없어요.`);
  return out.join(' ');
}

/**
 * 한 줄 정리. 확인된 범위만 말한다: '평가받은 식단의 평균'과 '기록된 항목의 변화'.
 * 회원을 탓하는 말·'식단을 잘 지켰다' 같은 단정은 쓰지 않는다. 평균이 기준 아래이거나 좋아진 항목이 없으면 트레이너와 다음 목표를 정하자는 말로 맺는다.
 * improved: 기록된 항목 중 체지방률이 내려갔거나 골격근량이 늘었음(둘 다 기록이 없으면 null)
 */
export function summarize(r: DietReport, c: Change): { line: string; goodDiet: boolean | null; improved: boolean | null } {
  const improved = c.pbf === null && c.smm === null ? null : (c.pbf !== null && c.pbf < 0) || (c.smm !== null && c.smm > 0);
  const goodDiet = r.score === null ? null : r.score >= GOOD_SCORE;
  const changes = changeSentences(c);
  const sc = r.score === null ? '' : scoreText(r.score);
  const avg = r.rated === 1 ? `평가받은 식단 1끼는 5점 만점에 ${sc}점이에요.` : `평가받은 식단 ${r.rated}끼의 평균은 5점 만점에 ${sc}점이에요.`;
  let line: string;
  if (goodDiet === null) line = `${r.meals ? '이 기간에는 평가받은 식단이 없어요.' : '이 기간에는 남긴 식단이 없어요.'} ${changes}`;
  else if (improved === null || (goodDiet && improved)) line = `${avg} ${changes}`;
  else line = `${avg} ${changes} 다음 목표를 트레이너와 함께 정해 보세요.`;
  return { line, goodDiet, improved };
}

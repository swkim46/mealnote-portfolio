// 식단 탭 하루 화면(2.1, 2026-11-03 사용자 확정 — design/diet-tab-20261103 시안):
//  - 그날 트레이너 평가 요약 한 줄(평가별 끼니 수·답변 대기·확인 대기)
//  - 끼니 칸(아침·점심·저녁·간식): 기록한 끼니는 지금 카드 그대로, 빈 끼니는 그 끼니로 바로 기록하는 칸
// 근거: 문서/기획/식단탭_레퍼런스조사_261103.md (MyFitnessPal·Lose It!·Yazio·필라이즈의 끼니 칸, 밀리그램·필라이즈의 하루 점수)
import type { ReactNode } from 'react';
import { RATINGS } from '../lib/rating';
import { hasQuestion } from '../lib/status';
import { MEAL_TYPES, type Meal, type MealType } from '../lib/types';

/** 날짜 띠 아래 평가 색 설명(평가한 날이 하나라도 있을 때만) */
export function ToneLegend() {
  return (
    <div className="tone-legend" aria-hidden="true">
      {RATINGS.map((r) => (
        <span key={r.value}>
          <i className={`tone ${r.cls}`} />
          {r.cls === 'great' ? '아주 좋아요' : r.cls === 'good' ? '조금만 더' : '조절 필요'}
        </span>
      ))}
    </div>
  );
}

/** 그날 평가 요약 한 줄. 기록이 없으면 그리지 않는다 */
export function DayRatings({ label, meals }: { label: string; meals: Meal[] }) {
  if (!meals.length) return null;
  const questions = meals.filter(hasQuestion).length;
  const waiting = meals.filter((m) => !m.reviewed_at && !hasQuestion(m)).length;
  return (
    <div className="day-ratings" data-testid="day-ratings">
      <b>{label} 평가</b>
      {RATINGS.map((r) => {
        const n = meals.filter((m) => m.rating === r.value).length;
        return n ? (
          <span key={r.value} className={`rating-chip ${r.cls}`}>
            {r.label} {n}
          </span>
        ) : null;
      })}
      {questions > 0 && <span className="status question">답변 대기 {questions}</span>}
      {waiting > 0 && <span className="status pending">확인 대기 {waiting}</span>}
    </div>
  );
}

/** 끼니 칸. card = 기존 식사 카드, onAdd = 그 끼니로 기록 창 열기 */
export function MealSlots({ meals, card, onAdd }: { meals: Meal[]; card: (id: string) => ReactNode; onAdd: (type: MealType) => void }) {
  return (
    <div className="meal-slots">
      {MEAL_TYPES.map((t) => {
        const mine = meals.filter((m) => m.meal_type === t).sort((a, b) => a.eaten_at.localeCompare(b.eaten_at));
        return (
          <div key={t} className="meal-slot" data-testid={`meal-slot-${t}`}>
            <div className="meal-slot-head">
              <strong>{t}</strong>
              {mine.length > 1 && <span>{mine.length}끼</span>}
            </div>
            {mine.length ? (
              <div className="meals">{mine.map((m) => card(m.id))}</div>
            ) : (
              <button type="button" className="meal-slot-empty" onClick={() => onAdd(t)}>
                <b aria-hidden="true">+</b>
                {t} 기록하기
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// 식단 3단계 평가(2026-10-23 사용자 결정. 문구는 사용자가 준 느낌 '너무 좋다 / 좋은데 좀 더 / 신경 써 달라'을 다듬은 것). 점수는 5점 만점(5·3·1)으로 변화 카드의 평균에만 쓰고, 평가 자체는 문구와 색으로 보여 준다.
// 점수 매핑의 원본은 DB의 private.rating_score다. 여기 score는 화면 설명용으로만 같은 값을 둔다.
export type Rating = 1 | 2 | 3;

export const RATINGS: { value: Rating; label: string; cls: string; score: number }[] = [
  { value: 1, label: '아주 좋아요', cls: 'great', score: 5 },
  { value: 2, label: '좋아요, 조금만 더', cls: 'good', score: 3 },
  { value: 3, label: '조절이 필요해요', cls: 'care', score: 1 },
];

export const ratingOf = (r: number | null | undefined) => RATINGS.find((x) => x.value === r) ?? null;
